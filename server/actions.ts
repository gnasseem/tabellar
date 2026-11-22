// Carrying out actions, logging them, and undoing them.
//
// act() asks policy.decide() and then does the action, records it as a
// proposal waiting for approval, or records why it was refused. Every action
// that happens is a row in action_log, and labels, archives, drafts, todos and
// meeting proposals can be undone from there.

import { db } from "./db.ts";
import { ensureLabel, modifyLabels } from "./gmail.ts";
import { decide, normalizeLevel, proposalHash, type Kind, type Source } from "./policy.ts";

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

async function log(userId: string, p: Planned, row: Record<string, unknown>) {
  const { data, error } = await db
    .from("action_log")
    .insert({ user_id: userId, kind: p.kind, email_id: p.emailId, summary: p.summary, detail: p.detail, ...row })
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

// Make the change. Returns what undo will need (label id, row ids).
async function execute(userId: string, p: Planned): Promise<Record<string, unknown>> {
  const d = p.detail;
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
  ctx: Settings & { source: Source; suspicious?: boolean; todayCount?: number; cycleCount?: number },
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
  try {
    const undoInfo = await execute(userId, p);
    await log(userId, { ...p, detail: { ...p.detail, ...undoInfo } }, { status: "done", source: ctx.source, reason: decision.reason, decided_at: new Date().toISOString() });
    return "done";
  } catch (e) {
    await log(userId, p, { status: "failed", source: ctx.source, error: (e as Error).message.slice(0, 500) });
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
  const claimed = await db.from("action_log").update({ status: "running" }).eq("id", id).eq("status", "proposed").select("id");
  if (!claimed.data?.length) throw Object.assign(new Error("This proposal was already handled"), { status: 409 });
  const p: Planned = { kind: row.kind as Kind, emailId: row.email_id as string | null, summary: row.summary as string, detail: row.detail as Record<string, unknown> };
  try {
    const undoInfo = await execute(userId, p);
    await db.from("action_log").update({ status: "done", detail: { ...p.detail, ...undoInfo }, decided_at: new Date().toISOString(), reason: "Approved" }).eq("id", id);
  } catch (e) {
    await db.from("action_log").update({ status: "failed", error: (e as Error).message.slice(0, 500), decided_at: new Date().toISOString() }).eq("id", id);
    throw e;
  }
}

export async function dismiss(userId: string, id: string): Promise<void> {
  const res = await db.from("action_log").update({ status: "dismissed", decided_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId).eq("status", "proposed").select("id");
  if (!res.data?.length) throw Object.assign(new Error("This proposal was already handled"), { status: 409 });
}

// Undo works while paused: pause stops Tabellar acting, not the user reversing.
export async function undo(userId: string, id: string): Promise<void> {
  const row = await loadRow(userId, id);
  if (row.status !== "done") throw Object.assign(new Error("Only completed actions can be undone"), { status: 409 });
  const d = row.detail as Record<string, unknown>;
  const kind = row.kind as string;
  if (kind === "label" || kind === "archive") {
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
}
