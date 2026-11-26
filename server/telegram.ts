// Telegram: the Brief and what needs the user on their phone, answered there,
// through a bot of their own. Nothing in between: this process asks Telegram
// for what was sent to the bot (long polling), so there is no server and no
// public address.
//
// The token is kept with the other secrets. The window shows a code; the private chat
// that sends it to the bot is the only one listened to or written to from then
// on. Everything else that reaches the bot is dropped.
//
// Out: the Brief at its time, and what Tabellar would notify about, as a
// channel of notify.ts. Nothing goes out in the quiet hours. In: a button is
// answers.answer(), and its pick is bound to what the line said, so it is
// given once and never to something that changed; text is Ask, which cannot
// send. An answer that sends a text is only offered under the whole of that
// text; a longer one has Read in its place, which fetches it.
//
// Telegram can read what a bot sends. So of an email it is given who wrote,
// the summary and what a short answer says, a longer draft only when the user
// presses Read, and never an attachment. Text is sent as it is, never as markup, and links
// in it are not fetched.

import { randomBytes, randomInt } from "node:crypto";
import { answer, options, undoAnswer } from "./answers.ts";
import { askTabellar } from "./ask.ts";
import { brief, briefSettings, type Brief, type NeedItem } from "./brief.ts";
import { inLine } from "./choices.ts";
import { PLUS_URL, secrets } from "./config.ts";
import { changes, db, type Change } from "./db.ts";
import { kickEngine } from "./engine.ts";
import { CHANNELS, inQuietHours, wallClock, type Hours, type Note } from "./notify.ts";
import { displayName } from "./profile.ts";
import { userCalendar } from "./providers.ts";

// Where Telegram is; `tabellar check` puts its own there.
export const wire = { base: "https://api.telegram.org", plus: PLUS_URL, pollSeconds: 50, retryMs: [5_000, 15_000, 60_000, 300_000, 900_000] };

const CODE_MS = 10 * 60_000;
const QUOTE = 300; // the longest text shown in a list
const FULL = 3_400; // and on its own
const MOST = 4_000; // Telegram's limit is 4,096
const KEPT = 40; // messages that can still be answered
const HISTORY = 10;
const CONVERSATION_MS = 2 * 3600_000;

type Row = Record<string, any>;

// One thing the user can answer. `was` is its key before an answer put another
// line in its place, `said` what was answered, `queued` the send it became.
type Line = { key: string; who: string; text: string; about: string; full?: boolean; hide?: boolean; was?: string; said?: string; undo?: string | null; queued?: string | null };
type Message = { id: number; title: string; head: string; lines: Line[]; tail: string; show?: boolean };
type State = { user_id: string; bot: string; token_ref: string; chat: number | null; who: string | null; code: string | null; code_until: string | null; next: number; messages: Message[] };

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const line1 = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

async function state(): Promise<State | null> {
  const { data } = await db.from("telegram").select("*").limit(1).maybeSingle();
  return data as State | null;
}
const keep = (s: State, patch: Partial<State>) => db.from("telegram").update(Object.assign(s, patch) && patch).eq("user_id", s.user_id);
const pairing = (s: State) => !!s.code && String(s.code_until) > new Date().toISOString();

// What happens to the stored messages happens one thing at a time.
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(f: () => Promise<T>): Promise<T> {
  const p = turn.then(f, f);
  turn = p.catch(() => {});
  return p;
}

// ── The wire ────────────────────────────────────────────────────────────────

async function callWith(token: string, method: string, body: Row = {}, ms = 20_000, stop?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(ms);
  const r = await fetch(`${wire.base}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
  });
  const j = (await r.json().catch(() => ({}))) as Row;
  if (!j.ok) throw Object.assign(new Error(String(j.description || `Telegram answered ${r.status}`)), { code: Number(j.error_code || r.status), wait: Number(j.parameters?.retry_after) || 0 });
  return j.result;
}

function call(s: State, method: string, body: Row = {}): Promise<any> {
  const token = secrets.get(s.token_ref);
  if (!token) throw Object.assign(new Error(LOST), { code: 401 });
  return callWith(token, method, body);
}

const LOST = "The bot's token is not kept here. Connect it again.";
// What is wrong with asking Telegram, and with writing to the chat.
let problem: string | null = null;
let refused: string | null = null;
function inWords(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  if ((e as Error).message === LOST) return LOST;
  if (code === 401 || code === 404) return "Telegram does not accept the bot's token any more. Connect it again.";
  if (code === 409) return "Another program is using this bot. Stop it, or make a new bot.";
  if (code === 403) return "The bot was blocked in Telegram. Unblock it there.";
  return typeof code === "number" ? (e as Error).message : "Telegram could not be reached.";
}

// ── Connecting ──────────────────────────────────────────────────────────────

const LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const makeCode = () => ({ code: Array.from({ length: 8 }, () => LETTERS[randomInt(LETTERS.length)]).join(""), code_until: new Date(Date.now() + CODE_MS).toISOString() });

// ── One tap ─────────────────────────────────────────────────────────────────

// Where Tabellar+ runs, its bot can have Telegram make a bot for the user
// (managed bots): one tap there, and Tabellar+ hands this process the new
// bot's token once, for the secret only this process holds. Tabellar+ is that
// bot's manager, so it could ask Telegram for the token again.
let making: { userId: string; username: string; claim: string; until: number; asked: number } | null = null;

export async function makeBot(userId: string): Promise<{ link: string }> {
  if (!wire.plus) throw fail("This copy of Tabellar makes the bot with BotFather.");
  const username = `tabellar_${randomBytes(5).toString("hex")}_bot`;
  const claim = randomBytes(32).toString("base64url");
  const r = await fetch(`${wire.plus}/api/telegram/expect`, { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, claim }) });
  const d = (await r.json().catch(() => ({}))) as { link?: string; error?: string };
  if (!r.ok || !d.link) throw fail(d.error ?? "Tabellar+ could not be reached. Make the bot with BotFather instead.", 502);
  making = { userId, username, claim, until: Date.now() + 15 * 60_000, asked: 0 };
  return { link: d.link };
}

// Whether the bot was made yet; asked at most every two seconds.
async function madeYet(userId: string): Promise<void> {
  const m = making;
  if (!m || m.userId !== userId || Date.now() - m.asked < 2_000) return;
  if (Date.now() > m.until) return void (making = null);
  m.asked = Date.now();
  const r = await fetch(`${wire.plus}/api/telegram/claim`, { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: m.username, claim: m.claim }) }).catch(() => null);
  const d = r?.ok ? ((await r.json().catch(() => ({}))) as { token?: string }) : {};
  if (!d.token || making !== m) return;
  making = null;
  await connect(userId, d.token);
}

// What Settings shows.
export async function telegramState(userId: string) {
  await madeYet(userId).catch((e) => console.error("[telegram] the new bot:", (e as Error).message));
  const s = await state();
  if (!s || s.user_id !== userId) return { bot: null, oneTap: !!wire.plus, making: making?.userId === userId };
  const code = !s.chat && pairing(s) ? s.code : null;
  return { bot: s.bot, who: s.chat ? s.who : null, paired: !!s.chat, code, link: `https://t.me/${s.bot}${code ? `?start=${code}` : ""}`, error: s.chat || code ? (problem ?? refused) : null };
}

export async function connect(userId: string, pasted: string): Promise<void> {
  // The whole message BotFather answers with will do: the token is in it.
  const token = pasted.match(/(?<![\w:])\d{5,20}:[\w-]{30,60}(?![\w-])/)?.[0] ?? "";
  if (!token) throw fail("That is not a bot token. It looks like 123456789:AAE... and BotFather sends it when the bot is made.");
  let me: { id: number; username: string };
  try {
    me = await callWith(token, "getMe");
    // A bot with a webhook cannot be asked for its messages.
    await callWith(token, "deleteWebhook");
    await callWith(token, "setMyCommands", { commands: [{ command: "brief", description: "What needs you now" }] });
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw fail(code === 401 || code === 404 ? "Telegram does not know that token. Copy it again from BotFather." : inWords(e), 502);
  }
  const had = await state();
  if (had) await disconnect(had.user_id);
  const token_ref = `telegram:${me.id}`;
  secrets.set(token_ref, token);
  await db.from("telegram").insert({ user_id: userId, bot: me.username, token_ref, ...makeCode() });
  problem = refused = null;
  listen();
}

export async function newCode(userId: string): Promise<void> {
  const s = await state();
  if (!s || s.user_id !== userId || s.chat) return;
  await keep(s, makeCode());
  listen();
}

export async function disconnect(userId: string): Promise<void> {
  const s = await state();
  if (!s || s.user_id !== userId) return;
  stopListening();
  secrets.delete(s.token_ref);
  await db.from("telegram").delete().eq("user_id", userId);
  problem = refused = null;
}

// ── A message ───────────────────────────────────────────────────────────────

const timeZone = (me: Row | null) => (me?.working_hours as Hours | null)?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
async function profileOf(userId: string): Promise<Row | null> {
  const { data } = await db.from("profiles").select("working_hours, brief, notification_preview, notification_quiet").eq("id", userId).maybeSingle();
  return data;
}

// The text with its entities and buttons. A line is as it stands now, so one
// dealt with elsewhere says so.
async function render(userId: string, m: Omit<Message, "id">, quote = QUOTE): Promise<Row> {
  let text = "";
  const entities: Row[] = [];
  const keys: Row[][] = [];
  const put = (words: string, type?: string) => {
    if (type && words) entities.push({ type, offset: text.length, length: words.length });
    text += words;
  };
  const gap = () => text && put("\n\n");
  if (m.title) put(m.title, "bold");
  if (m.head) (gap(), put(clip(m.head, quote ? 1_200 : 500)));
  for (const [i, l] of m.lines.entries()) {
    const n = m.lines.length > 1 ? `${i + 1}` : "";
    gap();
    if (n) put(`${n}. `);
    if (l.who) (put(clip(l.who, 60), "bold"), put(l.text ? ": " : ""));
    put(clip(l.text, quote ? 200 : 110));
    const buttons: Row[] = [];
    const button = (label: string, what: string) => buttons.push({ text: n ? `${n} ${label}` : label, callback_data: `${i}|${what}` });
    const o = l.said ? null : await options(userId, l.key);
    if (l.said) (put("\n"), put(l.said, "italic"));
    else if (!o) (put("\n"), put("No longer waiting", "italic"));
    else {
      const written = o.options.some((x) => x.sends !== undefined) || /^(draft|sending):/.test(l.key);
      let shown = true;
      if (l.about && quote) put(`\n${clip(l.about, quote)}`);
      if (written && o.shows) {
        const whole = l.full ? `To ${o.to}\n\n${o.shows}` : `To ${o.to}: ${inLine(o.shows)}`;
        shown = !l.hide && whole.length <= (l.full ? FULL : quote);
        if (shown) (put("\n"), put(whole, "blockquote"));
        else if (l.full) (put("\n"), put(clip(whole, FULL), "blockquote"), put("\nThe rest is in Tabellar."));
      } else if (o.shows && !l.hide) {
        const rest = o.shows.split("\n").map((x) => x.trim()).filter((x) => x && x !== l.text && x !== l.about).join("\n");
        if (rest) put(`\n${clip(rest, l.full ? FULL : quote * 2)}`);
      }
      // What would be sent is there to read, or it is not offered.
      const may = o.options.filter((x) => shown || x.sends === undefined);
      if (!shown && !l.full && !l.hide) button("Read", "read");
      for (const x of may) button(clip(x.label, 30), x.pick);
    }
    if (l.undo) button("Undo", "undo");
    if (buttons.length) keys.push(buttons);
  }
  if (m.tail) (gap(), put(clip(m.tail, quote ? 1_200 : 500)));
  if (m.show) keys.push([{ text: "Show", callback_data: "brief" }]);
  if (text.length > MOST && quote) return render(userId, m, quote > 120 ? 120 : 0);
  return { text: clip(text, MOST), entities: entities.filter((e) => e.offset + e.length < MOST), link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keys } };
}

async function post(s: State, m: Omit<Message, "id">): Promise<void> {
  const sent = await call(s, "sendMessage", { chat_id: s.chat, ...(await render(s.user_id, m)) });
  refused = null;
  if (m.lines.length) await keep(s, { messages: [...s.messages, { ...m, id: sent.message_id }].slice(-KEPT) });
}

const say = (s: State, text: string) => call(s, "sendMessage", { chat_id: s.chat, text: clip(text, MOST), link_preview_options: { is_disabled: true } });

// Every message that holds one of these lines, as it stands now.
async function redraw(s: State, has: (l: Line) => boolean): Promise<void> {
  for (const m of s.messages) {
    if (!m.lines.some(has)) continue;
    await call(s, "editMessageText", { chat_id: s.chat, message_id: m.id, ...(await render(s.user_id, m)) }).catch((e) => {
      if (!/not modified/.test((e as Error).message)) console.error("[telegram] changing a message:", (e as Error).message);
    });
  }
}

// ── What goes out ───────────────────────────────────────────────────────────

const when = (iso: string, tz: string, day = true) => new Date(iso).toLocaleString("en-US", { timeZone: tz, ...(day ? { weekday: "short" } : {}), hour: "numeric", minute: "2-digit" });

async function summariesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const { data } = await db.from("email_processed").select("email_id, summary").in("email_id", ids.filter(Boolean) as string[]);
  return new Map(((data ?? []) as Row[]).map((r) => [String(r.email_id), line1(r.summary)]));
}

function lineOf(n: NeedItem, tz: string, today: string, summaries: Map<string, string>): Line {
  const who = n.who === "Todo" || n.who === "Tabellar" ? "" : n.who;
  const text = n.kind === "question" ? n.shows.split("\n")[0] : n.kind === "meeting" && n.start ? `${n.text}, ${when(n.start, tz)}` : n.kind === "todo" ? `${n.text}${n.due && n.due < today ? ", overdue" : ", due today"}` : n.text;
  const written = n.kind === "reply" || n.kind === "forward" || n.options.some((o) => o.sends !== undefined);
  return { key: n.key, who, text: line1(text), about: written ? (summaries.get(String(n.email_id)) ?? "") : "" };
}

// The Brief in one message: today's calendar, what needs the user and who they
// wait on, each with its answers, then what was gathered and how much was handled.
const WAITING = 3;
async function briefMessage(userId: string, b: Brief, me: Row | null): Promise<Omit<Message, "id">> {
  const tz = timeZone(me);
  const has = (section: string) => b.settings.sections.includes(section);
  const summaries = await summariesOf(b.needs.map((n) => n.email_id));
  const head = [b.away, b.summary].filter((t): t is string => !!t);
  if (has("calendar")) {
    try {
      const cal = await userCalendar(userId);
      const left = 1440 - wallClock(tz).minute;
      const events = cal ? await cal.calendar.events(cal.account, new Date(), new Date(Date.now() + left * 60_000), 8) : [];
      if (events.length) head.push(events.map((e) => `${e.allDay || !e.start ? "All day" : when(e.start, tz, false)}  ${clip(line1(e.title), 80)}`).join("\n"));
    } catch (e) {
      console.error("[telegram] calendar:", (e as Error).message);
    }
  }
  if (b.changes.length) head.push(b.changes.map((c) => clip(line1(c.text), 140)).join("\n"));
  const count = b.needs.length + b.more;
  const lines = has("needs") ? b.needs.map((n) => lineOf(n, tz, b.day, summaries)) : [];
  if (has("waiting")) for (const w of b.waiting.slice(0, WAITING)) lines.push({ key: w.key, who: `Waiting on ${w.who}`, text: line1(w.text), about: "" });
  const tail: string[] = [];
  for (const d of b.digests) tail.push([clip(line1(d.title), 120), ...d.items.slice(0, 5).map((x) => `${x.who}: ${clip(line1(x.text), 100)}`), ...(d.items.length > 5 ? [`${d.items.length - 5} more`] : [])].join("\n"));
  if (b.more && has("needs")) tail.push(`${b.more} more in Tabellar`);
  if (has("handled") && b.handled.length) tail.push(`${b.handled.length} handled without you since yesterday`);
  return { title: count ? `${count} ${count === 1 ? "thing needs" : "things need"} you` : "Nothing needs you", head: head.join("\n\n"), lines, tail: tail.join("\n\n") };
}

// What there is to answer about an email: the reply Autopilot is about to
// send, its lines of the Brief, or the email itself.
async function linesAbout(userId: string, emailIds: string[], tz: string): Promise<Line[]> {
  const b = await brief(userId, { all: true });
  const summaries = await summariesOf(emailIds);
  const out: Line[] = [];
  for (const id of emailIds) {
    const { data: e } = await db.from("emails").select("id, sender, sender_email, subject").eq("id", id).eq("user_id", userId).maybeSingle();
    if (!e) continue;
    const who = displayName(e.sender as string, String(e.sender_email ?? ""));
    const about = summaries.get(id) ?? "";
    const { data: leaving } = await db.from("scheduled_emails").select("id").eq("user_id", userId).eq("email_id", id).eq("status", "pending").not("action_id", "is", null).limit(1);
    const mine = b.needs.filter((n) => n.email_id === id);
    if (leaving?.length) out.push({ key: `sending:${leaving[0].id}`, who, text: line1(e.subject), about });
    else if (mine.length) out.push(...mine.map((n) => lineOf(n, tz, b.day, summaries)));
    else out.push({ key: `read:${id}`, who, text: about || line1(e.subject), about: "" });
  }
  return out;
}

const LINES = 8;
async function messageOf(s: State, n: Note, me: Row | null): Promise<Omit<Message, "id"> | null> {
  const tz = timeZone(me);
  const hide = me?.notification_preview === false;
  // Said where it was announced: that message changes instead (onSent).
  if (n.sent && s.messages.some((m) => m.lines.some((l) => l.key === `sending:${n.sent}`))) return null;
  if (n.brief && !hide) return briefMessage(s.user_id, n.brief, me);
  const lines = n.emails?.length ? await linesAbout(s.user_id, n.emails.slice(0, LINES), tz) : [];
  if (hide) {
    // That it arrived, and no more; what is about to be sent can still be stopped.
    const going = lines.filter((l) => l.key.startsWith("sending:")).map((l) => ({ ...l, who: "", text: "", about: "", hide: true }));
    return { title: going.length ? (n.subtitle ?? "") : "", head: going.length ? "" : n.body, lines: going, tail: "", show: !!n.brief || !!n.emails?.length };
  }
  if (!lines.length) return { title: n.title === "Tabellar" && n.subtitle ? n.subtitle : n.title, head: [n.title === "Tabellar" ? "" : n.subtitle, n.body].filter(Boolean).join("\n"), lines: [], tail: "" };
  // The line says who and what; what is left is why it comes now.
  const why = lines.every((l) => /^(sending|back):/.test(l.key)) ? (n.subtitle ?? "") : "";
  return { title: why, head: n.title === "Tabellar" && !why ? n.body : "", lines, tail: "" };
}

// One note after another. Without a network (a Mac just awake) it is tried
// again for some hours; what is due in the quiet hours does not go out.
const TRY_MS = 6 * 3600_000;
async function deliver(n: Note): Promise<void> {
  const since = Date.now();
  for (let tries = 0; ; tries++) {
    const s = await state();
    if (!s?.chat) return;
    const me = await profileOf(s.user_id);
    if (inQuietHours(me)) return;
    try {
      return await inTurn(async () => {
        const now = await state();
        const m = now?.chat ? await messageOf(now, n, me) : null;
        if (now && m) await post(now, m);
      });
    } catch (e) {
      const { code, wait } = e as { code?: unknown; wait?: number };
      const again = wire.retryMs[Math.min(tries, wire.retryMs.length - 1)];
      if ((typeof code === "number" && code !== 429 && code < 500) || Date.now() - since > TRY_MS) {
        refused = inWords(e);
        return console.error("[telegram] a message did not go out:", (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, Math.max(again, (wait ?? 0) * 1000)));
    }
  }
}

let queue: Promise<void> = Promise.resolve();
export const channel = (n: Note): void => {
  queue = queue.then(() => deliver(n)).catch((e) => console.error("[telegram]", (e as Error).message));
};
// Done with everything given to it so far.
export const idle = () => queue.then(() => inTurn(async () => {}));

// A send a message announced, or that a button started, has gone out or not.
function onChange(c: Change): void {
  const r = c.new as Row;
  if (c.table !== "scheduled_emails" || c.eventType !== "UPDATE" || !["sent", "failed", "cancelled"].includes(String(r.status))) return;
  void inTurn(async () => {
    const s = await state();
    const about = (l: Line) => l.queued === r.id || l.key === `sending:${r.id}`;
    if (!s?.chat || !s.messages.some((m) => m.lines.some(about))) return;
    const { data: row } = await db.from("scheduled_emails").select("status, error_message, to_addresses").eq("id", r.id).maybeSingle();
    if (!row) return;
    const said = row.status === "sent" ? `Sent to ${((row.to_addresses as string[]) ?? []).join(", ")}` : `Not sent${row.error_message && row.error_message !== "Cancelled" ? `: ${row.error_message}` : ""}`;
    for (const l of s.messages.flatMap((m) => m.lines).filter(about)) if (row.status !== "cancelled" || !l.said) Object.assign(l, { said, undo: null });
    await redraw(s, about);
    await keep(s, { messages: s.messages });
  }).catch((e) => console.error("[telegram]", (e as Error).message));
}

// ── What comes in ───────────────────────────────────────────────────────────

async function pair(s: State, m: Row): Promise<void> {
  const said = String(m.text ?? "").replace(/^\/start\s*/, "").replace(/[\s-]/g, "").toUpperCase();
  if (!pairing(s) || said !== s.code) return;
  const who = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || String(m.from.username ?? "");
  await keep(s, { chat: m.chat.id, who, code: null, code_until: null });
  const me = await profileOf(s.user_id);
  await say(s, `This is Tabellar. The Brief comes here at ${briefSettings(me?.brief).time}, and what needs you when it arrives. Write to ask about your mail, or send /brief.`);
}

async function press(s: State, q: Row): Promise<void> {
  const data = String(q.data ?? "");
  const tell = (text = "") => call(s, "answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text: clip(text, 190) } : {}) }).catch(() => {});
  if (data === "brief") return void (await tell(), await sendBrief(s));
  const [at, what] = [data.slice(0, data.indexOf("|")), data.slice(data.indexOf("|") + 1)];
  const line = s.messages.find((m) => m.id === q.message.message_id)?.lines[Number(at)];
  if (!line) return void (await tell("This is too old to answer here. Send /brief."));
  if (what === "read") return void (await tell(), await post(s, { title: "", head: "", lines: [{ ...line, full: true }], tail: "" }));
  // The same line in another message moves along.
  const key = line.key;
  const same = s.messages.flatMap((m) => m.lines).filter((l) => l.key === key && l.undo === line.undo);
  const set = (patch: Partial<Line>) => same.forEach((l) => Object.assign(l, patch));
  let words: string;
  try {
    if (what === "undo") {
      words = (await undoAnswer(String(line.undo ?? ""))).said ?? "Undone";
      const back = line.was ?? key;
      const waits = await options(s.user_id, back);
      set({ key: back, was: undefined, undo: null, queued: null, said: waits ? undefined : words });
    } else {
      const done = await answer(s.user_id, key, what);
      words = done.said;
      // Where one answer was not all, what follows takes the line's place.
      set({ undo: done.undo, queued: done.queued, ...(done.next ? { key: done.next, was: line.was ?? key } : { said: done.said }) });
      if (done.replan) kickEngine();
    }
  } catch (e) {
    words = (e as Error).message;
    if (what === "undo") set({ undo: null });
  }
  await tell(words);
  await redraw(s, (l) => same.includes(l));
  await keep(s, { messages: s.messages });
}

async function sendBrief(s: State): Promise<void> {
  await post(s, await briefMessage(s.user_id, await brief(s.user_id), await profileOf(s.user_id)));
}

async function onUpdate(u: Row): Promise<void> {
  const s = await state();
  if (!s) return;
  const q = u.callback_query as Row | undefined;
  if (q) return s.chat && q.from?.id === s.chat && q.message?.chat?.id === s.chat ? press(s, q) : undefined;
  const m = u.message as Row | undefined;
  if (!m || m.chat?.type !== "private" || m.from?.id !== m.chat.id) return;
  if (!s.chat) return pair(s, m);
  if (m.chat.id !== s.chat) return;
  const text = String(m.text ?? "").trim();
  if (!text) return void (await say(s, "Only text can be read here."));
  // Someone else's words are not the user's: what they ask for is not done.
  if (m.forward_origin || m.forward_date || m.via_bot) return void (await say(s, "Forwarded messages are not read here. Write it yourself."));
  if (/^\/?brief$/i.test(text)) return sendBrief(s);
  if (text.startsWith("/")) return void (await say(s, "Write to ask about your mail, or send /brief."));
  // Asked one after the other, with the buttons still answered meanwhile.
  asking = asking.then(() => askFor(text)).catch((e) => console.error("[telegram] ask:", (e as Error).message));
}

// ── Ask ─────────────────────────────────────────────────────────────────────

let asking: Promise<void> = Promise.resolve();
// The conversation going on, kept with the others in Ask.
let talk: { id: string; at: number } | null = null;

type Said = { role: "user" | "assistant"; content: string };
async function askFor(text: string): Promise<void> {
  const s = await state();
  if (!s?.chat) return;
  const typing = () => void Promise.resolve().then(() => call(s, "sendChatAction", { chat_id: s.chat, action: "typing" })).catch(() => {});
  typing();
  const timer = setInterval(typing, 4_500);
  try {
    const { data: had } = talk && Date.now() - talk.at < CONVERSATION_MS ? await db.from("conversations").select("id, messages").eq("id", talk.id).maybeSingle() : { data: null };
    const before = (had?.messages as Said[] | undefined) ?? [];
    const messages = [...before, { role: "user", content: text }];
    const id = had ? String(had.id) : String((await db.from("conversations").insert({ user_id: s.user_id, title: clip(line1(text), 80), messages }).select("id").single()).data!.id);
    if (had) await db.from("conversations").update({ messages, updated_at: new Date().toISOString() }).eq("id", id);
    talk = { id, at: Date.now() };
    const history = before.slice(-HISTORY).map(({ role, content }) => ({ role, content }));
    const { reply, actions } = await askTabellar(s.user_id, { message: text, history, timezone: timeZone(await profileOf(s.user_id)), conversation_id: id });
    const more = actions.some((a) => a.type === "plan_cleanup") ? "\n\nThe plan is in Ask, in the window." : "";
    await say(s, plain(reply) + more || "No answer. Ask again.");
    for (const a of actions) {
      const line = (key: string, who: string, words: unknown): Line => ({ key, who, text: line1(words), about: "", full: true });
      const made = !a.data.id ? null : a.type === "save_draft" ? line(`draft:${a.data.id}`, "", a.data.subject) : a.type === "create_meeting" ? line(`meeting:${a.data.id}`, "", `${a.data.title}, ${when(String(a.data.start_time), timeZone(await profileOf(s.user_id)))}`) : null;
      if (made) await inTurn(async () => post((await state())!, { title: "", head: "", lines: [made], tail: "" }));
      if (a.type === "make_automation") void showTrial(String(a.data.id), String(a.data.text)).catch((e) => console.error("[telegram] trial:", (e as Error).message));
    }
  } catch (e) {
    await say(s, (e as Error).message);
  } finally {
    clearInterval(timer);
  }
}

// What an automation would have matched, once it has been tried, with Turn on.
const TRIAL_MS = 15 * 60_000;
async function showTrial(id: string, text: string): Promise<void> {
  for (const until = Date.now() + TRIAL_MS; Date.now() < until; await new Promise((r) => setTimeout(r, 1_000))) {
    const s = await state();
    const { data: a } = await db.from("automations").select("trial, enabled").eq("id", id).maybeSingle();
    const trial = a?.trial as { state?: string; error?: string } | null;
    if (!s?.chat || !a || a.enabled) return;
    if (trial?.state === "failed") return void (await say(s, `It could not be tried: ${trial.error ?? "the model did not answer"}. Try it in Automations.`));
    if (trial?.state !== "done") continue;
    return inTurn(async () => post((await state())!, { title: "", head: "", lines: [{ key: `automation:${id}`, who: "", text, about: "", full: true }], tail: "" }));
  }
}

// A model's Markdown, without its marks.
function plain(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^(\s*)[*-]\s+/gm, "$1• ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\s*\u2014\s*/g, ", ")
    .trim();
}

// ── Listening ───────────────────────────────────────────────────────────────

// Asks for what was sent to the bot, as long as there is a chat or a code to
// wait for. An update is marked as read before it is acted on: after a crash it
// is lost, not done twice.
const BACKOFF_MS = 5 * 60_000;
let listening: AbortController | null = null;

function stopListening(): void {
  listening?.abort();
  listening = null;
}

export function listen(): void {
  if (listening) return;
  const mine = (listening = new AbortController());
  const rest = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      mine.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });
  void (async () => {
    let wait = 0;
    while (!mine.signal.aborted) {
      const s = await state();
      if (!s || !(s.chat || pairing(s))) break;
      try {
        const token = secrets.get(s.token_ref);
        if (!token) throw Object.assign(new Error(LOST), { code: 401 });
        const updates = (await callWith(token, "getUpdates", { offset: s.next, timeout: wire.pollSeconds, allowed_updates: ["message", "callback_query"] }, (wire.pollSeconds + 15) * 1000, mine.signal)) as Row[];
        problem = null;
        wait = 0;
        for (const u of updates) {
          if (mine.signal.aborted) return;
          await db.from("telegram").update({ next: u.update_id + 1 }).eq("user_id", s.user_id);
          await inTurn(() => onUpdate(u)).catch((e) => console.error("[telegram] an update:", (e as Error).message));
        }
      } catch (e) {
        if (mine.signal.aborted) return;
        problem = inWords(e);
        wait = Math.min(BACKOFF_MS, Math.max(5_000, wait * 2, ((e as { wait?: number }).wait ?? 0) * 1000));
        await rest(wait);
      }
    }
    if (listening === mine) listening = null;
  })().catch((e) => {
    console.error("[telegram]", (e as Error).message);
    if (listening === mine) listening = null;
  });
}

export function startTelegram(): () => void {
  if (!CHANNELS.includes(channel)) CHANNELS.push(channel);
  changes.on("change", onChange);
  listen();
  return () => {
    stopListening();
    changes.off("change", onChange);
    if (CHANNELS.includes(channel)) CHANNELS.splice(CHANNELS.indexOf(channel), 1);
  };
}
