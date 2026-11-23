// Carrying out actions, logging them, and undoing them.
//
// act() asks policy.decide() and then does the action, records it as a
// proposal waiting for approval, or records why it was refused. Every action
// that happens is a row in action_log, and labels, archives, drafts, todos and
// meeting proposals can be undone from there. An Autopilot reply is a row in
// scheduled_emails until its cancel window passes, and undo cancels it.

import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { batchModifyLabels, ensureLabel, modifyLabels } from "./gmail.ts";
import { decide, normalizeLevel, proposalHash, type AutoSend, type Kind, type Source } from "./policy.ts";
import { learn, type Signal } from "./profile.ts";

export type Planned = {
  kind: Kind;
  emailId: string | null;
  summary: string; // one line for the Activity list, e.g. "Label Important"
  detail: Record<string, unknown>;
};

export type Settings = { level: string; paused: boolean };

export async function engineSettings(userId: string): Promise<Settings> {
  const { data } = await db.from("profiles").select("autonomy_level, engine_paused").eq("id", userId).maybeSingle();
  return { level: normalizeLevel(data?.autonomy_level), paused: !!data?.engine_paused };
}

async function log(userId: string, p: Planned, row: Record<string, unknown>, id: string = randomUUID()) {
  const { data, error } = await db
    .from("action_log")
    .insert({ id, user_id: userId, kind: p.kind, email_id: p.emailId, summary: p.summary, detail: p.detail, ...row })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function emailWithToken(emailId: string) {
  const { data, error } = await db
    .from("emails")
    .select("id, gmail_id, label_ids, gmail_account_id, gmail_accounts(token_ref)")
    .eq("id", emailId)
    .single();
  if (error || !data) throw new Error("The email is no longer in Tabellar");
  const tokenRef = (data.gmail_accounts as { token_ref?: string } | null)?.token_ref;
  if (!tokenRef) throw new Error("The Gmail account for this email is no longer connected");
  return { ...data, tokenRef, labelIds: (data.label_ids as string[] | null) ?? [] };
}

function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

// Archive (or, undoing, return to the inbox) a batch of emails, grouped by
// the account each belongs to.
async function setArchived(userId: string, emailIds: string[], archived: boolean) {
  const { data } = await db
    .from("emails")
    .select("id, gmail_id, gmail_accounts(token_ref)")
    .eq("user_id", userId)
    .in("id", emailIds);
  const byAccount = new Map<string, { ids: string[]; gmailIds: string[] }>();
  for (const e of data ?? []) {
    const ref = (e.gmail_accounts as { token_ref?: string } | null)?.token_ref;
    if (!ref) continue;
    const g = byAccount.get(ref) ?? { ids: [], gmailIds: [] };
    g.ids.push(e.id as string);
    g.gmailIds.push(e.gmail_id as string);
    byAccount.set(ref, g);
  }
  for (const [ref, g] of byAccount) {
    await batchModifyLabels(ref, g.gmailIds, archived ? [] : ["INBOX"], archived ? ["INBOX"] : []);
    for (const id of g.ids) {
      const { data: row } = await db.from("emails").select("label_ids").eq("id", id).single();
      const labels = ((row?.label_ids as string[] | null) ?? []).filter((l) => l !== "INBOX");
      await db.from("emails").update({ is_archived: archived, label_ids: archived ? labels : ["INBOX", ...labels] }).eq("id", id);
    }
  }
}

// Make the change. Returns what undo will need (label id, row ids).
async function execute(userId: string, p: Planned, actionId: string): Promise<Record<string, unknown>> {
  const d = p.detail;
  if (p.kind === "archive" && Array.isArray(d.emailIds)) {
    await setArchived(userId, d.emailIds as string[], true);
    return {};
  }
  if (p.kind === "send") {
    // Only Autopilot reaches here (the window sends through /send-email), and
    // decide() has already checked the recipient. It waits out the cancel
    // window in scheduled_emails, where outbox.ts checks it again.
    const sendAt = new Date(Date.now() + Number(d.delayMinutes ?? 5) * 60_000).toISOString();
    const { data, error } = await db
      .from("scheduled_emails")
      .insert({
        user_id: userId, gmail_account_id: d.accountId, to_addresses: d.to, subject: d.subject, body_html: textToHtml(String(d.body)),
        body_text: d.body, in_reply_to: d.inReplyTo ?? null, thread_id: d.threadId, send_at: sendAt,
        source: "autopilot", email_id: p.emailId, action_id: actionId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { scheduledId: data.id, sendAt };
  }
  if (p.kind === "label" || p.kind === "archive") {
    const email = await emailWithToken(p.emailId!);
    if (p.kind === "label") {
      const labelId = await ensureLabel(email.tokenRef, String(d.label));
      const labels = await modifyLabels(email.tokenRef, email.gmail_id as string, [labelId], []);
      await db.from("emails").update({ label_ids: labels }).eq("id", email.id);
      return { labelId };
    }
    const labels = await modifyLabels(email.tokenRef, email.gmail_id as string, [], ["INBOX"]);
    await db.from("emails").update({ label_ids: labels, is_archived: true }).eq("id", email.id);
    return {};
  }
  if (p.kind === "draft") {
    const { data, error } = await db
      .from("draft_emails")
      .insert({ user_id: userId, to_addresses: d.to, subject: d.subject, body_html: textToHtml(String(d.body)), email_id: p.emailId, source: "tabellar" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { draftId: data.id };
  }
  if (p.kind === "todo") {
    const { data, error } = await db
      .from("todos")
      .insert({ user_id: userId, text: d.text, email_id: p.emailId, source: "tabellar" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { todoId: data.id };
  }
  if (p.kind === "meeting") {
    const { data, error } = await db
      .from("meetings")
      .insert({
        user_id: userId, email_id: p.emailId, title: d.title, description: d.description ?? null,
        start_time: d.start_time, end_time: d.end_time, location: d.location ?? null, status: "proposed",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { meetingId: data.id };
  }
  throw new Error(`Tabellar cannot carry out "${p.kind}" from the action log`);
}

// Decide, then do, propose or refuse. Refusals for Observe and pause are not
// logged (they are the normal state), every other outcome is.
export async function act(
  userId: string,
  p: Planned,
  ctx: Settings & { source: Source; suspicious?: boolean; todayCount?: number; cycleCount?: number; send?: AutoSend; sendCap?: number },
): Promise<"done" | "proposed" | "refused" | "failed"> {
  const decision = decide({ kind: p.kind, ...ctx });
  if (decision.verdict === "refuse") {
    if (!ctx.paused && normalizeLevel(ctx.level) !== "observe") {
      await log(userId, p, { status: "blocked", source: ctx.source, reason: decision.reason });
    }
    return "refused";
  }
  if (decision.verdict === "propose") {
    await log(userId, p, { status: "proposed", source: ctx.source, reason: decision.reason, hash: proposalHash(p.kind, p.emailId, p.detail) });
    return "proposed";
  }
  const id = randomUUID();
  try {
    // Log first, so a scheduled send already has its row to report back to.
    await log(userId, p, { status: "running", source: ctx.source, reason: decision.reason }, id);
    const undoInfo = await execute(userId, p, id);
    await db.from("action_log").update({ status: "done", detail: { ...p.detail, ...undoInfo }, decided_at: new Date().toISOString() }).eq("id", id);
    return "done";
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    const updated = await db.from("action_log").update({ status: "failed", error }).eq("id", id).select("id");
    if (!updated.data?.length) await log(userId, p, { status: "failed", source: ctx.source, error });
    return "failed";
  }
}

// Record something the user's window already did (an agent or assistant send),
// so the log covers it too. Sends cannot be undone.
export async function record(userId: string, p: Planned, source: Source): Promise<void> {
  await log(userId, p, { status: "done", source, decided_at: new Date().toISOString() });
}

async function loadRow(userId: string, id: string) {
  const { data } = await db.from("action_log").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw Object.assign(new Error("No such action"), { status: 404 });
  return data;
}

// Carry out a proposal that has been claimed (status "running").
async function carryOut(userId: string, row: Record<string, unknown>, reason: string): Promise<void> {
  const p: Planned = { kind: row.kind as Kind, emailId: row.email_id as string | null, summary: row.summary as string, detail: row.detail as Record<string, unknown> };
  try {
    const undoInfo = await execute(userId, p, row.id as string);
    await db.from("action_log").update({ status: "done", detail: { ...p.detail, ...undoInfo }, decided_at: new Date().toISOString(), reason }).eq("id", row.id);
  } catch (e) {
    await db.from("action_log").update({ status: "failed", error: (e as Error).message.slice(0, 500), decided_at: new Date().toISOString() }).eq("id", row.id);
    throw e;
  }
}

async function claim(id: string): Promise<boolean> {
  const claimed = await db.from("action_log").update({ status: "running" }).eq("id", id).eq("status", "proposed").select("id");
  return !!claimed.data?.length;
}

// Approve a proposal. `hash` is the one the window showed alongside the text;
// it has to match both the stored hash and a fresh hash of the stored detail.
export async function approve(userId: string, id: string, hash: string): Promise<void> {
  const row = await loadRow(userId, id);
  if (row.status !== "proposed") throw Object.assign(new Error("This proposal was already handled"), { status: 409 });
  const fresh = proposalHash(row.kind as string, row.email_id as string | null, row.detail);
  if (!hash || hash !== row.hash || hash !== fresh) {
    throw Object.assign(new Error("This proposal changed after you saw it. Reload Activity and look again."), { status: 409 });
  }
  const { paused } = await engineSettings(userId);
  const decision = decide({ kind: row.kind as string, source: "user", level: "suggest", paused });
  if (decision.verdict !== "do") throw Object.assign(new Error(decision.reason), { status: 409 });
  // Claim it first so a double click cannot run it twice.
  if (!(await claim(id))) throw Object.assign(new Error("This proposal was already handled"), { status: 409 });
  await carryOut(userId, row, "Approved");
  await learnFrom(userId, row, "approved");
}

// Approving, dismissing and undoing what the engine made teaches the profile.
async function learnFrom(userId: string, row: Record<string, unknown>, outcome: Signal["outcome"]): Promise<void> {
  const thing = row.kind as Signal["thing"];
  if (row.source !== "engine" || !["todo", "meeting", "draft"].includes(thing)) return;
  try {
    await learn(userId, { thing, outcome, emailId: row.email_id as string | null });
  } catch (e) {
    console.error("[actions] learn:", (e as Error).message);
  }
}

// Labels no longer wait for approval at Suggest. Labels proposed before that
// are carried out now, as the engine would label new mail.
export async function applyWaitingLabels(userId: string): Promise<number> {
  const settings = await engineSettings(userId);
  const decision = decide({ kind: "label", source: "engine", ...settings });
  if (decision.verdict !== "do") return 0;
  const { data } = await db.from("action_log").select("*").eq("user_id", userId).eq("kind", "label").eq("status", "proposed");
  let done = 0;
  for (const row of data ?? []) {
    if (!(await claim(row.id as string))) continue;
    try {
      await carryOut(userId, row, decision.reason);
      done++;
    } catch (e) {
      console.error("[actions] waiting label:", (e as Error).message);
    }
  }
  return done;
}

export async function dismiss(userId: string, id: string): Promise<void> {
  const res = await db.from("action_log").update({ status: "dismissed", decided_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId).eq("status", "proposed").select("id, kind, source, email_id");
  if (!res.data?.length) throw Object.assign(new Error("This proposal was already handled"), { status: 409 });
  await learnFrom(userId, res.data[0], "dismissed");
}

// Undo works while paused: pause stops Tabellar acting, not the user reversing.
export async function undo(userId: string, id: string): Promise<void> {
  const row = await loadRow(userId, id);
  if (row.status !== "done") throw Object.assign(new Error("Only completed actions can be undone"), { status: 409 });
  const d = row.detail as Record<string, unknown>;
  const kind = row.kind as string;
  if (kind === "send") {
    // Cancelling an Autopilot reply still inside its window.
    const res = await db.from("scheduled_emails").update({ status: "cancelled", error_message: "Cancelled" }).eq("id", String(d.scheduledId ?? "")).eq("user_id", userId).eq("status", "pending").select("id");
    if (!res.data?.length) throw Object.assign(new Error("This reply was already sent"), { status: 409 });
  } else if (kind === "archive" && Array.isArray(d.emailIds)) {
    await setArchived(userId, d.emailIds as string[], false);
  } else if (kind === "label" || kind === "archive") {
    const email = await emailWithToken(row.email_id as string);
    const labels = kind === "label"
      ? await modifyLabels(email.tokenRef, email.gmail_id as string, [], [String(d.labelId)])
      : await modifyLabels(email.tokenRef, email.gmail_id as string, ["INBOX"], []);
    await db.from("emails").update(kind === "archive" ? { label_ids: labels, is_archived: false } : { label_ids: labels }).eq("id", email.id);
  } else if (kind === "draft") {
    await db.from("draft_emails").delete().eq("id", String(d.draftId)).eq("user_id", userId);
  } else if (kind === "todo") {
    await db.from("todos").delete().eq("id", String(d.todoId)).eq("user_id", userId);
  } else if (kind === "meeting") {
    const gone = await db.from("meetings").delete().eq("id", String(d.meetingId)).eq("user_id", userId).eq("status", "proposed").select("id");
    if (!gone.data?.length) throw Object.assign(new Error("The meeting was already confirmed or removed; change it in Meetings"), { status: 409 });
  } else {
    throw Object.assign(new Error(`A ${kind} cannot be undone`), { status: 409 });
  }
  await db.from("action_log").update({ status: "undone", undone_at: new Date().toISOString() }).eq("id", id);
  await learnFrom(userId, row, "dismissed");
}
