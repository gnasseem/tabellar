import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { Empty, Glyph, KeyHints, Kbd, Seg, SkeletonRows, Tick, ViewBar, dayLabel, shortWhen } from "../ui";
import { NotThis, usePrefStops } from "../Profile";

// Follow-ups: mail the user sent that has had no answer. Each one carries a
// reminder date; once that date has come it is due and set in wax red. Sent
// mail that went unanswered but is not tracked yet is listed last, to track
// or leave.

/* eslint-disable @typescript-eslint/no-explicit-any */
type FollowUp = {
  id: string;
  email_id: string | null;
  thread_id: string;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  remind_at: string;
  status: "waiting" | "replied" | "dismissed" | "snoozed";
  snooze_until: string | null;
  created_at: string;
};

type Suggested = {
  email_id: string;
  thread_id: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  sent_at: string;
  days_waiting: number;
};

type State = "due" | "waiting" | "snoozed" | "answered" | "dismissed" | "untracked";
type Item = {
  key: string;
  state: State;
  f: FollowUp | null; // the reminder, when it is tracked
  s: Suggested | null; // the sent email, when it is not
  name: string;
  email: string;
  subject: string;
  threadId: string;
  since: string; // when the wait began
  wrote: string; // what the user sent, as far as the list knows it
};
type Head = { head: true; key: string; name: string; note: string; count: number; need: boolean };
type Filter = "waiting" | "due" | "snoozed" | "done";

const DAY = 86_400_000;
const SNOOZES: [number, string][] = [
  [1, "1 day"],
  [3, "3 days"],
  [7, "1 week"],
  [14, "2 weeks"],
];

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function onDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
function sentOn(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: false });
}
function waited(since: string): string {
  const n = daysAgo(since);
  return n <= 0 ? "Sent today" : `Waiting ${plural(n, "day")}`;
}
function overdue(remindAt: string): string {
  const n = daysAgo(remindAt);
  return n <= 0 ? "Due today" : `${plural(n, "day")} overdue`;
}

function stateOf(f: FollowUp): State {
  if (f.status === "replied") return "answered";
  if (f.status === "dismissed") return "dismissed";
  if (f.status === "snoozed" && f.snooze_until && new Date(f.snooze_until) > new Date()) return "snoozed";
  return new Date(f.remind_at) <= new Date() ? "due" : "waiting";
}

// The short status at the right of a row.
function statusOf(i: Item): string {
  if (i.state === "due") return overdue(i.f!.remind_at);
  if (i.state === "waiting") return `Reminder ${onDate(i.f!.remind_at)}`;
  if (i.state === "snoozed") return `Snoozed until ${onDate(i.f!.snooze_until!)}`;
  if (i.state === "answered") return "Answered";
  if (i.state === "dismissed") return "Dismissed";
  return "Not tracked";
}

function SnoozeMenu({ onSnooze, up = false, hint }: { onSnooze: (days: number) => void; up?: boolean; hint?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Snooze {hint && <Kbd>{hint}</Kbd>}
        <Icon name="expand_more" size={13} className="text-ink3" />
      </button>
      {open && (
        <div className={`pop absolute left-0 min-w-[130px] ${up ? "bottom-9" : "top-8"}`} role="menu">
          {SNOOZES.map(([days, label]) => (
            <button key={days} className="pop-item" role="menuitem" onClick={() => (setOpen(false), onSnooze(days))}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FollowupsView() {
  const { user, addToast, openCompose, search, mail } = useApp();
  const supabase = createClient();
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [sent, setSent] = useState<Record<string, { snippet: string; received_at: string }>>({});
  const [suggestions, setSuggestions] = useState<Suggested[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("waiting");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false); // narrow windows: the list or the detail, one at a time
  const anchor = useRef<string | null>(null);
  const lastUndo = useRef<(() => Promise<void>) | null>(null);
  const goKey = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const stopped = usePrefStops("followup");

  const loadFollowUps = useCallback(async () => {
    const { data, error: failed } = await supabase.from("follow_up_reminders").select("*").eq("user_id", user.id).order("remind_at", { ascending: true });
    setError(failed ? "Could not load your follow-ups." : null);
    const rows = (data as FollowUp[]) || [];
    setFollowUps(rows);
    setLoading(false);
    // What was sent and when, for the line under each name and the detail pane.
    const ids = rows.map((f) => f.email_id).filter(Boolean);
    if (!ids.length) return;
    const { data: emails } = await supabase.from("emails").select("id, snippet, received_at").in("id", ids);
    setSent(Object.fromEntries(((emails || []) as any[]).map((e) => [e.id, { snippet: e.snippet || "", received_at: e.received_at }])));
  }, [user.id]);

  // Sent mail from the last 30 days with no reply in its thread and no reminder.
  const loadSuggestions = useCallback(async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * DAY).toISOString();
    const { data: sentEmails } = await supabase
      .from("emails")
      .select("id, thread_id, recipients, subject, received_at, sender_email, sender, snippet")
      .eq("user_id", user.id)
      .contains("label_ids", ["SENT"])
      .gte("received_at", thirtyDaysAgo)
      .order("received_at", { ascending: false })
      .limit(50);
    if (!sentEmails?.length) return;

    const { data: existing } = await supabase.from("follow_up_reminders").select("thread_id").eq("user_id", user.id);
    const tracked = new Set((existing || []).map((r: any) => r.thread_id));

    const threadIds = [...new Set(sentEmails.map((e: any) => e.thread_id).filter(Boolean))];
    if (!threadIds.length) return;
    const { data: replies } = await supabase.from("emails").select("thread_id, sender_email").eq("user_id", user.id).in("thread_id", threadIds).not("label_ids", "cs", '{"SENT"}');
    const answered = new Set((replies || []).map((r: any) => r.thread_id));

    const byThread = new Map<string, Suggested>();
    const snippets: Record<string, { snippet: string; received_at: string }> = {};
    for (const email of sentEmails as any[]) {
      if (!email.thread_id || tracked.has(email.thread_id) || answered.has(email.thread_id) || byThread.has(email.thread_id)) continue;
      const recipients = (email.recipients || "").split(",").map((s: string) => s.trim()).filter(Boolean);
      const first = recipients[0] || email.recipients || "unknown";
      const nameMatch = first.match(/^(.*?)\s*<[^>]+>/);
      const emailMatch = first.match(/<([^>]+)>/);
      const recipientEmail = emailMatch ? emailMatch[1] : first.replace(/<.*>/, "").trim();
      byThread.set(email.thread_id, {
        email_id: email.id,
        thread_id: email.thread_id,
        recipient_email: recipientEmail,
        recipient_name: nameMatch ? nameMatch[1].replace(/"/g, "").trim() : recipientEmail.split("@")[0],
        subject: email.subject || "(no subject)",
        sent_at: email.received_at,
        days_waiting: daysAgo(email.received_at),
      });
      snippets[email.id] = { snippet: email.snippet || "", received_at: email.received_at };
    }
    setSuggestions([...byThread.values()].filter((s) => s.days_waiting >= 2));
    setSent((prev) => ({ ...snippets, ...prev }));
  }, [user.id]);

  useEffect(() => {
    loadFollowUps();
    loadSuggestions();
  }, [loadFollowUps, loadSuggestions]);

  const all = useMemo(() => {
    const tracked: Item[] = followUps.map((f) => ({
      key: f.id,
      state: stateOf(f),
      f,
      s: null,
      name: f.recipient_name || f.recipient_email,
      email: f.recipient_email,
      subject: f.subject || "(no subject)",
      threadId: f.thread_id,
      since: (f.email_id && sent[f.email_id]?.received_at) || f.created_at,
      wrote: (f.email_id && sent[f.email_id]?.snippet) || "",
    }));
    const threads = new Set(followUps.map((f) => f.thread_id));
    const untracked: Item[] = suggestions
      .filter((s) => !hidden.has(s.thread_id) && !threads.has(s.thread_id) && !stopped(s.recipient_email, s.subject))
      .map((s) => ({ key: `s:${s.thread_id}`, state: "untracked", f: null, s, name: s.recipient_name || s.recipient_email, email: s.recipient_email, subject: s.subject, threadId: s.thread_id, since: s.sent_at, wrote: sent[s.email_id]?.snippet || "" }));
    return [...tracked, ...untracked];
  }, [followUps, suggestions, hidden, sent, stopped]);

  const counts = useMemo(() => {
    const n = (s: State) => all.filter((i) => i.state === s).length;
    return { due: n("due"), active: n("due") + n("waiting"), snoozed: n("snoozed") };
  }, [all]);

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const shown = q ? all.filter((i) => `${i.name} ${i.email} ${i.subject}`.toLowerCase().includes(q)) : all;
    const out: (Head | Item)[] = [];
    const add = (state: State, name: string, note: string, sort: (a: Item, b: Item) => number) => {
      const list = shown.filter((i) => i.state === state).sort(sort);
      if (list.length) out.push({ head: true, key: `head:${state}`, name, note, count: list.length, need: state === "due" }, ...list);
    };
    const byReminder = (a: Item, b: Item) => a.f!.remind_at.localeCompare(b.f!.remind_at);
    const newest = (a: Item, b: Item) => b.since.localeCompare(a.since);
    if (filter === "waiting" || filter === "due") add("due", "Due now", "The reminder date has come", byReminder);
    if (filter === "waiting") {
      add("waiting", "Waiting", "No answer yet, reminder still ahead", byReminder);
      add("untracked", "Not tracked", "Sent two or more days ago, no answer", (a, b) => a.since.localeCompare(b.since));
    }
    if (filter === "snoozed") add("snoozed", "Snoozed", "Back in Waiting on the date shown", (a, b) => (a.f!.snooze_until || "").localeCompare(b.f!.snooze_until || ""));
    if (filter === "done") {
      add("answered", "Answered", "", newest);
      add("dismissed", "Dismissed", "", newest);
    }
    return out;
  }, [all, filter, search]);

  const rows = useMemo(() => items.filter((i): i is Item => !("head" in i)), [items]);
  const cursor = rows.find((r) => r.key === cursorKey) || rows[0] || null;
  const selected = rows.filter((r) => picked.has(r.key));

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor?.key]);

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorKey(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].key);
  };

  // Only tracked follow-ups can be selected: the bulk actions change reminders.
  const pick = (r: Item, range = false) => {
    if (!r.f) return;
    const pickable = rows.filter((x) => x.f);
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && anchor.current) {
        const a = pickable.findIndex((x) => x.key === anchor.current);
        const b = pickable.indexOf(r);
        if (a >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(pickable[i].key);
      } else if (next.has(r.key)) next.delete(r.key);
      else next.add(r.key);
      return next;
    });
    anchor.current = r.key;
  };

  const targets = (): Item[] => (selected.length ? selected : cursor ? [cursor] : []);

  // Keep the cursor near where it was when rows leave the list.
  const stepPast = (list: Item[]) => {
    if (!cursor || !list.includes(cursor)) return;
    const rest = rows.filter((r) => !list.includes(r));
    const at = rows.indexOf(cursor);
    setCursorKey((rest.find((r) => rows.indexOf(r) > at) || rest[rest.length - 1])?.key ?? null);
  };

  // Nudge opens a reply in the same thread for the user to write and send.
  const nudge = (i: Item) => openCompose({ sender_email: i.email, subject: /^re:/i.test(i.subject) ? i.subject : `Re: ${i.subject}`, thread_id: i.threadId });

  const setStatus = async (list: Item[], status: FollowUp["status"], snoozeUntil: string | null, done: string) => {
    const before = list.map((i) => i.f).filter((f): f is FollowUp => !!f);
    if (!before.length) return;
    const ids = before.map((f) => f.id);
    stepPast(list);
    setPicked(new Set());
    setFollowUps((prev) => prev.map((f) => (ids.includes(f.id) ? { ...f, status, snooze_until: snoozeUntil } : f)));
    const { error: failed } = await supabase.from("follow_up_reminders").update({ status, snooze_until: snoozeUntil }).in("id", ids);
    if (failed) {
      addToast("error", "Could not save that. Nothing was changed.");
      return loadFollowUps();
    }
    mail.reload();
    const undo = async () => {
      for (const f of before) await supabase.from("follow_up_reminders").update({ status: f.status, snooze_until: f.snooze_until }).eq("id", f.id);
      mail.reload();
      await loadFollowUps();
    };
    lastUndo.current = undo;
    addToast("success", before.length === 1 ? done : `${done}: ${before.length} follow-ups`, { action: { label: "Undo", onClick: undo } });
  };

  const snooze = (list: Item[], days: number) => setStatus(list.filter((i) => i.state !== "answered" && i.state !== "dismissed"), "snoozed", new Date(Date.now() + days * DAY).toISOString(), `Snoozed for ${plural(days, "day")}`);
  const answered = (list: Item[]) => setStatus(list.filter((i) => i.state !== "answered"), "replied", null, "Marked answered");
  const dismiss = (list: Item[]) => setStatus(list.filter((i) => i.state !== "dismissed"), "dismissed", null, "Dismissed");
  const restore = (list: Item[]) => setStatus(list, "waiting", null, "Back in Waiting");

  const remove = async (i: Item) => {
    const f = i.f;
    if (!f) return;
    stepPast([i]);
    setFollowUps((prev) => prev.filter((x) => x.id !== f.id));
    await supabase.from("follow_up_reminders").delete().eq("id", f.id);
    mail.reload();
    const undo = async () => {
      await supabase.from("follow_up_reminders").insert(f);
      mail.reload();
      await loadFollowUps();
    };
    lastUndo.current = undo;
    addToast("info", "Follow-up deleted", { action: { label: "Undo", onClick: undo } });
  };

  const track = async (i: Item) => {
    const s = i.s;
    if (!s || adding) return;
    setAdding(s.thread_id);
    const { data, error: failed } = await supabase
      .from("follow_up_reminders")
      .insert({ user_id: user.id, email_id: s.email_id, thread_id: s.thread_id, recipient_email: s.recipient_email, recipient_name: s.recipient_name, subject: s.subject, remind_at: new Date(Date.now() + 2 * DAY).toISOString() })
      .select("*")
      .single();
    setAdding(null);
    if (failed) return addToast("error", "Could not track that email. Nothing was changed.");
    setFollowUps((prev) => [...prev, data as FollowUp].sort((a, b) => a.remind_at.localeCompare(b.remind_at)));
    setHidden((prev) => new Set([...prev, s.thread_id]));
    setCursorKey((data as FollowUp).id);
    mail.reload();
    addToast("success", `Tracking it. The reminder is due ${onDate((data as FollowUp).remind_at)}.`);
  };

  // "Not this": a tracked follow-up is dismissed, a suggestion is stored as
  // dismissed so it does not come back.
  const notThis = async (i: Item) => {
    if (i.f) return dismiss([i]);
    const s = i.s!;
    stepPast([i]);
    setHidden((prev) => new Set([...prev, s.thread_id]));
    const { error: failed } = await supabase.from("follow_up_reminders").insert({
      user_id: user.id, email_id: s.email_id, thread_id: s.thread_id, recipient_email: s.recipient_email, recipient_name: s.recipient_name,
      subject: s.subject, remind_at: new Date().toISOString(), status: "dismissed",
    });
    if (failed) throw new Error("Could not dismiss it. Try again.");
    loadFollowUps();
  };

  const hide = (i: Item) => {
    if (!i.s) return;
    stepPast([i]);
    setHidden((prev) => new Set([...prev, i.s!.thread_id]));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[data-compose-modal]")) return;
      // "g" then a letter goes to another view; that letter is not an action here.
      if (Date.now() - goKey.current < 1500) return void (goKey.current = 0);
      const k = e.key.toLowerCase();
      if (k === "g") return void (goKey.current = Date.now());
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "x" && cursor) pick(cursor, e.shiftKey);
      else if (e.key === "Enter" && cursor) nudge(cursor);
      else if (k === "s") snooze(targets(), 3);
      else if (k === "a") answered(targets());
      else if (k === "t" && cursor?.s) track(cursor);
      else if (k === "z" && lastUndo.current) {
        const undo = lastUndo.current;
        lastUndo.current = null;
        undo().then(() => addToast("info", "Undid the last change"));
      } else if (e.key === "Escape" && picked.size) setPicked(new Set());
      else if (e.key === "Escape" && open) setOpen(false);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const change = (f: Filter) => {
    setFilter(f);
    setPicked(new Set());
    setOpen(false);
  };
  const active = cursor && (cursor.state === "due" || cursor.state === "waiting" || cursor.state === "snoozed");

  return (
    <>
      {selected.length ? (
        <header className="bar">
          <b className="bar-title mr-1.5">{selected.length} selected</b>
          <button className="btn" onClick={() => answered(selected)}>
            Mark answered <Kbd>A</Kbd>
          </button>
          <SnoozeMenu onSnooze={(days) => snooze(selected, days)} />
          <button className="btn" onClick={() => dismiss(selected)}>
            Dismiss
          </button>
          <button className="btn btn-plain" onClick={() => setPicked(new Set())}>
            Clear <Kbd>esc</Kbd>
          </button>
        </header>
      ) : (
        <ViewBar title="Follow-ups" search="Search follow-ups">
          <Seg
            value={filter}
            onChange={change}
            options={[
              { id: "waiting", label: "Waiting", count: counts.active },
              { id: "due", label: "Due now", count: counts.due, need: true },
              { id: "snoozed", label: "Snoozed", count: counts.snoozed },
              { id: "done", label: "Done" },
            ]}
          />
        </ViewBar>
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={listRef} className={`w-full flex-none overflow-y-auto border-line md:w-[440px] md:border-r ${open ? "hidden md:block" : ""}`} role="listbox" aria-label="Follow-ups">
          {loading ? (
            <div className="pt-9">
              <SkeletonRows count={9} tall />
            </div>
          ) : error ? (
            <p className="px-5 py-4 text-danger" role="alert">
              {error} Check that Tabellar is still running, then{" "}
              <button className="link !text-danger" onClick={() => loadFollowUps()}>
                try again
              </button>
              .
            </p>
          ) : !rows.length ? (
            search ? (
              <Empty icon="search" title="No follow-ups match that search">
                Try the name of the person or a word from the subject.
              </Empty>
            ) : filter === "waiting" ? (
              <Empty icon="schedule_send" title="Nobody owes you an answer">
                Mail you sent that goes two days without a reply is listed here. Track one and Tabellar reminds you when it is time to nudge.
              </Empty>
            ) : (
              <Empty icon="schedule_send" title={filter === "due" ? "No reminders are due" : filter === "snoozed" ? "Nothing is snoozed" : "Nothing here yet"}>
                {filter === "due" ? "A follow-up shows here in red once its reminder date has come." : filter === "snoozed" ? "A snoozed follow-up waits here until the date you chose." : "Follow-ups you mark answered or dismiss are kept here."}{" "}
                <button className="link" onClick={() => change("waiting")}>
                  Show what is waiting
                </button>
              </Empty>
            )
          ) : (
            items.map((item) => {
              if ("head" in item)
                return (
                  <div key={item.key} className="day">
                    <b>{item.name}</b>
                    <span className="truncate">{item.note}</span>
                    <span className="flex-1" />
                    <span className={item.need ? "count-need" : ""}>{item.count}</span>
                  </div>
                );
              const isCursor = cursor === item;
              const isPicked = picked.has(item.key);
              const due = item.state === "due";
              return (
                <div
                  key={item.key}
                  role="option"
                  aria-selected={isCursor}
                  className={`row2 group grid scroll-mt-[34px] grid-cols-[26px_minmax(0,1fr)_auto] gap-y-[3px] ${isPicked && !isCursor ? "bg-hover" : ""}`}
                  onClick={(e) => (e.shiftKey ? pick(item, true) : (setCursorKey(item.key), setOpen(true)))}
                  onDoubleClick={() => nudge(item)}
                >
                  <span className="row-span-2 grid place-items-start justify-center pt-px">
                    {item.f && (
                      <span className={isPicked ? "" : "hidden group-hover:block"}>
                        <Tick checked={isPicked} onChange={(_, e) => pick(item, e.shiftKey)} label={`Select follow-up with ${item.name}`} />
                      </span>
                    )}
                    <span className={!item.f ? "" : isPicked ? "hidden" : "group-hover:hidden"}>
                      <Glyph state={due ? "need" : item.state === "answered" ? "done" : "filed"} />
                    </span>
                  </span>
                  <div className="flex min-w-0 items-baseline gap-2">
                    <b className={`max-w-[55%] flex-none truncate text-ink ${due ? "font-semibold" : "font-normal"}`}>{item.name}</b>
                    <span className="truncate text-ink2">{item.subject}</span>
                  </div>
                  <time className="pl-2.5 text-xs text-ink3">{shortWhen(item.since)}</time>
                  <div className="col-span-2 flex min-w-0 gap-2.5 text-ink3">
                    <span className="min-w-0 flex-1 truncate">{item.state === "answered" || item.state === "dismissed" ? item.wrote.replace(/\s+/g, " ") : waited(item.since)}</span>
                    <span className={`flex-none text-xs ${due ? "font-semibold text-wax-ink" : ""}`}>{statusOf(item)}</span>
                    {item.state !== "answered" && item.state !== "dismissed" && (
                      <span className="-my-[5px] flex-none opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-aria-selected:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                        <NotThis
                          thing="followup"
                          sender={item.email}
                          who={item.name}
                          onNotThis={() => notThis(item)}
                          onDone={() => {
                            loadFollowUps();
                            loadSuggestions();
                          }}
                        />
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        {cursor ? (
          <div className={`min-w-0 flex-1 flex-col ${open ? "flex" : "hidden md:flex"}`}>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-[22px] md:px-10">
              <div className="max-w-[580px]">
                <button className="btn btn-plain -ml-2 mb-3 md:hidden" onClick={() => setOpen(false)}>
                  <Icon name="arrow_back" size={15} /> Follow-ups
                </button>
                <dl className="grid grid-cols-[58px_1fr] gap-y-[5px] border-b border-line-soft pb-4 text-[12.5px] text-ink2">
                  <dt className="text-ink3">To</dt>
                  <dd className="min-w-0 break-words">
                    <b className="font-medium text-ink">{cursor.name}</b> {cursor.email !== cursor.name && cursor.email}
                  </dd>
                  <dt className="text-ink3">Subject</dt>
                  <dd className="min-w-0 break-words">{cursor.subject}</dd>
                  <dt className="text-ink3">Sent</dt>
                  <dd>{sentOn(cursor.since)}</dd>
                </dl>
                <div className="mt-4 grid grid-cols-[22px_1fr] text-[13px] leading-normal text-ink2">
                  <Glyph state={cursor.state === "due" ? "need" : cursor.state === "answered" ? "done" : "info"} className="mt-px" />
                  {cursor.state === "due" ? (
                    <p>
                      <b className="font-semibold text-wax-ink">{overdue(cursor.f!.remind_at)}.</b> No answer for {plural(Math.max(1, daysAgo(cursor.since)), "day")}. The reminder was set for {onDate(cursor.f!.remind_at)}.
                    </p>
                  ) : cursor.state === "waiting" ? (
                    <p>
                      <b className="font-semibold text-ink">{waited(cursor.since)}.</b> The reminder is due {onDate(cursor.f!.remind_at)}; until then this stays quiet.
                    </p>
                  ) : cursor.state === "snoozed" ? (
                    <p>
                      <b className="font-semibold text-ink">Snoozed until {onDate(cursor.f!.snooze_until!)}.</b> {waited(cursor.since)}. It returns to Waiting on that date.
                    </p>
                  ) : cursor.state === "answered" ? (
                    <p>
                      <b className="font-semibold text-ink">Answered.</b> You marked this as answered, so there is no reminder.
                    </p>
                  ) : cursor.state === "dismissed" ? (
                    <p>
                      <b className="font-semibold text-ink">Dismissed.</b> No reminder is set. Restore it to wait for an answer again.
                    </p>
                  ) : (
                    <p>
                      <b className="font-semibold text-ink">Not tracked.</b> {waited(cursor.since)} with no answer. Track it and a reminder is set for two days from now.
                    </p>
                  )}
                </div>
                {cursor.wrote && (
                  <div className="inset mt-4">
                    <b className="mb-1 block text-xs font-semibold text-ink2">
                      You wrote, {dayLabel(cursor.since).name.toLowerCase()} {shortWhen(cursor.since)}
                    </b>
                    <p className="leading-normal text-ink2">{cursor.wrote}</p>
                  </div>
                )}
                {(active || cursor.state === "untracked") && (
                  <p className="mt-[22px] border-t border-line-soft pt-3.5 text-[12.5px] leading-normal text-ink3">Nudge opens a reply in the same conversation for you to write. Nothing is sent until you send it yourself.</p>
                )}
              </div>
            </div>
            <div className="flex flex-none flex-wrap items-center gap-2 border-t border-line py-[11px] pl-6 pr-4 md:pl-10">
              {active ? (
                <>
                  <button className="btn btn-pri" onClick={() => nudge(cursor)}>
                    Nudge <Kbd>↵</Kbd>
                  </button>
                  <SnoozeMenu up hint="S" onSnooze={(days) => snooze([cursor], days)} />
                  <button className="btn" onClick={() => answered([cursor])}>
                    Mark answered <Kbd>A</Kbd>
                  </button>
                </>
              ) : cursor.state === "untracked" ? (
                <>
                  <button className="btn btn-pri" disabled={adding === cursor.threadId} onClick={() => track(cursor)}>
                    Track <Kbd>T</Kbd>
                  </button>
                  <button className="btn" onClick={() => nudge(cursor)}>
                    Nudge <Kbd>↵</Kbd>
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => restore([cursor])}>
                  Restore to Waiting
                </button>
              )}
              <span className="flex-1" />
              <span className="flex items-center gap-0.5 whitespace-nowrap text-xs text-ink3">
                {rows.indexOf(cursor) + 1} of {rows.length}
                <button className="iconbtn" aria-label="Previous follow-up" onClick={() => move(-1)}>
                  <Icon name="expand_less" size={16} />
                </button>
                <button className="iconbtn" aria-label="Next follow-up" onClick={() => move(1)}>
                  <Icon name="expand_more" size={16} />
                </button>
              </span>
              {active ? (
                <button className="btn btn-plain" onClick={() => dismiss([cursor])}>
                  Dismiss
                </button>
              ) : cursor.state === "untracked" ? (
                <button className="btn btn-plain" onClick={() => hide(cursor)}>
                  Hide
                </button>
              ) : (
                <button className="btn btn-plain btn-danger" onClick={() => remove(cursor)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="hidden flex-1 md:block" />
        )}
      </div>
      <KeyHints
        left={loading ? "" : `${counts.active} waiting${counts.due ? `, ${counts.due} due now` : ""}${counts.snoozed ? `, ${counts.snoozed} snoozed` : ""}`}
        keys={[
          ["J K", "Move"],
          ["X", "Select"],
          ["↵", "Nudge"],
          ["S", "Snooze 3 days"],
          ["A", "Answered"],
          ["Z", "Undo"],
        ]}
      />
    </>
  );
}
