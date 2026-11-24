// Before a meeting: the last thread with the people in it, and what is open
// between them and the user. The window shows it under a meeting (Meetings,
// the Brief); an hour before one, the engine tells the user with a
// notification, once, and only when there is something to say. Read from what
// Tabellar stores; no model call.

import { db } from "./db.ts";
import { userCalendar, type CalEvent } from "./providers.ts";
import { followupList } from "./followups.ts";
import { HOURS, inQuietHours, notify, type Hours } from "./notify.ts";
import { displayName } from "./profile.ts";
import { ownAddresses } from "./senders.ts";

const DAY = 86_400_000;
const AHEAD_MS = 60 * 60_000;
const WINDOW_DAYS = 60;

export type PrepLine = { key: string; kind: "reply" | "approve" | "todo" | "answer" | "waiting"; text: string; email_id: string | null };
export type Prep = { last: { email_id: string; who: string; subject: string; text: string; at: string; mine: boolean } | null; open: PrepLine[] };

type Row = Record<string, unknown>;
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const words = (s: string) => new Set(lc(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3 && !/^(meeting|call|with|sync|chat|zoom|weekly|daily)$/.test(w)));

export async function prepFor(userId: string, event: { title: string; people: string[] }): Promise<Prep> {
  const own = await ownAddresses(userId);
  const people = [...new Set(event.people.map(lc))].filter((p) => /^[^\s@,()"]+@[^\s@,()"]+$/.test(p) && !own.has(p)).slice(0, 20);
  if (!people.length) return { last: null, open: [] };
  const since = new Date(Date.now() - WINDOW_DAYS * DAY).toISOString();
  const SELECT = "id, thread_id, subject, sender, sender_email, recipients, snippet, received_at, label_ids, email_processed(summary, category)";
  const [{ data: from }, { data: to }] = await Promise.all([
    db.from("emails").select(SELECT).eq("user_id", userId).gte("received_at", since).eq("is_calendar", false).eq("is_receipt", false).not("label_ids", "cs", '{"SENT"}').or(people.map((p) => `sender_email.ilike.${p}`).join(",")).order("received_at", { ascending: false }).limit(60),
    db.from("emails").select(SELECT).eq("user_id", userId).gte("received_at", since).contains("label_ids", ["SENT"]).or(people.map((p) => `recipients.ilike.%${p}%`).join(",")).order("received_at", { ascending: false }).limit(60),
  ]);
  const theirs = (from ?? []) as Row[];
  const processed = (e: Row) => (Array.isArray(e.email_processed) ? e.email_processed[0] : e.email_processed) as Row | null;

  // The newest mail whose subject shares the most words with the meeting's title.
  const title = words(event.title);
  const all = [...theirs, ...((to ?? []) as Row[])].sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)));
  const shared = (e: Row) => [...words(String(e.subject ?? ""))].filter((w) => title.has(w)).length;
  const last = all.reduce<Row | null>((best, e) => (!best || shared(e) > shared(best) ? e : best), null);
  const mine = !!last && ((last.label_ids as string[] | null) ?? []).includes("SENT");

  // Open between them and the user.
  const ids = theirs.map((e) => String(e.id));
  const byId = new Map(theirs.map((e) => [String(e.id), e]));
  const [{ data: drafts }, { data: proposals }, { data: todos }, waiting, { data: names }] = await Promise.all([
    db.from("draft_emails").select("id, email_id, subject").eq("user_id", userId).in("email_id", ids),
    db.from("action_log").select("id, kind, email_id, detail").eq("user_id", userId).eq("status", "proposed").in("kind", ["draft", "todo"]).in("email_id", ids),
    db.from("todos").select("id, email_id, text").eq("user_id", userId).eq("is_completed", false).in("email_id", ids),
    followupList(userId).catch(() => []),
    db.from("senders").select("address, name").eq("user_id", userId).in("address", people),
  ]);
  const nameOf = new Map((names ?? []).map((n): [string, string] => [String(n.address), String(n.name || "")]));
  const open: PrepLine[] = [];
  const replied = new Set<string>();
  for (const d of (drafts ?? []) as Row[]) {
    replied.add(String(d.email_id));
    open.push({ key: `draft:${d.id}`, kind: "reply", text: `Reply not sent: ${byId.get(String(d.email_id))?.subject ?? d.subject ?? ""}`, email_id: String(d.email_id) });
  }
  for (const p of (proposals ?? []) as Row[]) {
    if (p.kind === "draft" && replied.has(String(p.email_id))) continue;
    if (p.kind === "draft") replied.add(String(p.email_id));
    open.push({ key: `act:${p.id}`, kind: "approve", text: p.kind === "draft" ? `Reply to approve: ${byId.get(String(p.email_id))?.subject ?? ""}` : `Todo to approve: ${String((p.detail as Row | null)?.text ?? "")}`, email_id: String(p.email_id) });
  }
  for (const t of (todos ?? []) as Row[]) open.push({ key: `todo:${t.id}`, kind: "todo", text: `Todo: ${t.text}`, email_id: (t.email_id as string) ?? null });
  // Mail of theirs that asked for something and that nobody answered since.
  const seen = new Set<string>();
  for (const e of theirs) {
    const thread = String(e.thread_id || e.id);
    if (seen.has(thread)) continue;
    seen.add(thread);
    if (processed(e)?.category !== "action-required" || replied.has(String(e.id)) || Date.now() - new Date(String(e.received_at)).getTime() > 14 * DAY) continue;
    const { count } = await db.from("emails").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("thread_id", thread).contains("label_ids", ["SENT"]).gt("received_at", e.received_at);
    if (!count) open.push({ key: `mail:${e.id}`, kind: "answer", text: `Not answered: ${e.subject || "(no subject)"}`, email_id: String(e.id) });
  }
  for (const w of waiting) if (people.includes(lc(w.recipient_email))) open.push({ key: `wait:${w.key}`, kind: "waiting", text: `Waiting on ${w.recipient_name.includes("@") ? nameOf.get(lc(w.recipient_email)) || w.recipient_name : w.recipient_name}: ${w.asked || w.subject}`, email_id: w.email_id || null });

  return {
    last: last && {
      email_id: String(last.id),
      who: mine ? "You" : displayName(last.sender as string, String(last.sender_email ?? "")),
      subject: String(last.subject || "(no subject)"),
      text: String(processed(last)?.summary || last.snippet || ""),
      at: String(last.received_at),
      mine,
    },
    open: open.slice(0, 6),
  };
}

// ── An hour before ──────────────────────────────────────────────────────────

// The calendar is read every ten minutes, for the next two hours.
const READ_MS = 10 * 60_000;
let upcoming: { at: number; events: CalEvent[] } = { at: 0, events: [] };

async function soon(userId: string): Promise<CalEvent[]> {
  if (Date.now() - upcoming.at > READ_MS) {
    upcoming.at = Date.now();
    const cal = await userCalendar(userId);
    upcoming.events = cal ? await cal.calendar.events(cal.account, new Date(), new Date(Date.now() + 2 * AHEAD_MS), 20) : [];
  }
  return upcoming.events;
}

const said = (minutes: number) => (minutes >= 55 ? "In an hour" : `In ${minutes} minutes`);

export async function tellMeetings(userId: string, events?: CalEvent[]): Promise<number> {
  const { data: me } = await db.from("profiles").select("notify_meetings, notification_level, notification_preview, notification_quiet, working_hours, meetings_told, onboarding").eq("id", userId).maybeSingle();
  if (!me || me.notify_meetings === false || me.notification_level === "none" || me.onboarding !== "done" || inQuietHours(me)) return 0;
  const told = (me.meetings_told as string[] | null) ?? [];
  let count = 0;
  for (const e of events ?? (await soon(userId))) {
    const left = e.start ? new Date(e.start).getTime() - Date.now() : -1;
    const key = `${e.id}|${e.start}`;
    if (e.allDay || left < 5 * 60_000 || left > AHEAD_MS || !e.people.length || told.includes(key)) continue;
    const prep = await prepFor(userId, e);
    told.push(key);
    await db.from("profiles").update({ meetings_told: told.slice(-50) }).eq("id", userId);
    if (!prep.last && !prep.open.length) continue;
    const others = e.attendees.length > 1 ? `${e.attendees[0]} and ${e.attendees.length - 1} more` : e.attendees[0];
    const lines = [
      prep.last && `${prep.last.who}, ${new Date(prep.last.at).toLocaleDateString("en-US", { weekday: "short", timeZone: ({ ...HOURS, ...((me.working_hours as Hours | null) ?? {}) } as Hours).timezone })}: ${prep.last.text || prep.last.subject}`.slice(0, 110),
      ...prep.open.slice(0, 2).map((o) => o.text.slice(0, 60)),
    ].filter(Boolean);
    const minutes = Math.round(left / 60_000);
    notify(me.notification_preview === false ? { title: "Tabellar", body: `${said(minutes)}: a meeting.` } : { title: e.title, subtitle: `${said(minutes)}${others ? `, with ${others}` : ""}`, body: lines.join("\n") });
    count++;
  }
  return count;
}
