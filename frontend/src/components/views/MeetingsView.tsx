import { useCallback, useEffect, useRef, useState } from "react";
import { setEmailFlag } from "@/lib/outcomes";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import DateTimePicker from "../DateTimePicker";
import EmailDetail from "../EmailDetail";
import { EmailField, useContacts } from "../EmailAutocomplete";
import { Empty, Glyph, Seg, SkeletonRows, ViewBar, clock, dayLabel } from "../ui";
import { NotThis, usePrefStops } from "../Profile";

// Meetings: the ones Tabellar proposed from mail and that wait to be confirmed,
// the ones coming up, and the ones that have passed. The list is on the left;
// the pane on the right shows one meeting, or the form that schedules a new one
// against the free time in the user's Google Calendar.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Meeting = {
  id: string;
  email_id?: string | null;
  title: string;
  start_time: string;
  end_time: string;
  attendees: string[] | null;
  location: string | null;
  as_written?: string | null; // the time as the email wrote it, when its zone is not the user's
  calendar_event_id: string | null;
  status: "proposed" | "confirmed" | "cancelled";
};

// A meeting the analysis noticed in an email, not yet a meeting here.
type SuggestedMeeting = {
  email_id: string;
  email_subject: string;
  email_sender: string;
  title: string;
  attendees: string[];
  location?: string;
  dateTime?: string;
  duration?: number;
  asWritten?: string;
};

type Source = { id: string; sender: string; sender_email: string; subject: string; received_at: string; summary?: string };
type FreeSlot = { start: string; end: string };
type SchedulerStep = "form" | "slots";
type SchedulingMode = "find" | "specific";
type WorkingHours = { start?: string; end?: string; days?: number[] } | null;
type Filter = "confirm" | "upcoming" | "past";
type Head = { head: true; key: string; name: string };
type Row = { key: string; meeting?: Meeting; suggestion?: SuggestedMeeting };

const DURATIONS = [
  { id: "15", label: "15 min" },
  { id: "30", label: "30 min" },
  { id: "45", label: "45 min" },
  { id: "60", label: "1 hour" },
  { id: "90", label: "1.5 hours" },
  { id: "120", label: "2 hours" },
];

const pad = (n: number) => String(n).padStart(2, "0");

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The value a DateTimePicker holds: local "YYYY-MM-DDTHH:MM".
function toLocalInput(d: Date): string {
  return `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nameOf(s: string): string {
  return (s || "").replace(/<.*>/, "").replace(/"/g, "").trim();
}

function nextWorkingDay(d: Date, wh: WorkingHours): Date {
  const days = wh?.days || [1, 2, 3, 4, 5];
  const next = new Date(d);
  do {
    next.setDate(next.getDate() + 1);
  } while (!days.includes(next.getDay()));
  return next;
}

function prevWorkingDay(d: Date, min: Date, wh: WorkingHours): Date | null {
  const days = wh?.days || [1, 2, 3, 4, 5];
  const prev = new Date(d);
  do {
    prev.setDate(prev.getDate() - 1);
  } while (!days.includes(prev.getDay()));
  return dateKey(prev) < dateKey(min) ? null : prev;
}

function groupSlotsByHour(slots: FreeSlot[]): Record<string, FreeSlot[]> {
  const groups: Record<string, FreeSlot[]> = {};
  for (const slot of slots) {
    const label = `${new Date(slot.start).getHours()}:00`;
    if (!groups[label]) groups[label] = [];
    groups[label].push(slot);
  }
  return groups;
}

// Quarter-hour slots joined into the stretches of free time they cover.
function freeRanges(slots: FreeSlot[]): FreeSlot[] {
  const out: FreeSlot[] = [];
  for (const s of [...slots].sort((a, b) => a.start.localeCompare(b.start))) {
    const last = out[out.length - 1];
    if (last && new Date(s.start).getTime() <= new Date(last.end).getTime()) {
      if (new Date(s.end).getTime() > new Date(last.end).getTime()) last.end = s.end;
    } else out.push({ ...s });
  }
  return out;
}

function isOutsideWorkingHours(isoStr: string, wh: WorkingHours): boolean {
  if (!isoStr) return false;
  const d = new Date(isoStr);
  const days = wh?.days || [1, 2, 3, 4, 5];
  if (!days.includes(d.getDay())) return true;
  const [startH, startM] = (wh?.start || "09:00").split(":").map(Number);
  const [endH, endM] = (wh?.end || "17:00").split(":").map(Number);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return minutes < startH * 60 + startM || minutes >= endH * 60 + endM;
}

// The start of the next working day that is still ahead, as a picker value.
function getNextWorkingSlot(wh: WorkingHours): string {
  const now = new Date();
  const days = wh?.days || [1, 2, 3, 4, 5];
  const [startH, startM] = (wh?.start || "09:00").split(":").map(Number);
  for (let d = 0; d <= 7; d++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + d);
    candidate.setHours(startH, startM, 0, 0);
    if (days.includes(candidate.getDay()) && candidate > now) return toLocalInput(candidate);
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return toLocalInput(tomorrow);
}

function minutesOf(m: Meeting): number {
  return Math.round((new Date(m.end_time).getTime() - new Date(m.start_time).getTime()) / 60000);
}

function durationLabel(min: string | number): string {
  const m = Number(min);
  if (m < 60) return `${m} min`;
  if (m === 60) return "1 hour";
  return `${m / 60} hours`;
}

function longDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

// Group header for a day that may lie ahead: Today, Tomorrow, then the weekday.
function dayHead(iso: string): { key: string; name: string } {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
  const weekday = d.toLocaleDateString([], { weekday: "long" });
  const date = d.toLocaleDateString([], { day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  const near = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : "";
  return { key: dateKey(d), name: near || `${weekday} ${date}` };
}

// When an email arrived, in words: "today 12:31", "Monday 17 November".
function wroteWhen(iso: string): string {
  const d = dayLabel(iso);
  return d.name === "Today" || d.name === "Yesterday" ? `${d.name.toLowerCase()} ${clock(iso)}` : `${d.name} ${d.date}`;
}

// The free times of one day, a line per hour. The chosen one is filled.
function SlotGrid({ slots, failed, selected, onPick, onRetry }: { slots: FreeSlot[] | null; failed: boolean; selected: string | null; onPick: (s: FreeSlot) => void; onRetry: () => void }) {
  if (slots === null)
    return (
      <div className="space-y-2.5 py-3" aria-busy="true" aria-label="Checking your calendar">
        {[72, 64, 55, 68].map((w) => (
          <div key={w} className="skel h-4" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  if (failed)
    return (
      <p className="py-3 leading-normal text-danger" role="alert">
        Your Google Calendar could not be read. Reconnect the account in Settings, under General, or set the time yourself.{" "}
        <button type="button" className="link" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  if (!slots.length) return <p className="py-3 text-ink3">Nothing free within your working hours</p>;
  return (
    <div>
      {Object.entries(groupSlotsByHour(slots)).map(([hour, list]) => (
        <div key={hour} className="flex flex-wrap items-center gap-1 border-b border-line-soft py-1 last:border-0">
          <span className="w-12 flex-none text-xs text-ink3">{hour}</span>
          {list.map((slot) => {
            const on = selected === slot.start;
            return (
              <button
                key={slot.start}
                type="button"
                aria-pressed={on}
                aria-label={clock(slot.start)}
                onClick={() => onPick(slot)}
                className={`h-6 rounded-md px-2 text-xs transition-colors duration-150 ${on ? "bg-ink font-medium text-canvas" : "text-ink hover:bg-sel"}`}
              >
                {on ? clock(slot.start) : `:${pad(new Date(slot.start).getMinutes())}`}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function MeetingsView() {
  const { user, profile, addToast, search, getViewCache, setViewCache, liveChanges, pendingMeetingSchedule, setPendingMeetingSchedule } = useApp();
  const { contacts, primaryAccountId } = useContacts(user?.id ?? "");
  const supabase = createClient();
  const wh = profile?.working_hours as WorkingHours;
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [sources, setSources] = useState<Map<string, Source>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [chosen, setChosen] = useState<Filter | null>(null);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [paneOpen, setPaneOpen] = useState(false); // narrow windows show the list or the pane
  const [reading, setReading] = useState<any | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Free time, per day and meeting length, as the calendar reported it.
  const [dayCache, setDayCache] = useState<Record<string, FreeSlot[]>>({});
  const dayCacheRef = useRef<Record<string, FreeSlot[]>>({});
  const inflightRef = useRef<Set<string>>(new Set());
  const [slotsFailed, setSlotsFailed] = useState<Set<string>>(new Set());

  // Meetings noticed in recent mail
  const [suggestedMeetings, setSuggestedMeetings] = useState<SuggestedMeeting[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [schedulingFromSuggestion, setSchedulingFromSuggestion] = useState<SuggestedMeeting | null>(null);

  // New meeting form
  const [showScheduler, setShowScheduler] = useState(false);
  const [schedulerStep, setSchedulerStep] = useState<SchedulerStep>("form");
  const [schedulingMode, setSchedulingMode] = useState<SchedulingMode>("find");
  const [newTitle, setNewTitle] = useState("");
  const [newDuration, setNewDuration] = useState("30");
  const [newAttendees, setNewAttendees] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [specificDateTime, setSpecificDateTime] = useState(() => getNextWorkingSlot(null));
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [selectedSlot, setSelectedSlot] = useState<FreeSlot | null>(null);
  const [creating, setCreating] = useState(false);

  // Changing a meeting
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editStartTime, setEditStartTime] = useState("");
  const [editDuration, setEditDuration] = useState("30");
  const [editAttendees, setEditAttendees] = useState("");
  const [saving, setSaving] = useState(false);

  const stopped = usePrefStops("meeting");

  const loadMeetings = useCallback(async () => {
    const cached = getViewCache("meetings");
    if (cached) {
      setMeetings(cached);
      setLoading(false);
    }
    const { data, error } = await supabase.from("meetings").select("*").eq("user_id", user.id).order("start_time", { ascending: false }).limit(500);
    setLoading(false);
    if (error) return setLoadError(error.message || "the database did not answer");
    setLoadError("");
    const result = (data || []) as Meeting[];
    setMeetings(result);
    setViewCache("meetings", result);
    // The emails the meetings came from.
    const ids = [...new Set(result.map((m) => m.email_id).filter(Boolean))] as string[];
    if (!ids.length) return;
    const [e, p] = await Promise.all([
      supabase.from("emails").select("id, sender, sender_email, subject, received_at").in("id", ids),
      supabase.from("email_processed").select("email_id, summary").in("email_id", ids),
    ]);
    const summary = new Map(((p.data || []) as any[]).map((x) => [x.email_id, x.summary]));
    setSources(new Map(((e.data || []) as any[]).map((x) => [x.id, { ...x, summary: summary.get(x.id) }])));
  }, [user.id]);

  useEffect(() => {
    loadMeetings();
  }, [loadMeetings, liveChanges.meetings]);

  // Meetings the analysis of the last three days of mail noticed.
  const loadSuggestedMeetings = useCallback(async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data: processed } = await supabase
      .from("email_processed")
      .select("email_id, quick_actions, calendar, emails!inner(subject, sender, sender_email, received_at, user_id)")
      .eq("emails.user_id", user.id)
      .filter("emails.received_at", "gte", threeDaysAgo)
      .not("quick_actions", "is", null)
      .limit(30);
    if (!processed) return;
    const suggestions: SuggestedMeeting[] = [];
    for (const p of processed as any[]) {
      const email = p.emails;
      const actions = Array.isArray(p.quick_actions) ? p.quick_actions : [];
      const meetingAction = actions.find((a: any) => a.action === "schedule_meeting");
      // Already on the calendar: nothing to suggest.
      if (!meetingAction || p.calendar || stopped(email?.sender_email, `${email?.subject ?? ""} ${meetingAction.label ?? ""}`)) continue;
      const details = meetingAction.meetingDetails;
      suggestions.push({
        email_id: p.email_id,
        email_subject: email?.subject || "(no subject)",
        email_sender: email?.sender || email?.sender_email || "",
        title:
          details?.title ||
          meetingAction.text?.trim() ||
          meetingAction.label?.replace(/^Schedule:\s*/i, "").replace(/^Add to Calendar:\s*/i, "") ||
          `Meeting about ${email?.subject?.slice(0, 40) || "an email"}`,
        attendees: details?.attendees || (email?.sender_email ? [email.sender_email] : []),
        dateTime: details?.dateTime || undefined,
        location: details?.location || undefined,
        duration: details?.duration || undefined,
        asWritten: details?.asWritten || undefined,
      });
    }
    setSuggestedMeetings(suggestions);
  }, [user.id, stopped]);

  useEffect(() => {
    loadSuggestedMeetings();
  }, [loadSuggestedMeetings, liveChanges.email_processed]);

  const slotKey = (date: Date, duration: string | number) => `${dateKey(date)}|${duration}`;

  const clearSlots = () => {
    dayCacheRef.current = {};
    setDayCache({});
    setSlotsFailed(new Set());
  };

  // Ask the calendar for the free times of one day, for a meeting of a length.
  const fetchSlots = async (date: Date, duration: string | number = newDuration, again = false) => {
    const key = slotKey(date, duration);
    if (inflightRef.current.has(key) || (key in dayCacheRef.current && !again)) return;
    inflightRef.current.add(key);
    if (again) {
      delete dayCacheRef.current[key];
      setDayCache((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
    let slots: FreeSlot[] = [];
    let failed = false;
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch(`/api/calendar/free-slots?duration=${duration}&date=${dateKey(date)}&timezone=${encodeURIComponent(tz)}`, { headers: { Authorization: `Bearer ${session?.access_token}` } });
      const body = await res.json().catch(() => ({}));
      failed = !res.ok || !!body.error;
      slots = body.slots || [];
    } catch {
      failed = true;
    }
    inflightRef.current.delete(key);
    dayCacheRef.current[key] = slots;
    setDayCache((prev) => ({ ...prev, [key]: slots }));
    setSlotsFailed((prev) => {
      const next = new Set(prev);
      if (failed) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const resetScheduler = () => {
    setNewTitle("");
    setNewAttendees("");
    setNewDuration("30");
    setNewLocation("");
    clearSlots();
    inflightRef.current.clear();
    setSelectedSlot(null);
    setSchedulerStep("form");
    setSchedulingMode("find");
    setSpecificDateTime(getNextWorkingSlot(wh));
    setShowScheduler(false);
    setSchedulingFromSuggestion(null);
    setPaneOpen(false);
  };

  const newMeeting = () => {
    resetScheduler();
    setEditingId(null);
    setShowScheduler(true);
    setPaneOpen(true);
  };

  // Open the form filled in, from a suggestion here or a quick action elsewhere.
  const prefillScheduler = (p: { title?: string; attendees?: string[]; duration?: number; location?: string; dateTime?: string }) => {
    setNewTitle(p.title || "");
    setNewAttendees((p.attendees || []).join(", "));
    setNewDuration(p.duration ? String(p.duration) : "30");
    setNewLocation(p.location || "");
    setSchedulerStep("form");
    clearSlots();
    setSelectedSlot(null);
    if (p.dateTime) {
      setSchedulingMode("specific");
      setSpecificDateTime(p.dateTime);
    } else {
      setSchedulingMode("find");
    }
    setEditingId(null);
    setShowScheduler(true);
    setPaneOpen(true);
  };

  const openSchedulerFromSuggestion = (s: SuggestedMeeting) => {
    prefillScheduler(s);
    setSchedulingFromSuggestion(s);
  };

  // Arriving from a "schedule meeting" quick action on an email.
  useEffect(() => {
    if (!pendingMeetingSchedule) return;
    prefillScheduler(pendingMeetingSchedule);
    setSchedulingFromSuggestion(null);
    setPendingMeetingSchedule(null);
  }, [pendingMeetingSchedule]);

  const startFindAvailable = () => {
    if (!newTitle.trim()) return;
    const workDays = wh?.days || [1, 2, 3, 4, 5];
    const first = new Date();
    while (!workDays.includes(first.getDay())) first.setDate(first.getDate() + 1);
    setCurrentDate(first);
    setSelectedSlot(null);
    setSchedulerStep("slots");
    fetchSlots(first);
    fetchSlots(nextWorkingDay(first, wh));
  };

  const goNextDay = () => {
    const next = nextWorkingDay(currentDate, wh);
    setCurrentDate(next);
    setSelectedSlot(null);
    fetchSlots(next);
    fetchSlots(nextWorkingDay(next, wh));
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const prevDay = prevWorkingDay(currentDate, today, wh);
  const goPrevDay = () => {
    if (!prevDay) return;
    setCurrentDate(prevDay);
    setSelectedSlot(null);
  };

  // Puts the event on Google Calendar, which invites the people added, then
  // keeps the meeting here. If the calendar refuses, it is kept as a proposal.
  const createMeeting = async () => {
    if (!newTitle || creating) return;
    if (schedulingMode === "find" && !selectedSlot) return;
    if (schedulingMode === "specific" && !specificDateTime) return;
    setCreating(true);
    const durationMin = parseInt(newDuration, 10) || 30;
    const startTime = schedulingMode === "specific" ? new Date(specificDateTime) : new Date(selectedSlot!.start);
    const endTime = new Date(startTime.getTime() + durationMin * 60000);
    const attendees = newAttendees.split(",").map((s) => s.trim()).filter(Boolean);

    const meetingData: Record<string, unknown> = {
      user_id: user.id,
      title: newTitle,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      attendees,
      status: "proposed",
      ...(newLocation ? { location: newLocation } : {}),
      ...(schedulingFromSuggestion ? { email_id: schedulingFromSuggestion.email_id } : {}),
    };

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const calRes = await fetch("/api/calendar/create-event", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          title: newTitle,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          attendees,
          location: newLocation || "",
          description: "Scheduled from Tabellar",
          sendUpdates: "all",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (calRes.ok) {
        const cal = await calRes.json();
        meetingData.calendar_event_id = cal.event_id;
        meetingData.status = "confirmed";
        addToast("success", "Meeting scheduled and added to your Google Calendar");
      } else {
        const errBody = await calRes.json().catch(() => ({}));
        const errMsg = String(errBody?.error ?? "calendar sync failed");
        console.error("[MeetingsView] calendar sync error:", errMsg);
        if (errMsg.includes("insufficient_scope") || errMsg.includes("No calendar access") || errMsg.includes("token refresh failed")) {
          addToast("info", "Meeting kept in Tabellar only. Reconnect your Google account in Settings to add meetings to your calendar.");
        } else {
          addToast("info", "Meeting kept in Tabellar only: Google Calendar did not accept it.");
        }
      }
    } catch {
      addToast("info", "Meeting kept in Tabellar only: Google Calendar could not be reached.");
    }

    const { data, error } = await supabase.from("meetings").insert(meetingData).select("id").single();
    setCreating(false);
    if (error) return addToast("error", `The meeting was not saved: ${error.message}. Try again.`);
    resetScheduler();
    setChosen(meetingData.status === "proposed" ? "confirm" : "upcoming");
    if (data?.id) setCursorKey(data.id);
    loadMeetings();
  };

  const setStatus = async (m: Meeting, status: Meeting["status"]) => {
    const { error } = await supabase.from("meetings").update({ status }).eq("id", m.id);
    if (error) {
      addToast("error", `That was not saved: ${error.message}. Try again.`);
      return false;
    }
    setMeetings((prev) => prev.map((x) => (x.id === m.id ? { ...x, status } : x)));
    return true;
  };

  const openEdit = (m: Meeting) => {
    setEditTitle(m.title);
    setEditStartTime(toLocalInput(new Date(m.start_time)));
    setEditDuration(String(minutesOf(m)));
    setEditAttendees((m.attendees || []).join(", "));
    setShowScheduler(false);
    setEditingId(m.id);
    setPaneOpen(true);
  };

  const saveMeeting = async (m: Meeting) => {
    if (!editTitle || !editStartTime) return;
    setSaving(true);
    const startTime = new Date(editStartTime);
    const endTime = new Date(startTime.getTime() + (parseInt(editDuration, 10) || 30) * 60000);
    const attendees = editAttendees.split(",").map((s) => s.trim()).filter(Boolean);
    const updates = { title: editTitle, start_time: startTime.toISOString(), end_time: endTime.toISOString(), attendees };

    await supabase.from("meetings").update(updates).eq("id", m.id);

    if (m.calendar_event_id) {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const res = await fetch("/api/calendar/update-event", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ event_id: m.calendar_event_id, ...updates }),
        });
        if (res.ok) addToast("success", "Meeting updated. The people invited have been told.");
        else addToast("info", "Saved in Tabellar, but Google Calendar did not accept the change.");
      } catch {
        addToast("info", "Saved in Tabellar, but Google Calendar could not be reached.");
      }
      clearSlots();
    } else {
      addToast("success", "Meeting updated");
    }

    setMeetings((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...updates } : x)));
    setEditingId(null);
    setSaving(false);
  };

  const openEmailById = async (emailId: string) => {
    const { data } = await supabase.from("emails").select("*, email_processed(*)").eq("id", emailId).single();
    if (data) setReading(data);
    else addToast("error", "That email is no longer in Tabellar.");
  };

  // What the list shows: the chosen filter, the search, grouped by day.
  const q = search.trim().toLowerCase();
  const now = Date.now();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const sourceOf = (m: Meeting) => (m.email_id ? sources.get(m.email_id) : undefined);
  const proposed = meetings.filter((m) => m.status === "proposed");
  const suggested = suggestedMeetings.filter((s) => !dismissed.has(s.email_id) && !meetings.some((m) => m.email_id === s.email_id) && matches(`${s.title} ${s.email_sender} ${s.email_subject}`));
  const filter: Filter = chosen ?? (proposed.length || suggested.length ? "confirm" : "upcoming");

  const listed = meetings
    .filter((m) => (filter === "confirm" ? m.status === "proposed" : filter === "upcoming" ? new Date(m.start_time).getTime() >= now : new Date(m.start_time).getTime() < now))
    .filter((m) => matches(`${m.title} ${(m.attendees || []).join(" ")} ${m.location || ""} ${sourceOf(m)?.sender || ""} ${sourceOf(m)?.subject || ""}`))
    .sort((a, b) => (filter === "past" ? b.start_time.localeCompare(a.start_time) : a.start_time.localeCompare(b.start_time)));

  const items: (Head | Row)[] = [];
  for (const m of listed) {
    const d = dayHead(m.start_time);
    const head = items.findLast((i): i is Head => "head" in i);
    if (head?.key !== d.key) items.push({ head: true, key: d.key, name: d.name });
    items.push({ key: m.id, meeting: m });
  }
  if (filter === "confirm" && suggested.length) {
    items.push({ head: true, key: "suggested", name: "Suggested" });
    for (const s of suggested) items.push({ key: `s:${s.email_id}`, suggestion: s });
  }

  const rows = items.filter((i): i is Row => !("head" in i));
  const cursor = rows.find((r) => r.key === cursorKey) || rows[0] || null;
  const current = cursor?.meeting || null;
  const editing = !showScheduler && current && current.id === editingId ? current : null;
  // The row to land on when the one at `key` leaves the list.
  const after = (key: string) => {
    const at = rows.findIndex((r) => r.key === key);
    return (rows[at + 1] || rows[at - 1])?.key ?? null;
  };

  const select = (key: string) => {
    setCursorKey(key);
    setShowScheduler(false);
    setEditingId(null);
    setPaneOpen(true);
  };

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorKey(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].key);
  };

  const confirmMeeting = async (m: Meeting) => {
    if (filter === "confirm") setCursorKey(after(m.id));
    if (await setStatus(m, "confirmed")) addToast("success", "Meeting confirmed", { action: { label: "Undo", onClick: () => setStatus(m, "proposed") } });
  };

  const cancelMeeting = async (m: Meeting) => {
    if (filter === "confirm") setCursorKey(after(m.id));
    if (await setStatus(m, "cancelled")) addToast("info", "Meeting cancelled", { action: { label: "Undo", onClick: () => setStatus(m, m.status) } });
  };

  const removeMeeting = async (m: Meeting) => {
    setCursorKey(after(m.id));
    const { error } = await supabase.from("meetings").delete().eq("id", m.id);
    if (error) return addToast("error", `The meeting was not removed: ${error.message}. Try again.`);
    setMeetings((prev) => prev.filter((x) => x.id !== m.id));
    const undo = async () => {
      await supabase.from("meetings").insert({ ...m, user_id: user.id });
      loadMeetings();
    };
    addToast("info", m.calendar_event_id ? "Meeting removed from Tabellar. The event stays on your Google Calendar." : "Meeting removed", { action: { label: "Undo", onClick: undo } });
  };

  // Free time on the day of the meeting in the pane, and on the day being
  // picked while its time is changed.
  const upcoming = !showScheduler && current && current.status !== "cancelled" && new Date(current.start_time).getTime() > now ? current : null;
  const upcomingKey = upcoming ? slotKey(new Date(upcoming.start_time), minutesOf(upcoming)) : "";
  useEffect(() => {
    if (upcoming && !(upcomingKey in dayCache)) fetchSlots(new Date(upcoming.start_time), minutesOf(upcoming));
  }, [upcomingKey, upcomingKey in dayCache]);

  const editDate = editing && editStartTime && new Date(editStartTime).getTime() > today.getTime() ? new Date(editStartTime) : null;
  const editKey = editDate ? slotKey(editDate, editDuration) : "";
  useEffect(() => {
    if (editDate && !(editKey in dayCache)) fetchSlots(editDate, editDuration);
  }, [editKey, editKey in dayCache]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor?.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The forms keep the keyboard to themselves.
      if (reading || showScheduler || editing || document.querySelector("[data-compose-modal]")) return;
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "n") newMeeting();
      else if (k === "e" && current && current.status !== "cancelled") openEdit(current);
      else if (e.key === "Enter" && cursor) {
        // A focused button or link takes its own Enter.
        if ((e.target as HTMLElement).closest?.("button, a")) return;
        if (current?.status === "proposed") confirmMeeting(current);
        else if (cursor.suggestion) openSchedulerFromSuggestion(cursor.suggestion);
        else return;
      } else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (reading)
    return (
      <EmailDetail
        key={reading.id}
        email={reading}
        onBack={() => setReading(null)}
        onArchive={() => {
          const id = reading.id;
          setReading(null);
          setEmailFlag(id, "archive")
            .then((undo) => addToast("success", "Archived", { action: { label: "Undo", onClick: () => void undo() } }))
            .catch((e: Error) => addToast("error", `Could not archive: ${e.message}`));
        }}
        onReply={() => setReading(null)}
        onMarkUnread={() => {
          const id = reading.id;
          setReading(null);
          setEmailFlag(id, "unread").catch(() => {});
        }}
        onSnooze={() => setReading(null)}
        onRethink={(updated: any) => setReading((prev: any) => (prev ? { ...prev, email_processed: updated } : prev))}
      />
    );

  const who = (m: Meeting) => {
    const people = m.attendees || [];
    if (people.length) return people.length > 1 ? `${people[0]} and ${people.length - 1} more` : people[0];
    return nameOf(sourceOf(m)?.sender || "");
  };

  const schedulerSlotKey = slotKey(currentDate, newDuration);
  const schedulerSlots = dayCache[schedulerSlotKey] ?? null;
  const specificOutside = isOutsideWorkingHours(specificDateTime, wh);
  const invited = newAttendees.split(",").filter((s) => s.trim()).length;

  // Shared by the pane's three layouts: a scrolling body over a bar of actions.
  const pane = "flex min-w-0 flex-1 flex-col";
  const paneBody = "min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-[22px] md:px-10";
  const paneBar = "flex flex-none flex-wrap items-center gap-2 border-t border-line py-[11px] pl-6 pr-4 md:pl-10";
  const paneTitle = "text-[15px] font-[650] leading-snug tracking-[-0.01em]";
  const fieldLabel = "label mb-1.5 mt-4 block";
  const back = (
    <button className="iconbtn -ml-1.5 mb-2 md:hidden" aria-label="Back to the list" onClick={() => setPaneOpen(false)}>
      <Icon name="arrow_back" size={16} />
    </button>
  );
  const sourceInset = (emailId: string, sender: string, subject: string, receivedAt?: string, summary?: string) => (
    <div className="inset mt-4">
      <div className="mb-1 flex justify-between gap-3 text-xs text-ink3">
        <b className="truncate font-semibold text-ink2">
          {nameOf(sender) || "Someone"} wrote{receivedAt ? `, ${wroteWhen(receivedAt)}` : ""}
        </b>
        <button className="link flex-none" onClick={() => openEmailById(emailId)}>
          Open the email
        </button>
      </div>
      <p className="font-medium leading-snug text-ink">{subject || "(no subject)"}</p>
      {summary && <p className="mt-1 leading-normal text-ink2">{summary}</p>}
    </div>
  );

  // On a narrow window the pane takes the place of the list, when it has something to show.
  const paneShown = paneOpen && (showScheduler || !!cursor);
  let paneContent: React.ReactNode = <div className="flex-1" />;

  if (showScheduler) {
    paneContent = (
      <div className={pane}>
        <div className={paneBody}>
          <div className="max-w-[460px]">
            {back}
            {schedulerStep === "form" ? (
              <>
                <h2 className={paneTitle}>{schedulingFromSuggestion ? "Schedule this meeting" : "New meeting"}</h2>
                {schedulingFromSuggestion && <p className="mt-0.5 truncate text-xs text-ink3">From the email "{schedulingFromSuggestion.email_subject}"</p>}
                <label className={fieldLabel} htmlFor="meeting-title">
                  Title
                </label>
                <input id="meeting-title" className="input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Product sync with Alex" autoFocus />
                <div className={fieldLabel}>Length</div>
                <div className="[&>.seg]:flex-wrap">
                  <Seg value={newDuration} onChange={setNewDuration} options={DURATIONS} />
                </div>
                <div className={fieldLabel}>People</div>
                <EmailField value={newAttendees} onChange={setNewAttendees} contacts={contacts} accountId={primaryAccountId} placeholder="alex@example.com, sarah@example.com" multi />
                <label className={fieldLabel} htmlFor="meeting-place">
                  Place
                </label>
                <input id="meeting-place" className="input" value={newLocation} onChange={(e) => setNewLocation(e.target.value)} placeholder="A link, a room or an address" />
                <div className={fieldLabel}>Time</div>
                <div className="[&>.seg]:flex-wrap">
                  <Seg
                    value={schedulingMode}
                    onChange={setSchedulingMode}
                    options={[
                      { id: "find", label: "Find a free time" },
                      { id: "specific", label: "Set the time" },
                    ]}
                  />
                </div>
                {schedulingMode !== "find" && (
                  <div className="mt-2">
                    <DateTimePicker value={specificDateTime} onChange={setSpecificDateTime} placeholder="Pick date and time" showWarning={specificOutside} />
                    {specificOutside && <p className="mt-1.5 text-xs text-warn">Outside your working hours</p>}
                  </div>
                )}
              </>
            ) : (
              <>
                <h2 className={paneTitle}>Pick a time</h2>
                <p className="mt-0.5 truncate text-xs text-ink3">
                  {newTitle}, {durationLabel(newDuration)}
                  {invited > 0 && `, ${invited} ${invited === 1 ? "person" : "people"}`}
                </p>
                <div className="mt-4 flex items-center gap-0.5 border-b border-line pb-2">
                  <b className="font-semibold">{longDate(currentDate)}</b>
                  <span className="flex-1" />
                  {schedulerSlots !== null && !slotsFailed.has(schedulerSlotKey) && <span className="mr-1.5 text-xs text-ink3">{schedulerSlots.length ? `${schedulerSlots.length} free` : "Nothing free"}</span>}
                  <button className="iconbtn" disabled={!prevDay} onClick={goPrevDay} aria-label="Previous working day">
                    <Icon name="chevron_left" size={16} />
                  </button>
                  <button className="iconbtn" onClick={goNextDay} aria-label="Next working day">
                    <Icon name="chevron_right" size={16} />
                  </button>
                </div>
                <SlotGrid slots={schedulerSlots} failed={slotsFailed.has(schedulerSlotKey)} selected={selectedSlot?.start ?? null} onPick={setSelectedSlot} onRetry={() => fetchSlots(currentDate, newDuration, true)} />
                {selectedSlot && (
                  <p className="inset mt-4 text-ink2">
                    <b className="font-semibold text-ink">{longDate(selectedSlot.start)}</b>, {clock(selectedSlot.start)} to {clock(new Date(new Date(selectedSlot.start).getTime() + parseInt(newDuration, 10) * 60000).toISOString())}, {durationLabel(newDuration)}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
        <div className={paneBar}>
          {schedulerStep === "form" && schedulingMode === "find" ? (
            <button className="btn btn-pri" disabled={!newTitle.trim()} onClick={startFindAvailable}>
              Find free times
            </button>
          ) : (
            <button className="btn btn-pri" disabled={creating || !newTitle.trim() || (schedulerStep === "slots" ? !selectedSlot : !specificDateTime)} onClick={createMeeting}>
              {creating ? "Scheduling" : "Schedule meeting"}
            </button>
          )}
          {schedulerStep === "slots" ? (
            <button className="btn" onClick={() => (setSchedulerStep("form"), setSelectedSlot(null))}>
              Back
            </button>
          ) : (
            <button className="btn" onClick={resetScheduler}>
              Cancel
            </button>
          )}
          {(schedulerStep === "slots" || schedulingMode === "specific") && <small className="ml-1.5 text-xs text-ink3">{invited > 0 ? "Google Calendar sends the invitations." : "It goes on your Google Calendar."}</small>}
        </div>
      </div>
    );
  } else if (editing) {
    const m = editing;
    const slots = editDate ? (dayCache[editKey] ?? null) : null;
    const picked = (slots || []).find((s) => new Date(s.start).getTime() === new Date(editStartTime).getTime())?.start ?? null;
    paneContent = (
      <div className={pane}>
        <div className={paneBody}>
          <div className="max-w-[460px]">
            {back}
            <h2 className={paneTitle}>Change this meeting</h2>
            <label className={fieldLabel} htmlFor="edit-title">
              Title
            </label>
            <input id="edit-title" className="input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} autoFocus />
            <div className={fieldLabel}>Starts</div>
            <DateTimePicker value={editStartTime} onChange={setEditStartTime} placeholder="Pick date and time" showWarning={isOutsideWorkingHours(editStartTime, wh)} />
            {isOutsideWorkingHours(editStartTime, wh) && <p className="mt-1.5 text-xs text-warn">This is outside your working hours.</p>}
            <div className={fieldLabel}>Length</div>
            <div className="[&>.seg]:flex-wrap">
              <Seg value={editDuration} onChange={setEditDuration} options={DURATIONS.some((d) => d.id === editDuration) ? DURATIONS : [...DURATIONS, { id: editDuration, label: durationLabel(editDuration) }]} />
            </div>
            <div className={fieldLabel}>People</div>
            <EmailField value={editAttendees} onChange={setEditAttendees} contacts={contacts} accountId={primaryAccountId} placeholder="alex@example.com, sarah@example.com" multi />
            {editDate && (
              <>
                <div className={`${fieldLabel} border-b border-line pb-2`}>Free on {longDate(editDate)}</div>
                <SlotGrid slots={slots} failed={slotsFailed.has(editKey)} selected={picked} onPick={(s) => setEditStartTime(toLocalInput(new Date(s.start)))} onRetry={() => fetchSlots(editDate, editDuration, true)} />
              </>
            )}
          </div>
        </div>
        <div className={paneBar}>
          <button className="btn btn-pri" disabled={!editTitle.trim() || !editStartTime || saving} onClick={() => saveMeeting(m)}>
            {saving ? "Saving" : "Save changes"}
          </button>
          <button className="btn" onClick={() => setEditingId(null)}>
            Cancel
          </button>
          {m.calendar_event_id && <small className="ml-1.5 text-xs text-ink3">Saving updates Google Calendar and tells the people invited.</small>}
        </div>
      </div>
    );
  } else if (current) {
    const m = current;
    const src = sourceOf(m);
    const slots = upcoming ? (dayCache[upcomingKey] ?? null) : null;
    const ranges = freeRanges(slots || []);
    const start = new Date(m.start_time).getTime();
    const end = new Date(m.end_time).getTime();
    const free = ranges.some((r) => new Date(r.start).getTime() <= start && new Date(r.end).getTime() >= end);
    paneContent = (
      <div className={pane}>
        <div className={paneBody}>
          <div className="max-w-[580px]">
            {back}
            <h2 className={`${paneTitle} ${m.status === "cancelled" ? "text-ink3 line-through" : ""}`}>{m.title}</h2>
            <p className="-ml-0.5 mt-1 flex items-center gap-1 text-xs">
              {m.status === "proposed" ? (
                <>
                  <Glyph state="need" />
                  <b className="font-semibold text-wax-ink">To confirm</b>
                </>
              ) : m.status === "confirmed" ? (
                <>
                  <Glyph state="done" />
                  <span className="text-ink2">Confirmed{m.calendar_event_id ? ", on your Google Calendar" : ""}</span>
                </>
              ) : (
                <span className="ml-0.5 text-ink3">Cancelled</span>
              )}
            </p>
            <dl className="mt-4 grid grid-cols-[58px_1fr] gap-y-[5px] border-b border-line-soft pb-4 text-[12.5px] text-ink2">
              <dt className="text-ink3">When</dt>
              <dd>
                <b className="font-medium text-ink">{longDate(m.start_time)}</b>, {clock(m.start_time)} to {clock(m.end_time)}, {durationLabel(minutesOf(m))}
                {m.as_written && <span className="text-ink3"> ({m.as_written} in the email)</span>}
              </dd>
              <dt className="text-ink3">Who</dt>
              <dd>{(m.attendees || []).join(", ") || (src ? nameOf(src.sender) || src.sender_email : "Nobody is invited")}</dd>
              <dt className="text-ink3">Where</dt>
              <dd>{m.location || "No place given"}</dd>
            </dl>
            {src && sourceInset(src.id, src.sender || src.sender_email, src.subject, src.received_at, src.summary)}
            {upcoming && (
              <>
                <h3 className="label mb-1 mt-5">Your calendar that day</h3>
                {slots === null ? (
                  <div className="skel mt-1.5 h-3 w-56" aria-busy="true" aria-label="Checking your calendar" />
                ) : slotsFailed.has(upcomingKey) ? (
                  <p className="text-[12.5px] leading-normal text-danger" role="alert">
                    Your Google Calendar could not be read. Reconnect the account in Settings, under General.{" "}
                    <button className="link" onClick={() => fetchSlots(new Date(m.start_time), minutesOf(m), true)}>
                      Try again
                    </button>
                  </p>
                ) : (
                  <p className="text-[12.5px] leading-normal text-ink2">
                    {!m.calendar_event_id &&
                      (isOutsideWorkingHours(m.start_time, wh) ? (
                        <b className="font-medium text-warn">This is outside your working hours. </b>
                      ) : free ? (
                        <b className="font-medium text-ink">You are free at this time. </b>
                      ) : (
                        <b className="font-medium text-warn">Something is already on your calendar at this time. </b>
                      ))}
                    {ranges.length ? `Free within your working hours: ${ranges.map((r) => `${clock(r.start)} to ${clock(r.end)}`).join(", ")}.` : "Nothing else is free within your working hours."}
                  </p>
                )}
              </>
            )}
            <div className="mt-[22px] grid grid-cols-[22px_1fr] border-t border-line-soft pt-3.5 text-[12.5px] leading-normal text-ink2">
              <Glyph state="info" />
              <p>{m.status === "cancelled" ? (m.calendar_event_id ? "Cancelled here, still on your Google Calendar" : "Cancelled") : m.calendar_event_id ? "On your Google Calendar" : "Not on your Google Calendar"}</p>
            </div>
          </div>
        </div>
        <div className={paneBar}>
          {m.status === "proposed" && (
            <button className="btn btn-pri" onClick={() => confirmMeeting(m)}>
              Confirm
            </button>
          )}
          {m.status !== "cancelled" && (
            <>
              <button className="btn" onClick={() => openEdit(m)}>
                Change time
              </button>
              <button className="btn" onClick={() => cancelMeeting(m)}>
                Cancel meeting
              </button>
            </>
          )}
          <span className="flex-1" />
          <span className="hidden items-center gap-0.5 whitespace-nowrap text-xs text-ink3 lg:flex">
            {rows.indexOf(cursor!) + 1} of {rows.length}
            <button className="iconbtn" aria-label="Previous meeting" onClick={() => move(-1)}>
              <Icon name="expand_less" size={16} />
            </button>
            <button className="iconbtn" aria-label="Next meeting" onClick={() => move(1)}>
              <Icon name="expand_more" size={16} />
            </button>
          </span>
          <button className="btn btn-plain" onClick={() => removeMeeting(m)}>
            Remove
          </button>
        </div>
      </div>
    );
  } else if (cursor?.suggestion) {
    const s = cursor.suggestion;
    paneContent = (
      <div className={pane}>
        <div className={paneBody}>
          <div className="max-w-[580px]">
            {back}
            <h2 className={paneTitle}>{s.title}</h2>
            <p className="mt-1 text-xs text-ink3">Suggested</p>
            <dl className="mt-4 grid grid-cols-[58px_1fr] gap-y-[5px] border-b border-line-soft pb-4 text-[12.5px] text-ink2">
              <dt className="text-ink3">When</dt>
              <dd>
                {s.dateTime && !isNaN(new Date(s.dateTime).getTime()) ? (
                  <>
                    <b className="font-medium text-ink">{longDate(s.dateTime)}</b>, {clock(s.dateTime)}
                    {s.duration ? `, ${durationLabel(s.duration)}` : ""}
                    {s.asWritten && <span className="text-ink3"> ({s.asWritten} in the email)</span>}
                  </>
                ) : (
                  "No time given"
                )}
              </dd>
              <dt className="text-ink3">Who</dt>
              <dd>{s.attendees.join(", ") || nameOf(s.email_sender) || "Nobody named"}</dd>
              <dt className="text-ink3">Where</dt>
              <dd>{s.location || "No place given"}</dd>
            </dl>
            {sourceInset(s.email_id, s.email_sender, s.email_subject)}
          </div>
        </div>
        <div className={paneBar}>
          <button className="btn btn-pri" onClick={() => openSchedulerFromSuggestion(s)}>
            {s.dateTime ? "Add to calendar" : "Find a time"}
          </button>
          <span className="flex-1" />
          <button className="btn btn-plain" onClick={() => (setCursorKey(after(cursor.key)), setDismissed((prev) => new Set(prev).add(s.email_id)))}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

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
            <button className="btn" onClick={newMeeting}>
              New meeting
            </button>
          </>
        }
      >
        <Seg
          value={filter}
          onChange={(f) => {
            setChosen(f);
            setCursorKey(null);
            setPaneOpen(false);
          }}
          options={[
            { id: "confirm", label: "To confirm", count: proposed.length, need: true },
            { id: "upcoming", label: "Upcoming" },
            { id: "past", label: "Past" },
          ]}
        />
      </ViewBar>
      <div className="flex min-h-0 flex-1">
        <div ref={listRef} className={`w-full flex-none overflow-y-auto border-line md:block md:w-[400px] md:border-r ${paneShown ? "hidden" : ""}`} role="listbox" aria-label="Meetings">
          {loadError && (
            <p className="px-5 pt-3 leading-normal text-danger" role="alert">
              Your meetings could not be loaded: {loadError}.{" "}
              <button className="link" onClick={loadMeetings}>
                Try again
              </button>
            </p>
          )}
          {loading ? (
            <div className="pt-9">
              <SkeletonRows count={8} tall />
            </div>
          ) : loadError && !meetings.length ? null : !rows.length ? (
            q ? (
              <Empty icon="search" title="Nothing matches that search" />
            ) : filter === "confirm" ? (
              <Empty icon="event" title="Nothing to confirm" />
            ) : filter === "upcoming" ? (
              <Empty icon="event" title="No upcoming meetings" />
            ) : (
              <Empty icon="event" title="No past meetings" />
            )
          ) : (
            items.map((item) => {
              if ("head" in item)
                return (
                  <div key={item.key} className="day">
                    <b>{item.name}</b>
                    <span className="flex-1" />
                  </div>
                );
              const isCursor = !showScheduler && cursor === item;
              const rowClass = "row2 group grid scroll-mt-[34px] grid-cols-[26px_minmax(0,1fr)_auto] gap-y-[3px]";
              if (item.suggestion) {
                const s = item.suggestion;
                const when = s.dateTime && !isNaN(new Date(s.dateTime).getTime()) ? `${longDate(s.dateTime)}, ${clock(s.dateTime)}` : "No time given";
                return (
                  <div key={item.key} role="option" aria-selected={isCursor} className={rowClass} onClick={() => select(item.key)} onDoubleClick={() => openSchedulerFromSuggestion(s)}>
                    <span className="row-span-2" />
                    <b className="truncate font-semibold">{s.title}</b>
                    <span className="pl-2.5 text-xs text-ink3">Suggested</span>
                    <div className="col-span-2 truncate text-ink3">
                      {when}
                      {nameOf(s.email_sender) && `, ${nameOf(s.email_sender)}`}
                    </div>
                  </div>
                );
              }
              const m = item.meeting!;
              const fromMail = m.status === "proposed" && !!m.email_id;
              return (
                <div key={item.key} role="option" aria-selected={isCursor} className={rowClass} onClick={() => select(item.key)}>
                  <span className="row-span-2 grid place-items-start justify-center pt-px">
                    <Glyph state={m.status === "proposed" ? "need" : m.status === "confirmed" ? "done" : "filed"} />
                  </span>
                  <b className={`truncate ${m.status === "cancelled" ? "font-normal text-ink3 line-through" : "font-semibold"}`}>{m.title}</b>
                  <span className="pl-2.5 text-xs text-ink3">{m.status === "proposed" ? <b className="font-semibold text-wax-ink">To confirm</b> : m.status === "cancelled" ? "Cancelled" : ""}</span>
                  <div className={`truncate text-ink3 ${fromMail ? "" : "col-span-2"}`}>
                    {clock(m.start_time)} to {clock(m.end_time)}
                    {who(m) && `, ${who(m)}`}
                  </div>
                  {fromMail && (
                    <span className="-my-[5px] justify-self-end opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-aria-selected:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                      <NotThis thing="meeting" id={m.id} who={nameOf(sources.get(m.email_id!)?.sender ?? "") || undefined} onDone={loadMeetings} />
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className={`min-w-0 flex-1 md:flex ${paneShown ? "flex" : "hidden"}`}>{paneContent}</div>
      </div>
    </>
  );
}
