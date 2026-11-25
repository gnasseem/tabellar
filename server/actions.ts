// Carrying out actions, logging them, and undoing them.
//
// act() asks policy.decide() and then does the action, records it as a
// proposal waiting for approval, or records why it was refused. Every action
// that happens is a row in action_log, and labels, archives, drafts, todos and
// meeting proposals can be undone from there. An Autopilot reply is a row in
// scheduled_emails until its cancel window passes, and undo cancels it.

import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { mail, userCalendar } from "./providers.ts";
import type { Account } from "./accounts.ts";
import { decide, normalizeLevel, proposalHash, type AutoSend, type HandOn, type Kind, type Source } from "./policy.ts";
import { learn, setPref, type Signal } from "./profile.ts";
import { discardDrafts, putInDrafts, textToHtml, threadDrafts } from "./drafts.ts";
import { snooze, unsnooze } from "./snooze.ts";
import { undone as automationUndone } from "./automations.ts";

export type Planned = {
  kind: Kind;
  emailId: string | null;
  summary: string; // one line for History, e.g. "Label Important"
  detail: Record<string, unknown>;
  automationId?: string; // the automation that does it
};

export type Settings = { level: string; paused: boolean };

export async function engineSettings(userId: string): Promise<Settings> {
  const { data } = await db.from("profiles").select("autonomy_level, engine_paused").eq("id", userId).maybeSingle();
  return { level: normalizeLevel(data?.autonomy_level), paused: !!data?.engine_paused };
}

async function log(userId: string, p: Planned, row: Record<string, unknown>, id: string = randomUUID()) {
  const { data, error } = await db
    .from("action_log")
    .insert({ id, user_id: userId, kind: p.kind, email_id: p.emailId, summary: p.summary, detail: p.detail, automation_id: p.automationId ?? null, ...row })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function emailWithAccount(emailId: string) {
  const { data, error } = await db
    .from("emails")
    .select("id, gmail_id, label_ids, account_id, accounts(*)")
    .eq("id", emailId)
    .single();
  if (error || !data) throw new Error("The email is no longer in Tabellar");
  const account = data.accounts as unknown as Account | null;
  if (!account?.token_ref) throw new Error("The account for this email is no longer connected");
  return { ...data, account, labelIds: (data.label_ids as string[] | null) ?? [] };
}

// Change one email's labels in its mailbox and in the stored copy.
async function relabel(email: Awaited<ReturnType<typeof emailWithAccount>>, add: string[], remove: string[], patch: Record<string, unknown> = {}) {
  await mail(email.account).modify(email.account, [email.gmail_id as string], add, remove);
  const labels = [...new Set([...email.labelIds.filter((l) => !remove.includes(l)), ...add])];
  await db.from("emails").update({ label_ids: labels, ...patch }).eq("id", email.id);
}

// Archive or return to the inbox, mark read or unread, a batch of emails: in
// the mailbox first, grouped by account, then in the stored copies. Mail
// changed here and mail changed in the mailbox itself end up the same way
// (sync.ts).
export async function setMailState(userId: string, emailIds: string[], state: { archived?: boolean; read?: boolean }) {
  const { data } = await db
    .from("emails")
    .select("id, gmail_id, label_ids, account_id, accounts(*)")
    .eq("user_id", userId)
    .in("id", emailIds);
  const add: string[] = [];
  const drop: string[] = [];
  if (state.archived !== undefined) (state.archived ? drop : add).push("INBOX");
  if (state.read !== undefined) (state.read ? drop : add).push("UNREAD");
  if (!add.length && !drop.length) return;
  const byAccount = new Map<string, typeof data>();
  for (const e of data ?? []) {
    if (!(e.accounts as Account | null)?.token_ref) continue;
    byAccount.set(String(e.account_id), [...(byAccount.get(String(e.account_id)) ?? []), e]);
  }
  for (const rows of byAccount.values()) {
    const account = rows![0].accounts as unknown as Account;
    await mail(account).modify(account, rows!.map((e) => e.gmail_id as string), add, drop);
    for (const e of rows!) {
      const labels = [...new Set([...((e.label_ids as string[] | null) ?? []).filter((l) => !drop.includes(l)), ...add])];
      const patch: Record<string, unknown> = { label_ids: labels };
      if (state.archived !== undefined) patch.is_archived = state.archived;
      // Archiving ends a snooze, and deals with an email back from one (snooze.ts).
      if (state.archived) Object.assign(patch, { is_snoozed: false, snooze_until: null });
      if (state.read !== undefined) patch.is_read = state.read;
      await db.from("emails").update(patch).eq("id", e.id);
    }
  }
}

// One of the user's labels on or off the stored email, beside its mailbox label.
async function ownLabel(emailId: string, slug: string, on: boolean): Promise<void> {
  const { data } = await db.from("email_processed").select("extra_labels").eq("email_id", emailId).maybeSingle();
  const extra = new Set((data?.extra_labels as string[] | null) ?? []);
  if (on) extra.add(slug);
  else extra.delete(slug);
  await db.from("email_processed").update({ extra_labels: [...extra] }).eq("email_id", emailId);
}

// Make the change. Returns what undo will need (label id, row ids).
async function execute(userId: string, p: Planned, actionId: string): Promise<Record<string, unknown>> {
  const d = p.detail;
  if ((p.kind === "archive" || p.kind === "read") && (Array.isArray(d.emailIds) || p.kind === "read")) {
    const ids = Array.isArray(d.emailIds) ? (d.emailIds as string[]) : [p.emailId!];
    await setMailState(userId, ids, p.kind === "archive" ? { archived: true } : { read: true });
    return {};
  }
  if (p.kind === "notify") return {}; // told by whoever planned it
  if (p.kind === "snooze") return { snoozed: await snooze(userId, [p.emailId!], (d.until as string | null) ?? null) };
  if (p.kind === "brief" && d.place === "digest") {
    await db.from("automations").update({ digest: { at: new Date().toISOString(), emails: d.emailIds } }).eq("id", p.automationId ?? "");
    return {};
  }
  if (p.kind === "brief") {
    const { data } = await db.from("email_processed").select("brief").eq("email_id", p.emailId!).maybeSingle();
    await db.from("email_processed").update({ brief: d.place }).eq("email_id", p.emailId!);
    return { before: data?.brief ?? null };
  }
  if (p.kind === "vip") {
    const { data: before } = await db.from("preferences").select("*").eq("user_id", userId).eq("kind", "sender").eq("subject", String(d.address));
    await setPref(userId, "sender", String(d.address), "vip", "automation", p.summary);
    return { before: before ?? [] };
  }
  if (p.kind === "send") {
    // Only Autopilot reaches here (the window sends through /send-email), and
    // decide() has already checked the recipient. It waits out the cancel
    // window in scheduled_emails, where outbox.ts checks it again.
    const sendAt = new Date(Date.now() + Number(d.delayMinutes ?? 5) * 60_000).toISOString();
    const { data, error } = await db
      .from("scheduled_emails")
      .insert({
        user_id: userId, account_id: d.accountId, from_address: d.from ?? null, to_addresses: d.to, subject: d.subject, body_html: textToHtml(String(d.body)),
        body_text: d.body, in_reply_to: d.inReplyTo ?? null, thread_id: d.threadId ?? null, send_at: sendAt,
        source: "autopilot", email_id: p.emailId, action_id: actionId, forward: d.forward ?? null, automation_id: p.automationId ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { scheduledId: data.id, sendAt };
  }
  if (p.kind === "label" || p.kind === "archive") {
    const email = await emailWithAccount(p.emailId!);
    if (p.kind === "label") {
      const labelId = await mail(email.account).label(email.account, String(d.label));
      await relabel(email, [labelId], []);
      if (d.slug) await ownLabel(p.emailId!, String(d.slug), true);
      return { labelId };
    }
    await relabel(email, [], ["INBOX"], { is_archived: true });
    return {};
  }
  if (p.kind === "draft" && d.forward) {
    // A conversation of its own, with the email it hands on.
    const { data, error } = await db
      .from("draft_emails")
      .insert({ user_id: userId, account_id: d.accountId ?? null, to_addresses: d.to, subject: d.subject, body_html: textToHtml(String(d.body ?? "")), source: "tabellar", forward: d.forward, written_from: d.writtenFrom ?? null })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { draftId: data.id };
  }
  if (p.kind === "draft") {
    // One draft per thread: the reply takes the place of an earlier one the
    // user has not changed, in the mailbox's Drafts too.
    const before = (await threadDrafts(userId, p.emailId)).filter((x) => x.source === "tabellar" && !x.edited_at);
    const { data, error } = await db
      .from("draft_emails")
      .insert({
        user_id: userId, account_id: d.accountId ?? null, from_address: d.from ?? null, to_addresses: d.to, subject: d.subject, body_html: textToHtml(String(d.body)), email_id: p.emailId, source: "tabellar",
        written_from: d.writtenFrom ?? null, gmail_draft_id: before[0]?.gmail_draft_id ?? null, mailbox_version: before[0]?.mailbox_version ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (before.length) await db.from("draft_emails").delete().eq("id", before[0].id);
    if (before.length > 1) await discardDrafts(userId, before.slice(1).map((x) => x.id));
    // Without the mailbox the draft is here, and the next sync puts it there.
    await putInDrafts(userId, data.id as string).catch((e) => console.error("[drafts] not in the mailbox yet:", (e as Error).message));
    return { draftId: data.id };
  }
  if (p.kind === "todo") {
    const { data, error } = await db
      .from("todos")
      .insert({ user_id: userId, text: d.text, due: d.due ?? null, email_id: p.emailId, source: "tabellar" })
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
        start_time: d.start_time, end_time: d.end_time, location: d.location ?? null, as_written: d.as_written ?? null, quote: d.quote ?? null, status: "proposed",
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
  ctx: Settings & { source: Source; suspicious?: boolean; todayCount?: number; cycleCount?: number; send?: AutoSend; sendCap?: number; own?: boolean; handOn?: HandOn; sentToday?: number },
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
async function carryOut(userId: string, row: Record<string, unknown>, reason: string): Promise<Record<string, unknown>> {
  const p: Planned = { kind: row.kind as Kind, emailId: row.email_id as string | null, summary: row.summary as string, detail: row.detail as Record<string, unknown>, automationId: (row.automation_id as string | null) ?? undefined };
  try {
    const undoInfo = await execute(userId, p, row.id as string);
    await db.from("action_log").update({ status: "done", detail: { ...p.detail, ...undoInfo }, decided_at: new Date().toISOString(), reason }).eq("id", row.id);
    return undoInfo;
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
// Returns what was made (todoId, meetingId, draftId).
export async function approve(userId: string, id: string, hash: string): Promise<Record<string, unknown>> {
  const row = await loadRow(userId, id);
  if (row.status !== "proposed") throw Object.assign(new Error("This proposal was already handled"), { status: 409 });
  const fresh = proposalHash(row.kind as string, row.email_id as string | null, row.detail);
  if (!hash || hash !== row.hash || hash !== fresh) {
    throw Object.assign(new Error("This proposal changed after you saw it. Reload and look again."), { status: 409 });
  }
  const { paused } = await engineSettings(userId);
  const decision = decide({ kind: row.kind as string, source: "user", level: "suggest", paused });
  if (decision.verdict !== "do") throw Object.assign(new Error(decision.reason), { status: 409 });
  // Claim it first so a double click cannot run it twice.
  if (!(await claim(id))) throw Object.assign(new Error("This proposal was already handled"), { status: 409 });
  const made = await carryOut(userId, row, "Approved");
  await learnFrom(userId, row, "approved");
  return made;
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
  const { data } = await db.from("action_log").select("*").eq("user_id", userId).eq("kind", "label").eq("status", "proposed").eq("source", "engine");
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

// What an action made, taken back.
async function takeBack(userId: string, row: Record<string, unknown>): Promise<void> {
  const d = row.detail as Record<string, unknown>;
  const kind = row.kind as string;
  if (kind === "send") {
    // Cancelling an Autopilot reply still inside its window.
    const res = await db.from("scheduled_emails").update({ status: "cancelled", error_message: "Cancelled" }).eq("id", String(d.scheduledId ?? "")).eq("user_id", userId).eq("status", "pending").select("*");
    if (!res.data?.length) throw Object.assign(new Error("This reply was already sent"), { status: 409 });
    // Its text is kept as a draft, to change and send.
    const s = res.data[0];
    await db.from("draft_emails").insert({ user_id: userId, account_id: s.account_id, from_address: s.from_address, to_addresses: s.to_addresses, subject: s.subject, body_html: s.body_html, email_id: s.forward ? null : s.email_id, forward: s.forward, source: "tabellar" });
  } else if (kind === "archive" && Array.isArray(d.emailIds)) {
    await setMailState(userId, d.emailIds as string[], { archived: false });
  } else if (kind === "read") {
    await setMailState(userId, Array.isArray(d.emailIds) ? (d.emailIds as string[]) : [String(row.email_id)], { read: false });
  } else if (kind === "snooze") {
    // Back from it already, there is nothing to take back.
    const { data: still } = await db.from("emails").select("id").eq("is_snoozed", true).in("id", (d.snoozed as string[] | undefined) ?? []);
    if (still?.length) await unsnooze(userId, still.map((e) => String(e.id)));
  } else if (kind === "brief" && d.place === "digest") {
    await db.from("automations").update({ digest: null }).eq("id", String(row.automation_id ?? ""));
  } else if (kind === "brief") {
    await db.from("email_processed").update({ brief: d.before ?? null }).eq("email_id", String(row.email_id));
  } else if (kind === "vip") {
    await db.from("preferences").delete().eq("user_id", userId).eq("kind", "sender").eq("subject", String(d.address)).eq("value", "vip");
    const had = (d.before as Record<string, unknown>[] | undefined) ?? [];
    if (had.length) await db.from("preferences").upsert(had, { onConflict: "user_id,kind,subject,value" });
  } else if (kind === "label" || kind === "archive") {
    const email = await emailWithAccount(row.email_id as string);
    if (kind === "label") {
      await relabel(email, [], [String(d.labelId)]);
      if (d.slug) await ownLabel(String(row.email_id), String(d.slug), false);
    } else await relabel(email, ["INBOX"], [], { is_archived: false });
  } else if (kind === "draft") {
    await discardDrafts(userId, [String(d.draftId)]);
  } else if (kind === "todo") {
    await db.from("todos").delete().eq("id", String(d.todoId)).eq("user_id", userId);
  } else if (kind === "meeting") {
    const gone = await db.from("meetings").delete().eq("id", String(d.meetingId)).eq("user_id", userId).eq("status", "proposed").select("id");
    if (!gone.data?.length) throw Object.assign(new Error("The meeting was already confirmed or removed; change it in Meetings"), { status: 409 });
  } else {
    throw Object.assign(new Error(`A ${kind} cannot be undone`), { status: 409 });
  }
}

// Undo works while paused: pause stops Tabellar acting, not the user reversing.
export async function undo(userId: string, id: string): Promise<void> {
  const row = await loadRow(userId, id);
  if (row.status !== "done") throw Object.assign(new Error("Only completed actions can be undone"), { status: 409 });
  await takeBack(userId, row);
  await db.from("action_log").update({ status: "undone", undone_at: new Date().toISOString() }).eq("id", id);
  await learnFrom(userId, row, "dismissed");
  if (row.automation_id) await automationUndone(userId, row);
}

// An approval that was a slip: what it made goes and the proposal waits again,
// as it was. It says nothing about what the user wants.
export async function unapprove(userId: string, before: Record<string, unknown>): Promise<void> {
  const row = await loadRow(userId, String(before.id));
  if (row.status === "done") await takeBack(userId, row);
  await db.from("action_log").update({ status: "proposed", detail: before.detail, reason: before.reason, decided_at: null, undone_at: null }).eq("id", row.id);
}

// Puts a meeting waiting to be confirmed on the calendar. Only the people the
// user added are invited. Returns the event's page, and what takes it off again.
export async function confirmMeeting(userId: string, id: string, changes: Record<string, unknown> = {}): Promise<{ link: string | null; undo: () => Promise<void> }> {
  const fail = (message: string, status: number) => Object.assign(new Error(message), { status });
  const { data: m } = await db.from("meetings").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!m) throw fail("That meeting is gone", 404);
  if (m.status === "confirmed" && m.calendar_event_id) return { link: null, undo: async () => {} };
  if (Object.keys(changes).length) await db.from("meetings").update(changes).eq("id", id);
  const meeting: Record<string, any> = { ...m, ...changes };
  const cal = await userCalendar(userId);
  if (!cal) throw fail("No calendar is connected. Connect a Google or Outlook account in Settings.", 502);
  const attendees = Array.isArray(meeting.attendees) ? (meeting.attendees as string[]) : [];
  let ev: { id: string; link: string | null };
  try {
    ev = await cal.calendar.create(
      cal.account,
      { title: meeting.title, description: meeting.description ?? "", start: meeting.start_time, end: meeting.end_time, ...(meeting.location ? { location: meeting.location } : {}), attendees },
      attendees.length > 0,
    );
  } catch {
    throw fail("The calendar did not accept it", 502);
  }
  await db.from("meetings").update({ status: "confirmed", calendar_event_id: ev.id }).eq("id", id);
  return {
    link: ev.link,
    undo: async () => {
      await cal.calendar.cancel(cal.account, ev.id, attendees.length > 0);
      await db.from("meetings").update({ status: "proposed", calendar_event_id: null }).eq("id", id);
    },
  };
}
