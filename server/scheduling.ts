// A meeting from the first email to the calendar, with one decision asked of
// the user.
//
// When an email asks for a time, the reply's answers are real free times. When
// the other side takes one the user offered, or the user takes one they
// offered, it goes on the calendar. When a meeting Tabellar put there is moved
// or called off by mail, the event follows. All of it is worked out in code,
// from the words of the thread, and only where they leave one reading: a time
// counts as agreed when the user wrote it themselves or said yes to it. Nobody
// is invited and nothing is sent from here.

import { db } from "./db.ts";
import { act, engineSettings, type Planned } from "./actions.ts";
import { blocksOf } from "./choices.ts";
import { looksLikeInstructions } from "./policy.ts";
import { displayName } from "./profile.ts";
import { calendarAccount, userCalendar, type Box, type Calendar } from "./providers.ts";
import { COMMITS, languageOf, NEGATED, sentencesOf, type EmailRow } from "./replies.ts";
import { daysIn, meetingOf, parseTime, parseZone, timeIn, toInstant, todayIn, wallIn, ZONE_AFTER, type Day } from "./rules.ts";
import { addressesIn } from "./senders.ts";
import { listAccounts } from "./accounts.ts";
import { ownWords } from "./writing.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const USUAL_MIN = 30;
const LOOK_DAYS = 10; // working days looked at for free times
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

export type Hours = { start?: string; end?: string; days?: number[]; timezone?: string } | null;
const HOURS = { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] };

// ── Times in words ──────────────────────────────────────────────────────────

export type Said = { start: Date; sentence: string };

// Every day with a time a text names. A time alone takes the day named before
// it in the same sentence, and a zone written after a time is applied.
export function timesIn(text: string, tz: string, sent: Date): Said[] {
  const today = todayIn(tz, sent);
  const out: Said[] = [];
  for (const sentence of sentencesOf(text)) {
    let day: Day | null = null;
    const next = /\bnext week\b/i.test(sentence) ? " next week" : "";
    for (const piece of sentence.split(/,(?!\s*\d{1,2}[:.]\d\d)|;|\s+(?:or|and|to|ou|oder|o)\s+/i)) {
      const days = daysIn(`${piece}${next}`, today);
      if (days.length > 1) {
        day = null;
        continue;
      }
      day = days[0] ?? day;
      const m = piece.match(/(?<![\d.,:/-])(\d{1,2}(?:[:.h]\d{2})?\s*(?:[ap]\.?\s?m\b\.?)?|noon\b)(?![\d%:/-]|\s*(?:min|hour|day|week|%))/gi)?.map((x) => x.trim()).find((x) => parseTime(x) !== null);
      if (!m || !day) continue;
      const minutes = timeIn(m, piece);
      if (minutes === null) continue;
      const after = piece.slice(piece.indexOf(m) + m.length).match(ZONE_AFTER)?.[1];
      const zone = after ? parseZone(after) : undefined;
      out.push({ start: toInstant(day, minutes, zone || { iana: tz }), sentence });
    }
  }
  return out;
}

const same = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) < MIN;
const unique = (list: Date[]) => list.filter((d, i) => list.findIndex((x) => same(x, d)) === i);

const YES = /\b(?:works?|perfect|confirm(?:ed|ing)?|sounds (?:good|great)|see you|talk (?:then|soon)|great|booked|that(?:'s| is) (?:fine|good)|is (?:fine|good|great|perfect)|let'?s (?:do|go with|say)|i(?:'ll| will) (?:be there|call|see you)|suits|yes|sure|agreed|parfait|d'accord|entendu|convient|perfecto|de acuerdo|passt|einverstanden|va bene|perfetto|combinado|akkoord)\b/i;
const NO = /\b(?:can(?:'t|not)|won't|unable|unfortunately|doesn't work|does not work|not available|instead|another (?:time|day)|reschedul\w*|however|rather|unless|ne (?:peux|convient|pourrai)|leider|no puedo|non posso)\b/i;

// The one of `offered` a text takes, or null when it takes none, or leaves
// more than one reading.
export function taken(text: string, offered: Date[], tz: string, sent: Date): Date | null {
  if (!YES.test(text) || NO.test(text)) return null;
  const named = unique(timesIn(text, tz, sent).map((t) => t.start));
  if (named.length) return named.length === 1 ? (offered.find((o) => same(o, named[0])) ?? null) : null;
  const days = daysIn(text, todayIn(tz, sent)).map((d) => `${d.y}-${d.m}-${d.d}`);
  const dayOf = (o: Date) => todayIn(tz, o);
  const left = days.length ? offered.filter((o) => days.includes(`${dayOf(o).y}-${dayOf(o).m}-${dayOf(o).d}`)) : offered;
  return left.length === 1 ? left[0] : null;
}

// Asks when to meet, and names no time itself.
const ASKS_TIME =
  /\b(?:when (?:are|would|could|can|will) (?:you|we)|what (?:time|day)s?\b[^.?!]{0,40}\b(?:work|suit|good|best|free|available)|(?:which|what) (?:day|time) (?:works|suits|is)|(?:could|can|shall|should|may) we (?:please )?(?:meet|talk|chat|speak|have a (?:call|chat|meeting)|catch up|schedule|set up|find|arrange|hop on|get together|grab)|(?:find|set up|schedule|arrange|book) (?:a |some )?(?:time|call|meeting|chat)|do you have (?:any |some )?(?:time|availability)|your availability|times? that works?|(?:send|give) me (?:a few |some )?(?:times|dates|slots)|quand (?:êtes|seriez|pouvons)|vos disponibilités|wann (?:haben|hätten|können|passt)|cuándo (?:puedes|podemos|podría))/i;
const LENGTH = /\b(\d{1,3})[ -]?(min(?:ute)?s?|hours?|h)\b|\b(half an hour|an hour|quick (?:call|chat))\b/i;

export function minutesIn(text: string): number {
  const m = text.match(LENGTH);
  if (!m) return USUAL_MIN;
  if (m[3]) return /^an hour$/i.test(m[3]) ? 60 : USUAL_MIN;
  const n = Number(m[1]) * (/^h/i.test(m[2]) ? 60 : 1);
  return n >= 10 && n <= 480 ? n : USUAL_MIN;
}

// ── Free times ──────────────────────────────────────────────────────────────

const clockMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const noonOf = (d: Day) => new Date(Date.UTC(d.y, d.m - 1, d.d, 12));
const later = (d: Day, n: number): Day => {
  const x = new Date(noonOf(d).getTime() + n * DAY);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
};

// What is free on a day within the working hours, every quarter of an hour,
// and what is taken. Nothing on a day off.
export async function freeOn(cal: { account: Box; calendar: Calendar }, hours: Hours, tz: string, day: Day, minutes: number): Promise<{ slots: { start: string; end: string }[]; busy: { start: string; end: string }[] }> {
  const h = { ...HOURS, ...(hours ?? {}) };
  const busy = await cal.calendar.busy(cal.account, toInstant(day, 0, { iana: tz }), new Date(toInstant(later(day, 1), 0, { iana: tz }).getTime() - 1));
  if (!h.days.includes(noonOf(day).getUTCDay())) return { slots: [], busy };
  const end = toInstant(day, clockMinutes(h.end), { iana: tz }).getTime();
  const quarter = 15 * MIN;
  const from = Math.ceil(Math.max(toInstant(day, clockMinutes(h.start), { iana: tz }).getTime(), Date.now()) / quarter) * quarter;
  const slots: { start: string; end: string }[] = [];
  for (let t = from; t + minutes * MIN <= end; t += quarter) {
    if (busy.some((b) => t < Date.parse(b.end) && t + minutes * MIN > Date.parse(b.start))) continue;
    slots.push({ start: new Date(t).toISOString(), end: new Date(t + minutes * MIN).toISOString() });
  }
  return { slots, busy };
}

// Two free times on two days: the days the email names, else the next working
// days; on the hour or half hour, a morning and an afternoon where there are both.
export async function offer(cal: { account: Box; calendar: Calendar }, hours: Hours, tz: string, text: string, sent: Date, minutes: number): Promise<Date[]> {
  const today = todayIn(tz, new Date());
  const asked = daysIn(text, todayIn(tz, sent)).filter((d) => noonOf(d) >= noonOf(today));
  const ahead = Array.from({ length: LOOK_DAYS * 2 }, (_, i) => later(today, i + 1));
  // "next week" is Monday to Sunday of it.
  const toMonday = ((8 - noonOf(today).getUTCDay()) % 7 || 7);
  const week = /\bnext week\b/i.test(text) ? ahead.filter((d) => noonOf(d) >= noonOf(later(today, toMonday)) && noonOf(d) < noonOf(later(today, toMonday + 7))) : [];
  const held = new Set(await alreadyOffered(cal.account.user_id));
  const out: Date[] = [];
  for (const d of asked.length ? asked : week.length ? week : ahead) {
    const { slots } = await freeOn(cal, hours, tz, d, minutes);
    const good = slots.map((s) => new Date(s.start)).filter((s) => s.getUTCMinutes() % 30 === 0 && s.getTime() > Date.now() + 2 * 3600_000 && !held.has(s.toISOString()));
    const at = (s: Date) => Number(wallIn(s, tz).slice(11, 13));
    const pick = out.length ? (good.find((s) => at(s) >= 14) ?? good[0]) : (good.find((s) => at(s) >= 10) ?? good[0]);
    if (pick) out.push(pick);
    // One day asked about can hold both.
    if (asked.length === 1 && pick) {
      const other = good.find((s) => Math.abs(s.getTime() - pick.getTime()) >= 2 * 3600_000);
      if (other) out.push(other);
    }
    if (out.length === 2) break;
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

// Times in drafts and answers of the last days that nobody has taken yet.
async function alreadyOffered(userId: string): Promise<string[]> {
  const { data } = await db.from("action_log").select("detail").eq("user_id", userId).eq("kind", "draft").in("status", ["done", "proposed"]).gte("created_at", new Date(Date.now() - 5 * DAY).toISOString());
  return (data ?? []).flatMap((r) => ((r.detail as { offers?: string[] } | null)?.offers ?? []));
}

// ── The answers of a draft ──────────────────────────────────────────────────

const IN: Record<string, { locale: string; one: (t: string) => string; both: (a: string, b: string) => string }> = {
  en: { locale: "en-GB", one: (t) => `${t} works for me.`, both: (a, b) => `I could do ${a} or ${b}. Which suits you better?` },
  fr: { locale: "fr-FR", one: (t) => `${t} me convient.`, both: (a, b) => `Je pourrais ${a} ou ${b}. Qu'est-ce qui vous conviendrait le mieux ?` },
  es: { locale: "es-ES", one: (t) => `${t} me viene bien.`, both: (a, b) => `Podría ${a} o ${b}. ¿Qué te viene mejor?` },
  de: { locale: "de-DE", one: (t) => `${t} passt mir.`, both: (a, b) => `Ich könnte ${a} oder ${b}. Was passt Ihnen besser?` },
  it: { locale: "it-IT", one: (t) => `${t} per me va bene.`, both: (a, b) => `Potrei ${a} o ${b}. Cosa le andrebbe meglio?` },
  pt: { locale: "pt-PT", one: (t) => `${t} serve-me bem.`, both: (a, b) => `Poderia ${a} ou ${b}. Qual lhe dá mais jeito?` },
  nl: { locale: "nl-NL", one: (t) => `${t} komt mij uit.`, both: (a, b) => `Ik zou ${a} of ${b} kunnen. Wat komt u het beste uit?` },
};

const inZone = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
const spoken = (d: Date, tz: string, locale: string, zone: boolean) => {
  const day = d.toLocaleDateString(locale, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).replace(",", "");
  const at = locale === "en-GB" ? " at " : locale === "fr-FR" ? " à " : locale === "es-ES" ? " a las " : locale === "de-DE" ? " um " : locale === "it-IT" ? " alle " : locale === "pt-PT" ? " às " : " om ";
  return `${day}${at}${d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" })}${zone ? ` (${inZone(d, tz)})` : ""}`;
};
export const labelOf = (d: Date, tz: string) => `${d.toLocaleDateString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).replace(",", "")}, ${d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" })}`;

// The free times as the answers of a draft: either, the first, the second.
export function answersFor(slots: Date[], tz: string, text: string, zone: boolean): { label: string; text: string }[] {
  const l = IN[languageOf(text)] ?? IN.en;
  const words = slots.map((s) => spoken(s, tz, l.locale, zone));
  const one = slots.map((s, i) => ({ label: labelOf(s, tz), text: l.one(words[i].replace(/^\p{Ll}/u, (x) => x.toUpperCase())) }));
  return slots.length === 2 ? [{ label: "Either", text: l.both(words[0], words[1]) }, ...one] : one;
}

const TIMED = /\b\d{1,2}(?::\d\d|\s?[ap]m|\s?h)\b|\b(?:tomorrow|next week|this week|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
const ABOUT_TIME = /\b(?:availab|schedul|calendar|time that|times? (?:work|suit)|when (?:would|are|can|could)|what (?:day|time)|which (?:day|time)|let me know)\w*/i;

// A draft with those answers in it, in place of what the model says of times.
export function withAnswers(draft: string, answers: { label: string; text: string }[]): string {
  const kept: string[] = [];
  for (const b of blocksOf(draft)) {
    if (!("text" in b)) continue;
    const text = b.text
      .split("\n")
      .map((line) => (/^\S+[^.?!]{0,40},$/.test(line.trim()) ? line : sentencesOf(line).filter((s) => !TIMED.test(s) && !ABOUT_TIME.test(s)).join(" ")))
      .filter((line, i, all) => line.trim() || all.length === 1)
      .join("\n")
      .trim();
    if (text) kept.push(text);
  }
  const [greeting, ...rest] = kept.length ? kept : [""];
  // The last paragraph is the sign-off, when there is more than the greeting.
  const close = rest.length ? rest[rest.length - 1] : "";
  const between = rest.slice(0, -1);
  return [greeting, ...between, ...answers.map((a) => `[${a.label}]\n${a.text}`), close].filter(Boolean).join("\n\n");
}

// What an email that asks for a time is answered with, or null when it does
// not ask, the calendar cannot be read, or nothing is free.
export async function slotsFor(userId: string, e: EmailRow, zoneKnown: boolean): Promise<{ slots: Date[]; answers: { label: string; text: string }[] } | null> {
  const own = ownWords(String(e.body_text || e.snippet || ""));
  const sent = e.received_at ? new Date(e.received_at) : new Date();
  const cal = calendarAccount(await listAccounts(userId));
  if (!cal || !ASKS_TIME.test(own)) return null;
  const { data: me } = await db.from("profiles").select("working_hours").eq("id", userId).maybeSingle();
  const hours = me?.working_hours as Hours;
  const tz = hours?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  // A time of theirs is a yes or a no, not times of the user's.
  if (timesIn(own, tz, sent).some((t) => t.start.getTime() > Date.now())) return null;
  try {
    const slots = await offer(cal, hours, tz, own, sent, minutesIn(own));
    return slots.length ? { slots, answers: answersFor(slots, tz, `${e.subject ?? ""} ${own}`, !zoneKnown) } : null;
  } catch (err) {
    console.error("[scheduling] free times:", (err as Error).message);
    return null;
  }
}

// ── What the thread agrees ──────────────────────────────────────────────────

type Stored = { id: string; subject: string | null; sender: string | null; sender_email: string | null; recipients: string | null; body_text: string | null; snippet: string | null; received_at: string; label_ids: string[] | null; thread_id: string | null; is_calendar: boolean | null };
const FIELDS = "id, subject, sender, sender_email, reply_to_email, recipients, body_text, snippet, received_at, label_ids, thread_id, is_calendar";
const isSent = (m: Stored) => !!m.label_ids?.includes("SENT");
const textOf = (m: Stored) => ownWords(String(m.body_text || m.snippet || "")).replace(/’/g, "'");

async function threadOf(userId: string, threadId: string | null | undefined): Promise<Stored[]> {
  if (!threadId) return [];
  const { data } = await db.from("emails").select(FIELDS).eq("user_id", userId).eq("thread_id", threadId).eq("is_receipt", false).order("received_at", { ascending: true }).limit(60);
  return (data ?? []) as unknown as Stored[];
}

// The meeting of this thread that Tabellar put on the calendar and that is
// still ahead, when there is exactly one.
async function meetingOfThread(userId: string, thread: Stored[]): Promise<Record<string, any> | null> {
  if (!thread.length) return null;
  const { data } = await db.from("meetings").select("*").eq("user_id", userId).eq("status", "confirmed").not("calendar_event_id", "is", null).gte("end_time", new Date().toISOString()).in("email_id", thread.map((m) => m.id));
  return data?.length === 1 ? (data[0] as Record<string, any>) : null;
}

// The times the user put forward in their last email of the thread: those they
// did not turn down.
function offeredIn(m: Stored, tz: string): Date[] {
  return unique(timesIn(textOf(m), tz, new Date(m.received_at)).filter((t) => !NEGATED.test(t.sentence)).map((t) => t.start)).filter((d) => d.getTime() > Date.now());
}

const MOVES = /\b(?:mov(?:e|ed|ing)|push(?:ed|ing)?|reschedul(?:e|ed|ing)|postpon(?:e|ed|ing)|shift(?:ed|ing)?|bring(?:ing)? (?:it )?forward|chang(?:e|ed|ing)|new time|now (?:at|on))\b/i;
const CANCELS = /\b(?:(?:have|need|had|going|like|want) to cancel|(?:is|are|been|be|was|will be|'s) cancel(?:l)?ed|cancel(?:l)?ing|let'?s cancel|i(?:'ll| will| must) (?:have to )?cancel|call(?:ing|ed)? (?:it|this|the \w+|our \w+)? ?off|annul(?:er|é|ée|ons)|absagen|cancelar)\b/i;
const NOT_THAT = /\b(?:not|never|don't|do not|won't|no need|unless|if|subscription|order|anytime|policy)\b/i;

export type Plan = { summary: string; detail: Record<string, unknown>; also: boolean };

// What an email that just came settles: the time they take of those the user
// offered, or that the meeting is moved or off. `also` when it asks something
// besides. Null when it settles nothing.
export async function settles(userId: string, email: EmailRow, tz: string): Promise<Plan | null> {
  const thread = await threadOf(userId, email.thread_id);
  const at = thread.findIndex((m) => m.id === email.id);
  const m = thread[at];
  if (!m || isSent(m) || m.is_calendar || looksLikeInstructions(m.subject, m.body_text)) return null;
  const text = textOf(m);
  const sent = new Date(m.received_at);
  const who = displayName(m.sender, String(m.sender_email ?? ""));
  const also = sentencesOf(text).some((s) => s.endsWith("?"));
  const say = (d: Date) => labelOf(d, tz);
  // Only someone the user wrote to in this thread.
  const before = thread.slice(0, at).filter(isSent).pop();
  if (!before || !addressesIn(before.recipients ?? "").includes(lc(m.sender_email))) return null;

  const meeting = await meetingOfThread(userId, thread);
  if (meeting) {
    const off = sentencesOf(text).find((s) => CANCELS.test(s) && !NOT_THAT.test(s) && !s.endsWith("?"));
    const named = unique(timesIn(text, tz, sent).map((t) => t.start)).filter((d) => d.getTime() > Date.now());
    if (off && !named.some((d) => !same(d, new Date(meeting.start_time)))) {
      return { summary: `${who} called off "${meeting.title}", ${say(new Date(meeting.start_time))}`, detail: { op: "cancel", meetingId: meeting.id, title: meeting.title, start_time: meeting.start_time, end_time: meeting.end_time }, also };
    }
    const moved = sentencesOf(text).find((s) => MOVES.test(s) && !s.endsWith("?") && !NEGATED.test(s));
    const to = moved ? unique(timesIn(moved, tz, sent).map((t) => t.start)).filter((d) => d.getTime() > Date.now() && !same(d, new Date(meeting.start_time))) : [];
    if (to.length === 1) return move(userId, meeting, to[0], `${who} moved`, say, also);
  }

  const offered = offeredIn(before, tz);
  if (!offered.length) return null;
  const start = taken(text, offered, tz, sent);
  if (!start) return null;
  if (meeting) return same(start, new Date(meeting.start_time)) ? null : move(userId, meeting, start, "Moved", say, also);
  if (await there(userId, start, [lc(m.sender_email)])) return null;
  const all = thread.map(textOf).join("\n");
  return { summary: `On your calendar: ${titleOf(m, who)}, ${say(start)}`, detail: { op: "add", title: titleOf(m, who), start_time: start.toISOString(), end_time: new Date(start.getTime() + minutesIn(all) * MIN).toISOString(), people: [lc(m.sender_email)] }, also };
}

// Is something with them, or at that time, on the calendar already?
async function there(userId: string, start: Date, people: string[]): Promise<boolean> {
  const cal = await userCalendar(userId);
  if (!cal) return true;
  return !!(await cal.calendar.find(cal.account, { start: start.toISOString(), people }).catch(() => ({})));
}

// The event at its new time, when nothing else is there then.
async function move(userId: string, meeting: Record<string, any>, start: Date, how: string, say: (d: Date) => string, also: boolean): Promise<Plan | null> {
  const end = new Date(start.getTime() + (Date.parse(meeting.end_time) - Date.parse(meeting.start_time)));
  const cal = await userCalendar(userId);
  if (!cal) return null;
  const busy = await cal.calendar.busy(cal.account, start, end).catch(() => null);
  const self = (b: { start: string; end: string }) => Math.abs(Date.parse(b.start) - Date.parse(meeting.start_time)) < MIN;
  if (!busy || busy.some((b) => !self(b) && start.getTime() < Date.parse(b.end) && end.getTime() > Date.parse(b.start))) return null;
  return { summary: `${how} "${meeting.title}" to ${say(start)}`, detail: { op: "move", meetingId: meeting.id, title: meeting.title, start_time: start.toISOString(), end_time: end.toISOString(), before: { start_time: meeting.start_time, end_time: meeting.end_time } }, also };
}

function titleOf(m: Stored, who: string): string {
  const subject = String(m.subject ?? "").replace(/^((re|fwd?|aw|sv|tr)\s*:\s*)+/i, "").trim();
  return subject && subject.length <= 80 ? `${subject} (${who})` : `Meeting with ${who}`;
}

// Through the policy, as agreed in the thread.
export async function put(userId: string, emailId: string, plan: Plan): Promise<"done" | "proposed" | "refused" | "failed"> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const { count } = await db.from("action_log").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("kind", "event").gte("created_at", since.toISOString());
  const p: Planned = { kind: "event", emailId, summary: plan.summary, detail: plan.detail };
  return act(userId, p, { ...(await engineSettings(userId)), source: "engine", agreed: true, todayCount: count ?? 0 });
}

// Was something about this email put on the calendar, or asked about, before?
export async function settledBefore(userId: string, emailId: string): Promise<boolean> {
  const { count } = await db.from("action_log").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("kind", "event").eq("email_id", emailId).neq("status", "failed");
  return !!count;
}

// ── What the user agreed to ─────────────────────────────────────────────────

const looked = new Set<string>();
const LOOK_BACK_MS = 2 * DAY;

// Mail the user just sent that says yes to a time they were asked about: that
// meeting goes on the calendar (or moves there), and what asked about it is
// closed. A no closes it too.
export async function afterSent(userId: string, tz: string): Promise<number> {
  const { data } = await db.from("emails").select(FIELDS).eq("user_id", userId).contains("label_ids", ["SENT"]).gte("received_at", new Date(Date.now() - LOOK_BACK_MS).toISOString()).order("received_at", { ascending: true }).limit(200);
  let made = 0;
  for (const m of (data ?? []) as unknown as Stored[]) {
    if (looked.has(m.id) || !m.thread_id) continue;
    looked.add(m.id);
    const thread = await threadOf(userId, m.thread_id);
    const asked = thread.filter((x) => !isSent(x) && x.received_at < m.received_at).pop();
    if (!asked || asked.is_calendar || (await settledBefore(userId, asked.id))) continue;
    const { data: p } = await db.from("email_processed").select("quick_actions").eq("email_id", asked.id).maybeSingle();
    const action = ((p?.quick_actions as Record<string, unknown>[] | null) ?? []).find((a) => a.action === "schedule_meeting");
    const found = action ? meetingOf(action, asked as never, tz, new Date(asked.received_at)) : null;
    // The time they asked about, or the one there is in their words.
    const own = unique(timesIn(textOf(asked), tz, new Date(asked.received_at)).map((t) => t.start)).filter((d) => d.getTime() > Date.now());
    const wall = found?.dateTime ? toInstant({ y: Number(found.dateTime.slice(0, 4)), m: Number(found.dateTime.slice(5, 7)), d: Number(found.dateTime.slice(8, 10)) }, clockMinutes(found.dateTime.slice(11, 16)), { iana: tz }) : null;
    const times = unique([...(wall && wall.getTime() > Date.now() ? [wall] : []), ...own]);
    if (!times.length) continue;
    const text = textOf(m);
    const yes = sentencesOf(text).filter((s) => COMMITS.test(s) && !NEGATED.test(s) && !s.endsWith("?")).join(" ");
    const no = sentencesOf(text).some((s) => NEGATED.test(s));
    if (!yes && no) {
      await closeWaiting(userId, asked.id, "You answered no");
      continue;
    }
    if (!yes) continue;
    const named = unique(timesIn(yes, tz, new Date(m.received_at)).map((t) => t.start));
    const start = named.length > 1 ? null : named.length ? (times.find((t) => same(t, named[0])) ?? null) : taken(`yes ${yes}`, times, tz, new Date(m.received_at));
    if (!start) continue;
    const who = displayName(asked.sender, String(asked.sender_email ?? ""));
    const meeting = await meetingOfThread(userId, thread);
    if (meeting && same(start, new Date(meeting.start_time))) continue;
    if (!meeting && (await there(userId, start, [lc(asked.sender_email)]))) {
      await closeWaiting(userId, asked.id, "On the calendar already");
      continue;
    }
    const title = found?.title || titleOf(asked, who);
    const say = (d: Date) => labelOf(d, tz);
    const plan: Plan | null = meeting
      ? await move(userId, meeting, start, "Moved", say, false)
      : { summary: `On your calendar: ${title}, ${say(start)}`, detail: { op: "add", title, start_time: start.toISOString(), end_time: new Date(start.getTime() + (found?.duration || minutesIn(textOf(asked))) * MIN).toISOString(), location: found?.location ?? null, quote: found?.quote ?? null, people: [lc(asked.sender_email)] }, also: false };
    if (!plan) continue;
    if ((await put(userId, asked.id, plan)) === "done") {
      made++;
      await closeWaiting(userId, asked.id, "You agreed to it");
    }
  }
  return made;
}

// The proposal of a meeting from an email, dealt with in the mail itself. It
// says nothing about what the user wants proposed.
async function closeWaiting(userId: string, emailId: string, why: string): Promise<void> {
  const now = new Date().toISOString();
  await db.from("action_log").update({ status: "dismissed", decided_at: now, reason: why }).eq("user_id", userId).eq("kind", "meeting").eq("status", "proposed").eq("email_id", emailId);
  await db.from("meetings").delete().eq("user_id", userId).eq("status", "proposed").eq("email_id", emailId);
}
