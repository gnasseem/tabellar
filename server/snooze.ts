// Snooze: an email leaves the inbox until a time, or until someone answers.
//
// In the mailbox a snoozed email is archived, so it is gone from the phone
// too, and it returns to the inbox, unread, when its time comes or when
// someone else writes in the thread, whichever is first. Tabellar's own timer
// (server.ts) brings it back; one that fell due while Tabellar was off returns
// at the next start. It is the user's order, so pausing does not hold it.
//
// Once back, snooze_until is when it came back: the email waits on the user
// until they archive it, mark it done, answer it or snooze it again.

import { db } from "./db.ts";
import { setMailState } from "./actions.ts";
import { displayName } from "./profile.ts";
import { notify } from "./notify.ts";

type Row = { id: string; thread_id: string | null; account_id: string | null; subject: string | null; sender: string | null; sender_email: string | null };
const ROW = "id, thread_id, account_id, subject, sender, sender_email";

// The given emails and the rest of their threads that are in the inbox.
async function inThread(userId: string, ids: string[]): Promise<string[]> {
  const { data } = await db.from("emails").select("id, thread_id").eq("user_id", userId).in("id", ids);
  const threads = [...new Set((data ?? []).map((e) => e.thread_id).filter(Boolean))] as string[];
  const out = new Set<string>((data ?? []).map((e) => String(e.id)));
  if (threads.length) {
    const { data: rest } = await db.from("emails").select("id").eq("user_id", userId).in("thread_id", threads).eq("is_archived", false).not("label_ids", "cs", '{"SENT"}');
    for (const e of rest ?? []) out.add(String(e.id));
  }
  return [...out];
}

// Snooze until a time, or until an answer when there is none. Returns every
// email that left the inbox, for undo.
export async function snooze(userId: string, emailIds: string[], until: string | null): Promise<string[]> {
  const at = until ? new Date(until) : null;
  if (at && !(at.getTime() > Date.now())) throw Object.assign(new Error("Pick a time that has not passed"), { status: 400 });
  const ids = await inThread(userId, emailIds);
  if (!ids.length) throw Object.assign(new Error("That email is no longer in Tabellar"), { status: 404 });
  await setMailState(userId, ids, { archived: true });
  await db.from("emails").update({ is_snoozed: true, snooze_until: at?.toISOString() ?? null, resolved_at: null }).in("id", ids);
  return ids;
}

// Back in the inbox now, as if it had not been snoozed (undo, or by hand).
export async function unsnooze(userId: string, emailIds: string[]): Promise<void> {
  await setMailState(userId, emailIds, { archived: false });
  await db.from("emails").update({ is_snoozed: false, snooze_until: null }).eq("user_id", userId).in("id", emailIds);
}

async function comeBack(userId: string, rows: Row[]): Promise<void> {
  const ids = rows.map((r) => r.id);
  await setMailState(userId, ids, { archived: false, read: false });
  await db.from("emails").update({ is_snoozed: false, snooze_until: new Date().toISOString() }).in("id", ids);
}

// Everything whose time has come. A mailbox that cannot be reached is tried
// again a minute later.
let retryAt = 0;
let waking = false;
export async function wakeDue(): Promise<void> {
  if (waking || Date.now() < retryAt) return;
  const { data } = await db.from("emails").select(`user_id, ${ROW}`).eq("is_snoozed", true).lte("snooze_until", new Date().toISOString()).order("received_at", { ascending: false });
  if (!data?.length) return;
  waking = true;
  try {
    const groups = new Map<string, (Row & { user_id: string })[]>();
    for (const r of data as (Row & { user_id: string })[]) {
      const key = `${r.account_id}|${r.thread_id || r.id}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const rows of groups.values()) {
      try {
        await comeBack(rows[0].user_id, rows);
      } catch (e) {
        retryAt = Date.now() + 60_000;
        console.error("[snooze] bringing an email back:", (e as Error).message);
        continue;
      }
      const { data: me } = await db.from("profiles").select("notification_level, notification_preview").eq("id", rows[0].user_id).maybeSingle();
      if (me?.notification_level === "none") continue;
      const r = rows[0];
      notify(me?.notification_preview === false ? { title: "Tabellar", body: "A snoozed email is back." } : { title: displayName(r.sender, r.sender_email ?? ""), subtitle: "Back from snooze", body: r.subject || "(no subject)" });
    }
  } finally {
    waking = false;
  }
}

// Someone wrote in these threads: what was snoozed in them comes back.
export async function wakeThreads(userId: string, threadIds: (string | null | undefined)[]): Promise<void> {
  const threads = [...new Set(threadIds.filter(Boolean))] as string[];
  if (!threads.length) return;
  const { data } = await db.from("emails").select(ROW).eq("user_id", userId).eq("is_snoozed", true).in("thread_id", threads);
  if (!data?.length) return;
  try {
    await comeBack(userId, data as Row[]);
  } catch (e) {
    console.error("[snooze] bringing an answered email back:", (e as Error).message);
    // The timer tries again.
    await db.from("emails").update({ snooze_until: new Date().toISOString() }).in("id", (data as Row[]).map((r) => r.id));
  }
}

// The user wrote in a thread: an email that came back before that is answered.
export async function answered(userId: string, threadId: string | null | undefined, at: string): Promise<void> {
  if (threadId) await db.from("emails").update({ snooze_until: null }).eq("user_id", userId).eq("is_snoozed", false).eq("thread_id", threadId).lte("snooze_until", at);
}

// Put everything snoozed back in the inbox, so nothing is left archived when
// an account is disconnected.
export async function unsnoozeAll(userId: string, accountId?: string): Promise<void> {
  let q = db.from("emails").select("id").eq("user_id", userId).eq("is_snoozed", true);
  if (accountId) q = q.eq("account_id", accountId);
  const { data } = await q;
  if (data?.length) await unsnooze(userId, data.map((e) => String(e.id)));
}
