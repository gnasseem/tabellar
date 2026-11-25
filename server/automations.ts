// Automations: a sentence the user wrote once, carried out from then on.
//
// compile() has the careful model read the sentence once into a trigger,
// conditions and actions. checkSpec() is what decides: a trigger, a condition
// or an action that is not one of the kinds below is refused, and every
// address, name, word and label has to be in the sentence itself. What the
// user confirms is read back from the result by code (readBack), so what they
// read is what runs. Nothing in an email ever changes an automation.
//
// A sentence with nothing to do on its own ("I never go to webinars") is kept
// as a rule for the prompts instead (profile.ts).
//
// An automation is off until its trial has been shown: what it would have
// matched in the last 30 days. It runs from the engine's pass over new mail
// (runOnMail), and once a minute for a time, silence or a meeting (runTimed).
// Every action goes through actions.act() and so policy.decide(), with a cap a
// day, and can be undone. Three undos in a row turn it off and ask why.

import { db } from "./db.ts";
import { answerAbout, automationFrom } from "./ai.ts";
import { act, engineSettings, type Planned, type Settings } from "./actions.ts";
import { listAccounts } from "./accounts.ts";
import { wallClockToUtc, parseWallClock } from "./agentExecute.ts";
import { threadDrafts } from "./drafts.ts";
import { unanswered } from "./followups.ts";
import { userLabels, gmailLabelOf, type Label } from "./labels.ts";
import { HOURS, inQuietHours, notify, wallClock, type Hours } from "./notify.ts";
import { decide, GAP, looksLikeInstructions, CAP_PER_AUTOMATION } from "./policy.ts";
import { soon } from "./prep.ts";
import { allPrefs, ask, displayName, mentions, pick, setPref, type Pref } from "./profile.ts";
import type { AttachmentInfo, CalEvent } from "./providers.ts";
import { draftReply, writeTo, type EmailRow } from "./replies.ts";
import { quoted } from "./rules.ts";
import { addressesIn, readWithoutModel, writtenTo, type Written } from "./senders.ts";
import { isRule, recipients, type Recipient } from "./writing.ts";

const DAY = 86_400_000;
const NO_REPLY = /no.?reply|noreply|donotreply|do-not-reply|notifications?@|mailer-daemon|bounce/i;
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

// ── What a sentence is read as ──────────────────────────────────────────────

export type Trigger = { on: "mail" } | { on: "time"; at: string; days: number[] } | { on: "silence"; days: number } | { on: "meeting"; minutes: number };

// vip: most important. org: the user's organisation. newsletter: bulk by its headers (senders.ts).
export const WHO = ["vip", "org", "known", "stranger", "newsletter"] as const;
export const FILES = ["any", "pdf", "image", "spreadsheet", "document", "calendar"] as const;
export const SORTS = ["action-required", "important", "updates", "promotions"] as const;
export type Conditions = {
  from: string[]; // addresses, domains or names; the recipient for silence, the people of a meeting
  except: string[];
  who: (typeof WHO)[number][];
  labels: string[]; // slugs of the user's labels
  sort: (typeof SORTS)[number] | null;
  file: (typeof FILES)[number] | null;
  words: string[]; // any of them
  account: string | null;
  question: string | null; // for the fast model, yes or no
};

// `only`: done when that question, too, is answered yes. For notify a no keeps
// Tabellar's own notification back as well.
export type Action = { only?: string } & ActionKind;
type ActionKind =
  | { do: "label"; label: string }
  | { do: "archive" }
  | { do: "read" }
  | { do: "snooze"; days: number | null } // null: until someone answers
  | { do: "todo"; text: string; days: number | null }
  | { do: "reply"; say: string }
  | { do: "forward"; to: string; note: string }
  | { do: "notify" }
  | { do: "first" }
  | { do: "leave_out" }
  | { do: "vip" }
  | { do: "digest" };

export type Spec = { trigger: Trigger; conditions: Conditions; actions: Action[] };

// What can follow each trigger: only mail that has just arrived can be
// answered, handed on or put first.
const FITS: Record<Trigger["on"], Action["do"][]> = {
  mail: ["label", "archive", "read", "snooze", "todo", "reply", "forward", "notify", "first", "leave_out", "vip"],
  time: ["digest", "label", "archive", "read", "todo", "notify"],
  silence: ["reply", "todo", "notify"],
  meeting: ["todo", "notify"],
};

export type Automation = {
  id: string; user_id: string; text: string; spec: Spec; mode: "ask" | "own"; enabled: boolean; enabled_at: string | null; tried_at: string | null; trial: Trial | null;
  runs: number; last_run: string | null; undone: number; state: { slot?: string; told?: string[] }; digest: { at: string; emails: string[] } | null; source: string; created_at: string;
};

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const list = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
const whole = (v: unknown, min: number, max: number): number | null => {
  const n = Math.round(Number(v));
  return v !== null && v !== "" && Number.isFinite(n) && n >= min && n <= max ? n : null;
};

// Is it in the sentence: an address or a domain as written, a name, a word or
// a label with every word of it.
function inSentence(entry: string, sentence: string): boolean {
  if (/[@.]/.test(entry)) return lc(sentence).includes(lc(entry).replace(/^@/, ""));
  return mentions(sentence, entry);
}

const isAddress = (s: string) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s);

type Known = { labels: Label[]; accounts: string[] };

// The model's reading, checked. Throws, in words the user can act on, when any
// of it is not a kind of thing above or not in the sentence: a condition left
// out would match more than was asked, so nothing is dropped.
export function checkSpec(raw: unknown, sentence: string, known: Known): Spec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const t = (r.trigger ?? {}) as Record<string, unknown>;
  const c = (r.conditions ?? {}) as Record<string, unknown>;
  const must = (entry: string, what: string) => {
    if (!inSentence(entry, sentence)) throw fail(`"${entry}" is not in your sentence. Write ${what} out in it.`);
  };

  let trigger: Trigger;
  if (t.on === "mail") trigger = { on: "mail" };
  else if (t.on === "time") {
    const at = String(t.at ?? "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    const days = [...new Set(list(t.days).map((d) => DAYS.findIndex((x) => x.startsWith(lc(d).slice(0, 3)))))].sort();
    if (!at || days.includes(-1)) throw fail("Say at what time, and on which days.");
    trigger = { on: "time", at: `${at[1].padStart(2, "0")}:${at[2]}`, days: days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
  } else if (t.on === "silence") {
    const days = whole(t.days, 1, 30);
    if (!days) throw fail("Say after how many days without an answer, up to 30.");
    trigger = { on: "silence", days };
  } else if (t.on === "meeting") {
    const minutes = whole(t.minutes, 5, 120);
    if (!minutes) throw fail("Say how long before the meeting, from 5 minutes to 2 hours.");
    trigger = { on: "meeting", minutes };
  } else throw fail("Say when it should happen: when mail arrives, at a time, when nobody answers, or before a meeting.");

  const conditions: Conditions = { from: [], except: [], who: [], labels: [], sort: null, file: null, words: [], account: null, question: null };
  for (const f of list(c.from)) (must(f, "who it is from"), conditions.from.push(f));
  for (const f of list(c.except)) (must(f, "who is left out"), conditions.except.push(f));
  for (const w of list(c.words)) (must(w, "the words to look for"), conditions.words.push(w));
  for (const w of list(c.who)) {
    if (!(WHO as readonly string[]).includes(w)) throw fail(`Tabellar does not know who "${w}" is.`);
    conditions.who.push(w as Conditions["who"][number]);
  }
  for (const l of list(c.labels)) {
    const label = known.labels.find((x) => lc(x.display_name) === lc(l) || x.slug === lc(l));
    if (!label) throw fail(`There is no label "${l}".`);
    must(label.display_name, "the label");
    conditions.labels.push(label.slug);
  }
  const one = <T extends string>(v: unknown, of: readonly T[], what: string): T | null => {
    if (!v) return null;
    if (!(of as readonly string[]).includes(String(v))) throw fail(`Tabellar cannot tell ${what} "${String(v)}".`);
    return v as T;
  };
  conditions.sort = one(c.sort, SORTS, "mail sorted as");
  conditions.file = one(c.file, FILES, "an attachment of the kind");
  if (c.account) {
    const a = known.accounts.find((x) => lc(x) === lc(c.account));
    if (!a) throw fail(`${String(c.account)} is not one of your mailboxes.`);
    must(a, "the mailbox");
    conditions.account = a;
  }
  // A question may say it another way, but holds no address or number of its own.
  const questionOf = (v: unknown): string | null => {
    const q = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!q) return null;
    if (q.length > 160) throw fail("That asks too much of each email. Say it shorter.");
    for (const a of addressesIn(q)) must(a, "the address");
    for (const n of q.match(/\d[\d,.]*\d|\d/g) ?? []) if (!sentence.replace(/[,\s]/g, "").includes(n.replace(/,/g, ""))) throw fail(`"${n}" is not in your sentence.`);
    return q.replace(/[?.]*$/, "?");
  };
  conditions.question = questionOf(c.question);
  if (trigger.on !== "mail" && trigger.on !== "time" && (conditions.labels.length || conditions.sort || conditions.file || conditions.account || conditions.question || conditions.who.includes("newsletter"))) {
    throw fail(trigger.on === "silence" ? "For mail nobody answered, say only who it went to and what it mentions." : "For a meeting, say only who is in it and what its title mentions.");
  }

  const actions: Action[] = [];
  for (const x of Array.isArray(r.actions) ? (r.actions as Record<string, unknown>[]) : []) {
    const what = String(x?.do ?? "") as Action["do"];
    if (!FITS.mail.includes(what) && what !== "digest") throw fail(`Tabellar cannot do that: ${String(x?.what ?? x?.do ?? "").slice(0, 80) || "no action"}.`);
    const only = questionOf(x.only);
    if (only && (trigger.on !== "mail" || actions.some((y) => y.only && y.only !== only))) throw fail("That is several automations in one. Write each in a sentence of its own.");
    if (!FITS[trigger.on].includes(what)) throw fail(`Tabellar cannot ${VERB[what]} ${trigger.on === "time" ? "at a set time" : trigger.on === "silence" ? "when nobody answers" : trigger.on === "meeting" ? "before a meeting" : "when mail arrives"}.`);
    if (what === "label") {
      const label = list(x.label)[0]?.slice(0, 40) ?? "";
      if (!label) throw fail("Say which label.");
      must(label, "the label");
      actions.push({ do: "label", label: known.labels.find((l) => lc(l.display_name) === lc(label))?.display_name ?? label });
    } else if (what === "snooze") actions.push({ do: "snooze", days: whole(x.days, 1, 90) });
    else if (what === "todo") {
      const text = String(x.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!text) throw fail("Say what the todo is.");
      for (const a of addressesIn(text)) must(a, "the address");
      actions.push({ do: "todo", text: text[0].toUpperCase() + text.slice(1), days: whole(x.days, 0, 365) });
    } else if (what === "reply") actions.push({ do: "reply", say: String(x.say ?? "").replace(/\s+/g, " ").trim().slice(0, 300) });
    else if (what === "forward") {
      const to = addressesIn(String(x.to ?? ""))[0] ?? "";
      if (!isAddress(to)) throw fail("Write the address to forward to.");
      must(to, "the address to forward to");
      actions.push({ do: "forward", to, note: String(x.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300) });
    } else actions.push({ do: what } as Action);
    if (only) actions.at(-1)!.only = only;
  }
  if (!actions.length) throw fail("Say what should happen.");
  // An address the reading has no use for was about something it left out.
  const used = lc(JSON.stringify([conditions, actions]));
  for (const a of addressesIn(sentence)) if (!used.includes(a)) throw fail(`Tabellar did not understand what ${a} is for.`);
  return { trigger, conditions, actions };
}

const VERB: Record<Action["do"], string> = {
  label: "label mail", archive: "archive mail", read: "mark mail read", snooze: "snooze mail", todo: "add a todo", reply: "draft a reply", forward: "forward mail",
  notify: "notify you", first: "put mail first in the Brief", leave_out: "leave mail out of the Brief", vip: "mark someone most important", digest: "make a digest",
};

// ── Read back, by code ──────────────────────────────────────────────────────

const or = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);
const WHO_WORDS: Record<string, string> = { vip: "your most important people", org: "your organisation", known: "people you know", stranger: "someone you do not know", newsletter: "a newsletter" };
const SORT_WORDS: Record<string, string> = { "action-required": "Action required", important: "Important", updates: "Updates", promotions: "Promotions" };
const FILE_WORDS: Record<string, string> = { any: "a file", pdf: "a PDF", image: "an image", spreadsheet: "a spreadsheet", document: "a document", calendar: "a calendar file" };
const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

function dayWords(ds: number[]): string {
  if (ds.length === 7) return "Every day";
  if (ds.join() === "1,2,3,4,5") return "Every weekday";
  const names = ds.map((d) => DAYS[d][0].toUpperCase() + DAYS[d].slice(1));
  return `Every ${names.length < 2 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`;
}

export function readBack(spec: Spec, labels: Label[]): { when: string; then: string[] } {
  const c = spec.conditions;
  const t = spec.trigger;
  const name = (slug: string) => labels.find((l) => l.slug === slug)?.display_name ?? slug;
  const people = or([...c.from, ...c.who.map((w) => WHO_WORDS[w])]);
  const about = [
    c.except.length && `not ${t.on === "silence" ? "to" : "from"} ${or(c.except)}`,
    c.account && `in ${c.account}`,
    c.labels.length && `labelled ${or(c.labels.map(name))}`,
    c.sort && `sorted as ${SORT_WORDS[c.sort]}`,
    c.file && `with ${FILE_WORDS[c.file]} attached`,
    c.words.length && `that mentions ${or(c.words.map((w) => `"${w}"`))}`,
  ].filter(Boolean).join(", ");
  const asked = c.question ? `, if the answer to "${c.question}" is yes` : "";
  const mail = `${people ? ` from ${people}` : ""}${about ? `${people ? "," : ""} ${about}` : ""}${asked}`;
  const any = !people && !about && !asked;
  const when =
    t.on === "mail" ? `When ${any ? "any mail" : "mail"} arrives${mail}`
    : t.on === "time" ? `${dayWords(t.days)} at ${t.at}${spec.actions.every((a) => a.do === "todo" || a.do === "notify") && any ? "" : `, for ${any ? "all mail" : "mail"} since the time before${mail}`}`
    : t.on === "silence" ? `When mail you sent${people ? ` to ${people}` : ""}${about ? `${people ? "," : ""} ${about}` : ""} has had no answer for ${days(t.days)}`
    : `${t.minutes} minutes before a meeting${people ? ` with ${people}` : ""}${about ? `${people ? "," : ""} ${about}` : ""}`;
  const act = (a: Action): string => {
    if (a.do === "label") return `Label it ${a.label}${labels.some((l) => lc(l.display_name) === lc(a.label)) ? "" : ", a new label"}`;
    if (a.do === "archive") return t.on === "time" ? "Archive it all" : "Archive it";
    if (a.do === "read") return t.on === "time" ? "Mark it all read" : "Mark it read";
    if (a.do === "snooze") return a.days ? `Snooze it for ${days(a.days)}` : "Snooze it until someone answers";
    if (a.do === "todo") return `Add the todo "${a.text}"${a.days === null ? "" : a.days ? `, due in ${days(a.days)}` : ", due that day"}`;
    if (a.do === "reply") return `Draft ${t.on === "silence" ? "a follow-up" : "a reply"}${a.say ? ` saying: ${a.say}` : ""}`;
    if (a.do === "forward") return `Draft a forward to ${a.to}${a.note ? ` with a note: ${a.note}` : ""}; at Autopilot it is sent`;
    if (a.do === "notify") return "Notify you";
    if (a.do === "first") return "Put it first in the Brief";
    if (a.do === "leave_out") return "Leave it out of the Brief";
    if (a.do === "vip") return "Ask to make the sender most important";
    return "Put a digest of it in the Brief";
  };
  return { when, then: spec.actions.map((a) => act(a) + (a.only ? `, only if the answer to "${a.only}" is yes` : "")) };
}

// ── Reading a sentence ──────────────────────────────────────────────────────

// `tabellar check` swaps these, so automations can be run without a model.
export const models = {
  read: automationFrom,
  answer: answerAbout,
  reply: (userId: string, e: EmailRow, say: string) => draftReply(userId, e, say),
  forward: (userId: string, e: EmailRow, to: string, note: string) => writeTo(userId, { to, intent: note, forward: { subject: e.subject ?? "", from: e.sender ?? e.sender_email ?? "", body: e.body_text ?? e.snippet ?? "" } }),
  nudge: (userId: string, e: EmailRow, to: string, say: string) => writeTo(userId, { to, intent: say || "I have had no answer to this. Write a short, friendly follow-up that asks again.", replyTo: { subject: e.subject ?? "", body: e.body_text ?? "" } }),
};

async function knownTo(userId: string): Promise<Known> {
  const [labels, accounts] = await Promise.all([userLabels(userId), listAccounts(userId)]);
  return { labels, accounts: accounts.map((a) => a.address) };
}

// A kind of person the sentence does not seem to speak of ("recruiters" read
// as strangers). A first reading is asked for again with this; the second
// stands, as the user is shown what it says and matched.
const SPOKEN: Record<string, RegExp> = { vip: /important|vip|favou?rite|key people/i, org: /organi[sz]ation|compan|colleague|co-?worker|team|work|school|universit|office/i, known: /know|contact|friend|deal with|writ/i, stranger: /know|stranger|unknown|never (?:met|written)|new (?:people|sender)|cold/i, newsletter: /newsletter|bulk|mailing list|marketing|promo|digest|ads?\b/i };
const unspoken = (s: Spec, text: string) => s.conditions.who.find((w) => !SPOKEN[w].test(text));

// The sentence as an automation, which lands off with its trial under way, or
// as a rule. `id` is the automation whose sentence this replaces.
export async function compile(userId: string, sentence: string, opts: { id?: string; source?: string } = {}): Promise<{ id: string } | { rule: string }> {
  const text = sentence.replace(/\s+/g, " ").trim().slice(0, 400);
  if (text.length < 8) throw fail("Say what should happen, and when.");
  const known = await knownTo(userId);
  let spec: Spec | null = null;
  let wrong = "";
  for (let i = 0; i < 2 && !spec; i++) {
    const raw = await models.read(text, { labels: known.labels.map((l) => l.display_name), accounts: known.accounts }, wrong);
    if (raw.rule && !addressesIn(text).length) {
      if (!isRule(text)) throw fail("Say what should happen, and when.");
      await setPref(userId, "rule", "", text, "user");
      return { rule: text };
    }
    try {
      spec = checkSpec(raw, text, known);
      const who = i ? undefined : unspoken(spec, text);
      if (who) throw fail(`The sentence does not say "${who}". Use "from" for a name and "question" for a kind of mail or sender.`);
    } catch (e) {
      spec = null;
      wrong = (e as Error).message;
      if (i) throw e;
    }
  }
  const row = { user_id: userId, text, spec, enabled: false, enabled_at: null, tried_at: null, trial: null, undone: 0, state: {}, digest: null };
  let id = opts.id;
  if (id) {
    const { data } = await db.from("automations").update(row).eq("id", id).eq("user_id", userId).select("id");
    if (!data?.length) throw fail("That automation is gone", 404);
  } else {
    const { data, error } = await db.from("automations").insert({ ...row, source: opts.source ?? "user" }).select("id").single();
    if (error) throw new Error(error.message);
    id = data.id as string;
  }
  void tryOut(userId, id).catch((e) => console.error("[automations] trial:", (e as Error).message));
  return { id };
}

// ── What an email is checked against ────────────────────────────────────────

type Mail = EmailRow & {
  label_ids?: string[] | null; has_list_unsubscribe?: boolean | null; list_id?: string | null; precedence_header?: string | null;
  category?: string | null; summary?: string | null; extra?: string[];
};
type World = { prefs: Pref[]; kindOf: (a: string) => Recipient; written: Written; labels: Label[]; accounts: Map<string, string> };

async function worldOf(userId: string): Promise<World> {
  const [prefs, kindOf, written, labels, accounts] = await Promise.all([allPrefs(userId), recipients(userId), writtenTo(userId), userLabels(userId), listAccounts(userId)]);
  return { prefs, kindOf, written, labels, accounts: new Map(accounts.map((a) => [lc(a.address), a.id])) };
}

// An address, a domain, or a name: the sender's own, or the company's in their domain.
function isFrom(entry: string, address: string, name: string): boolean {
  const e = lc(entry).replace(/^@/, "");
  const a = lc(address);
  const d = a.split("@")[1] ?? "";
  if (e.includes("@")) return a === e;
  if (/^[\w-]+(\.[\w-]+)+$/.test(e)) return d === e || d.endsWith(`.${e}`);
  return mentions(name, e) || d.split(".").slice(0, -1).includes(e.replace(/\s+/g, ""));
}

const EXT: Record<string, RegExp> = {
  pdf: /\.pdf$/i, image: /\.(png|jpe?g|gif|heic|webp|tiff?)$/i, spreadsheet: /\.(xlsx?|csv|numbers|ods|tsv)$/i, document: /\.(docx?|rtf|odt|pages|txt|md)$/i, calendar: /\.ics$/i,
};

function isWho(who: Conditions["who"], address: string, w: World, m?: Mail): boolean {
  return who.some((k) =>
    k === "newsletter" ? !!m && readWithoutModel(m, w.written)
    : k === "vip" ? pick(w.prefs, address, "").some((p) => p.value === "vip")
    : w.kindOf(address) === k && !(m && k === "stranger" && readWithoutModel(m, w.written)),
  );
}

function person(c: Conditions, address: string, name: string, w: World, m?: Mail): boolean {
  if (c.except.some((x) => isFrom(x, address, name))) return false;
  if (!c.from.length && !c.who.length) return true;
  return c.from.some((x) => isFrom(x, address, name)) || isWho(c.who, address, w, m);
}

// Everything but the question.
export function fits(c: Conditions, m: Mail, w: World): boolean {
  if (!person(c, m.sender_email ?? "", displayName(m.sender, m.sender_email ?? ""), w, m)) return false;
  if (c.account && w.accounts.get(lc(c.account)) !== m.account_id) return false;
  if (c.labels.length && !c.labels.some((l) => m.extra?.includes(l))) return false;
  if (c.sort && m.category !== c.sort) return false;
  const files = (m.attachments ?? []) as AttachmentInfo[];
  if (c.file && !files.some((f) => c.file === "any" || EXT[c.file!].test(f.filename))) return false;
  const text = `${m.subject ?? ""}\n${m.body_text || m.snippet || ""}`;
  return !c.words.length || c.words.some((x) => mentions(text, x));
}

// The one question, answered by the fast model. Yes counts only with a quote
// found word for word in the email.
const answers = new Map<string, string | null>();
async function answerTo(question: string, m: Mail): Promise<string | null> {
  const key = `${question}|${m.id}`;
  if (!answers.has(key)) {
    const text = `${m.subject ?? ""}\n${m.body_text || m.snippet || ""}`;
    const a = await models.answer(question, { subject: m.subject ?? "", from: m.sender ?? m.sender_email ?? "", body: m.body_text || m.snippet || "" });
    if (answers.size > 5000) answers.clear();
    answers.set(key, a.yes && quoted(a.quote, text) ? a.quote : null);
  }
  return answers.get(key)!;
}

// The quote that answers the question, "" without a question, null for no match.
async function matched(c: Conditions, m: Mail, w: World): Promise<string | null> {
  if (!fits(c, m, w)) return null;
  return c.question ? answerTo(c.question, m) : "";
}

// ── The trial ───────────────────────────────────────────────────────────────

export type Match = { email_id: string | null; who: string; subject: string; at: string; quote: string };
export type Trial = { state: "running" | "done" | "failed"; done: number; of: number; matches: Match[]; more: number; error?: string };

const TRIAL_DAYS = 30;
const TRIAL_ASKS = 100;
const TRIAL_SHOWN = 50;
const MAIL = "id, subject, sender, sender_email, reply_to_email, recipients, cc_recipients, body_text, snippet, received_at, thread_id, gmail_id, account_id, is_calendar, attachments, label_ids, has_list_unsubscribe, list_id, precedence_header, email_processed(category, summary, extra_labels)";

async function mailSince(userId: string, since: string): Promise<Mail[]> {
  const { data } = await db.from("emails").select(MAIL).eq("user_id", userId).eq("is_receipt", false).not("label_ids", "cs", '{"SENT"}').gte("received_at", since).order("received_at", { ascending: false }).limit(5000);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const p = (Array.isArray(r.email_processed) ? r.email_processed[0] : r.email_processed) as Record<string, unknown> | null;
    return { ...(r as unknown as Mail), category: (p?.category as string) ?? null, summary: (p?.summary as string) ?? null, extra: (p?.extra_labels as string[] | null) ?? [] };
  });
}

const matchOf = (m: Mail, quote: string): Match => ({ email_id: m.id, who: displayName(m.sender, m.sender_email ?? ""), subject: m.subject || "(no subject)", at: String(m.received_at), quote });

// What it would have matched: in the last 30 days of mail, since the time
// before for a digest, among what nobody answered, or in the next two hours of
// meetings. Kept on the row as it goes.
export async function tryOut(userId: string, id: string): Promise<void> {
  const { data } = await db.from("automations").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw fail("That automation is gone", 404);
  const a = data as unknown as Automation;
  const { trigger: t, conditions: c } = a.spec;
  const trial: Trial = { state: "running", done: 0, of: 0, matches: [], more: 0 };
  // A sentence changed meanwhile has a trial of its own.
  const keep = async (patch: Record<string, unknown> = {}) => !!(await db.from("automations").update({ trial, ...patch }).eq("id", id).eq("text", a.text).select("id")).data?.length;
  const add = (m: Match) => (trial.matches.length < TRIAL_SHOWN ? trial.matches.push(m) : trial.more++);
  if (!(await keep())) return;
  try {
    const w = await worldOf(userId);
    if (t.on === "silence") for (const s of await silent(userId, a, w, true)) add({ email_id: s.sent.id, who: s.to.name || s.to.email, subject: s.sent.subject || "(no subject)", at: s.sent.received_at, quote: "" });
    else if (t.on === "meeting") for (const e of await meetings(a, w, await soon(userId))) add({ email_id: null, who: e.attendees.join(", "), subject: e.title, at: String(e.start), quote: "" });
    else if (t.on === "mail" || usesMail(a.spec)) {
      const since = t.on === "mail" ? new Date(Date.now() - TRIAL_DAYS * DAY) : (slotBefore(t, await zone(userId), 1) ?? new Date(Date.now() - DAY));
      const mail = (await mailSince(userId, since.toISOString())).filter((m) => fits(c, m, w));
      const asked = c.question ? mail.slice(0, TRIAL_ASKS) : mail;
      trial.of = asked.length;
      // Two at a time, as many as a local model reads at once.
      for (let i = 0; i < asked.length; i += 2) {
        const pair = asked.slice(i, i + 2);
        const quotes = await Promise.all(pair.map((m) => matched(c, m, w)));
        quotes.forEach((quote, n) => quote !== null && add(matchOf(pair[n], quote)));
        trial.done += pair.length;
        if (c.question && i % 6 === 0 && !(await keep())) return;
      }
    }
    trial.state = "done";
    await keep({ tried_at: new Date().toISOString() });
  } catch (e) {
    trial.state = "failed";
    trial.error = (e as Error).message;
    await keep();
  }
}

// ── On, off and gone ────────────────────────────────────────────────────────

async function load(userId: string, id: string): Promise<Automation> {
  const { data } = await db.from("automations").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw fail("That automation is gone", 404);
  return data as unknown as Automation;
}

export async function setEnabled(userId: string, id: string, on: boolean): Promise<void> {
  const a = await load(userId, id);
  if (!on) {
    await db.from("automations").update({ enabled: false }).eq("id", id);
    return;
  }
  if (!a.tried_at) throw fail("Look at what it would have matched first.", 409);
  for (const x of a.spec.actions) if (x.do === "label") await ensureLabel(userId, x.label);
  const tz = await zone(userId);
  const slot = a.spec.trigger.on === "time" ? slotBefore(a.spec.trigger, tz, 0)?.toISOString() : undefined;
  await db.from("automations").update({ enabled: true, enabled_at: new Date().toISOString(), undone: 0, state: { ...a.state, ...(slot ? { slot } : {}) } }).eq("id", id);
}

// The label an automation puts on mail. The model is not told of it until the
// user describes it, so only the automation applies it.
async function ensureLabel(userId: string, name: string): Promise<void> {
  const labels = await userLabels(userId);
  if (labels.some((l) => lc(l.display_name) === lc(name))) return;
  const slug = lc(name).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "label";
  const taken = new Set(labels.map((l) => l.slug));
  let free = slug;
  for (let n = 2; taken.has(free); n++) free = `${slug}-${n}`;
  await db.from("categories").insert({ user_id: userId, slug: free, display_name: name, position: Math.max(0, ...labels.map((l) => l.position)) + 1, automatic: false });
}

export async function remove(userId: string, id: string): Promise<void> {
  await db.from("action_log").update({ status: "dismissed", decided_at: new Date().toISOString(), reason: "The automation was deleted" }).eq("user_id", userId).eq("automation_id", id).eq("status", "proposed");
  await db.from("automations").delete().eq("id", id).eq("user_id", userId);
}

// The page: each automation with what it was read as, newest first.
export async function listAutomations(userId: string): Promise<(Automation & { when: string; then: string[]; waiting: number })[]> {
  const [{ data }, labels, { data: waiting }] = await Promise.all([
    db.from("automations").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    userLabels(userId),
    db.from("action_log").select("automation_id").eq("user_id", userId).eq("status", "proposed").not("automation_id", "is", null),
  ]);
  return ((data ?? []) as unknown as Automation[]).map((a) => ({ ...a, ...readBack(a.spec, labels), waiting: (waiting ?? []).filter((r) => r.automation_id === a.id).length }));
}

// ── Running ─────────────────────────────────────────────────────────────────

// One pass: the automations that are on, what each did already, and what is
// left to do at its end.
export type Pass = {
  userId: string;
  settings: Settings;
  automations: Automation[];
  world: World;
  did: Set<string>; // "<automation> <email>"
  today: Map<string, number>; // actions today, by automation
  sent: number; // automatic sends today
  sendCap: number;
  delayMinutes: number;
  profile: Record<string, unknown> | null;
  batch: Map<string, { a: Automation; kind: "archive" | "read"; emails: string[] }>;
};

const units = (r: { detail?: unknown }) => (r.detail as { emailIds?: string[] } | null)?.emailIds?.length ?? 1;

export async function startPass(userId: string, on: Trigger["on"][]): Promise<Pass | null> {
  const { data } = await db.from("automations").select("*").eq("user_id", userId).eq("enabled", true).not("tried_at", "is", null).order("created_at", { ascending: true });
  const automations = ((data ?? []) as unknown as Automation[]).filter((a) => on.includes(a.spec.trigger.on));
  if (!automations.length) return null;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const [settings, world, { data: log }, { count: sent }, { data: profile }] = await Promise.all([
    engineSettings(userId),
    worldOf(userId),
    db.from("action_log").select("automation_id, email_id, status, detail, created_at").eq("user_id", userId).in("automation_id", automations.map((a) => a.id)).gte("created_at", new Date(Date.now() - 40 * DAY).toISOString()).limit(20_000),
    db.from("action_log").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("kind", "send").in("source", ["engine", "automation"]).in("status", ["done", "running"]).gte("created_at", midnight.toISOString()),
    db.from("profiles").select("working_hours, notification_preview, notification_quiet, autopilot_delay_min, autopilot_daily_cap").eq("id", userId).maybeSingle(),
  ]);
  const did = new Set<string>();
  const today = new Map<string, number>();
  for (const r of (log ?? []) as { automation_id: string; email_id: string | null; status: string; detail: unknown; created_at: string }[]) {
    for (const e of r.email_id ? [r.email_id] : ((r.detail as { emailIds?: string[] } | null)?.emailIds ?? [])) did.add(`${r.automation_id} ${e}`);
    if (["done", "proposed", "running"].includes(r.status) && r.created_at >= midnight.toISOString()) today.set(r.automation_id, (today.get(r.automation_id) ?? 0) + units(r));
  }
  return {
    userId, settings, automations, world, did, today, sent: sent ?? 0, profile, batch: new Map(),
    sendCap: Math.max(0, Number(profile?.autopilot_daily_cap ?? 5)), delayMinutes: Math.min(Math.max(Number(profile?.autopilot_delay_min) || 5, 1), 120),
  };
}

type Made = "done" | "proposed" | "refused" | "failed";

async function doIt(p: Pass, a: Automation, plan: Planned, opts: { suspicious?: boolean; n?: number; handOn?: { to: string[]; typed: string[] } } = {}): Promise<Made> {
  const r = await act(p.userId, { ...plan, automationId: a.id }, {
    ...p.settings, source: "automation", own: a.mode === "own", suspicious: opts.suspicious, todayCount: p.today.get(a.id) ?? 0, sentToday: p.sent, sendCap: p.sendCap, handOn: opts.handOn,
  });
  if (r === "done" || r === "proposed") p.today.set(a.id, (p.today.get(a.id) ?? 0) + (opts.n ?? 1));
  if (r === "done" && plan.kind === "send") p.sent++;
  return r;
}

async function ran(a: Automation, n: number): Promise<void> {
  if (!n) return;
  a.runs += n;
  const patch: Record<string, unknown> = { runs: a.runs, last_run: new Date().toISOString() };
  // Something it did a day ago and the user left alone: the undos are not in a row.
  if (a.undone) {
    const { data: last } = await db.from("action_log").select("undone_at").eq("automation_id", a.id).eq("status", "undone").order("undone_at", { ascending: false }).limit(1);
    const { count } = await db.from("action_log").select("id", { count: "exact", head: true }).eq("automation_id", a.id).eq("status", "done").gt("created_at", String(last?.[0]?.undone_at ?? "")).lt("created_at", new Date(Date.now() - DAY).toISOString());
    if (count) patch.undone = 0;
  }
  await db.from("automations").update(patch).eq("id", a.id);
}

const replySubject = (s: string | null) => (/^re:/i.test(s ?? "") ? s! : `Re: ${s ?? ""}`);
const dueIn = (n: number, tz: string) => wallClock(tz, new Date(Date.now() + n * DAY)).day;
const tzOf = (p: Record<string, unknown> | null) => (p?.working_hours as Hours | null)?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const zone = async (userId: string) => tzOf((await db.from("profiles").select("working_hours").eq("id", userId).maybeSingle()).data);

// The morning of a day from now, in the user's zone.
function morning(days: number, profile: Record<string, unknown> | null): string {
  const tz = tzOf(profile);
  const h = { ...HOURS, ...((profile?.working_hours as Hours | null) ?? {}) };
  return wallClockToUtc(parseWallClock(`${dueIn(days, tz)}T${h.start}:00`)!, tz).toISOString();
}

// New mail, after the analysis. Says whether the user is to be notified of it
// or not told, and whether it has been dealt with (archived or snoozed, so nothing else is
// to be made of it).
export async function runOnMail(p: Pass, m: Mail, suspicious: boolean): Promise<{ notify: boolean; quiet: boolean; gone: boolean }> {
  const out = { notify: false, quiet: false, gone: false };
  for (const a of p.automations) {
    if (a.spec.trigger.on !== "mail" || !a.enabled_at || String(m.received_at) < a.enabled_at || p.did.has(`${a.id} ${m.id}`)) continue;
    const quote = await matched(a.spec.conditions, m, p.world);
    if (quote === null) continue;
    p.did.add(`${a.id} ${m.id}`);
    let made = false;
    for (const x of a.spec.actions) {
      if (x.only && (await answerTo(x.only, m)) === null) {
        if (x.do === "notify") out.quiet = true;
        continue;
      }
      const r = await onMail(p, a, x, m, suspicious);
      if (r !== "done" && r !== "proposed") continue;
      made = true;
      if (r !== "done") continue;
      if (x.do === "notify") out.notify = true;
      if (x.do === "archive" || x.do === "snooze") out.gone = true;
    }
    if (made) await ran(a, 1);
  }
  return out;
}

async function onMail(p: Pass, a: Automation, x: Action, m: Mail, suspicious: boolean): Promise<Made> {
  const who = displayName(m.sender, m.sender_email ?? "");
  const run = (kind: Planned["kind"], summary: string, detail: Record<string, unknown>) => doIt(p, a, { kind, emailId: m.id, summary, detail }, { suspicious });
  if (x.do === "label") {
    const l = p.world.labels.find((l) => lc(l.display_name) === lc(x.label));
    const r = await run("label", `Label "${x.label}"`, { label: l ? gmailLabelOf(l) : `Tabellar/${x.label}`, ...(l ? { slug: l.slug } : {}) });
    if (l && r === "done") m.extra = [...new Set([...(m.extra ?? []), l.slug])];
    return r;
  }
  if (x.do === "archive" || x.do === "read") {
    // On its own it waits for the end of the pass, to be one change in the mailbox.
    const left = CAP_PER_AUTOMATION - (p.today.get(a.id) ?? 0);
    const may = decide({ kind: x.do, source: "automation", ...p.settings, own: a.mode === "own", suspicious, todayCount: p.today.get(a.id) ?? 0 }).verdict;
    if (may !== "do" || left <= 0) return run(x.do, x.do === "archive" ? "Archive" : "Mark read", {});
    const key = `${a.id} ${x.do}`;
    const b = p.batch.get(key) ?? { a, kind: x.do, emails: [] };
    b.emails.push(m.id);
    p.batch.set(key, b);
    p.today.set(a.id, (p.today.get(a.id) ?? 0) + 1);
    return "done";
  }
  if (x.do === "snooze") return run("snooze", x.days ? `Snooze for ${days(x.days)}` : "Snooze until an answer", { until: x.days ? morning(x.days, p.profile) : null });
  if (x.do === "todo") return run("todo", `Todo: ${x.text} (${who})`, { text: `${x.text} (${who})`, ...(x.days === null ? {} : { due: dueIn(x.days, tzOf(p.profile)) }) });
  if (x.do === "notify") return run("notify", `Notified you: ${m.subject || "(no subject)"}`, {});
  if (x.do === "first") return run("brief", "First in the Brief", { place: "first" });
  if (x.do === "leave_out") return run("brief", "Left out of the Brief", { place: "out" });
  if (x.do === "vip") return m.sender_email ? run("vip", `${who} is most important`, { address: lc(m.sender_email) }) : "refused";
  if (x.do === "reply") return reply(p, a, x.say, m, suspicious);
  if (x.do === "forward") return forward(p, a, x, m, suspicious);
  return "refused";
}

// Not worth a model call when the policy would refuse what it writes.
const wouldRefuse = (p: Pass, a: Automation, suspicious: boolean) => decide({ kind: "draft", source: "automation", ...p.settings, own: a.mode === "own", suspicious, todayCount: p.today.get(a.id) ?? 0 }).verdict === "refuse";

async function reply(p: Pass, a: Automation, say: string, m: Mail, suspicious: boolean): Promise<Made> {
  const to = (m.reply_to_email || m.sender_email || "").trim();
  if (!to || NO_REPLY.test(to)) return "refused";
  const plan: Planned = { kind: "draft", emailId: m.id, summary: `Draft a reply to ${displayName(m.sender, to)}`, detail: { to: [to], subject: replySubject(m.subject), accountId: m.account_id } };
  if (wouldRefuse(p, a, suspicious)) return doIt(p, a, plan, { suspicious });
  // One draft for an email, and none over the user's own in the thread.
  if ((await threadDrafts(p.userId, m.id)).some((d) => d.email_id === m.id || d.source !== "tabellar" || d.edited_at)) return "refused";
  const body = (await models.reply(p.userId, m, say)).trim();
  return body ? doIt(p, a, { ...plan, detail: { ...plan.detail, body } }, { suspicious }) : "refused";
}

async function forward(p: Pass, a: Automation, x: { to: string; note: string }, m: Mail, suspicious: boolean): Promise<Made> {
  const subject = /^fwd?:/i.test(m.subject ?? "") ? m.subject! : `Fwd: ${m.subject ?? ""}`;
  const base = { to: [x.to], subject, accountId: m.account_id, forward: { email_id: m.id } };
  const plan: Planned = { kind: "draft", emailId: m.id, summary: `Draft a forward to ${x.to}`, detail: base };
  if (wouldRefuse(p, a, suspicious)) return doIt(p, a, plan, { suspicious });
  const body = (await models.forward(p.userId, m, x.to, x.note).catch(() => x.note)).trim();
  const handOn = { to: [x.to], typed: addressesIn(a.text) };
  const may = decide({ kind: "send", source: "automation", ...p.settings, own: a.mode === "own", suspicious, handOn, sentToday: p.sent, sendCap: p.sendCap, todayCount: p.today.get(a.id) ?? 0 }).verdict === "do";
  if (may && body && !GAP.test(body)) return doIt(p, a, { kind: "send", emailId: m.id, summary: `Forward to ${x.to}`, detail: { ...base, body, delayMinutes: p.delayMinutes } }, { suspicious, handOn });
  return doIt(p, a, { ...plan, detail: { ...base, body } }, { suspicious });
}

// The archiving and marking read gathered in the pass, one change each.
export async function endPass(p: Pass): Promise<void> {
  for (const b of p.batch.values()) {
    // They were counted one by one as they were gathered.
    p.today.set(b.a.id, Math.max(0, (p.today.get(b.a.id) ?? 0) - b.emails.length));
    const one = b.emails.length === 1;
    const summary = b.kind === "archive" ? `Archive${one ? "" : ` ${b.emails.length} emails`}` : `Mark ${one ? "" : `${b.emails.length} emails `}read`;
    await doIt(p, b.a, { kind: b.kind, emailId: one ? b.emails[0] : null, summary, detail: { emailIds: b.emails } }, { n: b.emails.length });
  }
  p.batch.clear();
}

// ── A time, silence, a meeting ──────────────────────────────────────────────

const usesMail = (s: Spec) => s.actions.some((a) => a.do !== "todo" && a.do !== "notify") || fitsAnything(s.conditions) === false;
const fitsAnything = (c: Conditions) => !c.from.length && !c.except.length && !c.who.length && !c.labels.length && !c.sort && !c.file && !c.words.length && !c.account && !c.question;

// The last time it fell due, or with `back` the one that many before it.
export function slotBefore(t: Extract<Trigger, { on: "time" }>, tz: string, back: number, now = new Date()): Date | null {
  for (let n = 0, seen = 0; n < 15; n++) {
    const c = wallClock(tz, new Date(now.getTime() - n * DAY));
    if (!t.days.includes(c.weekday)) continue;
    const at = wallClockToUtc(parseWallClock(`${c.day}T${t.at}:00`)!, tz);
    if (at.getTime() <= now.getTime() && seen++ === back) return at;
  }
  return null;
}

// Sent mail nobody answered for that long. With `all`, for a trial; otherwise
// what reached it since the automation was turned on.
async function silent(userId: string, a: Automation, w: World, all = false) {
  if (a.spec.trigger.on !== "silence") return [];
  const wait = a.spec.trigger.days * DAY;
  const c = a.spec.conditions;
  return (await unanswered(userId)).filter(({ sent, to }) => {
    const due = new Date(sent.received_at).getTime() + wait;
    if (due > Date.now() || (!all && due < new Date(a.enabled_at ?? 0).getTime())) return false;
    return person(c, to.email, to.name, w) && (!c.words.length || c.words.some((x) => mentions(`${sent.subject ?? ""}\n${sent.body_text ?? ""}`, x)));
  });
}

async function meetings(a: Automation, w: World, events: CalEvent[]): Promise<CalEvent[]> {
  const c = a.spec.conditions;
  return events.filter((e) => {
    if (e.allDay || !e.start || !e.people.length) return false;
    const people = e.people.map((p, i) => ({ address: p, name: e.attendees[i] ?? p }));
    return people.some((p) => person(c, p.address, p.name, w)) && (!c.words.length || c.words.some((x) => mentions(e.title, x)));
  });
}

// Once a minute, beside the engine's other notifications. A time missed while
// the Mac slept runs once; `fresh` says mail was synced just now, which what is
// made of mail waits for, for half an hour at most.
const SILENCE_EVERY_MS = 15 * 60_000;
let silenceAt = 0;
const waited = new Map<string, number>();
export async function runTimed(userId: string, { fresh = true, now = new Date(), events }: { fresh?: boolean; now?: Date; events?: CalEvent[] } = {}): Promise<void> {
  const { data: me } = await db.from("profiles").select("onboarding").eq("id", userId).maybeSingle();
  if (me?.onboarding !== "done") return;
  const p = await startPass(userId, ["time", "silence", "meeting"]);
  if (!p || p.settings.paused) return;
  const look = events !== undefined || Date.now() - silenceAt > SILENCE_EVERY_MS;
  if (look) silenceAt = Date.now();
  for (const a of p.automations) {
    try {
      const t = a.spec.trigger;
      if (t.on === "time") await onTime(p, a, t, fresh, now);
      else if (t.on === "silence" && look) await onSilence(p, a);
      else if (t.on === "meeting") await onMeeting(p, a, t.minutes, events ?? (await soon(userId)));
    } catch (e) {
      console.error(`[automations] "${a.text}":`, (e as Error).message);
    }
  }
}

function tell(p: Pass, title: string, body: string, emails: string[] = []): void {
  if (inQuietHours(p.profile)) return;
  notify({ ...(p.profile?.notification_preview === false ? { title: "Tabellar", body: "One of your automations ran." } : { title, body }), emails });
}

async function onTime(p: Pass, a: Automation, t: Extract<Trigger, { on: "time" }>, fresh: boolean, now: Date): Promise<void> {
  const slot = slotBefore(t, tzOf(p.profile), 0, now);
  if (!slot || slot.toISOString() <= String(a.state.slot ?? a.enabled_at ?? "")) return;
  const needs = usesMail(a.spec);
  const n = (waited.get(a.id) ?? 0) + 1;
  waited.set(a.id, n);
  if (needs && !fresh && n < 30) return;
  waited.delete(a.id);
  const since = a.state.slot ?? slotBefore(t, tzOf(p.profile), 1, now)?.toISOString() ?? new Date(now.getTime() - DAY).toISOString();
  // Kept first: what goes wrong half way is not done again every minute.
  await db.from("automations").update({ state: { ...a.state, slot: slot.toISOString() } }).eq("id", a.id);
  let found: Mail[] = [];
  if (needs) {
    const mail = (await mailSince(p.userId, since)).filter((m) => fits(a.spec.conditions, m, p.world));
    for (const m of a.spec.conditions.question ? mail.slice(0, TRIAL_ASKS) : mail) {
      if ((await matched(a.spec.conditions, m, p.world)) !== null) found.push(m);
    }
    // A planted instruction may be in the HTML alone.
    const { data: html } = found.length ? await db.from("emails").select("id, body_html").in("id", found.map((m) => m.id)) : { data: [] };
    const planted = new Set((html ?? []).filter((h) => looksLikeInstructions(h.body_html as string)).map((h) => String(h.id)));
    found = found.filter((m) => !planted.has(m.id) && !looksLikeInstructions(m.subject, m.body_text));
    if (!found.length) return;
  }
  const room = () => Math.max(0, CAP_PER_AUTOMATION - (p.today.get(a.id) ?? 0));
  const emails = (k: number) => (k === 1 ? "1 email" : `${k} emails`);
  let made = false;
  const note = (r: Made) => (made = made || r === "done" || r === "proposed");
  for (const x of a.spec.actions) {
    if (x.do === "digest") note(await doIt(p, a, { kind: "brief", emailId: null, summary: `Digest of ${emails(found.length)}`, detail: { place: "digest", emailIds: found.slice(0, 200).map((m) => m.id) } }));
    else if (x.do === "archive" || x.do === "read") {
      const ids = found.slice(0, room()).map((m) => m.id);
      if (ids.length) note(await doIt(p, a, { kind: x.do, emailId: null, summary: x.do === "archive" ? `Archive ${emails(ids.length)}` : `Mark ${emails(ids.length)} read`, detail: { emailIds: ids } }, { n: ids.length }));
    } else if (x.do === "label") for (const m of found.slice(0, room())) note(await onMail(p, a, x, m, false));
    else if (x.do === "todo") note(await doIt(p, a, { kind: "todo", emailId: null, summary: `Todo: ${x.text}`, detail: { text: x.text, due: dueIn(x.days ?? 0, tzOf(p.profile)) } }));
    else if (x.do === "notify") {
      const r = await doIt(p, a, { kind: "notify", emailId: null, summary: "Notified you", detail: {} });
      note(r);
      if (r === "done") tell(p, "Tabellar", found.length ? `${emails(found.length)}: ${a.text}` : a.text, found.map((m) => m.id));
    }
  }
  if (made) await ran(a, 1);
}

async function onSilence(p: Pass, a: Automation): Promise<void> {
  for (const { sent, to } of await silent(p.userId, a, p.world)) {
    if (p.did.has(`${a.id} ${sent.id}`)) continue;
    p.did.add(`${a.id} ${sent.id}`);
    const who = to.name || to.email;
    let made = false;
    for (const x of a.spec.actions) {
      let r: Made = "refused";
      const run = (kind: Planned["kind"], summary: string, detail: Record<string, unknown>) => doIt(p, a, { kind, emailId: sent.id, summary, detail });
      if (x.do === "todo") r = await run("todo", `Todo: ${x.text} (${who})`, { text: `${x.text} (${who})`, ...(x.days === null ? {} : { due: dueIn(x.days, tzOf(p.profile)) }) });
      else if (x.do === "notify") {
        r = await run("notify", `Notified you: no answer from ${who}`, {});
        if (r === "done") tell(p, who, `No answer yet: ${sent.subject || "(no subject)"}`);
      } else if (x.do === "reply" && !wouldRefuse(p, a, false) && !(await threadDrafts(p.userId, sent.id)).length) {
        const { data: e } = await db.from("emails").select("*").eq("id", sent.id).maybeSingle();
        const body = e ? (await models.nudge(p.userId, e as unknown as EmailRow, to.name ? `${to.name} <${to.email}>` : to.email, x.say)).trim() : "";
        if (body) r = await run("draft", `Draft a follow-up to ${who}`, { to: [to.email], subject: replySubject(sent.subject), accountId: e!.account_id ?? null, body });
      }
      if (r === "done" || r === "proposed") made = true;
    }
    if (made) await ran(a, 1);
  }
}

async function onMeeting(p: Pass, a: Automation, minutes: number, events: CalEvent[]): Promise<void> {
  const told = a.state.told ?? [];
  for (const e of await meetings(a, p.world, events)) {
    const left = new Date(e.start!).getTime() - Date.now();
    const key = `${e.id}|${e.start}`;
    if (left < 0 || left > minutes * 60_000 || told.includes(key)) continue;
    told.push(key);
    await db.from("automations").update({ state: { ...a.state, told: told.slice(-50) } }).eq("id", a.id);
    let made = false;
    for (const x of a.spec.actions) {
      let r: Made = "refused";
      if (x.do === "todo") r = await doIt(p, a, { kind: "todo", emailId: null, summary: `Todo: ${x.text} (${e.title})`, detail: { text: `${x.text} (${e.title})`, due: dueIn(x.days ?? 0, tzOf(p.profile)) } });
      else if (x.do === "notify") {
        r = await doIt(p, a, { kind: "notify", emailId: null, summary: `Notified you: ${e.title}`, detail: {} });
        if (r === "done") tell(p, e.title, `In ${Math.max(1, Math.round(left / 60_000))} minutes${e.attendees.length ? `, with ${e.attendees.join(", ")}` : ""}`);
      }
      if (r === "done" || r === "proposed") made = true;
    }
    if (made) await ran(a, 1);
  }
}

// ── Undone, and offered ─────────────────────────────────────────────────────

const UNDOS = 3;

// The user took back something it did. The same email's other actions count
// once; at three in a row it is off, and one question asks what next.
export async function undone(userId: string, row: { id?: unknown; automation_id?: unknown; email_id?: unknown }): Promise<void> {
  const id = String(row.automation_id ?? "");
  const { data } = await db.from("automations").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) return;
  const a = data as unknown as Automation;
  if (row.email_id) {
    const { count } = await db.from("action_log").select("id", { count: "exact", head: true }).eq("automation_id", id).eq("email_id", String(row.email_id)).eq("status", "undone").neq("id", String(row.id));
    if (count) return;
  }
  const n = a.undone + 1;
  const off = a.enabled && n >= UNDOS;
  await db.from("automations").update({ undone: n, ...(off ? { enabled: false } : {}) }).eq("id", id);
  if (!off) return;
  await ask(userId, {
    text: `You undid "${a.text}" three times, so it is off. What now?`,
    detail: "Its sentence can be changed on the Automations page.",
    about: `automation ${id} off ${Date.now()}`,
    options: [
      { label: "Keep it off", automation: { id, set: "off" } },
      { label: "Turn it back on", automation: { id, set: "on" } },
      { label: "Delete it", automation: { id, set: "delete" } },
    ],
  });
}

// An answer to one of these questions (profile.ts), and taking it back.
export type AutomationAnswer = { id: string; set: "on" | "off" | "delete" } | { make: { text: string; from: string } };
export async function answered(userId: string, x: AutomationAnswer): Promise<void> {
  if ("id" in x) {
    if (x.set === "on") await setEnabled(userId, x.id, true);
    else if (x.set === "delete") await remove(userId, x.id);
    return;
  }
  // Its trial is the mail the question counted.
  const spec: Spec = { trigger: { on: "mail" }, conditions: { from: [x.make.from], except: [], who: [], labels: [], sort: null, file: null, words: [], account: null, question: null }, actions: [{ do: "archive" }] };
  const { data } = await db.from("automations").insert({ user_id: userId, text: x.make.text, spec, source: "offered" }).select("id").single();
  await tryOut(userId, data!.id as string);
  await setEnabled(userId, data!.id as string, true);
}
export async function unanswer(userId: string, x: AutomationAnswer): Promise<void> {
  if ("make" in x) await db.from("automations").delete().eq("user_id", userId).eq("source", "offered").eq("text", x.make.text);
  else if (x.set === "on") await setEnabled(userId, x.id, false);
}

// The user archived this mail by hand. From a sender whose mail they archive
// without reading, offered once: do it from now on?
const BY_HAND = 3;
export async function archivedByHand(userId: string, emailIds: string[]): Promise<void> {
  const { data: rows } = await db.from("emails").select("id, sender, sender_email").eq("user_id", userId).in("id", emailIds).eq("is_read", false);
  const senders = new Map<string, string>(((rows ?? []) as Record<string, unknown>[]).filter((e) => e.sender_email).map((e) => [lc(e.sender_email), String(e.sender ?? "")]));
  if (!senders.size) return;
  const [prefs, { data: rules }] = await Promise.all([allPrefs(userId), db.from("automations").select("spec").eq("user_id", userId)]);
  const mine = (rules ?? []).flatMap((a) => (a.spec as Spec).conditions?.from ?? []);
  for (const [address, sender] of senders) {
    if (pick(prefs, address, "").some((p) => p.value === "vip")) continue;
    if (mine.some((f) => isFrom(f, address, displayName(sender, address)))) continue;
    const { data: theirs } = await db.from("emails").select("id").eq("user_id", userId).eq("sender_email", address).eq("is_archived", true).eq("is_read", false).eq("is_snoozed", false).gte("received_at", new Date(Date.now() - 90 * DAY).toISOString()).limit(200);
    const ids = (theirs ?? []).map((e) => String(e.id));
    if (ids.length < BY_HAND) continue;
    // What Tabellar archived is not what the user did by hand.
    const { data: log } = await db.from("action_log").select("email_id, detail").eq("user_id", userId).eq("kind", "archive").in("status", ["done"]).limit(2000);
    const own = new Set((log ?? []).flatMap((r) => [String(r.email_id ?? ""), ...(((r.detail as { emailIds?: string[] } | null)?.emailIds) ?? [])]));
    const n = ids.filter((id) => !own.has(id)).length;
    if (n < BY_HAND) continue;
    const name = displayName(sender, address);
    await ask(userId, {
      text: `You archived ${n} emails from ${name} unread. Do that from now on?`,
      about: `archive from ${address}`,
      options: [{ label: "Yes", automation: { make: { text: `Archive mail from ${address}`, from: address } } }, { label: "No", final: true }, { label: "Not now" }],
    });
  }
}
