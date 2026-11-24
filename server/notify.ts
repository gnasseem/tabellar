// Telling the user something happened. One small interface with a list of
// channels; macOS Notification Center is the first, and another channel can be
// added to CHANNELS without touching the callers.

import { spawn } from "node:child_process";

export const LEVELS = ["vip", "needs", "none"] as const;

// Whether mail is worth a notification at the user's setting: people marked
// most important, or anything that needs them (their people included).
export function worthNotifying(level: unknown, mail: { vip: boolean; needsUser: boolean }): boolean {
  if (level === "none") return false;
  return mail.vip || (level !== "vip" && mail.needsUser);
}

// Working hours as Settings shows them when none are set.
export const HOURS = { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] };
export type Hours = { start?: string; end?: string; days?: number[]; timezone?: string };

// The weekday (Sunday 0), the day and the minute of the day in a time zone.
export function wallClock(timezone: string | undefined, at = new Date()): { weekday: number; day: string; minute: number } {
  const zone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const parts = (tz: string) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));
  let p: Record<string, string>;
  try {
    p = parts(zone);
  } catch {
    p = parts("UTC");
  }
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

export const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Whether notifications are quiet now: the setting is on and it is outside
// the working hours or not a working day. A day that ends before it starts
// runs over midnight.
export function inQuietHours(profile: Record<string, unknown> | null | undefined, at = new Date()): boolean {
  if (!profile?.notification_quiet) return false;
  const h = { ...HOURS, ...((profile.working_hours as Hours | null) ?? {}) };
  const now = wallClock((h as Hours).timezone, at);
  const start = minutes(h.start);
  const end = minutes(h.end);
  if (start <= end) return !h.days.includes(now.weekday) || now.minute < start || now.minute >= end;
  const yesterday = (now.weekday + 6) % 7;
  return !((h.days.includes(now.weekday) && now.minute >= start) || (h.days.includes(yesterday) && now.minute < end));
}

export type Note = { title: string; subtitle?: string; body: string };

type Channel = (n: Note) => void;

// Title and text are passed as arguments to an AppleScript run handler, never
// spliced into the script, so nothing in an email can inject AppleScript.
const macos: Channel = (n) => {
  if (process.platform !== "darwin") return;
  const script = [
    "on run argv",
    "display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)",
    "end run",
  ];
  const args = script.flatMap((l) => ["-e", l]);
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const child = spawn("osascript", [...args, clip(n.title, 80), clip(n.subtitle ?? "", 100), clip(n.body, 240)], { stdio: "ignore" });
  child.on("error", () => {});
};

// `tabellar check` empties this so its test emails stay quiet.
export const CHANNELS: Channel[] = [macos];

export function notify(n: Note): void {
  for (const send of CHANNELS) {
    try {
      send(n);
    } catch (e) {
      console.error("[notify]", e);
    }
  }
}
