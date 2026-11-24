// What Tabellar made of each email: the reply it drafted, the todo it added,
// the reply that is about to go out. One load feeds the inbox rows, the
// details panel, the sidebar counts and the outgoing list, so they always
// agree with each other and with History.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/db";
import type { MailState } from "@/components/ui";
import { reversible } from "@/lib/undo";

export type OutcomeAct =
  | { kind: "review"; draftId: string }
  | { kind: "approve"; id: string; hash: string }
  | { kind: "undo"; id: string }
  | { kind: "cancel"; id: string }
  | { kind: "back"; id: string }
  | { kind: "view"; view: string };

export type Outcome = {
  key: string;
  state: MailState; // need, going, held, failed, done, or info for history
  short: string; // the words on an inbox row; empty when the row should not mention it
  title: string; // the one line in the details panel and the reader
  why?: string; // shown on hover
  at: string;
  sendAt?: string; // for a reply on its way out
  act?: OutcomeAct;
};

export type Outgoing = { id: string; actionId: string | null; emailId: string | null; to: string; subject: string; sendAt: string };

export type EngineStatus = {
  level: "observe" | "suggest" | "assist" | "autopilot";
  paused: boolean;
  lastCycleAt: string | null;
  lastError: string | null;
  mailError: string | null;
  signIn: string | null; // the mailbox whose sign-in is no longer accepted
  modelError: string | null; // what went wrong, while the model does not answer
  down?: boolean; // the server itself does not answer
  running: boolean;
  model: boolean;
  autostart: boolean;
};

export type Overview = {
  byEmail: Map<string, Outcome[]>;
  written: Set<string>; // addresses the user has written to
  vips: Set<string>; // their most important people, as addresses and domains
  isVip: (address: string | null | undefined) => boolean;
  setVip: (address: string, on: boolean, name: string) => Promise<void>;
  outgoing: Outgoing[];
  counts: { need: number; replies: number; todos: number; meetings: number; followups: number; proposals: number };
  engine: EngineStatus | null;
  loaded: boolean;
  reload: () => void;
  // "own": the caller offers its own way to undo it.
  approve: (id: string, hash: string, own?: boolean) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  undo: (id: string) => Promise<void>;
  refreshEngine: () => void;
};

const RANK: Record<string, number> = { going: 0, need: 1, failed: 2, held: 3, done: 4, info: 5, filed: 6 };

const PROPOSED: Record<string, string> = {
  draft: "Reply to approve",
  send: "Reply to approve",
  todo: "Todo to approve",
  meeting: "Meeting to approve",
  archive: "Archive to approve",
  unsubscribe: "Unsubscribe to approve",
};

export async function api(path: string, body?: unknown) {
  const { data } = await createClient().auth.getSession();
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

function when(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: false });
  return sameDay ? t : `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
}

// A meeting's time, and the time as the email wrote it when its zone is not the user's.
const meetingWhen = (m: any) => `${when(m.start_time)}${m.as_written ? ` (${m.as_written} in the email)` : ""}`;

// The state and words for an inbox row, from an email's outcomes.
export function rowStatus(outcomes: Outcome[] | undefined): { state: MailState; text: string; sendAt?: string } {
  const shown = (outcomes || []).filter((o) => o.short);
  if (!shown.length) return { state: "filed", text: "" };
  const top = shown[0];
  const rest = shown.find((o) => o !== top && o.short !== top.short);
  return { state: top.state, text: rest ? `${top.short}, ${rest.short.charAt(0).toLowerCase()}${rest.short.slice(1)}` : top.short, sendAt: top.sendAt };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// What a draft says, in a line.
function draftLine(draft: any): string {
  const text = String(draft.body_html || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const said = text.replace(/^(hi|hello|dear|hey)\b[^,.]*[,.]\s*/i, "");
  return said.length > 140 ? `${said.slice(0, 140).replace(/\s+\S*$/, "")}...` : said;
}

// The calendar event an email is about, as the server linked it: on the
// calendar, or only described by the invitation's .ics.
function calendarOutcome(emailId: string, c: any, at: string): Outcome {
  const cancelled = c.method === "CANCEL";
  const time = c.start ? (c.all_day ? new Date(`${String(c.start).slice(0, 10)}T12:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) : when(c.start)) : "";
  const short = cancelled ? "Cancelled" : c.on_calendar ? `On calendar${time ? `, ${time}` : ""}` : `Invitation${time ? `, ${time}` : ""}`;
  return {
    key: `cal:${emailId}`,
    at,
    state: "done",
    short,
    title: `${cancelled ? "Cancelled" : c.on_calendar ? "On calendar" : "Invitation"}: ${c.title || "an event"}${time && !cancelled ? `, ${time}` : ""}`,
    act: { kind: "view", view: "meetings" },
  };
}

function build(log: any[], drafts: any[], meetings: any[], todos: any[], sched: any[], cal: any[], back: any[]): Map<string, Outcome[]> {
  const map = new Map<string, Outcome[]>();
  const push = (emailId: string | null, o: Outcome) => {
    if (!emailId) return;
    const list = map.get(emailId);
    if (list) list.push(o);
    else map.set(emailId, [o]);
  };
  const draftById = new Map(drafts.map((d) => [d.id, d]));
  const meetingById = new Map(meetings.map((m) => [m.id, m]));
  const pendingByAction = new Map(sched.filter((s) => s.action_id).map((s) => [s.action_id, s]));
  const seenDraft = new Set<string>();
  const seenMeeting = new Set<string>();
  const seenTodoText = new Set<string>();

  for (const r of log) {
    // Labels are plain Gmail labels, shown on the row; undo them in History.
    const d = r.detail || {};
    const base = { key: r.id, at: r.created_at };
    if (r.kind === "label") {
      // One of them says the email is held.
      if (r.status === "done" && d.label === "Tabellar/Suspicious") push(r.email_id, { ...base, key: `held:${r.email_id}`, state: "held", short: "Held: written to an AI", title: "Held: written to an AI, only labelled" });
      continue;
    }
    if (r.status === "proposed") {
      push(r.email_id, { ...base, state: "need", short: PROPOSED[r.kind] || "To approve", title: r.summary, act: { kind: "approve", id: r.id, hash: r.hash || "" } });
    } else if (r.status === "done" && r.kind === "send") {
      const pending = pendingByAction.get(r.id);
      if (pending) push(r.email_id, { ...base, state: "going", short: "Replying", title: "Replying", sendAt: pending.send_at, act: { kind: "cancel", id: r.id } });
      else if (d.sentAt) push(r.email_id, { ...base, state: "done", short: `Replied ${when(d.sentAt)}`, title: `Replied ${when(d.sentAt)}` });
    } else if (r.status === "done" && r.kind === "draft") {
      const draft = draftById.get(d.draftId);
      if (draft) {
        seenDraft.add(draft.id);
        push(r.email_id, { ...base, state: "need", short: "Reply ready", title: "Reply drafted", why: draftLine(draft), act: { kind: "review", draftId: draft.id } });
      } else push(r.email_id, { ...base, state: "info", short: "", title: "Drafted a reply", why: "Sent or discarded since" });
    } else if (r.status === "done" && r.kind === "todo") {
      seenTodoText.add(`${r.email_id}:${d.text}`);
      push(r.email_id, { ...base, state: "done", short: "Todo added", title: `Todo: ${d.text || ""}`, act: { kind: "undo", id: r.id } });
    } else if (r.status === "done" && r.kind === "meeting") {
      const m = meetingById.get(d.meetingId);
      if (m) seenMeeting.add(m.id);
      if (m && m.status === "proposed") push(r.email_id, { ...base, state: "need", short: "Meeting to confirm", title: `Meeting to confirm: ${m.title}, ${meetingWhen(m)}`, act: { kind: "view", view: "meetings" } });
      else if (m && m.status === "confirmed") push(r.email_id, { ...base, state: "done", short: `On calendar, ${when(m.start_time)}`, title: `On calendar: ${m.title}, ${when(m.start_time)}`, act: { kind: "view", view: "meetings" } });
    } else if (r.status === "done" && r.kind === "archive") {
      push(r.email_id, { ...base, state: "done", short: "Archived", title: "Archived", act: { kind: "undo", id: r.id } });
    } else if (r.status === "done" && r.kind === "unsubscribe") {
      push(r.email_id, { ...base, state: "done", short: "Unsubscribed", title: r.summary });
    } else if (r.status === "blocked") {
      const planted = /instructions to an AI/i.test(r.reason || "");
      push(r.email_id, { ...base, key: planted ? `held:${r.email_id}` : r.id, state: planted ? "held" : "info", short: planted ? "Held: written to an AI" : "", title: planted ? "Held: written to an AI, only labelled" : `Not done: ${r.summary}`, why: r.reason || undefined });
    } else if (r.status === "failed") {
      push(r.email_id, { ...base, state: "failed", short: "Could not finish", title: `Failed: ${r.summary}`, why: r.error || undefined });
    } else if (r.status === "undone" || r.status === "dismissed") {
      push(r.email_id, { ...base, state: "info", short: "", title: `${r.status === "undone" ? "Undone" : "Dismissed"}: ${r.summary}` });
    }
  }
  // Drafts, meetings and todos made elsewhere (the agent, the assistant, by hand).
  for (const d of drafts) if (d.email_id && !seenDraft.has(d.id)) push(d.email_id, { key: d.id, at: d.created_at, state: "need", short: "Reply ready", title: "Reply drafted", why: draftLine(d), act: { kind: "review", draftId: d.id } });
  for (const m of meetings) {
    if (!m.email_id || seenMeeting.has(m.id)) continue;
    if (m.status === "proposed") push(m.email_id, { key: m.id, at: m.created_at, state: "need", short: "Meeting to confirm", title: `Meeting to confirm: ${m.title}, ${meetingWhen(m)}`, act: { kind: "view", view: "meetings" } });
    else if (m.status === "confirmed") push(m.email_id, { key: m.id, at: m.created_at, state: "done", short: `On calendar, ${when(m.start_time)}`, title: `On calendar: ${m.title}, ${when(m.start_time)}`, act: { kind: "view", view: "meetings" } });
  }
  for (const e of back) push(e.id, { key: `back:${e.id}`, at: e.snooze_until, state: "need", short: "Back", title: `Back from snooze, ${when(e.snooze_until)}`, act: { kind: "back", id: e.id } });
  for (const c of cal) if (c.calendar) push(c.email_id, calendarOutcome(c.email_id, c.calendar, c.processed_at));
  for (const t of todos) if (t.email_id && !t.is_completed && !seenTodoText.has(`${t.email_id}:${t.text}`)) push(t.email_id, { key: t.id, at: t.created_at, state: "done", short: "Todo added", title: `Todo: ${t.text}`, act: { kind: "view", view: "todos" } });

  for (const list of map.values()) {
    // one line per held email however many actions were refused
    const seen = new Set<string>();
    const unique = list.filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)));
    unique.sort((a, b) => RANK[a.state] - RANK[b.state] || b.at.localeCompare(a.at));
    list.length = 0;
    list.push(...unique);
  }
  return map;
}

export function useOverview(userId: string, live: Record<string, number>, onError: (message: string) => void, onUndoable: (label: string, undo: () => Promise<unknown>) => void): Overview {
  const supabase = createClient();
  const [raw, setRaw] = useState<{ log: any[]; drafts: any[]; meetings: any[]; todos: any[]; sched: any[]; cal: any[]; vips: Set<string>; followups: number; written: Set<string> } | null>(null);
  // Mail back from snooze, and mail hidden by it.
  const [snooze, setSnooze] = useState<{ back: any[]; hidden: Set<string> }>({ back: [], hidden: new Set() });
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const loading = useRef(false);
  const again = useRef(false);

  const loadSnooze = useCallback(async () => {
    const [back, hidden] = await Promise.all([
      supabase.from("emails").select("id, snooze_until").eq("user_id", userId).eq("is_snoozed", false).eq("is_archived", false).not("snooze_until", "is", null).is("resolved_at", null),
      supabase.from("emails").select("id").eq("user_id", userId).eq("is_snoozed", true),
    ]);
    const next = { back: (back.data || []) as any[], hidden: new Set(((hidden.data || []) as any[]).map((e) => e.id as string)) };
    // Most changes to mail are not about snooze: keep the same value then.
    const key = (s: { back: any[]; hidden: Set<string> }) => `${s.back.map((e) => e.id + e.snooze_until).sort().join()}|${[...s.hidden].sort().join()}`;
    setSnooze((prev) => (key(prev) === key(next) ? prev : next));
  }, [userId]);

  const reload = useCallback(async () => {
    void loadSnooze();
    // A change while a load runs is loaded once more after it, not dropped.
    if (loading.current) {
      again.current = true;
      return;
    }
    loading.current = true;
    try {
      const [log, drafts, meetings, todos, sched, cal, followups, sent, vips] = await Promise.all([
        supabase.from("action_log").select("id, kind, status, source, email_id, summary, detail, hash, reason, error, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(4000),
        supabase.from("draft_emails").select("id, email_id, subject, to_addresses, body_html, created_at").eq("user_id", userId).order("created_at", { ascending: false }),
        supabase.from("meetings").select("id, email_id, title, start_time, as_written, status, created_at").eq("user_id", userId),
        supabase.from("todos").select("id, email_id, text, is_completed, created_at").eq("user_id", userId).eq("is_completed", false),
        supabase.from("scheduled_emails").select("id, email_id, action_id, send_at, source, to_addresses, subject").eq("user_id", userId).eq("status", "pending").order("send_at", { ascending: true }),
        supabase.from("email_processed").select("email_id, calendar, processed_at").eq("user_id", userId).not("calendar", "is", null).order("processed_at", { ascending: false }).limit(2000),
        supabase.from("follow_up_reminders").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "waiting"),
        supabase.from("emails").select("recipients").eq("user_id", userId).contains("label_ids", ["SENT"]).order("received_at", { ascending: false }).limit(3000),
        supabase.from("preferences").select("subject").eq("user_id", userId).eq("value", "vip").in("kind", ["sender", "domain"]),
      ]);
      // People the user has written to, from the sent mail kept here.
      const written = new Set<string>();
      for (const x of (sent.data || []) as any[]) for (const m of String(x.recipients || "").toLowerCase().match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []) written.add(m);
      // Names for the replies on their way out: the person each one answers.
      const pendingIds = ((sched.data || []) as any[]).map((x) => x.email_id).filter(Boolean);
      const pendingNames = new Map<string, string>();
      if (pendingIds.length) {
        const { data } = await supabase.from("emails").select("id, sender").in("id", pendingIds);
        for (const e of (data || []) as any[]) pendingNames.set(e.id, String(e.sender || "").replace(/<.*>/, "").replace(/"/g, "").trim());
      }
      for (const x of (sched.data || []) as any[]) x.to_name = pendingNames.get(x.email_id) || "";
      setRaw({ log: log.data || [], drafts: drafts.data || [], meetings: meetings.data || [], todos: todos.data || [], sched: sched.data || [], cal: cal.data || [], vips: new Set(((vips.data || []) as any[]).map((p) => p.subject)), followups: followups.count ?? 0, written });
    } finally {
      loading.current = false;
      if (again.current) {
        again.current = false;
        void reload();
      }
    }
  }, [userId, loadSnooze]);

  const refreshEngine = useCallback(() => {
    api("/engine/status").then(setEngine).catch((e) => e instanceof TypeError && setEngine((now) => now && { ...now, down: true }));
  }, []);

  useEffect(() => {
    reload();
  }, [reload, live.action_log, live.draft_emails, live.meetings, live.todos, live.scheduled_emails, live.follow_up_reminders, live.preferences]);

  useEffect(() => {
    loadSnooze();
  }, [loadSnooze, live.emails]);

  useEffect(() => {
    refreshEngine();
    const id = setInterval(refreshEngine, 15_000);
    return () => clearInterval(id);
  }, [refreshEngine, live.profiles]);

  // A reply leaves the outgoing list at its send time even if no event arrives.
  const [, bump] = useState(0);
  useEffect(() => {
    const next = raw?.sched.map((s) => new Date(s.send_at).getTime()).find((t) => t > Date.now());
    if (!next) return;
    const id = setTimeout(() => (bump((n) => n + 1), reload()), next - Date.now() + 1500);
    return () => clearTimeout(id);
  }, [raw, reload]);

  const derived = useMemo(() => {
    if (!raw) return { byEmail: new Map<string, Outcome[]>(), written: new Set<string>(), vips: new Set<string>(), outgoing: [] as Outgoing[], counts: { need: 0, replies: 0, todos: 0, meetings: 0, followups: 0, proposals: 0 } };
    const auto = raw.sched.filter((s) => s.source === "autopilot");
    const byEmail = build(raw.log, raw.drafts, raw.meetings, raw.todos, auto, raw.cal, snooze.back);
    // A snoozed email waits on nobody until it is back.
    let need = 0;
    const waiting = (kind: string) => raw.log.filter((r) => r.status === "proposed" && r.kind === kind).length;
    for (const [id, list] of byEmail) if (list[0]?.state === "need" && !snooze.hidden.has(id)) need++;
    return {
      byEmail,
      written: raw.written,
      vips: raw.vips,
      outgoing: auto.map((s) => ({ id: s.id, actionId: s.action_id, emailId: s.email_id, to: s.to_name || (s.to_addresses || [])[0] || "", subject: s.subject || "", sendAt: s.send_at })),
      counts: {
        need,
        // What waits on each page, approval included.
        replies: raw.drafts.length + waiting("draft"),
        todos: raw.todos.length + waiting("todo"),
        meetings: raw.meetings.filter((m) => m.status === "proposed").length + waiting("meeting"),
        followups: raw.followups,
        proposals: raw.log.filter((r) => r.status === "proposed" && r.kind !== "label").length,
      },
    };
  }, [raw, snooze]);

  const run = useCallback(
    async (path: string, body: unknown) => {
      try {
        await api(path, body);
      } catch (e) {
        onError((e as Error).message);
        throw e;
      } finally {
        reload();
      }
    },
    [reload, onError],
  );

  const isVip = useCallback(
    (address: string | null | undefined) => {
      const a = (address || "").toLowerCase();
      const d = a.split("@")[1] || "";
      return !!a && (derived.vips.has(a) || [...derived.vips].some((v) => !v.includes("@") && (d === v || d.endsWith(`.${v}`))));
    },
    [derived.vips],
  );
  const setVip = async (address: string, on: boolean, name: string) => {
    const a = address.toLowerCase();
    const undo = await reversible(userId, async () => {
      if (on) await api("/preferences", { kind: "sender", subject: a, value: "vip" });
      else await supabase.from("preferences").delete().eq("user_id", userId).eq("kind", "sender").eq("subject", a).eq("value", "vip");
    });
    onUndoable(on ? `${name} is most important` : `${name} is not most important`, () => undo().then(reload));
    reload();
  };

  return {
    ...derived,
    isVip,
    setVip,
    engine,
    loaded: raw !== null,
    reload,
    refreshEngine,
    approve: async (id, hash, own) => {
      await run("/actions/approve", { id, hash });
      if (!own) onUndoable("Approved", () => run("/actions/undo", { id }));
    },
    dismiss: async (id) => {
      const undo = await reversible(userId, () => run("/actions/dismiss", { id }));
      onUndoable("Dismissed", () => undo().then(reload));
    },
    undo: (id) => run("/actions/undo", { id }),
  };
}

// Archive or return to the inbox, mark read or unread: in Gmail and here.
export function setMailState(ids: string[], state: { archived?: boolean; read?: boolean }): Promise<unknown> {
  return api("/mail/state", { ids, ...state });
}

// Archive or mark unread from a reader opened outside the Inbox (Todos,
// Meetings, Brief). Returns the undo.
export async function setEmailFlag(emailId: string, flag: "archive" | "unread"): Promise<() => Promise<void>> {
  const key = flag === "archive" ? "archived" : "read";
  const on = flag === "archive";
  await setMailState([emailId], { [key]: on });
  return async () => {
    await setMailState([emailId], { [key]: !on });
  };
}
