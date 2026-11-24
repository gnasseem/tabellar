// How the user writes, and what every draft is told about it.
//
// style_profiles holds the lines learned from the sent mail: greeting,
// sign-off, tone and length for everyone, the same four for three kinds of
// recipient (`kinds`: the user's own organisation, people they know,
// strangers) where they differ, and phrases to avoid (`avoid`). Greeting,
// sign-off and length are counted in code; only the tone is the model's.
// `edited` names the lines the user set by hand, which learning never touches,
// and `edits` what they changed in recent drafts (learnFromEdit).
//
// The user's own writing rules are `preferences` rows of kind "writing". Rules
// and phrases are also checked in code after each draft (keepRules), since a
// small model forgets.

import { db } from "./db.ts";
import { toneOf } from "./ai.ts";
import { ownAddresses } from "./senders.ts";
import { allPrefs, domainOf } from "./profile.ts";

export const RECIPIENTS = ["org", "known", "stranger"] as const;
export type Recipient = (typeof RECIPIENTS)[number];
export const FIELDS = ["greeting_style", "closing_style", "tone", "avg_length"] as const;
type Field = (typeof FIELDS)[number];
type Lines = Partial<Record<Field, string>>;
type Edit = { at: string; kind: Recipient; what: string; value: string };
type StyleRow = Lines & { kinds: Partial<Record<Recipient, Lines>>; avoid: string[]; edited: string[]; edits: Edit[]; sample_count: number; last_learned_at: string | null };

export type Writing = { kind: Recipient | null; greeting: string; closing: string; tone: string; length: string; rules: string[]; avoid: string[] };

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|icloud|me|mac|yahoo|ymail|aol|proton|protonmail|fastmail|gmx|zoho|mail)\./;

export async function displayNameOf(userId: string): Promise<string> {
  const { data } = await db.from("profiles").select("display_name").eq("id", userId).maybeSingle();
  return String(data?.display_name ?? "");
}

export async function styleRow(userId: string): Promise<StyleRow> {
  const { data } = await db.from("style_profiles").select("*").eq("user_id", userId).maybeSingle();
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    greeting_style: (r.greeting_style as string) ?? "",
    closing_style: (r.closing_style as string) ?? "",
    tone: (r.tone as string) ?? "",
    avg_length: (r.avg_length as string) ?? "",
    kinds: (r.kinds as StyleRow["kinds"]) ?? {},
    avoid: (r.avoid as string[]) ?? [],
    edited: (r.edited as string[]) ?? [],
    edits: (r.edits as Edit[]) ?? [],
    sample_count: Number(r.sample_count ?? 0),
    last_learned_at: (r.last_learned_at as string) ?? null,
  };
}

// ── Who a draft is to ───────────────────────────────────────────────────────

// Own organisation: the domain of one of the user's addresses, free mail
// aside. Someone they know: written to more than once, or marked as someone
// they deal with. Everyone else is a stranger.
export async function recipients(userId: string): Promise<(address: string) => Recipient> {
  const [own, prefs, { data: senders }] = await Promise.all([
    ownAddresses(userId),
    allPrefs(userId),
    db.from("senders").select("address").eq("user_id", userId).or("sent_to.gt.1,replied.gt.0").limit(20_000),
  ]);
  const domains = [...new Set([...own].map(domainOf))].filter((d) => d && !FREE_MAIL.test(d));
  const known = new Set((senders ?? []).map((s) => lc(s.address)));
  for (const p of prefs) if (p.kind === "sender" && (p.value === "vip" || p.value === "normal")) known.add(p.subject);
  return (address) => {
    const a = lc(address).match(/[^\s<>,;"]+@[^\s<>,;"]+/)?.[0] ?? "";
    const d = domainOf(a);
    if (d && domains.some((x) => d === x || d.endsWith(`.${x}`) || x.endsWith(`.${d}`))) return "org";
    return known.has(a) ? "known" : "stranger";
  };
}

// The lines for one recipient; for no one in particular, those for everyone.
export async function writingFor(userId: string, address: string | null | undefined, kind?: Recipient): Promise<Writing> {
  const [row, prefs] = await Promise.all([styleRow(userId), allPrefs(userId)]);
  const k = kind ?? (address ? (await recipients(userId))(address) : null);
  const line = (f: Field) => (k && row.kinds[k]?.[f]) || row[f] || "";
  return {
    kind: k,
    greeting: line("greeting_style"),
    closing: line("closing_style"),
    tone: line("tone"),
    length: line("avg_length"),
    rules: prefs.filter((p) => p.kind === "writing").map((p) => p.value).reverse(),
    avoid: row.avoid,
  };
}

const LENGTHS: Record<string, string> = { short: "under 60 words", medium: "60 to 150 words", long: "over 150 words" };
const isNone = (s: string) => /^none\.?$/i.test(s.trim());

// What a drafting prompt is told, rules last and firmest. Changing a draft the
// user is looking at takes only the rules.
export function stylePrompt(w: Writing, only?: "rules"): string {
  const lines: string[] = [];
  // A line a rule speaks to is left out, so the two never pull apart: a small
  // model follows the line and forgets the rule.
  const said = w.rules.filter((r) => !bannedBy(r)).join("\n");
  const greeting = !/\b(greet\w*|(open|start|begin)\s.*\bwith|dear|hi|hey|hello)\b/i.test(said);
  const closing = !/\b(sign(ed|ing)?[ -]?(off|with|as|my)?|clos(e|ing)|end\s.*\bwith|regards|cheers)\b/i.test(said);
  const tone = !/\b(tone|formal\w*|informal\w*|casual\w*|friendl\w+|warm\w*|polite\w*)\b/i.test(said);
  const length = !/\b(short\w*|long\w*|brief\w*|words?|sentences?|paragraphs?|lines?)\b/i.test(said);
  if (!greeting) lines.push("- Greeting line: as the rules below say.");
  else if (isNone(w.greeting)) lines.push("- No greeting line; start with the first sentence.");
  else if (w.greeting) lines.push(`- Greeting line: ${w.greeting}${w.greeting.includes("{name}") ? " ({name} is the recipient's first name, or their title and last name where that fits)" : ""}`);
  if (!closing) lines.push("- Sign-off: as the rules below say.");
  else if (isNone(w.closing)) lines.push("- No sign-off; end with the last sentence.");
  else if (w.closing) lines.push(`- Sign-off, exactly, and nothing after it:\n${w.closing}`);
  if (w.tone && tone) lines.push(`- Tone: ${w.tone}`);
  if (LENGTHS[w.length] && length) lines.push(`- Length: ${w.length}, ${LENGTHS[w.length]}`);
  const out = lines.length && only !== "rules" ? [`How the user writes:\n${lines.join("\n")}`] : [];
  if (w.avoid.length) out.push(`Never write these phrases or anything close to them:\n${w.avoid.map((p) => `- ${p}`).join("\n")}`);
  if (w.rules.length) out.push(`The user's rules for their writing. Each one must be followed, over everything above:\n${w.rules.map((r) => `- ${r}`).join("\n")}`);
  return out.join("\n\n");
}

// ── Rules, kept in code ─────────────────────────────────────────────────────

// Whether text can stand as a writing rule. "nothing", "ok" and the like were
// once kept as preferences.
export function isRule(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 5 || t.length > 200 || !/\p{L}{2,}\s+\S/u.test(t)) return false;
  return !/^(nothing|none|no changes?|no change needed|not? (really|sure|now)|n\/a|ok(ay)?|fine|good|great|all good|looks? (good|great|fine)|it'?s (good|fine|ok(ay)?|great)|never ?mind|nvm|idk|i don'?t know|as is|keep it|leave it|test|thanks?|thank you)\b[\s\p{P}]*(as is|it|to me|here|else|thanks?|to change|to add|really)?[\s\p{P}]*$/iu.test(t);
}

const expand = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\bi'm\b/g, "i am")
    .replace(/\b(do|does|did|is|are|was|would|could|should)n't\b/g, "$1 not")
    .replace(/n't\b/g, " not")
    .replace(/'re\b/g, " are")
    .replace(/'ve\b/g, " have")
    .replace(/'ll\b/g, " will");
const tokens = (s: string): string[] => expand(s).match(/[\p{L}\p{N}']+/gu) ?? [];

// The text says the phrase: its words in order in one sentence, with up to
// two extra words between them once the phrase is four words or more, so "I
// hope this email finds you well" is "I hope this finds you well".
export function says(text: string, phrase: string): boolean {
  const p = tokens(phrase);
  if (!p.length) return false;
  const slack = p.length >= 4 ? 2 : 0;
  return text.split(/[.!?\n]+/).some((sentence) => {
    const t = tokens(sentence);
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== p[0]) continue;
      let at = i;
      let extra = 0;
      let k = 1;
      while (k < p.length && at + 1 < t.length) {
        at++;
        if (t[at] === p[k]) k++;
        else if (++extra > slack) break;
      }
      if (k === p.length) return true;
    }
    return false;
  });
}

// The phrase a rule bans, when it bans one: "never open with I hope this
// finds you well" is "I hope this finds you well".
export function bannedBy(rule: string): string | null {
  const m = rule
    .trim()
    .match(/^(?:please\s+)?(?:never|don['’]?t|do not|avoid|stop|no)\s+(?:ever\s+)?(?:open(?:ing)?|start(?:ing)?|begin(?:ning)?|end(?:ing)?|clos(?:e|ing)|sign(?:ing)? off|us(?:e|ing)|say(?:ing)?|writ(?:e|ing))\s+(?:(?:an?\s+)?(?:emails?|repl(?:y|ies)|messages?|drafts?)\s+)?(?:with\s+|by saying\s+|the (?:phrase|words?|line)\s+)?["'“‘]?(.+?)["'”’]?\s*[.!]?$/i);
  return m && tokens(m[1]).length >= 2 ? m[1] : null;
}

export const broken = (text: string, w: Writing): string[] =>
  [...w.avoid, ...w.rules.map(bannedBy).filter((p): p is string => !!p)].filter((p) => says(text, p));

// Write a draft, check it, have it written once more when it says something
// it must not, and take the sentence out if it still does.
export async function keepRules(w: Writing, write: (extra: string) => Promise<string>): Promise<string> {
  let text = await write("");
  let bad = broken(text, w);
  if (bad.length) {
    const again = await write(`Leave these out entirely, in any wording: ${bad.map((p) => `"${p}"`).join(", ")}.`);
    if (again.trim() && broken(again, w).length <= bad.length) text = again;
    bad = broken(text, w);
  }
  if (!bad.length) return text;
  const cut = text
    .split("\n")
    .map((l) => (bad.some((p) => says(l, p)) ? (l.match(/[^.!?]+[.!?]*\s*/g) ?? [l]).filter((s) => !bad.some((p) => says(s, p))).join("").trim() : l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cut.split(/\s+/).length > 3 ? cut : text;
}

// ── Reading how an email opens and closes ───────────────────────────────────

const GREETING = /^(hi|hey|hello|dear|good (?:morning|afternoon|evening)|greetings|salam|bonjour|bonsoir|salut|hola|hallo|liebe[r]?|ciao|ol[áa])\b(.*?)\s*([,!:.]|[-–])?$/i;
const GROUP = /^(all|everyone|everybody|team|there|folks|both|guys)$/i;
const CLOSING =
  /^(?:all the best|best(?: regards| wishes)?|(?:kind|warm|warmest|with kind) regards|kindest regards|regards|many thanks|thanks(?: again| so much| a lot)?|thank you(?: so much| very much)?|cheers|sincerely|yours(?: sincerely| truly| faithfully)?|warmly|respectfully|take care|talk soon|speak soon|see you(?: soon)?|cordialement|bien à vous|merci|saludos|un saludo|abrazos?|mit freundlichen grüßen|viele grüße|lg)[,!.]?$/i;

const linesOf = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

// "Hi Maya," as "Hi {name},"; "" when the email starts without a greeting.
export function greetingOf(text: string): string {
  const first = linesOf(text)[0] ?? "";
  if (first.split(/\s+/).length > 6) return "";
  const m = first.match(GREETING);
  if (!m) return "";
  const word = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const who = m[2].replace(/^[\s,]+/, "").trim();
  return `${word}${!who ? "" : GROUP.test(who) ? ` ${who.toLowerCase()}` : " {name}"}${m[3] ?? ""}`;
}

// The sign-off line and the user's name under it; "" when there is none.
export function closingOf(text: string, name: string): string {
  const lines = linesOf(text);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    if (!CLOSING.test(lines[i])) continue;
    const next = lines[i + 1] ?? "";
    const own = tokens(name);
    const signed = next.split(/\s+/).length <= 4 && tokens(next).length > 0 && tokens(next).every((t) => own.includes(t) || t.length === 1);
    return signed ? `${lines[i]}\n${next}` : lines[i];
  }
  return "";
}

// The user's own words in a sent email: the quoted reply and forwarded mail cut off.
export function ownWords(body: string): string {
  let text = body.replace(/\r/g, "");
  const cut = text.search(/\n[^\n]*(\bOn [^\n]{0,200}\n?[^\n]{0,200}wrote:|-{3,} ?Forwarded message|-{3,} ?Original Message)/i);
  if (cut > 0) text = text.slice(0, cut);
  return text
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const lengthOf = (n: number) => (n < 60 ? "short" : n < 150 ? "medium" : "long");

// The value most of them share; "None" when most have none.
function usual(values: string[]): string {
  const none = values.filter((v) => !v).length;
  if (none > values.length * 0.6) return "None";
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// ── Learning from the sent mail ─────────────────────────────────────────────

// Lines a model puts in email that many people never write. The ones the
// user's own mail does not contain become phrases to avoid.
const STOCK = [
  "I hope this email finds you well", "I hope you are doing well", "Thank you for reaching out", "Please do not hesitate to",
  "I am writing to inform you", "At your earliest convenience", "As per my last email", "I wanted to touch base", "Just circling back", "I appreciate your patience",
];
const STOCK_FROM = 20; // emails before a phrase missing from them says anything
const KIND_FROM = 5;

export type SentMail = { to: string; subject: string; own: string };

// What the sent emails show, counted: for everyone and for each kind of
// recipient with enough emails.
export function styleOf(mine: SentMail[], kindOf: (address: string) => Recipient, name: string): { all: Lines; kinds: Partial<Record<Recipient, Lines>>; avoid: string[] } {
  const read = (list: SentMail[]): Lines => ({
    greeting_style: usual(list.map((e) => greetingOf(e.own))),
    closing_style: usual(list.map((e) => closingOf(e.own, name))),
    avg_length: lengthOf(list.map((e) => wordCount(e.own)).sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0),
  });
  const all = read(mine);
  const kinds: Partial<Record<Recipient, Lines>> = {};
  for (const k of RECIPIENTS) {
    const list = mine.filter((e) => kindOf(e.to) === k);
    if (list.length < KIND_FROM) continue;
    // Only what differs; the rest follows the lines for everyone.
    const own = read(list);
    kinds[k] = Object.fromEntries(Object.entries(own).filter(([f, v]) => v && v !== all[f as Field]));
  }
  const avoid = mine.length >= STOCK_FROM ? STOCK.filter((p) => !mine.some((e) => says(e.own, p))) : [];
  return { all, kinds, avoid };
}

// The same words in another order.
const sameWords = (a: string, b = "") => [...tokens(a)].sort().join(" ") === [...tokens(b)].sort().join(" ");

// Learn the lines and keep them, except those the user set by hand.
export async function learnStyle(userId: string, mine: SentMail[], name: string): Promise<void> {
  const kindOf = await recipients(userId);
  const learned = styleOf(mine, kindOf, name);
  const samples = (list: SentMail[]) => list.slice(0, 12).map((e) => e.own.slice(0, 350)).join("\n---\n");
  learned.all.tone = await toneOf(samples(mine));
  for (const k of RECIPIENTS) {
    if (!learned.kinds[k]) continue;
    const list = mine.filter((e) => kindOf(e.to) === k);
    // One kind that is nearly all of it needs no second reading.
    const tone = list.length > mine.length * 0.9 ? "" : await toneOf(samples(list));
    if (tone && !sameWords(tone, learned.all.tone)) learned.kinds[k]!.tone = tone;
  }
  const row = await styleRow(userId);
  const kept = (where: string, lines: Lines, old: Lines): Lines => {
    const out: Lines = { ...lines };
    for (const f of FIELDS) if (row.edited.includes(`${where}.${f}`)) out[f] = old[f] ?? "";
    return out;
  };
  const all = kept("all", learned.all, row);
  const kinds = Object.fromEntries(RECIPIENTS.map((k) => [k, kept(k, learned.kinds[k] ?? {}, row.kinds[k] ?? {})]));
  await saveStyle(userId, { ...all, kinds, avoid: row.edited.includes("avoid") ? row.avoid : learned.avoid, sample_count: mine.length, last_learned_at: new Date().toISOString() });
}

async function saveStyle(userId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("style_profiles").upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
}

// ── The user's hand ─────────────────────────────────────────────────────────

const bad = (m: string) => Object.assign(new Error(m), { status: 400 });

// One line, set in Settings. "" gives the kind back to the line for everyone.
export async function setLine(userId: string, kind: string, field: string, value: string): Promise<void> {
  if (kind !== "all" && !(RECIPIENTS as readonly string[]).includes(kind)) throw bad(`Unknown kind "${kind}"`);
  if (!(FIELDS as readonly string[]).includes(field)) throw bad(`Unknown line "${field}"`);
  if (field === "avg_length" && value && !LENGTHS[value]) throw bad(`Unknown length "${value}"`);
  const row = await styleRow(userId);
  const text = value.replace(/[^\S\n]+/g, " ").replace(/\n{2,}/g, "\n").trim().slice(0, 160);
  const mark = `${kind}.${field}`;
  const edited = text || kind !== "all" ? [...new Set([...row.edited, mark])] : row.edited.filter((e) => e !== mark);
  if (kind === "all") return saveStyle(userId, { [field]: text || null, edited });
  const k = kind as Recipient;
  const lines = { ...row.kinds[k], [field]: text };
  if (!text) delete lines[field as Field];
  await saveStyle(userId, { kinds: { ...row.kinds, [k]: lines }, edited });
}

export async function setAvoid(userId: string, phrases: unknown[]): Promise<void> {
  const clean = [...new Set(phrases.map((p) => String(p ?? "").replace(/\s+/g, " ").replace(/^["'“]+|["'”.]+$/g, "").trim()).filter((p) => p.length > 2 && p.length < 120))].slice(0, 60);
  const row = await styleRow(userId);
  await saveStyle(userId, { avoid: clean, edited: [...new Set([...row.edited, "avoid"])] });
}

// ── Learning from edits ─────────────────────────────────────────────────────

const EDITS_KEPT = 60;
const TWICE = 2;
const THREE = 3;

// What the user changed in a draft Tabellar wrote before sending it: the
// greeting, the sign-off, a stock opening taken out, a draft cut to well
// under its length or grown well over it. The same greeting or sign-off
// change made twice to the same kind of recipient becomes their line (a
// length three times); a stock phrase taken out twice is avoided. No model
// call, and nothing the user set by hand is changed.
export async function learnFromEdit(userId: string, to: string, before: string, after: string, name: string): Promise<string[]> {
  const was = ownWords(before);
  const now = ownWords(after);
  if (!was || !now || was === now) return [];
  // A different email altogether says nothing about style.
  const old = new Set(tokens(was));
  const shared = tokens(now).filter((t) => old.has(t)).length;
  if (shared < Math.min(old.size, tokens(now).length) * 0.3) return [];

  const kind = (await recipients(userId))(to);
  const row = await styleRow(userId);
  const at = new Date().toISOString();
  const seen: Edit[] = [];
  const g = greetingOf(now) || "None";
  if (g !== (greetingOf(was) || "None")) seen.push({ at, kind, what: "greeting_style", value: g });
  const c = closingOf(now, name) || "None";
  if (c !== (closingOf(was, name) || "None")) seen.push({ at, kind, what: "closing_style", value: c });
  const ratio = wordCount(now) / Math.max(1, wordCount(was));
  if (ratio < 0.65 || ratio > 1.6) seen.push({ at, kind, what: "avg_length", value: lengthOf(wordCount(now)) });
  for (const p of STOCK) if (says(was, p) && !says(now, p)) seen.push({ at, kind, what: "avoid", value: p });
  if (!seen.length) return [];

  const edits = [...row.edits, ...seen].slice(-EDITS_KEPT);
  const patch: Record<string, unknown> = { edits };
  const kinds = { ...row.kinds };
  const learned: string[] = [];
  for (const e of seen) {
    const same = edits.filter((x) => x.what === e.what && x.value === e.value && (e.what === "avoid" || x.kind === kind)).length;
    if (e.what === "avoid") {
      if (same < TWICE || row.avoid.includes(e.value) || row.edited.includes("avoid")) continue;
      patch.avoid = [...((patch.avoid as string[]) ?? row.avoid), e.value];
      learned.push(`avoid "${e.value}"`);
      continue;
    }
    if (same < (e.what === "avg_length" ? THREE : TWICE) || row.edited.includes(`${kind}.${e.what}`)) continue;
    if ((kinds[kind]?.[e.what as Field] || row[e.what as Field]) === e.value) continue;
    kinds[kind] = { ...kinds[kind], [e.what]: e.value };
    patch.kinds = kinds;
    learned.push(`${e.what} ${e.value}`);
  }
  await saveStyle(userId, patch);
  return learned;
}
