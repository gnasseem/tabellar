// What Tabellar may make from an email, decided in code. The model reads the
// email and suggests a todo or a meeting; nothing it suggests is taken on its
// word:
//   todo     only from mail sorted action-required or important, never from
//            calendar mail, and only with a quote of the sentence that asks
//            for it, found word for word in the email
//   meeting  the model copies the time and timezone as written and the
//            sentence they are in; the time is parsed here, the stated zone
//            (or else the user's) applied here, and a time that is not in the
//            quote, or a zone that cannot be read, gives no time at all
// Calendar mail (an invitation, an acceptance) is told from its headers and
// its text/calendar part, and its .ics is read here too.

import { wallClockToUtc } from "./agentExecute.ts";

// Mail older than this is sorted and summarised but nothing is made from it,
// so the model is not asked what to do about it either.
export const ACT_WITHIN_MS = 7 * 24 * 3600_000;

type Action = Record<string, unknown> & { action?: string; label?: string; text?: string; quote?: string };
type Mail = { subject?: string | null; body_text?: string | null; snippet?: string | null };

// Letters and digits only, so "1:15 pm" and "1:15pm" read the same.
const squash = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

const textOf = (m: Mail) => `${m.subject ?? ""}\n${m.body_text || m.snippet || ""}`;

// Is `quote` in `text`, word for word? Short quotes prove nothing.
export function quoted(quote: unknown, text: string): boolean {
  const q = squash(quote);
  return q.length >= 12 && squash(text).includes(q);
}

// Categories a todo may come from; promotions and updates are mail nobody asks the user anything in.
const TODO_CATEGORIES = new Set(["action-required", "important"]);

export function todoOf(actions: Action[], m: Mail & { is_calendar?: boolean | null }, category: string): Action | null {
  if (m.is_calendar || !TODO_CATEGORIES.has(category)) return null;
  return actions.find((a) => a.action === "add_todo" && String(a.label ?? "").trim() && quoted(a.quote, textOf(m))) ?? null;
}

// ── Times ───────────────────────────────────────────────────────────────────

// Minutes after midnight, or null. Without am or pm only 7:00 to 23:59 count:
// "3:00" could be either, so it gives no time.
export function parseTime(s: unknown): number | null {
  const t = String(s ?? "").trim().toLowerCase();
  if (/^noon\b/.test(t)) return 12 * 60;
  if (/^midnight\b/.test(t)) return 0;
  const m = t.match(/^(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?(?![\p{L}\p{N}])/u);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = m[3].startsWith("p");
    h = (h % 12) + (pm ? 12 : 0);
  } else {
    if (m[2] === undefined || h > 23 || h < 7) return null;
  }
  return h * 60 + min;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

type Day = { y: number; m: number; d: number };

// Today in a timezone, with its weekday (0 is Sunday).
function todayIn(tz: string, now: Date): Day & { dow: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3)) };
}

const addDays = (t: Day, n: number): Day => {
  const d = new Date(Date.UTC(t.y, t.m - 1, t.d + n));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

// The day a piece of text names: a date ("Nov 24", "24 November 2026",
// "2026-11-24"), today, tomorrow, or a weekday (the next one, today included).
// A date with no year that is more than two months gone is next year's.
export function parseDay(s: string, today: Day & { dow: number }): Day | null {
  const t = s.toLowerCase();
  let m = t.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const named = (mon: string, day: string, year?: string): Day | null => {
    const mi = MONTHS.indexOf(mon.slice(0, 3)) + 1;
    const d = Number(day);
    if (!mi || d < 1 || d > 31) return null;
    if (year) return { y: Number(year), m: mi, d };
    const thisYear = Date.UTC(today.y, mi - 1, d);
    const back = (Date.UTC(today.y, today.m - 1, today.d) - thisYear) / 86_400_000;
    return { y: back > 61 ? today.y + 1 : today.y, m: mi, d };
  };
  m = t.match(new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d\\d))?`));
  if (m) return named(m[1], m[2], m[3]);
  m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(20\\d\\d))?`));
  if (m) return named(m[2], m[1], m[3]);
  if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  m = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday|s|\.)?\b/);
  if (m) return addDays(today, (DAYS.indexOf(m[1]) - today.dow + 7) % 7);
  return null;
}

// The day a todo is due, from the sentence that asks for it: a day named
// after "by", "before", "due", "until", "no later than" or "deadline"
// ("send it back by December 15", "due Friday"). "YYYY-MM-DD" or null.
export function dueOf(quote: unknown, userTz: string, now = new Date()): string | null {
  const t = String(quote ?? "");
  const at = t.search(/\b(by|before|due|until|till|no later than|deadline)\b/i);
  if (at < 0) return null;
  const day = parseDay(t.slice(at), todayIn(userTz, now));
  return day ? `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}` : null;
}

// ── Timezones ───────────────────────────────────────────────────────────────

export type Zone = { iana: string } | { offset: number }; // offset in minutes east of UTC

const ZONES: Record<string, string> = {
  utc: "UTC", gmt: "UTC",
  est: "America/New_York", edt: "America/New_York", et: "America/New_York", eastern: "America/New_York",
  cst: "America/Chicago", cdt: "America/Chicago", ct: "America/Chicago", central: "America/Chicago",
  mst: "America/Denver", mdt: "America/Denver", mt: "America/Denver", mountain: "America/Denver",
  pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pt: "America/Los_Angeles", pacific: "America/Los_Angeles",
  bst: "Europe/London", cet: "Europe/Paris", cest: "Europe/Paris", eet: "Europe/Athens", eest: "Europe/Athens",
  gst: "Asia/Dubai", gulf: "Asia/Dubai", ist: "Asia/Kolkata", sgt: "Asia/Singapore", hkt: "Asia/Hong_Kong",
  jst: "Asia/Tokyo", kst: "Asia/Seoul", aest: "Australia/Sydney", aedt: "Australia/Sydney",
};

const validIana = (z: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

// A zone as written: "EST", "Gulf Standard Time", "UTC+4", "GMT-05:30",
// "Asia/Dubai". undefined when nothing is written, null when it cannot be read.
export function parseZone(s: unknown): Zone | null | undefined {
  const t = String(s ?? "").trim().replace(/^[(\s]+|[)\s.,]+$/g, "");
  if (!t) return undefined;
  const off = t.match(/^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (off) return { offset: (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] ?? 0)) };
  if (t.includes("/") && validIana(t)) return { iana: t };
  const word = t.toLowerCase().split(/\s+/)[0];
  return ZONES[word] ? { iana: ZONES[word] } : null;
}

// A zone written right after a time: "1:15pm EST", "10am (GST)", "3 PM UTC+4".
const ZONE_AFTER = /^\s*\(?\s*((?:utc|gmt)\s*[+-]\s*\d{1,2}(?::?\d{2})?|[a-z]{2,5}\b|(?:gulf|eastern|central|mountain|pacific) (?:standard |daylight )?time)/i;

function offsetAt(zone: Zone, instant: number): number {
  if ("offset" in zone) return zone.offset;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone.iana, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return Math.round((Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - Math.floor(instant / 60_000) * 60_000) / 60_000);
}

export function toInstant(day: Day, minutes: number, zone: Zone): Date {
  const wall = Date.UTC(day.y, day.m - 1, day.d, Math.floor(minutes / 60), minutes % 60);
  return "offset" in zone ? new Date(wall - zone.offset * 60_000) : wallClockToUtc(wall, zone.iana);
}

// "YYYY-MM-DDTHH:mm" in a zone, the form meetingDetails.dateTime has.
export function wallIn(instant: Date, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute}`;
}

// ── Meetings ────────────────────────────────────────────────────────────────

export type Meeting = {
  title: string;
  dateTime: string | null; // the start in the user's zone, or null when the email gives no time
  duration: number | null;
  location: string | null;
  asWritten: string | null; // "1:15pm EST" when the email's zone is not the user's
  quote: string | null;
};

type Details = { title?: unknown; date?: unknown; time?: unknown; timezone?: unknown; duration?: unknown; location?: unknown };

// The meeting a schedule_meeting suggestion describes, with the time worked
// out in code from what the email says.
export function meetingOf(a: Action, m: Mail, userTz: string, now = new Date()): Meeting {
  const d = (a.meetingDetails ?? {}) as Details;
  const text = textOf(m);
  const quote = quoted(a.quote, text) ? String(a.quote) : null;
  const out: Meeting = {
    title: String(d.title || a.label || m.subject || "Meeting").trim(),
    dateTime: null,
    duration: Number(d.duration) > 0 ? Math.min(Math.round(Number(d.duration)), 24 * 60) : null,
    location: d.location ? String(d.location) : null,
    asWritten: null,
    quote,
  };
  const timeText = String(d.time ?? "").trim();
  const minutes = parseTime(timeText);
  if (!quote || minutes === null || !squash(quote).includes(squash(timeText))) return out;

  // The day: a date in the quote, else in the subject, else the model's resolved date.
  const today = todayIn(userTz, now);
  const modelDay = String(d.date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const day = parseDay(quote, today) ?? parseDay(String(m.subject ?? ""), today) ?? (modelDay ? { y: Number(modelDay[1]), m: Number(modelDay[2]), d: Number(modelDay[3]) } : null);
  if (!day) return out;

  // The zone: written right after the time, else as the model copied it (when
  // it is in the email), else the user's. A zone the email states that cannot
  // be read gives no time.
  const at = quote.toLowerCase().indexOf(timeText.toLowerCase());
  const after = at >= 0 ? quote.slice(at + timeText.length).match(ZONE_AFTER)?.[1] : undefined;
  const fromAfter = after ? parseZone(after) || undefined : undefined;
  const written = String(d.timezone ?? "").trim();
  const fromModel = written && squash(text).includes(squash(written)) ? parseZone(written) : undefined;
  const zone = fromAfter ?? fromModel;
  if (zone === null) return out;
  const start = toInstant(day, minutes, zone ?? { iana: userTz });
  out.dateTime = wallIn(start, userTz);
  if (zone && offsetAt(zone, start.getTime()) !== offsetAt({ iana: userTz }, start.getTime())) out.asWritten = `${timeText} ${fromAfter ? after : written}`;
  return out;
}

// What the analysis keeps of the model's suggestions: replies as they are, a
// todo only when todoOf allows it, a meeting with its time worked out here.
export function checkActions(actions: unknown, m: Mail & { is_calendar?: boolean | null }, category: string, userTz: string): Action[] {
  const list = (Array.isArray(actions) ? actions : []).filter((a): a is Action => !!a && typeof a === "object");
  const todo = todoOf(list, m, category);
  const out: Action[] = [];
  for (const a of list) {
    if (a.action === "reply" && !out.some((x) => x.action === "reply")) out.push(a);
    else if (a.action === "add_todo" && a === todo) out.push({ action: "add_todo", label: String(a.label).trim(), quote: a.quote });
    else if (a.action === "schedule_meeting" && !m.is_calendar && !out.some((x) => x.action === "schedule_meeting")) {
      const mt = meetingOf(a, m, userTz);
      out.push({ action: "schedule_meeting", label: a.label, text: a.text, quote: mt.quote ?? undefined, meetingDetails: { ...(a.meetingDetails as object), ...mt } });
    } else if (a.action && !["reply", "add_todo", "schedule_meeting"].includes(a.action)) out.push(a);
  }
  return out;
}

// ── Calendar mail ───────────────────────────────────────────────────────────

export type CalendarEvent = { method: string; uid: string; title: string; start: string | null; end: string | null; all_day: boolean; recurring: boolean };

// Mail from a calendar: Google Calendar sends invitations and answers on the
// organiser's behalf with itself as Sender; Exchange marks them in headers.
export function calendarHeaders(h: Record<string, string>): boolean {
  if (/calendar-notification@google\.com/i.test(`${h.sender ?? ""} ${h.from ?? ""}`)) return true;
  if (/calendarmessage/i.test(h["content-class"] ?? "")) return true;
  return Object.keys(h).some((k) => k.startsWith("x-ms-exchange-calendar"));
}

// The first event of an .ics, its times in UTC. A TZID Intl does not know
// (Outlook writes Windows names) falls back to the offset of its VTIMEZONE,
// then to `fallbackTz`.
export function parseIcs(ics: string, fallbackTz: string): CalendarEvent | null {
  const lines = ics.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const method = (lines.find((l) => /^METHOD:/i.test(l)) ?? "").split(":")[1]?.trim().toUpperCase() ?? "";
  const offsets = new Map<string, number>();
  let tzid = "";
  let inStandard = false;
  for (const l of lines) {
    if (/^TZID:/i.test(l)) tzid = l.slice(5).trim();
    if (/^BEGIN:STANDARD/i.test(l)) inStandard = true;
    if (/^END:STANDARD/i.test(l)) inStandard = false;
    const off = l.match(/^TZOFFSETTO:([+-])(\d{2})(\d{2})/i);
    if (off && inStandard && tzid) offsets.set(tzid, (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])));
  }
  const begin = lines.findIndex((l) => /^BEGIN:VEVENT/i.test(l));
  if (begin < 0) return null;
  const end = lines.findIndex((l, i) => i > begin && /^END:VEVENT/i.test(l));
  const ev = lines.slice(begin, end < 0 ? undefined : end);
  const prop = (name: string) => ev.find((l) => new RegExp(`^${name}[;:]`, "i").test(l));
  const time = (line: string | undefined): { iso: string; allDay: boolean } | null => {
    if (!line) return null;
    const [params, value] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()];
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!m) return null;
    const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    if (!m[4]) return { iso: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
    const minutes = Number(m[4]) * 60 + Number(m[5]);
    if (m[7]) return { iso: new Date(Date.UTC(day.y, day.m - 1, day.d, Number(m[4]), Number(m[5]), Number(m[6] ?? 0))).toISOString(), allDay: false };
    const id = params.match(/TZID=("?)([^";:]+)\1/i)?.[2] ?? "";
    const zone: Zone = id && validIana(id) ? { iana: id } : offsets.has(id) ? { offset: offsets.get(id)! } : { iana: fallbackTz };
    return { iso: toInstant(day, minutes, zone).toISOString(), allDay: false };
  };
  const unescape = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
  const value = (line: string | undefined) => (line ? unescape(line.slice(line.indexOf(":") + 1)) : "");
  const start = time(prop("DTSTART"));
  return {
    method,
    uid: value(prop("UID")),
    title: value(prop("SUMMARY")),
    start: start?.iso ?? null,
    end: time(prop("DTEND"))?.iso ?? null,
    all_day: !!start?.allDay,
    recurring: !!prop("RRULE"),
  };
}
