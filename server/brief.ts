// The Brief: what needs the user today, who they are waiting on, and what
// Tabellar handled since yesterday. Built from what the engine already
// decided and stored (drafts, proposals, meetings, todos, questions, the
// action log), so every line is something that is there to act on. Today's
// calendar comes from /calendar/events.
//
// Each line that needs the user, and each person they wait on, carries its
// answers (answers.ts), so nothing has to be opened to deal with it.
//
// profiles.brief holds the settings: the time of day a new Brief starts, how
// long it is, which sections it has, whether a notification with its first
// three lines goes out then, and an optional opening paragraph with
// its tone. The paragraph is one model call, made at that time from the
// same lines and kept in profiles.brief_summary.

import { db } from "./db.ts";
import { briefParagraph } from "./ai.ts";
import type { Away } from "./awake.ts";
import { modelConfigured } from "./llm.ts";
import { options, type Options } from "./answers.ts";
import { draftsKept } from "./drafts.ts";
import { normalizeLevel } from "./policy.ts";
import { followupList } from "./followups.ts";
import { inQuietHours, notify, wallClock, minutes, type Hours } from "./notify.ts";
import { allPrefs, displayName, pick, stops } from "./profile.ts";

const HANDLED_MAX = 200;
const DAY = 86_400_000;

// ── Settings ────────────────────────────────────────────────────────────────

export const SECTIONS = ["needs", "waiting", "calendar", "handled"] as const;
const LENGTHS = { short: { needs: 3, waiting: 3 }, standard: { needs: 5, waiting: 5 }, long: { needs: 10, waiting: 10 } };
export const TONES: Record<string, string> = {
  plain: "Plain and factual.",
  warm: "Warm and friendly, like a good assistant, without flattery.",
  blunt: "Blunt: short sentences, the most pressing thing first, nothing else.",
};

export type BriefSettings = { time: string; length: keyof typeof LENGTHS; sections: string[]; summary: boolean; tone: string; notify: boolean };

export function briefSettings(stored: unknown): BriefSettings {
  const b = (stored ?? {}) as Partial<BriefSettings>;
  return {
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time)) ? String(b.time) : "08:00",
    length: b.length && b.length in LENGTHS ? b.length : "standard",
    sections: Array.isArray(b.sections) ? SECTIONS.filter((s) => b.sections!.includes(s)) : [...SECTIONS],
    summary: b.summary !== false,
    tone: b.tone && b.tone in TONES ? b.tone : "plain",
    notify: b.notify !== false,
  };
}

const zoneOf = (profile: Record<string, unknown> | null | undefined) => (profile?.working_hours as Hours | null)?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// The day today's Brief belongs to, in the user's zone, whether its time
// has come and how many minutes ago. `since` is the same time the day before: what was handled counts
// from there, so a Brief always covers a whole night.
export function briefDay(settings: BriefSettings, tz: string, at = new Date()): { day: string; due: boolean; past: number; since: string } {
  const now = wallClock(tz, at);
  const past = now.minute - minutes(settings.time);
  return { day: now.day, due: past >= 0, past, since: new Date(at.getTime() - past * 60_000 - DAY).toISOString() };
}

// ── The lines ───────────────────────────────────────────────────────────────

export type NeedItem = Options & {
  key: string;
  kind: "reply" | "forward" | "approve" | "meeting" | "todo" | "question" | "back" | "read" | "proof";
  who: string; // the person, or "Todo", or "Tabellar"
  text: string; // one line: what it is
  email_id: string | null;
  id: string; // the draft, action, meeting, todo or question
  start?: string; // a meeting's start
  due?: string; // a todo's day, YYYY-MM-DD
};

export type WaitingItem = Options & { key: string; email_id: string; thread_id: string; who: string; address: string; text: string; subject: string; sent_at: string };

export type HandledItem = { email_id: string; who: string; subject: string; what: string; at: string };

// The mail an automation gathered at its time.
export type Digest = { id: string; title: string; at: string; items: { email_id: string; who: string; text: string; at: string }[] };

// What was put on the calendar, moved or taken off by mail.
export type Change = { id: string; text: string; email_id: string | null; at: string };
export type Brief = { settings: BriefSettings; changes: Change[]; away: string | null; summary: string | null; digests: Digest[]; needs: NeedItem[]; more: number; proof: NeedItem | null; waiting: WaitingItem[]; waitingMore: number; handled: HandledItem[]; day: string; at: string };

type Row = Record<string, unknown>;

const CATEGORY: Record<string, string> = { "action-required": "Action required", important: "Important", updates: "Updates", promotions: "Promotions" };

// A proposal in a line, about the thing rather than the person (the person
// is the line's first column).
function proposalText(p: Row, subject: string | undefined): string {
  const d = (p.detail as Row | null) ?? {};
  if (p.kind === "draft" && d.forward) return `Forward to approve: ${String(d.subject ?? "")}`;
  if (p.kind === "draft" || p.kind === "send") return `Reply to approve: ${subject ?? String(d.subject ?? "")}`;
  if (p.kind === "todo") return `Todo to approve: ${String(d.text ?? "")}`;
  if (p.kind === "meeting") return `Meeting to approve: ${String(d.title ?? "")}`;
  return subject && ["archive", "read", "snooze", "label", "vip"].includes(String(p.kind)) ? `${String(p.summary)}: ${subject}` : String(p.summary ?? "");
}

// The lines past its length are counted; `all` lists them too.
const ALL_MAX = 100;
export async function brief(userId: string, { all: every = false } = {}): Promise<Brief> {
  const { data: profile } = await db.from("profiles").select("working_hours, brief, brief_summary, autonomy_level, proof, away").eq("id", userId).maybeSingle();
  const settings = briefSettings(profile?.brief);
  const { day: today, since } = briefDay(settings, zoneOf(profile));
  const written = profile?.brief_summary as Summary | null;
  const max = LENGTHS[settings.length];

  const [drafts, proposals, meetings, todos, questions, recent, prefs, owed, back, hidden, unread, placed, gathered, events, leaving] = await Promise.all([
    db.from("draft_emails").select("id, email_id, subject, to_addresses, forward, created_at").eq("user_id", userId).or("email_id.not.is.null,forward.not.is.null").order("created_at", { ascending: false }).limit(200),
    db.from("action_log").select("id, kind, email_id, summary, detail, hash, created_at").eq("user_id", userId).eq("status", "proposed").or("kind.neq.label,source.eq.automation").order("created_at", { ascending: false }).limit(200),
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
    db.from("emails").select("id, subject, sender, sender_email, snooze_until").eq("user_id", userId).eq("is_snoozed", false).eq("is_archived", false).not("snooze_until", "is", null).is("resolved_at", null).limit(100),
    db.from("emails").select("id").eq("user_id", userId).eq("is_snoozed", true),
    db.from("emails").select("id, subject, sender, sender_email, received_at, email_processed(summary)").eq("user_id", userId).eq("is_read", false).eq("is_archived", false).eq("is_calendar", false).gte("received_at", new Date(Date.now() - 7 * DAY).toISOString()).not("label_ids", "cs", '{"SENT"}').order("received_at", { ascending: false }).limit(500),
    db.from("email_processed").select("email_id, brief").eq("user_id", userId).not("brief", "is", null).order("processed_at", { ascending: false }).limit(2000),
    db.from("automations").select("id, text, digest").eq("user_id", userId).not("digest", "is", null),
    db.from("action_log").select("id, summary, email_id, created_at").eq("user_id", userId).eq("kind", "event").eq("status", "done").gte("created_at", since).order("created_at", { ascending: false }).limit(20),
    db.from("scheduled_emails").select("thread_id").eq("user_id", userId).eq("status", "pending"),
  ]);
  // Where an automation put an email: first, or out of the Brief.
  const place = new Map<string, string>(((placed.data ?? []) as Row[]).map((r) => [String(r.email_id), String(r.brief)]));
  // Nothing about a snoozed email shows until it is back.
  const snoozed = new Set((hidden.data ?? []).map((e) => String(e.id)));
  for (const r of [drafts, proposals, meetings]) r.data = ((r.data ?? []) as Row[]).filter((x) => !snoozed.has(String(x.email_id ?? "")) && place.get(String(x.email_id ?? "")) !== "out");

  // The people the needs are about, by email.
  const ids = new Set<string>();
  for (const r of [...(drafts.data ?? []), ...(proposals.data ?? []), ...(meetings.data ?? []), ...(todos.data ?? [])] as Row[]) if (r.email_id) ids.add(String(r.email_id));
  const senders = new Map<string, { who: string; address: string; subject: string; received: string; own: boolean; thread: string }>();
  const list = [...ids];
  for (let i = 0; i < list.length; i += 300) {
    const { data } = await db.from("emails").select("id, sender, sender_email, recipients, subject, received_at, label_ids, thread_id").in("id", list.slice(i, i + 300));
    for (const e of (data ?? []) as Row[]) {
      // On the user's own mail it is about the one it went to.
      const own = ((e.label_ids as string[] | null) ?? []).includes("SENT");
      const to = String(e.recipients ?? "").split(",")[0].trim();
      senders.set(String(e.id), { own, thread: String(e.thread_id ?? ""), who: own ? displayName(to, to) : displayName(e.sender as string, String(e.sender_email ?? "")), address: String(e.sender_email ?? "").toLowerCase(), subject: String(e.subject || "(no subject)"), received: String(e.received_at ?? "") });
    }
  }
  const whoOf = (emailId: unknown) => senders.get(String(emailId ?? ""))?.who ?? "";
  const vip = (emailId: unknown) => pick(prefs, senders.get(String(emailId ?? ""))?.address ?? "", "").some((p) => p.value === "vip");

  // Ranked: an overdue todo, a meeting in the next day, a reply for someone
  // who matters and mail back from snooze, unread mail from someone who
  // matters, other replies and approvals, other meetings, todos due today,
  // then the questions. Newest first within each.
  type Ranked = Omit<NeedItem, keyof Options> & { rank: number; at: string };
  const all: Ranked[] = [];
  const draftedEmails = new Set<string>();
  for (const d of (drafts.data ?? []) as Row[]) {
    const handsOn = (d.forward as { email_id?: string } | null)?.email_id;
    if (handsOn) {
      all.push({ key: `draft:${d.id}`, kind: "forward", who: String((d.to_addresses as string[] | null)?.[0] ?? ""), text: `Forward drafted: ${String(d.subject ?? "")}`, email_id: handsOn, id: String(d.id), rank: 3, at: String(d.created_at) });
      continue;
    }
    if (!d.email_id) continue;
    draftedEmails.add(String(d.email_id));
    const s = senders.get(String(d.email_id));
    all.push({ key: `draft:${d.id}`, kind: "reply", who: s?.who || String((d.to_addresses as string[] | null)?.[0] ?? ""), text: `${s?.own ? "Follow-up" : "Reply"} drafted: ${s?.subject ?? String(d.subject ?? "")}`, email_id: String(d.email_id), id: String(d.id), rank: vip(d.email_id) ? 2 : 3, at: String(d.created_at) });
  }
  for (const p of (proposals.data ?? []) as Row[]) {
    if (p.kind === "draft" && draftedEmails.has(String(p.email_id))) continue;
    all.push({ key: `act:${p.id}`, kind: "approve", who: whoOf(p.email_id) || "Tabellar", text: proposalText(p, senders.get(String(p.email_id ?? ""))?.subject), email_id: (p.email_id as string) ?? null, id: String(p.id), rank: vip(p.email_id) ? 2 : 3, at: String(p.created_at) });
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
  // One line per thread is enough: mail with a line of its own already is not repeated.
  const listed = new Set(all.map((n) => n.email_id));
  for (const e of (back.data ?? []) as Row[]) {
    if (listed.has(String(e.id))) continue;
    listed.add(String(e.id));
    all.push({ key: `back:${e.id}`, kind: "back", who: displayName(e.sender as string, String(e.sender_email ?? "")), text: `Back from snooze: ${e.subject || "(no subject)"}`, email_id: String(e.id), id: String(e.id), rank: 2, at: String(e.snooze_until) });
  }
  const matters = (address: unknown) => pick(prefs, String(address ?? "").toLowerCase(), "").some((p) => p.value === "vip");
  for (const e of (unread.data ?? []) as Row[]) {
    const at = place.get(String(e.id));
    if (listed.has(String(e.id)) || at === "out" || (at !== "first" && !matters(e.sender_email))) continue;
    const p = (Array.isArray(e.email_processed) ? e.email_processed[0] : e.email_processed) as Row | null;
    all.push({ key: `read:${e.id}`, kind: "read", who: displayName(e.sender as string, String(e.sender_email ?? "")), text: String(p?.summary || e.subject || "(no subject)"), email_id: String(e.id), id: String(e.id), rank: 2.5, at: String(e.received_at) });
  }
  for (const n of all) if (n.email_id && place.get(n.email_id) === "first") n.rank = -1;
  // Who owes the user an answer: their most important people first, then the longest wait.
  // One with a follow-up drafted or on its way is a line of its own, or none.
  const chased = new Set([...[...draftedEmails].map((id) => senders.get(id)?.thread), ...(leaving.data ?? []).map((r) => r.thread_id)].filter(Boolean).map(String));
  const waiting = owed.filter((f) => !chased.has(f.thread_id));
  waiting.sort((a, b) => Number(matters(b.recipient_email)) - Number(matters(a.recipient_email)));

  all.sort((a, b) => a.rank - b.rank || (a.kind === "meeting" || a.kind === "todo" ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)));
  const length = every ? ALL_MAX : max.needs;
  const needs: NeedItem[] = [];
  for (const { rank: _rank, at: _at, ...n } of all.slice(0, length)) {
    const o = await options(userId, n.key);
    if (o) needs.push({ ...n, ...o });
  }
  const waits: WaitingItem[] = [];
  for (const f of waiting.slice(0, max.waiting)) {
    const o = await options(userId, `wait:${f.key}`);
    if (o) waits.push({ key: `wait:${f.key}`, email_id: f.email_id, thread_id: f.thread_id, who: f.recipient_name, address: f.recipient_email, text: f.asked || f.subject, subject: f.subject, sent_at: f.sent_at, ...o });
  }
  const needIds = new Set(all.map((n) => n.email_id).filter(Boolean) as string[]);

  // Handled: mail of the last day that needs nothing from the user, with
  // what Tabellar did with it in words.
  const mail = ((recent.data ?? []) as Row[]).filter((e) => {
    const labels = (e.label_ids as string[] | null) ?? [];
    if (labels.includes("SENT") || needIds.has(String(e.id)) || place.get(String(e.id)) === "out") return false;
    const raw = e.email_processed as Row | Row[] | null;
    if (!(Array.isArray(raw) ? raw[0] : raw)) return false; // not read yet
    return !stops(pick(prefs, String(e.sender_email ?? ""), String(e.subject ?? "")), "briefing");
  });
  const done = new Map<string, string[]>();
  const acted = new Set<string>();
  const mailIds = mail.map((e) => String(e.id));
  for (let i = 0; i < mailIds.length; i += 300) {
    const { data } = await db.from("action_log").select("email_id, kind, summary, detail").eq("user_id", userId).eq("status", "done").in("email_id", mailIds.slice(i, i + 300));
    for (const r of (data ?? []) as Row[]) {
      const d = (r.detail as Row | null) ?? {};
      const words =
        r.kind === "label" ? String(d.label ?? "").replace(/^Tabellar\//, "") : r.kind === "todo" ? "Todo added" : r.kind === "archive" ? "Archived" : r.kind === "send" ? "Replied" : r.kind === "meeting" ? "Meeting proposed" : r.kind === "unsubscribe" ? "Unsubscribed" : r.kind === "snooze" ? "Snoozed" : r.kind === "read" ? "Marked read" : r.kind === "event" ? "On calendar" : "";
      if (!words) continue;
      if (r.kind !== "label") acted.add(String(r.email_id));
      const list = done.get(String(r.email_id)) ?? [];
      if (!list.includes(words)) list.push(words);
      done.set(String(r.email_id), list);
    }
  }
  // Mail that asks the user for something is not handled by being sorted.
  const asks = (e: Row) => {
    const raw = e.email_processed as Row | Row[] | null;
    const p = (Array.isArray(raw) ? raw[0] : raw) as Row;
    return p.category === "action-required" && !p.calendar && !acted.has(String(e.id));
  };
  const handled: HandledItem[] = mail.filter((e) => !asks(e)).slice(0, HANDLED_MAX).map((e) => {
    const raw = e.email_processed as Row | Row[] | null;
    const p = (Array.isArray(raw) ? raw[0] : raw) as Row;
    const cal = p.calendar as Row | null;
    const words = done.get(String(e.id)) ?? [];
    if (cal) words.unshift(cal.method === "CANCEL" ? "Cancelled event" : cal.on_calendar ? "On calendar" : "Invitation");
    if (!words.length) words.push(CATEGORY[String(p.category)] ?? "Sorted");
    return { email_id: String(e.id), who: displayName(e.sender as string, String(e.sender_email ?? "")), subject: String(e.subject || "(no subject)"), what: words.slice(0, 2).join(", "), at: String(e.received_at) };
  });

  // Digests gathered since this Brief began.
  const digests: Digest[] = [];
  for (const a of (gathered.data ?? []) as Row[]) {
    const d = a.digest as { at: string; emails: string[] };
    if (d.at < since) continue;
    const { data } = await db.from("emails").select("id, sender, sender_email, subject, received_at, email_processed(summary)").in("id", d.emails).order("received_at", { ascending: false });
    const items = ((data ?? []) as Row[]).map((e) => {
      const p = (Array.isArray(e.email_processed) ? e.email_processed[0] : e.email_processed) as Row | null;
      return { email_id: String(e.id), who: displayName(e.sender as string, String(e.sender_email ?? "")), text: String(p?.summary || e.subject || "(no subject)"), at: String(e.received_at) };
    });
    if (items.length) digests.push({ id: String(a.id), title: String(a.text), at: d.at, items });
  }

  return {
    settings,
    changes: ((events.data ?? []) as Row[]).map((r) => ({ id: String(r.id), text: String(r.summary), email_id: (r.email_id as string) ?? null, at: String(r.created_at) })),
    away: await awayLine(userId, profile?.away as Away | null),
    digests,
    summary: settings.summary && current(written, today, settings, all.map((n) => n.key)) ? written!.text : null,
    needs,
    more: Math.max(0, all.length - length),
    proof: await proofLine(userId, profile, today),
    waitingMore: Math.max(0, waiting.length - max.waiting),
    waiting: waits,
    handled,
    day: today,
    at: new Date().toISOString(),
  };
}

// For some hours after Tabellar was away (awake.ts): how long, and what came
// meanwhile.
const AWAY_SHOWN_MS = 6 * 3600_000;
const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;
async function awayLine(userId: string, away: Away | null): Promise<string | null> {
  if (!away || Date.now() - Date.parse(away.to) > AWAY_SHOWN_MS) return null;
  const hours = Math.max(1, Math.round((Date.parse(away.to) - Date.parse(away.from)) / 3600_000));
  const came = () => db.from("emails").select("id, email_processed(id)").eq("user_id", userId).eq("is_receipt", false).not("label_ids", "cs", '{"SENT"}').gt("received_at", away.from).lte("received_at", away.to).limit(5000);
  const mail = ((await came()).data ?? []) as Row[];
  const left = mail.filter((e) => !(Array.isArray(e.email_processed) ? e.email_processed.length : e.email_processed)).length;
  const read = !mail.length ? "Nothing came meanwhile." : `${plural(mail.length, "email")} came meanwhile${left ? `, ${left} still to read.` : mail.length === 1 ? ", and it is read." : ", all read."}`;
  return `Tabellar was away for ${hours < 48 ? plural(hours, "hour") : plural(Math.round(hours / 24), "day")}. ${read}`;
}

// ── Proof before trust ──────────────────────────────────────────────────────

// Once, after a week of drafts that mostly went out word for word: how many
// did, and the offer to let the ones to people the user knows go on their own.
const PROOF_DAYS = 7;
const PROOF_FROM = 5;
const PROOF_SHARE = 0.7;
async function proofLine(userId: string, profile: Row | null, day: string): Promise<NeedItem | null> {
  const level = normalizeLevel(profile?.autonomy_level);
  if ((level !== "suggest" && level !== "assist") || (profile?.proof && profile.proof !== day)) return null;
  const k = await draftsKept(userId);
  if (!k.first || Date.now() - new Date(k.first).getTime() < PROOF_DAYS * DAY || k.decided < PROOF_FROM || k.unchanged < k.decided * PROOF_SHARE) return null;
  const o = await options(userId, "proof:");
  return o && { key: "proof:", kind: "proof", who: "Tabellar", text: `${k.unchanged} of ${k.decided} drafts were sent unchanged`, email_id: null, id: "", ...o };
}

// It was on screen today: it is not brought up on another day.
export async function proofShown(userId: string, day: string): Promise<void> {
  await db.from("profiles").update({ proof: day }).eq("id", userId).is("proof", null);
}

// What Tabellar asked the user to decide in the last seven days, against the
// mail that came: drafts, proposals, meetings and questions, each once, not
// what a rule or time took back.
export async function decisions(userId: string): Promise<{ asked: number; mail: number; per100: number | null }> {
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  const [{ data: log }, { count: questions }, { count: mail }] = await Promise.all([
    db.from("action_log").select("id, kind, email_id, hash, source, reason, status").eq("user_id", userId).in("source", ["engine", "automation"]).in("status", ["proposed", "done", "dismissed", "undone"]).gte("created_at", since),
    db.from("questions").select("id", { count: "exact", head: true }).eq("user_id", userId).in("status", ["open", "answered", "skipped"]).gte("created_at", since),
    db.from("emails").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("received_at", since).eq("is_receipt", false).not("label_ids", "cs", '{"SENT"}'),
  ]);
  const asked = new Set<string>();
  for (const r of (log ?? []) as Row[]) {
    if (!(r.hash || r.kind === "draft" || r.kind === "meeting") || (r.kind === "label" && r.source === "engine")) continue;
    if (r.reason === "Read again" || r.reason === "Your preference") continue;
    asked.add(`${r.kind}:${r.email_id ?? r.id}`);
  }
  const n = asked.size + (questions ?? 0);
  return { asked: n, mail: mail ?? 0, per100: mail ? Math.round((n / mail) * 100) : null };
}

// How many emails wait on the user: the count on the Inbox and in the menu bar.
export async function needCount(userId: string): Promise<number> {
  const [drafts, proposals, meetings, back, hidden, going] = await Promise.all([
    db.from("draft_emails").select("email_id, forward").eq("user_id", userId).or("email_id.not.is.null,forward.not.is.null"),
    db.from("action_log").select("email_id").eq("user_id", userId).eq("status", "proposed").or("kind.neq.label,source.eq.automation").not("email_id", "is", null),
    db.from("meetings").select("email_id").eq("user_id", userId).eq("status", "proposed").not("email_id", "is", null),
    db.from("emails").select("id").eq("user_id", userId).eq("is_snoozed", false).eq("is_archived", false).not("snooze_until", "is", null).is("resolved_at", null),
    db.from("emails").select("id").eq("user_id", userId).eq("is_snoozed", true),
    db.from("scheduled_emails").select("email_id").eq("user_id", userId).eq("status", "pending").eq("source", "autopilot"),
  ]);
  const need = new Set<string>([...(drafts.data ?? []), ...(proposals.data ?? []), ...(meetings.data ?? [])].map((r) => String(r.email_id ?? (r.forward as { email_id?: string } | null)?.email_id)));
  for (const e of back.data ?? []) need.add(String(e.id));
  for (const e of hidden.data ?? []) need.delete(String(e.id));
  for (const e of going.data ?? []) need.delete(String(e.email_id));
  return need.size;
}

// ── The notification ────────────────────────────────────────────────────────

const LATE_MIN = 6 * 60;
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// Once a day, when the Brief's time has come (or the quiet hours it fell in
// are over), its first three lines. Nothing when nothing needs the user, or
// when the Mac was off until long after. Mail still being read (not `fresh`)
// holds it for at most half an hour, from when its time came or the machine
// woke (`awake` ms ago). Returns whether it went out.
export async function tellBrief(userId: string, { at = new Date(), fresh = true, awake = Infinity } = {}): Promise<boolean> {
  const { data: me } = await db.from("profiles").select("working_hours, brief, brief_told, notification_level, notification_preview, notification_quiet, onboarding").eq("id", userId).maybeSingle();
  if (!me || me.onboarding !== "done" || me.notification_level === "none") return false;
  const settings = briefSettings(me.brief);
  const { day, due, past } = briefDay(settings, zoneOf(me), at);
  if (!settings.notify || !due || me.brief_told === day || inQuietHours(me, at) || (!fresh && Math.min(past, awake / 60_000) < 30)) return false;
  await db.from("profiles").update({ brief_told: day }).eq("id", userId);
  if (past > LATE_MIN) return false;
  const b = await brief(userId);
  if (!b.needs.length) return false;
  const count = b.needs.length + b.more;
  const title = `${count} ${count === 1 ? "thing needs" : "things need"} you today`;
  if (me.notification_preview === false) notify({ title: "Brief", body: title, brief: b });
  else notify({ title: "Brief", subtitle: title, brief: b, body: b.needs.slice(0, 3).map((n) => short(n.who === "Todo" || n.who === "Tabellar" ? n.text : `${n.who}: ${n.text}`, 76)).join("\n") });
  return true;
}

// ── The paragraph ───────────────────────────────────────────────────────────

type Summary = { day: string; tone: string; text: string; keys: string[] };

// Today's, in the tone chosen, and nothing it was written from has been dealt with since.
function current(s: Summary | null, day: string, settings: BriefSettings, open: string[]): boolean {
  return s?.day === day && s.tone === settings.tone && s.keys.every((k) => open.includes(k));
}

// Every number and name the paragraph gives is in the lines it was written from.
export function supported(text: string, lines: string): boolean {
  const have = lines.toLowerCase();
  const numbers = text.match(/\d+(?:[:.]\d+)?/g) ?? [];
  if (numbers.some((n) => !have.includes(n))) return false;
  const names = [...text.matchAll(/(?<![.!?]\s|^|\n)\b\p{Lu}[\p{L}'-]+/gu)].map((m) => m[0].toLowerCase().replace(/'s$/, ""));
  return names.every((n) => have.includes(n) || /^(i|today|tomorrow|yesterday|(mon|tues|wednes|thurs|fri|satur|sun)day|january|february|march|april|may|june|july|august|september|october|november|december|tabellar)$/.test(n));
}

function linesFor(b: Brief): string {
  const line = (n: NeedItem): string => {
    const about = n.text.replace(/^(Reply|Follow-up) drafted: |^Reply to approve: /, "");
    if (n.kind === "reply" || /^Reply to approve/.test(n.text)) return `A reply to ${n.who} about "${about}" is drafted and waits for the user to send it`;
    if (n.kind === "forward") return `A forward to ${n.who} is drafted and waits for the user to send it: ${n.text.replace(/^Forward drafted: /, "")}`;
    if (n.kind === "meeting") return `A meeting with ${n.who} waits to be confirmed: ${n.text}`;
    if (n.kind === "todo") return `Todo: ${n.text}${n.due && n.due < b.day ? ", overdue" : ", due today"}`;
    if (n.kind === "read") return `Unread mail from ${n.who}, who matters to the user: ${n.text}`;
    return `${n.who}: ${n.text}`;
  };
  const has = (section: string) => b.settings.sections.includes(section);
  const out: string[] = [];
  if (has("needs")) out.push(`Needs the user today (${b.needs.length + b.more} things, the first ${b.needs.length}):`, ...b.needs.map((n) => `- ${line(n)}`));
  if (has("waiting") && b.waiting.length) out.push(`The user waits for an answer from (${b.waiting.length + b.waitingMore}):`, ...b.waiting.map((w) => `- ${w.who}, asked: ${w.text}`));
  return out.join("\n");
}

// Today's paragraph, from the Brief's own lines: written once its time has
// come, and again when the window asks because a line it was written from is
// dealt with. A text that names something the lines do not is written once
// more, then left out.
let writing: Promise<string | null> | null = null;
export function prepareBrief(userId: string, opts: { now?: boolean } = {}): Promise<string | null> {
  writing ??= (async () => {
    const { data: profile } = await db.from("profiles").select("working_hours, brief, brief_summary, onboarding").eq("id", userId).maybeSingle();
    const settings = briefSettings(profile?.brief);
    if (!settings.summary || !modelConfigured() || profile?.onboarding !== "done") return null;
    const { day, due } = briefDay(settings, zoneOf(profile));
    const have = profile?.brief_summary as Summary | null;
    if (!opts.now && (!due || have?.day === day)) return null;
    const b = await brief(userId);
    if (b.summary !== null) return b.summary;
    const lines = linesFor(b);
    let text = "";
    for (let i = 0; i < 2 && !text; i++) {
      const t = await briefParagraph(lines, TONES[settings.tone]);
      if (t && supported(t, lines)) text = t;
    }
    await db.from("profiles").update({ brief_summary: { day, tone: settings.tone, text, keys: b.needs.map((n) => n.key) } }).eq("id", userId);
    return text || null;
  })().finally(() => {
    writing = null;
  });
  return writing;
}
