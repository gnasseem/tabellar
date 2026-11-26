import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import DateTimePicker from "../DateTimePicker";
import { ReaderById } from "../EmailDetail";
import { EmailField, useContacts } from "../EmailAutocomplete";
import { Empty, Glyph, Seg, SkeletonRows, ViewBar, clock } from "../ui";
import { NotThis } from "../NotThis";
import { MeetingPrep, useUpNext } from "../Prep";

// Meetings: two lists. To confirm holds what Tabellar found in mail, with the
// sentence the time came from and the free time that day; Add to calendar
// puts it on Google Calendar. Upcoming is Google Calendar itself, the next two
// weeks, with the email an event came from. The form for a new meeting or a
// changed time opens at the top only when asked for, and the line above the
// list takes the user's own time in words ("I have Machine Learning Mon and
// Wed 10 to 11:30"), read by the model and shown before it is added.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pending = {
  key: string;
  meetingId: string | null; // a meetings row waiting to be confirmed
  proposal: { id: string; hash: string } | null; // or a proposal waiting for approval
  emailId: string | null;
  title: string;
  start: string;
  end: string;
  asWritten: string | null;
  quote: string | null;
  location: string | null;
  attendees?: string[]; // who adding it to the calendar invites
};
type CalEvent = { id: string; title: string; start: string; end: string; allDay: boolean; attendees: string[]; people?: string[]; htmlLink: string | null };
type Source = { sender: string; subject: string };
type Slot = { start: string; end: string };
type Draft = { title: string; minutes: string; attendees: string; location: string; start: string };
type Form = { mode: "new" } | { mode: "change"; pending: Pending };
type Typed = { title: string; date: string; start: string; end: string; days: string[]; until: string | null; location: string | null };

const DAY_NAMES: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
const at = (date: string, hhmm: string) => clock(new Date(`${date}T${hhmm}:00`).toISOString());
function typedWhen(e: Typed): string {
  const time = `${at(e.date, e.start)} to ${at(e.date, e.end)}`;
  if (!e.days.length) return `${shortDay(`${e.date}T12:00`)}, ${time}`;
  const until = e.until ? `, until ${shortDay(`${e.until}T12:00`)}` : "";
  return `Every ${e.days.map((d) => DAY_NAMES[d]).join(" and ")}, ${time}, from ${shortDay(`${e.date}T12:00`)}${until}`;
}

const DAYS_AHEAD = 14;
const DURATIONS = [
  { id: "15", label: "15 min" },
  { id: "30", label: "30 min" },
  { id: "45", label: "45 min" },
  { id: "60", label: "1 hour" },
  { id: "90", label: "1.5 hours" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalInput = (d: Date) => `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nameOf = (s: string) => (s || "").replace(/<.*>/, "").replace(/"/g, "").trim();
const minutesBetween = (a: string, b: string) => Math.max(5, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// A day as a heading: Today, Tomorrow, else the weekday and date.
function dayName(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}
const shortDay = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

type Day = { slots: Slot[]; busy: Slot[] };

// Quarter-hour free slots joined into the stretches they cover.
function ranges(slots: Slot[]): Slot[] {
  const out: Slot[] = [];
  for (const s of [...slots].sort((a, b) => a.start.localeCompare(b.start))) {
    const last = out[out.length - 1];
    if (last && new Date(s.start).getTime() <= new Date(last.end).getTime()) {
      if (s.end > last.end) last.end = s.end;
    } else out.push({ ...s });
  }
  return out;
}

// Free time per day and meeting length, as Google Calendar reports it within
// the working hours. `get` asks once and returns null until the answer is in.
function useFreeSlots() {
  const [cache, setCache] = useState<Record<string, Day | "failed">>({});
  const asked = useRef(new Set<string>());
  const get = useCallback((day: string, minutes: number): Day | "failed" | null => {
    const key = `${day}|${minutes}`;
    if (!asked.current.has(key)) {
      asked.current.add(key);
      api(`/calendar/free-slots?duration=${minutes}&date=${day}&timezone=${encodeURIComponent(tz())}`)
        .then((r: { slots?: Slot[]; busy?: Slot[]; error?: string }) => setCache((c) => ({ ...c, [key]: r.error ? "failed" : { slots: r.slots || [], busy: r.busy || [] } })))
        .catch(() => setCache((c) => ({ ...c, [key]: "failed" })));
    }
    return cache[key] ?? null;
  }, [cache]);
  const forget = useCallback(() => {
    asked.current.clear();
    setCache({});
  }, []);
  return { get, forget };
}

// Whether the time of a meeting is free, and the rest of that day, in one line.
function FreeLine({ day, start, end }: { day: Day | "failed" | null; start: string; end: string }) {
  if (day === null) return <span className="skel inline-block h-2.5 w-48 align-middle" aria-label="Checking your calendar" />;
  if (day === "failed") return <span>The calendar could not be read</span>;
  const free = ranges(day.slots);
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  const open = !day.busy.some((r) => new Date(r.start).getTime() < e && new Date(r.end).getTime() > s);
  const inHours = free.some((r) => new Date(r.start).getTime() <= s && new Date(r.end).getTime() >= e);
  const rest = open && !inHours ? "outside your working hours" : free.length ? `free ${free.map((r) => `${clock(r.start)} to ${clock(r.end)}`).join(", ")}` : "nothing else free in working hours";
  return (
    <span>
      {open ? <b className="font-medium text-ink2">Free then</b> : <b className="font-medium text-warn">Not free then</b>}, {rest}
    </span>
  );
}

export default function MeetingsView() {
  const { user, addToast, search, liveChanges } = useApp();
  const supabase = createClient();
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [calError, setCalError] = useState(false);
  const [sources, setSources] = useState<Map<string, Source>>(new Map());
  const [linked, setLinked] = useState<Map<string, string>>(new Map()); // calendar event id to email id
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [typed, setTyped] = useState<Typed[] | null>(null);
  const [reading2, setReadingTyped] = useState(false);
  const free = useFreeSlots();
  // The meeting coming up in the next hour shows what is open on its own;
  // any other opens it on Enter or a click.
  const upNext = useUpNext(events);
  const [prepOpen, setPrepOpen] = useState<Map<string, boolean>>(new Map());
  const prepShown = (ev: CalEvent) => !!ev.people?.length && (prepOpen.get(ev.id) ?? upNext === ev.id);
  const togglePrep = (ev: CalEvent) => setPrepOpen((m) => new Map(m).set(ev.id, !prepShown(ev)));

  const loadPending = useCallback(async () => {
    const [m, p] = await Promise.all([
      supabase.from("meetings").select("*").eq("user_id", user.id).eq("status", "proposed").order("start_time", { ascending: true }),
      supabase.from("action_log").select("id, hash, detail, email_id").eq("user_id", user.id).eq("kind", "meeting").eq("status", "proposed"),
    ]);
    const list: Pending[] = [
      ...((m.data || []) as any[]).map((x) => ({ key: x.id, meetingId: x.id, proposal: null, emailId: x.email_id, title: x.title, start: x.start_time, end: x.end_time, asWritten: x.as_written, quote: x.quote, location: x.location, attendees: Array.isArray(x.attendees) ? x.attendees : [] })),
      ...((p.data || []) as any[]).map((x) => {
        const d = x.detail || {};
        return { key: `p:${x.id}`, meetingId: null, proposal: { id: x.id, hash: x.hash || "" }, emailId: x.email_id, title: d.title || "Meeting", start: d.start_time, end: d.end_time, asWritten: d.as_written ?? null, quote: d.quote ?? null, location: d.location ?? null };
      }),
    ].filter((x) => x.start);
    list.sort((a, b) => a.start.localeCompare(b.start));
    setPending(list);
    // The emails they came from, and the emails linked to calendar events.
    const [conf, cal] = await Promise.all([
      supabase.from("meetings").select("calendar_event_id, email_id").eq("user_id", user.id).not("calendar_event_id", "is", null).not("email_id", "is", null),
      supabase.from("email_processed").select("email_id, calendar").eq("user_id", user.id).not("calendar", "is", null).limit(2000),
    ]);
    const links = new Map<string, string>();
    for (const r of (cal.data || []) as any[]) if (r.calendar?.id) links.set(r.calendar.id, r.email_id);
    for (const r of (conf.data || []) as any[]) links.set(r.calendar_event_id, r.email_id);
    setLinked(links);
    const ids = [...new Set([...list.map((x) => x.emailId), ...links.values()].filter(Boolean))] as string[];
    if (!ids.length) return;
    const e = await supabase.from("emails").select("id, sender, sender_email, subject").in("id", ids);
    setSources(new Map(((e.data || []) as any[]).map((x) => [x.id, { sender: nameOf(x.sender) || x.sender_email || "", subject: x.subject || "(no subject)" }])));
  }, [user.id]);

  const loadEvents = useCallback(async () => {
    try {
      const r = (await api(`/calendar/events?date=${dateKey(new Date())}&days=${DAYS_AHEAD}&timezone=${encodeURIComponent(tz())}`)) as { events: CalEvent[]; error?: string };
      setCalError(!!r.error);
      setEvents((r.events || []).filter((ev) => new Date(ev.end).getTime() > Date.now()));
    } catch {
      setCalError(true);
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    loadPending();
  }, [loadPending, liveChanges.meetings, liveChanges.action_log]);
  useEffect(() => {
    loadEvents();
  }, [loadEvents, liveChanges.meetings]);

  const q = search.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const srcText = (emailId: string | null) => {
    const s = emailId ? sources.get(emailId) : undefined;
    return s ? `${s.sender} ${s.subject}` : "";
  };
  const toConfirm = (pending || []).filter((p) => matches(`${p.title} ${p.quote ?? ""} ${p.location ?? ""} ${srcText(p.emailId)}`));
  const upcoming = (events || []).filter((ev) => matches(`${ev.title} ${ev.attendees.join(" ")} ${srcText(linked.get(ev.id) ?? null)}`));
  const keys = [...toConfirm.map((p) => p.key), ...upcoming.map((ev) => `e:${ev.id}`)];
  const cursor = keys.includes(cursorKey ?? "") ? cursorKey : (keys[0] ?? null);
  const cursorPending = toConfirm.find((p) => p.key === cursor) ?? null;
  const cursorEvent = upcoming.find((ev) => `e:${ev.id}` === cursor) ?? null;

  const move = (delta: number) => {
    if (!keys.length) return;
    const at = cursor ? keys.indexOf(cursor) : -1;
    setCursorKey(keys[Math.min(keys.length - 1, Math.max(0, at + delta))]);
  };

  // Google Calendar, then the list, then the free time, which has changed.
  const confirm = async (p: Pending, changes?: Record<string, unknown>) => {
    setBusy(p.key);
    try {
      const r = (await api("/meetings/confirm", { id: p.meetingId ?? undefined, proposal: p.proposal ?? undefined, ...changes })) as { link: string | null };
      addToast("success", "On your calendar", r.link ? { action: { label: "Open", onClick: () => window.open(r.link!, "_blank", "noopener") } } : undefined);
      free.forget();
      loadPending();
      loadEvents();
      return true;
    } catch (e) {
      addToast("error", (e as Error).message);
      loadPending();
      return false;
    } finally {
      setBusy(null);
    }
  };

  // One that came from no email has no sender to say no to; it just goes.
  const remove = async (p: Pending) => {
    const { data } = await supabase.from("meetings").delete().eq("id", p.meetingId).eq("status", "proposed").select("*");
    loadPending();
    const row = (data || [])[0];
    if (row) addToast("info", "Meeting removed", { action: { label: "Undo", onClick: async () => (await supabase.from("meetings").insert(row), loadPending()) } });
  };

  // A meeting typed in by hand: kept here, then put on Google Calendar.
  const create = async (d: Draft) => {
    const start = new Date(d.start);
    const end = new Date(start.getTime() + Number(d.minutes) * 60000);
    const attendees = d.attendees.split(",").map((s) => s.trim()).filter(Boolean);
    const { data, error } = await supabase
      .from("meetings")
      .insert({ user_id: user.id, title: d.title.trim(), start_time: start.toISOString(), end_time: end.toISOString(), attendees, location: d.location.trim() || null, status: "proposed" })
      .select("id")
      .single();
    if (error || !data) {
      addToast("error", `The meeting was not saved: ${error?.message || "the database did not answer"}.`);
      return false;
    }
    const p: Pending = { key: data.id, meetingId: data.id, proposal: null, emailId: null, title: d.title, start: start.toISOString(), end: end.toISOString(), asWritten: null, quote: null, location: null, attendees };
    if (await confirm(p)) return true;
    // Not on the calendar: it waits in To confirm.
    return true;
  };

  const submit = async (d: Draft) => {
    if (!form) return;
    const ok =
      form.mode === "new"
        ? await create(d)
        : await confirm(form.pending, {
            title: d.title.trim(),
            start_time: new Date(d.start).toISOString(),
            end_time: new Date(new Date(d.start).getTime() + Number(d.minutes) * 60000).toISOString(),
            location: d.location.trim() || undefined,
            attendees: d.attendees.split(",").map((s) => s.trim()).filter(Boolean),
          });
    if (ok) setForm(null);
  };

  const readTyped = async () => {
    if (!said.trim() || reading2) return;
    setReadingTyped(true);
    try {
      const r = (await api("/calendar/from-text", { text: said.trim(), timezone: tz() })) as { events: Typed[] };
      if (!r.events.length) addToast("info", "No day and time in that. Try: Gym every Tuesday 7 to 8am.");
      else setTyped(r.events);
    } catch {
      addToast("error", "That needs the model, which did not answer. Check Settings, Models.");
    }
    setReadingTyped(false);
  };

  const addTyped = async () => {
    if (!typed?.length) return;
    setBusy("typed");
    try {
      const r = (await api("/calendar/add-typed", { events: typed, timezone: tz() })) as { added: { title: string }[] };
      addToast("success", r.added.length === 1 ? `${r.added[0].title} is on your calendar` : `${r.added.length} events are on your calendar`);
      setTyped(null);
      setSaid("");
      free.forget();
      loadEvents();
    } catch (e) {
      addToast("error", (e as Error).message || "The calendar did not take them.");
    }
    setBusy(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (reading || form || document.querySelector("[data-compose-modal]")) return;
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "n") setForm({ mode: "new" });
      else if (k === "e" && cursorPending) setForm({ mode: "change", pending: cursorPending });
      else if (e.key === "Enter" && cursorPending && !(e.target as HTMLElement).closest?.("button, a")) confirm(cursorPending);
      else if (e.key === "Enter" && cursorEvent?.people?.length && !(e.target as HTMLElement).closest?.("button, a")) togglePrep(cursorEvent);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (reading) return <ReaderById emailId={reading} onClose={() => setReading(null)} />;

  const reveal = "opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-aria-selected:opacity-100 has-[[aria-expanded=true]]:opacity-100";
  const mailButton = (emailId: string) => {
    const s = sources.get(emailId);
    const label = s ? `From ${s.sender ? `${s.sender}: ` : ""}${s.subject}` : "Open the email";
    return (
      <button className="iconbtn h-6 w-6" title={label} aria-label={label} onClick={(e) => (e.stopPropagation(), setReading(emailId))}>
        <Icon name="mail" size={14} />
      </button>
    );
  };

  // Upcoming, grouped by day.
  const days: { name: string; list: CalEvent[] }[] = [];
  for (const ev of upcoming) {
    const name = dayName(ev.allDay ? `${ev.start.slice(0, 10)}T12:00` : ev.start);
    if (days[days.length - 1]?.name !== name) days.push({ name, list: [] });
    days[days.length - 1].list.push(ev);
  }

  const loading = pending === null || events === null;
  const list = (
    <div className="min-h-0 flex-1 overflow-y-auto pb-4" role="listbox" aria-label="Meetings">
      <div className="px-6 pb-2 pt-5">
        <form
          className="addfield"
          onSubmit={(e) => {
            e.preventDefault();
            readTyped();
          }}
        >
          <Icon name="add" size={16} className="text-ink3" />
          <input value={said} maxLength={1500} placeholder="Add your own time: I have Machine Learning Mon and Wed 10 to 11:30 until 15 December" aria-label="Add your own time in words" onChange={(e) => (setSaid(e.target.value), setTyped(null))} />
          {said.trim() && (
            <button type="submit" className="btn-act" disabled={reading2}>
              {reading2 ? "Reading" : "Read"}
            </button>
          )}
        </form>
        {typed && (
          <div className="mt-2 rounded-[12px] bg-raised p-2 shadow-control">
            {typed.map((e, i) => (
              <div key={i} className="group flex min-h-[40px] items-center gap-3 rounded-[8px] px-2.5 hover:bg-hover">
                <Icon name={e.days.length ? "repeat" : "event"} size={15} className="flex-none text-ink3" />
                <b className="min-w-0 shrink-0 truncate font-medium text-ink">{e.title}</b>
                <span className="min-w-0 flex-1 truncate text-ink2">
                  {typedWhen(e)}
                  {e.location && <span className="text-ink3">, {e.location}</span>}
                </span>
                <button className="iconbtn h-6 w-6 opacity-0 group-hover:opacity-100" aria-label={`Leave out ${e.title}`} onClick={() => setTyped(typed.length > 1 ? typed.filter((_, j) => j !== i) : null)}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2 px-2.5 pb-1 pt-2">
              <span className="flex-1 text-xs text-ink3">Nobody is invited</span>
              <button className="btn btn-plain" onClick={() => (setTyped(null), setSaid(""))}>
                Cancel
              </button>
              <button className="btn btn-pri" disabled={busy === "typed"} onClick={addTyped}>
                {typed.length === 1 ? "Add to calendar" : `Add ${typed.length} to calendar`}
              </button>
            </div>
          </div>
        )}
      </div>
      {form && (
        <Scheduler
          key={form.mode === "new" ? "new" : form.pending.key}
          form={form}
          free={free.get}
          onSubmit={submit}
          onCancel={() => setForm(null)}
        />
      )}
      {loading ? (
        <div className="pt-9">
          <SkeletonRows count={10} />
        </div>
      ) : !toConfirm.length && !upcoming.length && !calError ? (
        q ? <Empty icon="search" title="Nothing matches that search" /> : <Empty icon="event" title="Nothing in the next two weeks" />
      ) : (
        <>
          {toConfirm.length > 0 && (
            <>
              <div className="day !static">
                <b>To confirm</b>
              </div>
              {toConfirm.map((p) => {
                const src = p.emailId ? sources.get(p.emailId) : undefined;
                const minutes = minutesBetween(p.start, p.end);
                return (
                  <div key={p.key} role="option" aria-selected={cursor === p.key} className="row2 group grid grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-y-[3px]" onClick={() => setCursorKey(p.key)}>
                    <span className="grid place-items-center">
                      <Glyph state="need" />
                    </span>
                    <b className="min-w-0 truncate font-semibold text-ink">{p.title}</b>
                    <div className="flex items-center gap-1 pl-2.5">
                      <span className={`flex items-center max-md:hidden max-md:group-aria-selected:flex ${reveal}`}>
                        {p.emailId && mailButton(p.emailId)}
                        <button className="link mx-1.5" onClick={(e) => (e.stopPropagation(), setForm({ mode: "change", pending: p }))}>
                          Change
                        </button>
                        {!p.emailId && p.meetingId && (
                          <button className="link mx-1.5" onClick={(e) => (e.stopPropagation(), remove(p))}>
                            Remove
                          </button>
                        )}
                        {p.emailId && <NotThis thing="meeting" id={p.meetingId ?? undefined} proposal={p.proposal?.id} who={src?.sender} onDone={loadPending} />}
                      </span>
                      <button className="btn-act" disabled={busy === p.key} onClick={(e) => (e.stopPropagation(), confirm(p))}>
                        Add to calendar
                      </button>
                    </div>
                    <span />
                    <p className="col-span-2 truncate text-ink2">
                      {shortDay(p.start)}, {clock(p.start)} to {clock(p.end)}
                      {p.asWritten && <span className="text-ink3">, {p.asWritten} in the email</span>}
                    </p>
                    <span />
                    <p className="col-span-2 truncate text-[12.5px] text-ink3">
                      {p.attendees?.length ? `Invites ${p.attendees.join(", ")}` : p.quote ? `"${p.quote}"` : src?.subject || ""}
                      {src?.sender && <span>, {src.sender}</span>}
                    </p>
                    <span />
                    <p className="col-span-2 truncate text-[12.5px] text-ink3">
                      <FreeLine day={free.get(dateKey(new Date(p.start)), minutes)} start={p.start} end={p.end} />
                    </p>
                  </div>
                );
              })}
            </>
          )}
          {calError && (
            <p className="px-6 pt-4 text-danger" role="alert">
              The calendar could not be read.{" "}
              <button className="link !text-danger" onClick={loadEvents}>
                Try again
              </button>
            </p>
          )}
          {days.map((d) => (
            <div key={d.name}>
              <div className="day !static">
                <b>{d.name}</b>
              </div>
              {d.list.map((ev) => {
                const emailId = linked.get(ev.id);
                const src = emailId ? sources.get(emailId) : undefined;
                const who = ev.attendees.length ? (ev.attendees.length > 1 ? `${ev.attendees[0]} and ${ev.attendees.length - 1} more` : ev.attendees[0]) : "";
                return (
                  <div key={ev.id}>
                  <div
                    role="option"
                    aria-selected={cursor === `e:${ev.id}`}
                    aria-expanded={ev.people?.length ? prepShown(ev) : undefined}
                    className="row group gap-2.5"
                    onClick={() => {
                      setCursorKey(`e:${ev.id}`);
                      if (ev.people?.length) togglePrep(ev);
                    }}
                  >
                    <span className="w-[26px] flex-none" />
                    <span className="w-[92px] flex-none text-ink3">{ev.allDay ? "All day" : `${clock(ev.start)} to ${clock(ev.end)}`}</span>
                    <span className="min-w-0 shrink truncate text-ink">{ev.title}</span>
                    <span className="min-w-0 flex-1 truncate text-ink3">{src?.sender ? `from ${src.sender}` : who}</span>
                    <span className={`flex flex-none items-center ${reveal}`}>
                      {emailId && mailButton(emailId)}
                      {ev.htmlLink && (
                        <a className="iconbtn h-6 w-6" href={ev.htmlLink} target="_blank" rel="noopener noreferrer" title="Open in Google Calendar" aria-label="Open in Google Calendar" onClick={(e) => e.stopPropagation()}>
                          <Icon name="open" size={14} />
                        </a>
                      )}
                    </span>
                  </div>
                  {prepShown(ev) && <MeetingPrep title={ev.title} people={ev.people!} onOpen={setReading} className="pl-10 md:pl-[152px]" />}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
    </div>
  );

  return (
    <>
      <ViewBar
        title="Meetings"
        search="Search meetings"
        right={
          <>
            <a className="iconbtn" href="https://calendar.google.com" target="_blank" rel="noopener noreferrer" title="Open Google Calendar" aria-label="Open Google Calendar">
              <Icon name="open" size={16} />
            </a>
            <button className="btn" onClick={() => setForm({ mode: "new" })}>
              New meeting
            </button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">{list}</div>
    </>
  );
}

// The form for a new meeting or a changed time, at the top of the list: what,
// how long, who and where on the left; when, from the day's free time or set
// by hand, on the right.
function Scheduler({ form, free, onSubmit, onCancel }: { form: Form; free: (day: string, minutes: number) => Day | "failed" | null; onSubmit: (d: Draft) => Promise<void>; onCancel: () => void }) {
  const { user } = useApp();
  const { contacts, primaryAccountId } = useContacts(user?.id ?? "");
  const [d, setD] = useState<Draft>(() => {
    if (form.mode === "change") {
      const p = form.pending;
      return { title: p.title, minutes: String(minutesBetween(p.start, p.end)), attendees: (p.attendees ?? []).join(", "), location: p.location ?? "", start: toLocalInput(new Date(p.start)) };
    }
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(9, 0, 0, 0);
    return { title: "", minutes: "30", attendees: "", location: "", start: toLocalInput(next) };
  });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));

  const day = d.start.slice(0, 10);
  const found = day ? free(day, Number(d.minutes)) : null;
  const slots = found && found !== "failed" ? found.slots : found;
  const shift = (delta: number) => {
    const t = new Date(d.start);
    t.setDate(t.getDate() + delta);
    set({ start: toLocalInput(t) });
  };
  const past = new Date(`${day}T23:59`).getTime() < Date.now();
  const invited = d.attendees.split(",").filter((s) => s.trim()).length;
  const label = "label mb-1.5 mt-4 block";

  return (
    <div className="mx-6 mb-3 mt-2 rounded-[12px] bg-raised shadow-control" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}>
      <div className="px-5 pb-4 pt-4">
        <div className="flex items-center">
          <h2 className="text-[15px] font-[650] tracking-[-0.01em] text-ink">{form.mode === "new" ? "New meeting" : "Change time"}</h2>
          <span className="flex-1" />
          <button className="iconbtn" aria-label="Close" onClick={onCancel}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="grid gap-x-8 md:grid-cols-2">
        <div>
        <label className={label} htmlFor="meeting-title">
          Title
        </label>
        <input id="meeting-title" className="input" value={d.title} onChange={(e) => set({ title: e.target.value })} autoFocus={form.mode === "new"} />
        <div className={label}>Length</div>
        <div className="[&>.seg]:flex-wrap">
          <Seg value={d.minutes} onChange={(minutes) => set({ minutes })} options={DURATIONS.some((x) => x.id === d.minutes) ? DURATIONS : [...DURATIONS, { id: d.minutes, label: `${d.minutes} min` }]} />
        </div>
        <div className={label}>People</div>
        <EmailField value={d.attendees} onChange={(attendees) => set({ attendees })} contacts={contacts} accountId={primaryAccountId} placeholder="Nobody is invited" multi />
        <label className={label} htmlFor="meeting-place">
          Place
        </label>
        <input id="meeting-place" className="input" value={d.location} onChange={(e) => set({ location: e.target.value })} placeholder="A link, a room or an address" />
        </div>
        <div>
        <div className={label}>When</div>
        <DateTimePicker value={d.start} onChange={(start) => set({ start })} placeholder="Pick a day and time" />
        <div className="mt-3 flex items-center gap-0.5">
          <b className="text-xs font-semibold text-ink2">Free on {day ? new Date(`${day}T12:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }) : ""}</b>
          <span className="flex-1" />
          <button className="iconbtn h-6 w-6" aria-label="Day before" disabled={new Date(`${day}T00:00`).getTime() <= Date.now()} onClick={() => shift(-1)}>
            <Icon name="chevron_left" size={15} />
          </button>
          <button className="iconbtn h-6 w-6" aria-label="Day after" onClick={() => shift(1)}>
            <Icon name="chevron_right" size={15} />
          </button>
        </div>
        <div className="mt-1.5">
          {past ? (
            <p className="text-[12.5px] text-ink3">That day has passed</p>
          ) : slots === null ? (
            <div className="skel h-3 w-56" aria-label="Checking your calendar" />
          ) : slots === "failed" ? (
            <p className="text-[12.5px] text-danger">The calendar could not be read</p>
          ) : !slots.length ? (
            <p className="text-[12.5px] text-ink3">Nothing free in your working hours</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {slots.map((s) => {
                const on = new Date(s.start).getTime() === new Date(d.start).getTime();
                return (
                  <button key={s.start} type="button" aria-pressed={on} onClick={() => set({ start: toLocalInput(new Date(s.start)) })} className={`h-6 rounded-md px-2 text-xs transition-colors duration-150 ${on ? "bg-ink font-medium text-canvas" : "text-ink2 hover:bg-sel hover:text-ink"}`}>
                    {clock(s.start)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        </div>
        </div>
      </div>
      <div className="flex flex-none items-center gap-2 border-t border-line-soft px-5 py-3">
        <button
          className="btn btn-pri"
          disabled={saving || !d.title.trim() || !d.start}
          onClick={async () => {
            setSaving(true);
            await onSubmit(d);
            setSaving(false);
          }}
        >
          Add to calendar
        </button>
        <button className="btn btn-plain" onClick={onCancel}>
          Cancel
        </button>
        {invited > 0 && <span className="ml-auto text-xs text-ink3">Google sends the invitations</span>}
      </div>
    </div>
  );
}
