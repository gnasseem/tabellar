// The Brief: what needs the user today, who they are waiting on, and what
// Tabellar handled since yesterday. Built from what the engine already
// decided and stored (drafts, proposals, meetings, todos, questions, the
// action log), never from a new model call, so every line is something that
// is there to act on. Today's calendar comes from /calendar/events.

import { db } from "./db.ts";
import { followupList } from "./followups.ts";
import { allPrefs, displayName, pick, stops } from "./profile.ts";

const NEED_MAX = 5;
const HANDLED_MAX = 200;
const DAY = 86_400_000;

export type NeedItem = {
  key: string;
  kind: "reply" | "approve" | "meeting" | "todo" | "question";
  who: string; // the person, or "Todo", or "Tabellar"
  text: string; // one line: what it is
  email_id: string | null;
  id: string; // the draft, action, meeting, todo or question
  hash?: string; // a proposal's hash, for approve
  start?: string; // a meeting's start
  due?: string; // a todo's day, YYYY-MM-DD
};

export type WaitingItem = { key: string; email_id: string; thread_id: string; who: string; address: string; text: string; subject: string; sent_at: string };

export type HandledItem = { email_id: string; who: string; subject: string; what: string; at: string };

export type Brief = { needs: NeedItem[]; more: number; waiting: WaitingItem[]; handled: HandledItem[]; at: string };

type Row = Record<string, unknown>;

// "YYYY-MM-DD" in the user's zone.
function dayIn(tz: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

const CATEGORY: Record<string, string> = { "action-required": "Action required", important: "Important", updates: "Updates", promotions: "Promotions" };

// A proposal in a line, about the thing rather than the person (the person
// is the line's first column).
function proposalText(p: Row, subject: string | undefined): string {
  const d = (p.detail as Row | null) ?? {};
  if (p.kind === "draft" || p.kind === "send") return `Reply to approve: ${subject ?? String(d.subject ?? "")}`;
  if (p.kind === "todo") return `Todo to approve: ${String(d.text ?? "")}`;
  if (p.kind === "meeting") return `Meeting to approve: ${String(d.title ?? "")}`;
  return String(p.summary ?? "");
}

export async function brief(userId: string): Promise<Brief> {
  const { data: profile } = await db.from("profiles").select("working_hours").eq("id", userId).maybeSingle();
  const tz = ((profile?.working_hours as { timezone?: string } | null)?.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = dayIn(tz);
  const since = new Date(Date.now() - DAY).toISOString();

  const [drafts, proposals, meetings, todos, questions, recent, prefs, waiting] = await Promise.all([
    db.from("draft_emails").select("id, email_id, subject, to_addresses, created_at").eq("user_id", userId).not("email_id", "is", null).order("created_at", { ascending: false }).limit(200),
    db.from("action_log").select("id, kind, email_id, summary, detail, hash, created_at").eq("user_id", userId).eq("status", "proposed").neq("kind", "label").order("created_at", { ascending: false }).limit(200),
    db.from("meetings").select("id, email_id, title, start_time, as_written").eq("user_id", userId).eq("status", "proposed").order("start_time", { ascending: true }).limit(100),
    db.from("todos").select("id, email_id, text, due").eq("user_id", userId).eq("is_completed", false).not("due", "is", null).lte("due", today).limit(200),
    db.from("questions").select("id, text, email_id").eq("user_id", userId).eq("status", "open").order("created_at", { ascending: true }),
    db
      .from("emails")
      .select("id, subject, sender, sender_email, received_at, label_ids, email_processed(category, calendar)")
      .eq("user_id", userId)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(1000),
    allPrefs(userId),
    followupList(userId).catch(() => []),
  ]);

  // The people the needs are about, by email.
  const ids = new Set<string>();
  for (const r of [...(drafts.data ?? []), ...(proposals.data ?? []), ...(meetings.data ?? []), ...(todos.data ?? [])] as Row[]) if (r.email_id) ids.add(String(r.email_id));
  const senders = new Map<string, { who: string; address: string; subject: string; received: string }>();
  const list = [...ids];
  for (let i = 0; i < list.length; i += 300) {
    const { data } = await db.from("emails").select("id, sender, sender_email, subject, received_at").in("id", list.slice(i, i + 300));
    for (const e of (data ?? []) as Row[]) {
      senders.set(String(e.id), { who: displayName(e.sender as string, String(e.sender_email ?? "")), address: String(e.sender_email ?? "").toLowerCase(), subject: String(e.subject || "(no subject)"), received: String(e.received_at ?? "") });
    }
  }
  const whoOf = (emailId: unknown) => senders.get(String(emailId ?? ""))?.who ?? "";
  const vip = (emailId: unknown) => pick(prefs, senders.get(String(emailId ?? ""))?.address ?? "", "").some((p) => p.value === "vip");

  // Ranked: an overdue todo, a meeting in the next day, a reply for someone
  // who matters, other replies and approvals, other meetings, todos due
  // today, then the questions. Newest first within each.
  type Ranked = NeedItem & { rank: number; at: string };
  const all: Ranked[] = [];
  const draftedEmails = new Set<string>();
  for (const d of (drafts.data ?? []) as Row[]) {
    draftedEmails.add(String(d.email_id));
    const s = senders.get(String(d.email_id));
    all.push({ key: `draft:${d.id}`, kind: "reply", who: s?.who || String((d.to_addresses as string[] | null)?.[0] ?? ""), text: `Reply drafted: ${s?.subject ?? String(d.subject ?? "")}`, email_id: String(d.email_id), id: String(d.id), rank: vip(d.email_id) ? 2 : 3, at: String(d.created_at) });
  }
  for (const p of (proposals.data ?? []) as Row[]) {
    if (p.kind === "draft" && draftedEmails.has(String(p.email_id))) continue;
    all.push({ key: `act:${p.id}`, kind: "approve", who: whoOf(p.email_id) || "Tabellar", text: proposalText(p, senders.get(String(p.email_id ?? ""))?.subject), email_id: (p.email_id as string) ?? null, id: String(p.id), hash: String(p.hash ?? ""), rank: vip(p.email_id) ? 2 : 3, at: String(p.created_at) });
  }
  const soon = Date.now() + DAY;
  for (const m of (meetings.data ?? []) as Row[]) {
    const start = String(m.start_time);
    if (new Date(start).getTime() < Date.now() - 3_600_000) continue; // already over
    all.push({ key: `meeting:${m.id}`, kind: "meeting", who: whoOf(m.email_id) || "Meeting", text: String(m.title ?? "Meeting"), email_id: (m.email_id as string) ?? null, id: String(m.id), start, rank: new Date(start).getTime() < soon ? 1 : 4, at: start });
  }
  for (const t of (todos.data ?? []) as Row[]) {
    const due = String(t.due);
    all.push({ key: `todo:${t.id}`, kind: "todo", who: whoOf(t.email_id) || "Todo", text: String(t.text), email_id: (t.email_id as string) ?? null, id: String(t.id), due, rank: due < today ? 0 : 5, at: due });
  }
  const open = (questions.data ?? []) as Row[];
  if (open.length) {
    const q = open[0];
    all.push({ key: `question:${q.id}`, kind: "question", who: "Tabellar", text: open.length === 1 ? String(q.text) : `${open.length} questions, the first: ${String(q.text)}`, email_id: (q.email_id as string) ?? null, id: String(q.id), rank: 6, at: "" });
  }
  all.sort((a, b) => a.rank - b.rank || (a.kind === "meeting" || a.kind === "todo" ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)));
  const needs = all.slice(0, NEED_MAX).map(({ rank: _rank, at: _at, ...n }) => n);
  const needIds = new Set(all.map((n) => n.email_id).filter(Boolean) as string[]);

  // Handled: mail of the last day that needs nothing from the user, with
  // what Tabellar did with it in words.
  const mail = ((recent.data ?? []) as Row[]).filter((e) => {
    const labels = (e.label_ids as string[] | null) ?? [];
    if (labels.includes("SENT") || needIds.has(String(e.id))) return false;
    const raw = e.email_processed as Row | Row[] | null;
    if (!(Array.isArray(raw) ? raw[0] : raw)) return false; // not read yet
    return !stops(pick(prefs, String(e.sender_email ?? ""), String(e.subject ?? "")), "briefing");
  });
  const done = new Map<string, string[]>();
  const mailIds = mail.map((e) => String(e.id));
  for (let i = 0; i < mailIds.length; i += 300) {
    const { data } = await db.from("action_log").select("email_id, kind, summary, detail").eq("user_id", userId).eq("status", "done").in("email_id", mailIds.slice(i, i + 300));
    for (const r of (data ?? []) as Row[]) {
      const d = (r.detail as Row | null) ?? {};
      const words =
        r.kind === "label" ? String(d.label ?? "").replace(/^Tabellar\//, "") : r.kind === "todo" ? "Todo added" : r.kind === "archive" ? "Archived" : r.kind === "send" ? "Replied" : r.kind === "meeting" ? "Meeting proposed" : r.kind === "unsubscribe" ? "Unsubscribed" : "";
      if (!words) continue;
      const list = done.get(String(r.email_id)) ?? [];
      if (!list.includes(words)) list.push(words);
      done.set(String(r.email_id), list);
    }
  }
  const handled: HandledItem[] = mail.slice(0, HANDLED_MAX).map((e) => {
    const raw = e.email_processed as Row | Row[] | null;
    const p = (Array.isArray(raw) ? raw[0] : raw) as Row;
    const cal = p.calendar as Row | null;
    const words = done.get(String(e.id)) ?? [];
    if (cal) words.unshift(cal.method === "CANCEL" ? "Cancelled event" : cal.on_calendar ? "On calendar" : "Invitation");
    if (!words.length) words.push(CATEGORY[String(p.category)] ?? "Sorted");
    return { email_id: String(e.id), who: displayName(e.sender as string, String(e.sender_email ?? "")), subject: String(e.subject || "(no subject)"), what: words.slice(0, 2).join(", "), at: String(e.received_at) };
  });

  return {
    needs,
    more: Math.max(0, all.length - NEED_MAX),
    waiting: waiting.map((f) => ({ key: f.key, email_id: f.email_id, thread_id: f.thread_id, who: f.recipient_name, address: f.recipient_email, text: f.asked || f.subject, subject: f.subject, sent_at: f.sent_at })),
    handled,
    at: new Date().toISOString(),
  };
}
