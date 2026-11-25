// Sending what is due in scheduled_emails: the user's undo-send and send-later,
// and Autopilot's replies once their cancel window has passed.
//
// A row is claimed by moving it out of "pending" before sending, so a slow
// send is never picked up twice. An Autopilot row is checked again when it
// falls due, against the stored email it answers: if Tabellar was paused or
// taken off Autopilot in the meantime, or the reply no longer passes
// checkAutoSend, it is not sent and is kept as a draft instead.

import { db } from "./db.ts";
import { mail } from "./providers.ts";
import { checkAutoSend, checkHandOn, looksLikeInstructions } from "./policy.ts";
import { engineSettings } from "./actions.ts";
import { notify } from "./notify.ts";
import { fromLine, type Account } from "./accounts.ts";
import { messageIdOf, withForward } from "./forward.ts";
import { htmlToText } from "./mime.ts";
import { addressesIn } from "./senders.ts";
import { answered } from "./snooze.ts";

type Row = Record<string, any>;

const ANSWERED = "You answered it yourself";

// Nothing reached the mailbox: no network (a Mac just awake), no address for
// it, no connection, or no sign-in to send with. Tried again until it is this
// late; anything else may have gone out, and is never sent twice.
const RETRY_FOR_MS = 12 * 3600_000;
const NOT_SENT = /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|Could not reach /;
function notSent(e: unknown): boolean {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  return NOT_SENT.test(`${err.message ?? ""} ${err.cause?.code ?? ""} ${err.cause?.message ?? ""}`);
}

// A send cut off by a crash or a quit may or may not have gone out, so it is
// not sent again on its own; the user looks.
export async function closeInterrupted(): Promise<void> {
  const { data } = await db.from("scheduled_emails").update({ status: "failed", error_message: "Tabellar stopped while sending it. Look in Sent before sending it again." }).eq("status", "sending").select("action_id");
  for (const r of data ?? []) if (r.action_id) await db.from("action_log").update({ status: "failed", error: "Tabellar stopped while sending it" }).eq("id", r.action_id);
  await db.from("action_log").update({ status: "failed", error: "Tabellar stopped before it was done" }).eq("status", "running");
  const { data: trials } = await db.from("automations").select("id, trial").not("trial", "is", null);
  for (const a of trials ?? []) if ((a.trial as { state?: string }).state === "running") await db.from("automations").update({ trial: { ...(a.trial as object), state: "failed", error: "Tabellar stopped while it was looking." } }).eq("id", a.id);
  await db.from("agent_sessions").update({ status: "error", error: "Tabellar stopped while this was running. Ask again.", pending_question: null, pending_questions: [] }).in("status", ["planning", "executing"]);
}

async function autopilotRefusal(row: Row): Promise<string | null> {
  const { level, paused } = await engineSettings(row.user_id);
  if (paused) return "Tabellar was paused before it was sent";
  if (level !== "autopilot") return "Autopilot was turned off before it was sent";
  if (!row.email_id) return "The email it answered is no longer in Tabellar";
  const { data: email } = await db.from("emails").select("sender_email, reply_to_email, thread_id, received_at").eq("id", row.email_id).maybeSingle();
  if (!email) return "The email it answered is no longer in Tabellar";
  if (row.forward) return handOnRefusal(row);
  if (email.thread_id !== row.thread_id) return "The reply is not in the thread of the email it answers";
  // Answered by hand inside the window, here or from another device.
  const { count } = await db.from("emails").select("id", { count: "exact", head: true }).eq("user_id", row.user_id).eq("thread_id", row.thread_id).contains("label_ids", ["SENT"]).gt("received_at", email.received_at);
  if (count) return ANSWERED;
  return checkAutoSend({
    to: (row.to_addresses as string[]) ?? [],
    cc: (row.cc_addresses as string[] | null) ?? [],
    bcc: (row.bcc_addresses as string[] | null) ?? [],
    threadId: row.thread_id,
    writer: String(email.reply_to_email || email.sender_email || ""),
  });
}

// An email an automation hands on: the automation is still on, still does
// this on its own, and the address is still one its sentence holds.
async function handOnRefusal(row: Row): Promise<string | null> {
  const { data: a } = await db.from("automations").select("text, enabled, mode").eq("id", String(row.automation_id ?? "")).maybeSingle();
  if (!a?.enabled || a.mode !== "own") return "The automation was turned off before it was sent";
  const { data: e } = await db.from("emails").select("subject, body_text, body_html").eq("id", row.email_id).maybeSingle();
  if (looksLikeInstructions(e?.subject as string, e?.body_text as string, e?.body_html as string)) return "The email looks like it is giving instructions to an AI";
  return checkHandOn({ to: row.to_addresses ?? [], cc: row.cc_addresses ?? [], bcc: row.bcc_addresses ?? [], typed: addressesIn(String(a.text)) });
}

// Keep a refused Autopilot reply as a draft and say so in History. One the
// user answered themselves is of no more use.
async function holdBack(row: Row, reason: string) {
  await db.from("scheduled_emails").update({ status: "cancelled", error_message: reason }).eq("id", row.id);
  if (reason === ANSWERED) {
    if (row.action_id) await db.from("action_log").update({ status: "blocked", reason, decided_at: new Date().toISOString() }).eq("id", row.action_id);
    return;
  }
  await db.from("draft_emails").insert({
    user_id: row.user_id, account_id: row.account_id, from_address: row.from_address, to_addresses: row.to_addresses, subject: row.subject, body_html: row.body_html, email_id: row.forward ? null : row.email_id, forward: row.forward, source: "tabellar",
  });
  if (row.action_id) {
    await db.from("action_log").update({ status: "blocked", reason: `${reason}; kept as a draft`, decided_at: new Date().toISOString() }).eq("id", row.action_id);
  }
}

export async function sendDueEmails(): Promise<void> {
  const { data: due } = await db
    .from("scheduled_emails")
    .select("*, accounts(*)")
    .eq("status", "pending")
    .lte("send_at", new Date().toISOString());
  for (const row of (due ?? []) as Row[]) {
    const claimed = await db.from("scheduled_emails").update({ status: "sending" }).eq("id", row.id).eq("status", "pending").select("id");
    if (!claimed.data?.length) continue;
    const autopilot = row.source === "autopilot";
    if (autopilot) {
      const why = await autopilotRefusal(row);
      if (why) {
        await holdBack(row, why);
        continue;
      }
    }
    const account = row.accounts as Account | null;
    try {
      if (!account?.token_ref) throw new Error("The account for this email is no longer connected");
      const from = await fromLine(row.user_id, account, row.from_address);
      const inReplyTo = await messageIdOf(account, row.in_reply_to);
      const m = await withForward(
        row.user_id,
        { from, to: row.to_addresses, cc: row.cc_addresses ?? undefined, bcc: row.bcc_addresses ?? undefined, subject: row.subject, html: row.body_html, inReplyTo, receipt: !!row.read_receipt },
        row.forward,
      );
      // A draft that is also in the mailbox's Drafts is sent from there, so it leaves Drafts.
      const result = row.gmail_draft_id
        ? await mail(account).sendDraft(account, row.gmail_draft_id, m, row.thread_id ?? undefined)
        : await mail(account).send(account, m, row.thread_id ?? undefined);
      await db.from("scheduled_emails").update({ status: "sent", error_message: null }).eq("id", row.id);
      await db.from("emails").upsert(
        {
          user_id: row.user_id,
          gmail_id: result.id,
          thread_id: row.thread_id,
          account_id: row.account_id,
          subject: row.subject,
          recipients: (row.to_addresses as string[]).join(", "),
          body_html: m.html,
          body_text: htmlToText(row.body_html),
          received_at: new Date().toISOString(),
          is_read: true,
          label_ids: ["SENT"],
          ...(row.read_receipt ? { receipt_asked: true, awaits_reply: true } : {}),
        },
        { onConflict: "user_id,gmail_id" },
      );
      await answered(row.user_id, row.thread_id, new Date().toISOString());
      if (autopilot && row.action_id) {
        const { data: a } = await db.from("action_log").select("detail").eq("id", row.action_id).maybeSingle();
        await db.from("action_log").update({ detail: { ...(a?.detail ?? {}), sentAt: new Date().toISOString() }, reason: row.forward ? "Sent by your automation" : "Sent by Autopilot" }).eq("id", row.action_id);
        notify({ title: "Tabellar", subtitle: row.forward ? "Forwarded by your automation" : "Autopilot sent a reply", body: `To ${(row.to_addresses as string[]).join(", ")}: ${row.subject}`, sent: String(row.id) });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (notSent(e) && Date.now() - new Date(row.send_at).getTime() < RETRY_FOR_MS) {
        await db.from("scheduled_emails").update({ status: "pending", error_message: "Waiting for the network" }).eq("id", row.id);
        continue;
      }
      console.error(`[scheduled] send failed for ${row.id}: ${msg}`);
      await db.from("scheduled_emails").update({ status: "failed", error_message: msg.slice(0, 500) }).eq("id", row.id);
      if (autopilot && row.action_id) await db.from("action_log").update({ status: "failed", error: msg.slice(0, 500) }).eq("id", row.action_id);
    }
  }
}
