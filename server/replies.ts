// Reply drafts: what one is written from, and what it may say.
//
// The model is given what a good assistant would look at (draftContext): the
// thread, what else was written with the same person, what the others in the
// thread or at that company wrote on the same subject, the text of the files
// attached, the open todos and meetings with them and the calendar on the days
// the email names. A new email to someone is written from the same. What a
// draft was given is kept with it, for the user to see (Source). A local model gets a tight, ranked selection, a cloud model
// more. The parts that are the same for every reply come first, so a local
// model can reuse the work it did on them.
//
// A draft never decides for the user. Where the email asks for a decision and
// nothing the user wrote settles it, the draft holds each answer under a label
// (choices.ts) and the user takes one.
//
// Small models forget instructions, so what a draft says is checked in code
// (problemsIn): numbers, addresses and days that are in none of what it was
// written from, things said to be done or attached, gaps, the user's own rules,
// and a decision taken for them. It is written once more, then the sentence is
// cut.

import { db } from "./db.ts";
import { composeDraft, generateDraft } from "./ai.ts";
import { choicesOf, MARK, sharedText, tidyChoices, type Choice } from "./choices.ts";
import { fileText, readable } from "./fileText.ts";
import { isLocalModel } from "./llm.ts";
import { GAP, looksLikeInstructions } from "./policy.ts";
import { displayName, profileContext } from "./profile.ts";
import { calendarAccount, mail, type AttachmentInfo } from "./providers.ts";
import { daysIn, todayIn } from "./rules.ts";
import { addressesIn, isBulk, ownAddresses, SHARED_DOMAINS, writtenTo } from "./senders.ts";
import { listAccounts } from "./accounts.ts";
import { broken, CLOSING, displayNameOf, keepRules, ownWords, recipients, splitQuoted, stylePrompt, writingFor, type Recipient, type Writing } from "./writing.ts";

export type EmailRow = {
  id: string;
  subject: string | null;
  sender: string | null;
  sender_email: string | null;
  reply_to_email: string | null;
  body_text: string | null;
  body_html?: string | null;
  snippet: string | null;
  received_at: string | null;
  thread_id?: string | null;
  gmail_id?: string | null;
  account_id?: string | null;
  recipients?: string | null;
  cc_recipients?: string | null;
  is_calendar?: boolean | null;
  attachments?: AttachmentInfo[] | null;
};

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const DAY = 86_400_000;

// ── What a reply is written from ────────────────────────────────────────────

// Characters of each part. A local model reads the prompt at a few hundred
// tokens a second, and more to read also means more to mix up.
type Budget = { email: number; thread: number; message: number; others: number; other: number; files: number; notes: number };
export const LOCAL: Budget = { email: 2600, thread: 1500, message: 600, others: 900, other: 320, files: 1200, notes: 400 };
const CLOUD: Budget = { email: 10_000, thread: 14_000, message: 3000, others: 6000, other: 1000, files: 10_000, notes: 1500 };
const OTHERS_DAYS = 180;
const MAX_FILE = 6 * 1024 * 1024;
const MAX_FILES = 4;

const STOP = new Set("about after again also been before being both could does done each even every from give have here into just know like long made make many more most much need only other over please said same some such sure take than thank thanks that their them then there these they this those time very want well were what when where which while will with would your yours hello dear best regards kind".split(" "));
const words = (s: string) => new Set((lc(s).match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => (w.length > 4 ? w.replace(/(?:es|s)$/, "") : w)));

// How much of `about` a text speaks of.
const shares = (text: string, about: Set<string>) => [...words(text)].filter((w) => about.has(w)).length;

// The lines of a text that speak most of `about`, in their order, with its first.
export function gist(text: string, about: Set<string>, cap: number): string {
  if (text.length <= cap) return text;
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 4) return `${text.slice(0, cap).replace(/\s+\S*$/, "")} ...`;
  const ranked = lines.map((l, i) => ({ i, l, score: (i === 0 ? 1000 : 0) + shares(l, about) })).sort((a, b) => b.score - a.score || a.i - b.i);
  const keep = new Set<number>();
  let room = cap;
  for (const r of ranked) {
    if (room <= 40) break;
    keep.add(r.i);
    room -= Math.min(r.l.length, room) + 1;
  }
  return lines.map((l, i) => (keep.has(i) ? l : null)).filter((l) => l !== null).join("\n").slice(0, cap);
}

// Signature blocks and confidentiality notes say nothing a reply needs.
const NOTICE = /\b(?:this|the) (?:e-?mail|message|communication|transmission)\b[\s\S]*\b(?:confidential|privileged|intended (?:only|solely)|addressee|named recipient)\b/i;
export function withoutFooter(text: string): string {
  return text
    .replace(/\n-- ?\n[\s\S]{0,600}$/, "")
    .split(/\n{2,}/)
    .filter((p) => !NOTICE.test(p))
    .join("\n\n")
    .trim();
}

const dayAs = (iso: string, tz: string, time = true) => new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", day: "numeric", month: "short", ...(time ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}) });

type Stored = { id: string; thread_id: string | null; subject: string | null; sender: string | null; sender_email: string | null; recipients: string | null; cc_recipients: string | null; body_text: string | null; snippet: string | null; received_at: string; label_ids: string[] | null };

// The text of the files attached to the email.
async function filesText(userId: string, e: EmailRow, about: Set<string>, cap: number): Promise<{ name: string; text: string }[]> {
  const files = (e.attachments ?? []).filter((a) => readable(a.filename, a.mime_type) && a.size <= MAX_FILE).slice(0, MAX_FILES);
  if (!files.length || !e.gmail_id) return [];
  const account = (await listAccounts(userId)).find((a) => a.id === e.account_id);
  if (!account) return [];
  const out: { name: string; text: string }[] = [];
  for (const f of files) {
    try {
      const got = await mail(account).attachment(account, e.gmail_id, f.attachment_id);
      const text = got ? await fileText(f.filename, f.mime_type, Buffer.from(got.data, "base64url")) : "";
      if (text && !looksLikeInstructions(text)) out.push({ name: f.filename, text: `Attached file "${f.filename}":\n${gist(text, about, Math.floor(cap / files.length))}` });
    } catch (err) {
      console.error("[replies] reading an attachment:", (err as Error).message);
    }
  }
  return out;
}

// What is on the calendar on the days the email names: when the user is taken,
// and by name only what is with this person.
async function calendarLines(userId: string, text: string, sent: Date, people: string[], tz: string): Promise<{ day: string; line: string }[]> {
  const days = daysIn(text, todayIn(tz, sent)).slice(0, 3);
  if (!days.length) return [];
  const cal = calendarAccount(await listAccounts(userId));
  if (!cal) return [];
  const iso = (d: { y: number; m: number; d: number }) => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  const today = iso(todayIn(tz, new Date()));
  const out: { day: string; line: string }[] = [];
  for (const d of days) {
    if (iso(d) < today) continue;
    try {
      const noon = Date.UTC(d.y, d.m - 1, d.d, 12);
      const events = (await cal.calendar.events(cal.account, new Date(noon - DAY), new Date(noon + DAY), 60)).filter((x) => x.start && !x.allDay && new Date(x.start).toLocaleDateString("en-CA", { timeZone: tz }) === iso(d));
      const at = (t: string) => new Date(t).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
      const taken = events.map((x) => `${at(x.start!)} to ${at(x.end ?? x.start!)}${x.people.some((p) => people.includes(lc(p))) ? ` ("${x.title}", with them)` : ""}`);
      const name = new Date(noon).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
      out.push({ day: name.split(",")[0], line: `- The user's calendar on ${name}: ${taken.length ? `taken ${taken.join(", ")}` : "nothing on it"}` });
    } catch (err) {
      console.error("[replies] calendar:", (err as Error).message);
      return out;
    }
  }
  return out;
}

// One thing a draft was written from, in words for the user, and what opens it.
export type Source = { kind: "thread" | "email" | "file" | "todos" | "meeting" | "calendar"; label: string; email_id?: string };
export type Drafted = { text: string; from: Source[] };
type Given = Source & { text: string };

export type Context = { prompt: string; sources: string; mine: string; own: string; about: string; who: string; given: Given[] };

// Everything a reply to `e` is written from, or, `fresh`, a new email to its
// sender, with what the user wants to say as its text. `sources` is all of it
// as one text and `mine` what the user wrote in the thread, for the checks on
// the draft; `given` is its parts.
export async function draftContext(userId: string, e: EmailRow, budget: Budget = isLocalModel() ? LOCAL : CLOUD, fresh = false): Promise<Context> {
  const [me, ownSet, { data: profile }] = await Promise.all([displayNameOf(userId), ownAddresses(userId), db.from("profiles").select("working_hours").eq("id", userId).maybeSingle()]);
  const tz = (profile?.working_hours as { timezone?: string } | null)?.timezone || "UTC";
  const sent = e.received_at ? new Date(e.received_at) : new Date();
  const address = lc(addressesIn(e.reply_to_email || "")[0] || e.sender_email);
  const people = [...new Set([address, lc(e.sender_email)])].filter(Boolean);
  const name = displayName(e.sender, address);
  const full = splitQuoted(String(e.body_text || e.snippet || ""));
  const own = withoutFooter(full.own) || full.own || String(e.snippet ?? "");
  const about = words(`${e.subject ?? ""} ${own}`);
  const isMine = (m: Stored) => !!m.label_ids?.includes("SENT") || ownSet.has(lc(m.sender_email));
  const whoOf = (m: Stored) => (isMine(m) ? `${me || "The user"} (the user)` : displayName(m.sender, String(m.sender_email ?? "")));
  const safe = (m: Stored) => isMine(m) || !looksLikeInstructions(m.subject, m.body_text);
  const FIELDS = "id, thread_id, subject, sender, sender_email, recipients, cc_recipients, body_text, snippet, received_at, label_ids";
  const textOf = (m: Stored) => withoutFooter(ownWords(String(m.body_text || m.snippet || "")));

  // The thread, newest first until the room is used, then in its order. Without
  // stored mail, what the email quotes.
  const { data: inThread } = e.thread_id
    ? await db.from("emails").select(FIELDS).eq("user_id", userId).eq("thread_id", e.thread_id).eq("is_receipt", false).neq("id", e.id || "-").order("received_at", { ascending: false }).limit(30)
    : { data: [] };
  const thread = ((inThread ?? []) as unknown as Stored[]).filter(safe);
  const mine = thread.filter(isMine).map(textOf).join("\n\n");
  const lines: string[] = [];
  let room = budget.thread;
  for (const m of thread) {
    if (room < 80) break;
    const text = textOf(m).slice(0, Math.min(budget.message, room));
    if (!text) continue;
    lines.unshift(`${whoOf(m)}, ${dayAs(m.received_at, tz)}:\n${text}`);
    room -= text.length + 40;
  }
  const quoted = thread.length || looksLikeInstructions(full.quoted) ? "" : full.quoted.slice(0, budget.thread);

  // The same person in other threads: what speaks of the same things, then the
  // newest; and, only where the subject is the same, the others in the thread
  // and at the sender's company.
  const others: Given[] = [];
  if (address.includes("@")) {
    const domain = address.split("@")[1];
    const company = SHARED_DOMAINS.has(domain) || [...ownSet].some((a) => a.endsWith(`@${domain}`)) ? "" : domain.replace(/[%,()]/g, "");
    const around = [...new Set([...thread, e].flatMap((m) => [lc(m.sender_email), ...addressesIn(`${m.recipients ?? ""},${m.cc_recipients ?? ""}`)]))].filter((a) => a.includes("@") && a !== address && !ownSet.has(a)).slice(0, 12);
    const subject = words(String(e.subject ?? "").replace(/^((re|fwd?|aw|sv|tr)\s*:\s*)+/i, ""));
    const since = new Date(sent.getTime() - OTHERS_DAYS * DAY).toISOString();
    const base = () => db.from("emails").select(FIELDS).eq("user_id", userId).gte("received_at", since).neq("id", e.id || "-").eq("is_calendar", false).eq("is_receipt", false);
    const plain = address.replace(/[%,()]/g, "");
    const beside = [...around.map((a) => `sender_email.ilike.${a.replace(/[%,()]/g, "")}`), ...(company ? [`sender_email.ilike.%@${company}`] : [])];
    const sentTo = around.map((a) => `recipients.ilike.%${a.replace(/[%,()]/g, "")}%`);
    const none = Promise.resolve({ data: [] as unknown[] });
    const [{ data: from }, { data: to }, { data: theirCircle }, { data: toCircle }] = await Promise.all([
      base().ilike("sender_email", plain).order("received_at", { ascending: false }).limit(60),
      base().contains("label_ids", ["SENT"]).ilike("recipients", `%${plain}%`).order("received_at", { ascending: false }).limit(60),
      subject.size && beside.length ? base().or(beside.join(",")).order("received_at", { ascending: false }).limit(120) : none,
      subject.size && sentTo.length ? base().contains("label_ids", ["SENT"]).or(sentTo.join(",")).order("received_at", { ascending: false }).limit(60) : none,
    ]);
    const theirs = (m: Stored) => lc(m.sender_email) === address || addressesIn(m.recipients ?? "").includes(address);
    const near = (m: Stored) => {
      const who = isMine(m) ? addressesIn(m.recipients ?? "") : [lc(m.sender_email)];
      return (who.some((a) => around.includes(a)) || (!!company && !isMine(m) && who[0].endsWith(`@${company}`))) && shares(String(m.subject ?? ""), subject) > 0;
    };
    const all = new Map(([...(from ?? []), ...(to ?? []), ...(theirCircle ?? []), ...(toCircle ?? [])] as unknown as Stored[]).map((m) => [m.id, m]));
    const found = [...all.values()]
      .filter((m) => (theirs(m) || near(m)) && (!e.thread_id || m.thread_id !== e.thread_id) && safe(m) && textOf(m))
      .map((m) => ({ m, score: shares(`${m.subject ?? ""} ${textOf(m)}`, about) }))
      .sort((a, b) => b.score - a.score || b.m.received_at.localeCompare(a.m.received_at));
    let left = budget.others;
    // Mail that shares nothing with this one says little, beyond the newest of it.
    for (const { m } of [...found.filter((x) => x.score > 1), ...found.filter((x) => x.score <= 1 && theirs(x.m)).slice(0, 1)]) {
      if (left < 100) break;
      const text = gist(textOf(m), about, Math.min(budget.other, left)).replace(/\n+/g, " ");
      const to = isMine(m) ? ` to ${addressesIn(m.recipients ?? "")[0] ?? ""}` : "";
      others.push({
        kind: "email", email_id: m.id, text: `- ${whoOf(m)}${theirs(m) ? "" : to}, ${dayAs(m.received_at, tz, false)}, "${m.subject ?? ""}": ${text}`,
        label: `${isMine(m) ? "your email" : `${displayName(m.sender, String(m.sender_email ?? ""))}'s email`} of ${new Date(m.received_at).toLocaleDateString("en-GB", { timeZone: tz, day: "numeric", month: "short" })}`,
      });
      left -= text.length + 60;
    }
  }

  // Open with them, what the calendar says, what Tabellar noted about them.
  const now = new Date().toISOString();
  const [{ data: todos }, { data: meetings }, { data: known }, files, calendar, who, whole] = await Promise.all([
    db.from("todos").select("text, due, emails!inner(sender_email)").eq("user_id", userId).eq("is_completed", false).in("emails.sender_email", people).limit(6),
    db.from("meetings").select("title, start_time, status, attendees, emails(sender_email)").eq("user_id", userId).gte("start_time", now).order("start_time", { ascending: true }).limit(40),
    name.length > 1 && !name.includes("@")
      ? db.from("knowledge_base").select("entity, entity_type, info").eq("user_id", userId).in("entity_type", ["person", "company"]).ilike("entity", `%${name.replace(/[%_]/g, "")}%`).limit(5)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    filesText(userId, e, about, budget.files),
    calendarLines(userId, `${e.subject ?? ""}\n${own}`, sent, people, tz),
    profileContext(userId),
    profileContext(userId, { sender_email: e.sender_email, subject: e.subject, text: own }),
  ]);
  const open: Given[] = [];
  const due = (todos ?? []).map((t) => `- Not done yet: ${t.text}${t.due ? ` (due ${t.due})` : ""}`);
  if (due.length) open.push({ kind: "todos", label: `${due.length} open todo${due.length === 1 ? "" : "s"}`, text: due.join("\n") });
  for (const m of meetings ?? []) {
    const theirs = people.includes(lc((m.emails as { sender_email?: string } | null)?.sender_email)) || JSON.stringify(m.attendees ?? "").toLowerCase().includes(address);
    if (theirs && m.status !== "cancelled") open.push({ kind: "meeting", label: `the meeting "${m.title}"`, text: `- Meeting ${m.status === "confirmed" ? "on the calendar" : "proposed, not agreed yet"}: ${m.title}, ${dayAs(String(m.start_time), tz)}` });
  }
  open.push(...calendar.map((c): Given => ({ kind: "calendar", label: `${c.day}'s calendar`, text: c.line })));
  const notes = (known ?? []).map((k) => `${k.entity}: ${k.info}`).join("\n").slice(0, budget.notes);

  const parts = [
    notes && `Notes on ${name}:\n${notes}`,
    others.length && `Other emails with ${name} and around this:\n${others.map((o) => o.text).join("\n")}`,
    open.length && `Now:\n${open.flatMap((o) => o.text.split("\n")).slice(0, 8).join("\n")}`,
    lines.length && `Earlier in this thread, oldest first:\n\n${lines.join("\n\n")}`,
    quoted && `Quoted under the email:\n${quoted}`,
    files.map((f) => f.text).join("\n\n"),
    !fresh && `The email to answer, from ${name}, ${dayAs(sent.toISOString(), tz)}:\nSubject: ${e.subject ?? ""}\n\n${own.slice(0, budget.email)}`,
  ].filter(Boolean) as string[];
  const prompt = parts.join("\n\n");
  // What is said of this sender alone goes with the email; the rest is the same for every reply.
  const sender = whole.startsWith(who) ? whole.slice(who.length).trim() : "";
  const given: Given[] = [
    ...(lines.length ? [{ kind: "thread" as const, label: "this thread", text: lines.join("\n"), ...(e.id ? { email_id: e.id } : {}) }] : []),
    ...others,
    ...files.map((f): Given => ({ kind: "file", label: f.name, text: f.text, email_id: e.id })),
    ...open,
  ];
  return { prompt, sources: `${whole}\n${prompt}\n${e.sender ?? ""} ${e.sender_email ?? ""}`, mine, own: fresh ? "" : own, about: sender, who, given };
}

// What a draft was written from, what it takes a figure from first.
const MOST_SOURCES = 8;
function sourcesOf(c: Context, text: string): Source[] {
  const figures = runs(text).filter((d) => d.length > 1);
  const holds = (g: Given) => runs(g.text).some((d) => figures.includes(d));
  const rank = (g: Given) => (g.kind === "thread" ? 2 : holds(g) ? 1 : 0);
  const ranked = [...c.given].sort((a, b) => rank(b) - rank(a)).filter((g, i, list) => list.findIndex((x) => x.label === g.label) === i);
  return ranked.slice(0, MOST_SOURCES).map(({ kind, label, email_id }) => ({ kind, label, ...(email_id ? { email_id } : {}) }));
}

// ── What a draft may say ────────────────────────────────────────────────────

const WEEKDAY = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/gi;
const MONTH = /\b(?:january|february|march|april|june|july|august|september|october|november|december)\b/gi;

const sentencesOf = (text: string) => text.split("\n").flatMap((l) => l.match(/[^.!?]+(?:[.!?](?=\S)[^.!?]*)*[.!?]*\s*/g) ?? []).map((s) => s.trim()).filter(Boolean);

// Something said to be done or attached. A draft is written before anything
// is done, so only what the sources say was done is.
const DONE =
  /\b(?:I(?:'ve| have)(?: just| already| now)? (?:sent|attached|forwarded|shared|signed|paid|submitted|uploaded|spoken|talked|checked|confirmed|reviewed|added|updated|scheduled|booked)|I(?: just| already) (?:sent|signed|paid|shared|checked)|(?:please )?(?:find|see) (?:the )?attached|(?:is|are|it's) attached|attached (?:is|are)|you(?:'ll| will) (?:find|receive) (?:a |the |an )?(?:invite|invitation|copy|file|document)|ci-joint|en pièce jointe|j'ai (?:bien )?(?:envoyé|signé|transmis|vérifié|payé))\b/i;

// The user agreeing, promising or accepting.
const COMMITS = new RegExp(
  [
    "\\b(?:that|this|it|which|time|date|day|(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|\\d(?:\\s?[ap]m)?)(?: [\\w:]+){0,5} (?:works|suits|would work|will work|is (?:good|fine|perfect|great|okay|ok))\\b",
    "\\bworks (?:well|perfectly|great|fine|best|for (?:me|us))",
    "\\b(?:sounds (?:good|great)|count me in|no problem|not a problem|fine by me|fine with me)\\b",
    "\\bsee you (?:then|there|at|on|soon|tomorrow|next|(?:mon|tues|wednes|thurs|fri|satur|sun)day)",
    "\\bi(?:'ll| will| can| am going to|'m going to| should be able to) (?!not\\b|only\\b|see why|understand|imagine|leave|(?:have|need) to\\b|let you (?:decide|choose))\\p{L}+",
    "\\bi(?:'m| am) (?:looking into|working on|checking|free|available|coming|attending|in\\b|glad to|happy to|good with|fine with|okay? with)",
    "\\bi(?: would like|'d like| want| prefer|'d prefer) (?!to (?:know|understand|see|hear)|not)",
    "\\bi(?:'d| would) (?:be (?:happy|glad|delighted|pleased)|love|like) to",
    "\\b(?:please |feel free to )?(?:go ahead|proceed)\\b",
    "\\b(?:will|'ll) (?:get|come|be) back to you|\\bkeep you (?:posted|updated)|\\bfollow up with you",
    "\\byou (?:can|may) (?:go|give|use|quote|send|share|count|put|tell|book|order|start|have)\\b",
    "\\b(?:i|we) (?:agree|accept|approve|confirm)\\b|\\bwe (?:can (?:do|agree|offer|raise|waive)|will)\\b|\\bwe'll \\p{L}+",
    "\\b(?:it's|it is|that's|that is) (?:approved|agreed|confirmed|fine|okay?)\\b|\\byou (?:have|can have) my (?:approval|permission|ok)\\b",
    "\\blooking forward to (?:seeing|meeting|it\\b|attending|joining|the (?:call|meeting|visit|dinner))",
    "\\bje (?:serai|viendrai|participerai|confirme|vous (?:envoie|enverrai|appelle|rappelle|tiens)|peux|pourrai|suis (?:disponible|d'accord|ravie?|partant))|avec plaisir|c'est (?:d'accord|parfait|entendu)|ça me (?:va|convient)",
  ].join("|"),
  "iu",
);
const NEGATED = /\b(?:can't|cannot|won't|don't|doesn't|didn't|unable|unfortunately|ne (?:peux|pourrai|serai|viendrai))\b|^(?:if|whether|once|unless)\b/i;

// The email asks the user to decide something: a time, money, an event, a
// favour, a thing by a day.
const ASKS =
  /\b(?:are you (?:free|available|able|ok|okay|coming|happy|willing|around|in|fine|good)|(?:will|would|can|could) you (?!(?:please )?(?:remind|tell|clarify|explain|point|let me know (?:what|where|which|who|how|the)|share the (?:address|number|name)))|do you (?:have (?:time|a (?:moment|minute|few))|want|agree|accept|mind|approve)|would (?:it|that|this|\w+day|you|the|next|either)|(?:can|could|may|shall|should) (?:i|we)\b|(?:does|do|would|is|are|will) [^?.\n]{0,60}\b(?:work|suit|ok|okay|fine|good|possible|convenient|a problem)\b|ok with|okay with|go ahead\?|which (?:day|time|date|one|of)|what time|when (?:can|could|are|would|suits)|rsvp|let me know if you(?:'re| are| can)|please (?:confirm|approve|sign|send)|pou[vr]+(?:ez|ais|iez)[ -]vous (?!me (?:le |la |les )?(?:rappeler|dire|indiquer|préciser))|êtes[ -]vous (?:disponible|libre|d'accord)|seriez[ -]vous|voulez[ -]vous|souhaitez[ -]vous|puis-je|est-ce que (?:cela|ça) vous|puedes|podrías|podría|können sie|kannst du|könnten sie)/i;

export const asksDecision = (own: string): boolean => ASKS.test(own);

// Sentences of `text` that decide for the user. What they said themselves in
// the thread stands behind a sentence whose days and numbers are all theirs.
export function decides(text: string, mine: string): string[] {
  const agreed = COMMITS.test(mine.replace(/’/g, "'"));
  return sentencesOf(text.replace(/’/g, "'")).filter((s) => {
    if (!COMMITS.test(s) || s.endsWith("?") || NEGATED.test(s)) return false;
    if (!agreed) return true;
    const theirs = lc(mine);
    const numbers = runs(mine);
    return runs(s).some((n) => !numbers.includes(n)) || [...s.matchAll(WEEKDAY), ...s.matchAll(MONTH)].some((m) => !theirs.includes(lc(m[0])));
  });
}

const runs = (s: string) => (s.match(/\d+/g) ?? []).map((d) => d.replace(/^0+(?=\d)/, ""));

// Numbers, addresses, links and days of a draft that nothing it was written
// from holds, as the words they appear in.
export function madeUp(text: string, sources: string, sent = new Date()): string[] {
  const src = lc(sources);
  const numbers = new Set(runs(sources));
  const out: string[] = [];
  for (const m of text.matchAll(/[^\s<>()]+@[^\s<>()]+\.\w+|https?:\/\/\S+|www\.\S+/gi)) if (!src.includes(lc(m[0]).replace(/[.,;:!?)]+$/, ""))) out.push(m[0]);
  const bare = text.replace(/\n\s*\d+[.)]\s/g, "\n").replace(/^\s*\d+[.)]\s/, "");
  for (const m of bare.matchAll(/[$€£]?\d[\d.,:/-]*\d%?|[$€£]?\d%?/g)) {
    const digits = runs(m[0]).filter((d) => d !== "0");
    // 2 pm is 14:00.
    const hour = (d: string) => Number(d) <= 24 && [Number(d) + 12, Number(d) - 12].some((h) => numbers.has(String(h)));
    if (digits.some((d) => !numbers.has(d) && !hour(d))) out.push(m[0]);
  }
  const at = { ...todayIn("UTC", sent) };
  const known = new Set([...daysIn(sources, at)].map((d) => new Date(Date.UTC(d.y, d.m - 1, d.d)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase()));
  for (const m of text.matchAll(WEEKDAY)) if (!src.includes(lc(m[0])) && !known.has(lc(m[0]))) out.push(m[0]);
  for (const m of text.matchAll(MONTH)) if (!src.includes(lc(m[0]).slice(0, 3))) out.push(m[0]);
  return [...new Set(out)];
}

const strayGap = (text: string) => text.split("\n").map((l) => l.replace(MARK, "").match(new RegExp(GAP.source, "i"))?.[0]).filter((x): x is string => !!x);

// The user is asked what they want.
const WANTS = /\b(?:do|did|would) you (?:want|prefer|like|rather)\b|\bwhich (?:one|do you|would you)\b|\b(?:préférez|voulez|souhaitez)[ -]vous\b/i;

export type Problems = { facts: string[]; done: string[]; gaps: string[]; rules: string[]; decided: string[]; asked: string[] };

const DECLINES = /^(?:no|non|none|neither|nein|nej|nessuno|nenhum|keine|ninguno|aucun|not)\b/i;
const TIMED = /\b\d{1,2}(?::\d\d|\s?[ap]m|\s?h)\b|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day/i;
// Times to choose between, with no way to decline them all.
const oneSided = (c: Choice[]) => c.every((x) => !DECLINES.test(x.label) && !NEGATED.test(x.text)) && c.some((x) => TIMED.test(x.text));

// What is wrong with a draft. `said` is what the user told it to say: their
// word, so a decision in it is theirs.
export function problemsIn(text: string, w: Writing, c: Context, said: string, sent = new Date()): Problems {
  const sources = `${c.sources}\n${said}\n${w.closing}\n${w.rules.join("\n")}`;
  return {
    facts: madeUp(text, sources, sent),
    done: sentencesOf(text.replace(/’/g, "'")).filter((s) => DONE.test(s) && !DONE.test(said) && !DONE.test(c.mine)),
    gaps: strayGap(text),
    rules: broken(text, w),
    decided: said ? [] : decides(sharedText(text), c.mine),
    asked: said || choicesOf(text).length || !text.trim() ? [] : sentencesOf(c.own).filter((s) => s.endsWith("?") && WANTS.test(s)),
  };
}

const count = (p: Problems) => Object.values(p).reduce((n, list) => n + list.length, 0);

// What the model is told when its first try broke something.
function again(p: Problems, first: string, asked: boolean): string {
  const open = choicesOf(first).length > 0;
  const quoted = (list: string[]) => list.map((x) => `"${x}"`).join(", ");
  return [
    `Your first try was:\n${first}\n\nWrite it again.`,
    p.decided.length &&
      (open
        ? `It agrees or promises something for the user: ${quoted(p.decided)}. Leave that out (that they are sorry may stand in its place, when something went wrong), and keep the answers under their labels.`
        : asked
        ? `It decided for the user: ${quoted(p.decided)}. Leave that to them: write the paragraphs [Yes] and [No] (or one for each option they are offered), then the sign-off.`
        : `It agrees or promises something for the user: ${quoted(p.decided)}. The email asks for no such thing: leave it out, without any labels, and say only that they have seen it.`),
    p.facts.length && `Nothing given to you says ${quoted(p.facts)}. Leave it out, and do not put another in its place.`,
    p.done.length && `This has not happened: ${quoted(p.done)}. Leave it out.`,
    p.gaps.length && `Leave no gaps to fill in: ${quoted(p.gaps)}.`,
    p.asked.length && `The user is asked what they want: ${quoted(p.asked)}. That is theirs to say: write each answer they can give as a paragraph under a short label in square brackets, then the sign-off.`,
    p.rules.length && `Leave these out entirely, in any wording: ${quoted(p.rules)}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// The sentences that still say what they must not, taken out.
function cut(text: string, p: Problems, w: Writing): string {
  if (!count({ ...p, asked: [] })) return text;
  const bits = [...p.facts, ...p.gaps, ...p.done, ...p.decided].map((x) => x.replace(/’/g, "'"));
  // "5" is not in "15".
  const holds = (s: string, b: string) => new RegExp(`(?<!\\d)${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(s);
  const bad = (s: string) => bits.some((b) => holds(s.replace(/’/g, "'"), b)) || broken(s, w).length > 0;
  return text
    .split("\n")
    .map((l) => (bad(l) ? sentencesOf(l).filter((s) => !bad(s)).join(" ") : l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Languages ───────────────────────────────────────────────────────────────

// The language of an email, by its commonest words; "en" when it is not clear.
const COMMON: Record<string, string> = {
  en: "the and you for that this with are have will can your please would from thanks hi we is to of",
  fr: "le la les des une vous nous je que pour dans est avec sur pas bonjour merci votre pouvez et à du cordialement",
  es: "el los las una que para con por está usted hola gracias saludos puede nos su del y le como",
  de: "der die das und ist nicht ich sie wir für mit ein eine auf hallo danke bitte können zu den von grüße",
  it: "il che per con una sono non grazie ciao buongiorno di della può vi saluti e gli questo",
  pt: "o os uma que para com não você obrigado olá por está do da em seu saudações podemos",
  nl: "de het een van ik je niet dat voor met hallo bedankt groet we zijn op kunt u",
};
export function languageOf(text: string): string {
  const t = lc(text).match(/[\p{L}]+/gu) ?? [];
  if (t.length < 6) return "en";
  let best = "en";
  let most = 0;
  for (const [lang, list] of Object.entries(COMMON)) {
    const set = new Set(list.split(" "));
    const n = t.filter((w) => set.has(w)).length;
    if (n > most) [best, most] = [lang, n];
  }
  return most >= t.length * 0.12 ? best : "en";
}

const LANGUAGES: Record<string, { name: string; greeting: string; closing: string; none: Choice }> = {
  fr: { name: "French", greeting: "Bonjour {name},", closing: "Cordialement,", none: { label: "Aucun", text: "Aucun de ces horaires ne me convient. Pourriez-vous en proposer un autre ?" } },
  es: { name: "Spanish", greeting: "Hola {name},", closing: "Saludos,", none: { label: "Ninguno", text: "Ninguno me viene bien. ¿Podría ser en otro momento?" } },
  de: { name: "German", greeting: "Hallo {name},", closing: "Viele Grüße", none: { label: "Keiner", text: "Keiner dieser Termine passt mir. Geht auch ein anderer?" } },
  it: { name: "Italian", greeting: "Buongiorno {name},", closing: "Cordiali saluti,", none: { label: "Nessuno", text: "Nessuno di questi orari mi va bene. Sarebbe possibile un altro momento?" } },
  pt: { name: "Portuguese", greeting: "Olá {name},", closing: "Com os melhores cumprimentos,", none: { label: "Nenhum", text: "Nenhum desses horários me serve. Seria possível outro?" } },
  nl: { name: "Dutch", greeting: "Hallo {name},", closing: "Met vriendelijke groet,", none: { label: "Geen", text: "Geen van deze tijden komt mij uit. Kan het op een ander moment?" } },
};
const NONE: Choice = { label: "Neither", text: "I can't make either of those. Could we find another time?" };
const ENGLISH = /\b(best|regards|thanks|thank|cheers|sincerely|warmly|yours|wishes|care|soon|hi|hey|hello|dear)\b/i;

// An email in another language is answered in it: the greeting and sign-off
// learned from English mail are the usual ones there.
function inLanguage(w: Writing, lang: string): Writing {
  const l = LANGUAGES[lang];
  if (!l) return w;
  const under = w.closing.split("\n").slice(1).join("\n");
  return {
    ...w,
    greeting: ENGLISH.test(w.greeting) ? l.greeting : w.greeting,
    closing: ENGLISH.test(w.closing.split("\n")[0]) ? `${l.closing}${under ? `\n${under}` : ""}` : w.closing,
  };
}

// The sign-off as the user writes it, once, whatever the model put there. A
// rule about signing off is the model's to follow.
export function signedOff(text: string, w: Writing, name: string): string {
  if (!w.closing || w.rules.some((r) => /\b(sign(ed|ing)?[ -]?(off|with|as|my)?|clos(e|ing)|end\b.*\bwith|regards|cheers)\b/i.test(r))) return text;
  const own = new Set(lc(`${name} ${w.closing}`).match(/[\p{L}]+/gu) ?? []);
  const lines = text.trimEnd().split("\n");
  const isName = (l: string) => {
    const t = lc(l).match(/[\p{L}]+/gu) ?? [];
    return t.length > 0 && t.length <= 4 && t.every((x) => own.has(x));
  };
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (!last || CLOSING.test(last) || isName(last)) lines.pop();
    else break;
  }
  return /^none\.?$/i.test(w.closing.trim()) ? lines.join("\n") : `${lines.join("\n")}\n\n${w.closing}`;
}

// ── Writing one ─────────────────────────────────────────────────────────────

// Added when the reply will go out without the user reading it. HOLD turns it
// back into a draft for the user.
const AUTO =
  "This reply will be sent automatically, without the user reading it first. If a good reply needs a decision, an attachment, or facts that are not given to you, write only the word HOLD and nothing else.";
export const HOLD = /^\W*HOLD\W*$/;

// A reply to one email in the user's way of writing. `said` is what the user
// wants to say, in their words; without it nothing is decided for them. ""
// when nothing it may say is left.
export async function draftReply(userId: string, e: EmailRow, said = "", opts: { kind?: Recipient; auto?: boolean } = {}): Promise<Drafted> {
  const [writing, context, name] = await Promise.all([writingFor(userId, e.reply_to_email || e.sender_email, opts.kind), draftContext(userId, e), displayNameOf(userId)]);
  const lang = languageOf(`${e.subject ?? ""} ${context.own}`);
  const w = inLanguage(writing, lang);
  const ask = [stylePrompt(w), context.about, context.prompt, LANGUAGES[lang] && `Write in ${LANGUAGES[lang].name}, the language of the email.`, said && `What the user wants to say: ${said}\nWhat this settles is decided: write it, without labels.`, opts.auto && AUTO].filter(Boolean).join("\n\n");
  const sent = e.received_at ? new Date(e.received_at) : new Date();
  const none = (c: Choice[]) => (oneSided(c) ? (LANGUAGES[lang]?.none ?? NONE) : null);
  const write = async (extra = "") => {
    const raw = await generateDraft(ask, context.who, extra);
    return HOLD.test(raw) ? raw : signedOff(tidyChoices(raw, CLOSING, none), w, name);
  };
  const out = (t: string): Drafted => ({ text: t, from: sourcesOf(context, t) });
  let text = await write();
  if (HOLD.test(text)) return out(text);
  let p = problemsIn(text, w, context, said, sent);
  if (count(p)) {
    const next = await write(again(p, text, asksDecision(context.own)));
    const q = HOLD.test(next) ? null : problemsIn(next, w, context, said, sent);
    if (!q) return out(next);
    if (count(q) <= count(p)) [text, p] = [next, q];
  }
  if (!count(p)) return out(text);
  const kept = tidyChoices(cut(text, p, w), CLOSING);
  // A greeting and a sign-off alone are no reply.
  const body = kept.replace(w.closing, "").split("\n").slice(1).join(" ");
  return out(body.trim().split(/\s+/).filter(Boolean).length > 2 ? signedOff(kept, w, name) : "");
}

// "Name <address>", or an address.
function recipientOf(to: string): { name: string; address: string } {
  return { name: to.match(/^(.*?)<[^>]+>\s*$/)?.[1].replace(/"/g, "").trim() ?? "", address: to.match(/<([^>]+)>/)?.[1].trim() ?? to.trim().split(/[\s,]/)[0] };
}

// What an email the user begins is written from: everything with the person
// it goes to, and on its subject.
async function freshContext(userId: string, to: { name: string; address: string }, subject: string, say: string): Promise<Context> {
  const e: EmailRow = { id: "", subject, sender: to.name ? `${to.name} <${to.address}>` : to.address, sender_email: to.address, reply_to_email: null, body_text: say, snippet: null, received_at: null };
  return draftContext(userId, e, undefined, true);
}

// A new email, one more in a thread the user wrote last in, or the note on an
// email handed on, from a few words on what to say; checked as a reply is.
export async function writeTo(
  userId: string,
  m: { to: string; intent?: string; subject?: string; senderName?: string; replyTo?: { subject: string; body?: string }; forward?: { subject: string; from: string; body?: string } },
): Promise<Drafted> {
  const to = recipientOf(m.to);
  const said = m.intent ?? "";
  const subject = m.subject ?? m.replyTo?.subject ?? "";
  const [w, senderName, c] = await Promise.all([writingFor(userId, to.address), m.senderName || displayNameOf(userId), freshContext(userId, to, subject, said)]);
  const own = { ...c, sources: [c.sources, subject, m.replyTo?.body, m.forward?.subject, m.forward?.from, m.forward?.body].filter(Boolean).join("\n") };
  const background = [c.who, c.about, c.prompt].filter(Boolean).join("\n\n");
  const write = async (extra = "") => {
    const raw = await composeDraft({ intent: said, subject: m.subject ?? "", recipientName: to.name, senderName, replyTo: m.replyTo, forward: m.forward, style: stylePrompt(w), extra, knowledgeContext: background || undefined });
    return m.forward ? raw : signedOff(raw, w, senderName);
  };
  const text = await settled(await write(), w, own, said, write);
  return { text, from: sourcesOf(c, text) };
}

// A text that says nothing it may not: as it is, written once more, or with
// the sentences cut that still do.
async function settled(first: string, w: Writing, c: Context, said: string, write: (extra: string) => Promise<string>): Promise<string> {
  let text = first;
  let p = problemsIn(text, w, c, said);
  if (!count(p)) return text;
  const next = await write(again(p, text, false));
  const q = problemsIn(next, w, c, said);
  if (count(q) <= count(p)) [text, p] = [next, q];
  return count(p) ? cut(text, p, w) : text;
}

// A text another model wrote for the user (Ask), held to the same: `said` is
// the user's own words and `seen` the mail it had before it.
export async function checkedText(userId: string, m: { to: string; subject: string; text: string; said: string; seen: string; answers?: EmailRow | null }): Promise<Drafted> {
  const to = recipientOf(m.to);
  const [w, senderName, c] = await Promise.all([writingFor(userId, to.address), displayNameOf(userId), m.answers ? draftContext(userId, m.answers) : freshContext(userId, to, m.subject, m.said)]);
  const own = { ...c, own: "", sources: `${c.sources}\n${m.subject}\n${m.seen}\n${senderName}` };
  const write = (extra: string) =>
    composeDraft({ intent: m.said, subject: m.subject, recipientName: to.name, senderName, replyTo: m.answers ? { subject: m.subject, body: ownWords(String(m.answers.body_text ?? "")) } : undefined, style: stylePrompt(w), extra, knowledgeContext: [c.who, c.about, c.prompt].filter(Boolean).join("\n\n") || undefined });
  const text = await settled(m.text, w, own, m.said, write);
  return { text, from: sourcesOf(c, text) };
}

// A reply to a real email from that kind of sender, to show how Tabellar
// writes now. Kept nowhere. With no such email it answers a made-up one.
const NO_REPLY = /no.?reply|noreply|donotreply|do-not-reply|notifications?@|mailer-daemon|bounce/i;

export async function sampleReply(userId: string, kind?: Recipient): Promise<{ who: string; subject: string; text: string; example: boolean; draft: string }> {
  const [kindOf, written, { data }] = await Promise.all([
    recipients(userId),
    writtenTo(userId),
    db
      .from("email_processed")
      .select("category, quick_actions, emails!inner(id, subject, sender, sender_email, reply_to_email, body_text, body_html, snippet, received_at, thread_id, gmail_id, account_id, label_ids, is_calendar, has_list_unsubscribe, list_id, precedence_header)")
      .eq("user_id", userId)
      .in("category", ["action-required", "important"])
      .order("processed_at", { ascending: false })
      .limit(300),
  ]);
  const asked = (r: Record<string, unknown>) => ((r.quick_actions as { action?: string }[] | null) ?? []).some((a) => a.action === "reply");
  const rows = ((data ?? []) as Record<string, unknown>[])
    .map((r) => ({ reply: asked(r), e: r.emails as EmailRow & Parameters<typeof isBulk>[0] & { label_ids: string[] | null } }))
    .filter(({ e }) => {
      const a = e.sender_email ?? "";
      return a && !NO_REPLY.test(a) && !e.is_calendar && !e.label_ids?.includes("SENT") && !isBulk(e, written) && String(e.body_text ?? "").trim().length > 40 && !looksLikeInstructions(e.subject, e.body_text, e.body_html) && (!kind || kindOf(a) === kind);
    })
    .sort((a, b) => Number(b.reply) - Number(a.reply) || String(b.e.received_at).localeCompare(String(a.e.received_at)));
  const made = { id: "", subject: "Thursday", sender: "Sam Lee <sam@example.org>", sender_email: "sam@example.org", reply_to_email: null, snippet: null, received_at: null, body_text: "Hi,\n\nAre you free on Thursday at 3 to go over the draft? If not, tell me what suits you better.\n\nSam" };
  const e: EmailRow = rows[0]?.e ?? made;
  return { who: displayName(e.sender, e.sender_email ?? ""), subject: e.subject ?? "", text: ownWords(String(e.body_text ?? "")).slice(0, 600), example: !rows[0], draft: (await draftReply(userId, e, "", { kind })).text };
}
