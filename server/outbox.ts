// Sending what is due in scheduled_emails: the user's undo-send and send-later,
// and Autopilot's replies once their cancel window has passed.
//
// A row is claimed by moving it out of "pending" before sending, so a slow
// send is never picked up twice. An Autopilot row is checked again when it
// falls due, against the stored email it answers: if Tabellar was paused or
// taken off Autopilot in the meantime, or the reply no longer passes
// checkAutoSend, it is not sent and is kept as a draft instead.

import { db } from "./db.ts";
import { sendEmail } from "./gmail.ts";
import { checkAutoSend } from "./policy.ts";
import { engineSettings } from "./actions.ts";
import { notify } from "./notify.ts";

// `tabellar check` swaps this for a recorder so nothing reaches Gmail.
export const transport = { send: sendEmail };

type Row = Record<string, any>;

async function autopilotRefusal(row: Row): Promise<string | null> {
  const { level, paused } = await engineSettings(row.user_id);
  if (paused) return "Tabellar was paused before it was sent";
  if (level !== "autopilot") return "Autopilot was turned off before it was sent";
  if (!row.email_id) return "The email it answered is no longer in Tabellar";
  const { data: email } = await db.from("emails").select("sender_email, reply_to_email, thread_id").eq("id", row.email_id).maybeSingle();
  if (!email) return "The email it answered is no longer in Tabellar";
  if (email.thread_id !== row.thread_id) return "The reply is not in the thread of the email it answers";
  return checkAutoSend({
    to: (row.to_addresses as string[]) ?? [],
    cc: (row.cc_addresses as string[] | null) ?? [],
    bcc: (row.bcc_addresses as string[] | null) ?? [],
    threadId: row.thread_id,
    writer: String(email.reply_to_email || email.sender_email || ""),
  });
}

// Keep a refused Autopilot reply as a draft and say so in Activity.
async function holdBack(row: Row, reason: string) {
  await db.from("scheduled_emails").update({ status: "cancelled", error_message: reason }).eq("id", row.id);
  await db.from("draft_emails").insert({
    user_id: row.user_id, to_addresses: row.to_addresses, subject: row.subject, body_html: row.body_html, email_id: row.email_id, source: "tabellar",
  });
  if (row.action_id) {
    await db.from("action_log").update({ status: "blocked", reason: `${reason}; kept as a draft`, decided_at: new Date().toISOString() }).eq("id", row.action_id);
  }
}

export async function sendDueEmails(): Promise<void> {
  const { data: due } = await db
    .from("scheduled_emails")
    .select("*, gmail_accounts(token_ref)")
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
    const tokenRef = (row.gmail_accounts as { token_ref?: string } | null)?.token_ref;
    try {
      if (!tokenRef) throw new Error("The Gmail account for this email is no longer connected");
      const result = await transport.send(tokenRef, row.to_addresses, row.subject, row.body_html, row.in_reply_to ?? undefined, row.thread_id ?? undefined, undefined, row.cc_addresses ?? undefined, row.bcc_addresses ?? undefined);
      await db.from("scheduled_emails").update({ status: "sent" }).eq("id", row.id);
      await db.from("emails").upsert(
        {
          user_id: row.user_id,
          gmail_id: result.id,
          thread_id: row.thread_id,
          gmail_account_id: row.gmail_account_id,
          subject: row.subject,
          recipients: (row.to_addresses as string[]).join(", "),
          body_html: row.body_html,
          received_at: new Date().toISOString(),
          is_read: true,
          label_ids: ["SENT"],
        },
        { onConflict: "user_id,gmail_id" },
      );
      if (autopilot && row.action_id) {
        const { data: a } = await db.from("action_log").select("detail").eq("id", row.action_id).maybeSingle();
        await db.from("action_log").update({ detail: { ...(a?.detail ?? {}), sentAt: new Date().toISOString() }, reason: "Sent by Autopilot" }).eq("id", row.action_id);
        notify({ title: "Tabellar", subtitle: "Autopilot sent a reply", body: `To ${(row.to_addresses as string[]).join(", ")}: ${row.subject}` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[scheduled] send failed for ${row.id}: ${msg}`);
      await db.from("scheduled_emails").update({ status: "failed", error_message: msg.slice(0, 500) }).eq("id", row.id);
      if (autopilot && row.action_id) await db.from("action_log").update({ status: "failed", error: msg.slice(0, 500) }).eq("id", row.action_id);
    }
  }
}
