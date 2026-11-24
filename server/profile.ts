// What Tabellar knows about the user, and what it asks instead of guessing.
//
// `preferences` holds one row per thing the user said, or Tabellar learned
// from what they did:
//   fact    free text about the user ("Studies computer science at NYU")
//   rule    free text the user wants followed ("No todos from job application receipts")
//   writing a rule for drafts only ("Never use bullet points"); see writing.ts
//   sender  an address, domain a domain, topic a few words; each with one of
//           VALUES as its value
// Prompts read it through profileContext(), the engine through prefsFor() and
// stops(). What the user does feeds it through learn() and feedback(), with no
// model call.
//
// `questions` is what Tabellar asks when it would otherwise guess: a todo or a
// draft from someone the user has never written to or opened mail from. At
// most MAX_OPEN are open at a time; the rest wait their turn.

import { db } from "./db.ts";
import { mail } from "./providers.ts";
import type { Account } from "./accounts.ts";
import { addressesIn } from "./senders.ts";

export const KINDS = ["fact", "rule", "writing", "sender", "domain", "topic"] as const;
export const VALUES = ["vip", "normal", "quiet", "ignore", "never_todo", "never_meeting", "never_draft", "never_followup", "not_newsletter"] as const;

// What each value stops. quiet: nothing is made from their mail and it never
// notifies. ignore: the same, and the briefing leaves it out too.
export type Thing = "todo" | "meeting" | "draft" | "followup" | "newsletter" | "notify" | "briefing";
const STOPS: Record<string, Thing[]> = {
  quiet: ["todo", "meeting", "draft", "followup", "notify"],
  ignore: ["todo", "meeting", "draft", "followup", "notify", "briefing"],
  never_todo: ["todo"],
  never_meeting: ["meeting"],
  never_draft: ["draft"],
  never_followup: ["followup"],
  not_newsletter: ["newsletter"],
};
// A sender, domain or topic has one standing; the never_ values add to it.
const STANDING = new Set(["vip", "normal", "quiet", "ignore"]);

// How a value reads in a prompt.
const DESCRIBE: Record<string, string> = {
  vip: "one of the user's most important people",
  normal: "someone the user deals with",
  quiet: "the user wants nothing made from their mail",
  ignore: "the user ignores their mail",
  never_todo: "never make todos from their mail",
  never_meeting: "never propose meetings from their mail",
  never_draft: "never draft replies to them",
  never_followup: "never suggest following up with them",
  not_newsletter: "not a newsletter",
};

// Two facts have a fixed start, so About you can show and edit them as fields.
export const ROLE = "Role: ";
export const WORK = "Works on: ";

const MAX_OPEN = 3;
const CONTEXT_CHARS = 1600; // about 400 tokens

export type Pref = { id: string; kind: string; subject: string; value: string; source: string; evidence: string | null };
export type Option = { label: string; pref?: { kind: string; subject: string; value: string } };

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const like = (s: string) => s.replace(/%/g, "");
export const domainOf = (address: string) => lc(address).split("@")[1] ?? "";

// "Voyage AI <hi@voyageai.com>" is "Voyage AI"; a bare address is itself.
export function displayName(sender: string | null | undefined, address: string): string {
  const name = String(sender ?? "").split("<")[0].replace(/"/g, "").trim();
  return name && !name.includes("@") ? name : address;
}

// Does the text mention the topic? Every word of it, as a word ("AI" is not
// in "email"), a plural counting as the singular.
export function mentions(text: string, topic: string): boolean {
  const t = lc(text);
  const words = lc(topic).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  return words.length > 0 && words.every((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.length > 3 ? w.replace(/s$/, "") : w}(?:e?s)?(?![\\p{L}\\p{N}])`, "u").test(t));
}

export async function allPrefs(userId: string): Promise<Pref[]> {
  const { data } = await db.from("preferences").select("id, kind, subject, value, source, evidence").eq("user_id", userId).order("updated_at", { ascending: false });
  return (data ?? []) as Pref[];
}

// The rows that apply to mail from `address` whose text is `text`. A sender's
// own standing replaces its domain's; topics apply on top of both.
export function pick(rows: Pref[], address: string, text: string): Pref[] {
  const a = lc(address);
  const d = domainOf(a);
  const own = rows.filter((r) => r.kind === "sender" && a && r.subject === a);
  const dom = rows.filter((r) => r.kind === "domain" && d && (d === r.subject || d.endsWith(`.${r.subject}`)));
  const topics = text ? rows.filter((r) => r.kind === "topic" && mentions(text, r.subject)) : [];
  const standing = own.some((r) => STANDING.has(r.value));
  return [...own, ...(standing ? dom.filter((r) => !STANDING.has(r.value)) : dom), ...topics];
}

export async function prefsFor(userId: string, address: string | null | undefined, text = ""): Promise<Pref[]> {
  return pick(await allPrefs(userId), lc(address), text);
}

// The first row that stops `thing`, or null.
export function stops(rows: Pref[], thing: Thing): Pref | null {
  return rows.find((r) => STOPS[r.value]?.includes(thing)) ?? null;
}

// Has the user already said what this sender is?
export const covers = (rows: Pref[]) => rows.some((r) => r.kind === "sender" || r.kind === "domain");

// ── Who the user knows ──────────────────────────────────────────────────────

// Has the user written to this address? Sent mail in the database first; for
// anything else the mailbox answers, since sync keeps little sent mail.
export async function wroteTo(userId: string, address: string, account: Account | null): Promise<boolean> {
  const a = lc(address);
  const { data: sent } = await db
    .from("emails")
    .select("recipients, cc_recipients")
    .eq("user_id", userId)
    .contains("label_ids", ["SENT"])
    .or(`recipients.ilike.%${like(a).replace(/[,()]/g, "")}%,cc_recipients.ilike.%${like(a).replace(/[,()]/g, "")}%`)
    .limit(500);
  if ((sent ?? []).some((e) => addressesIn(`${e.recipients ?? ""}, ${e.cc_recipients ?? ""}`).includes(a))) return true;
  if (!account || !/^[^\s@"]+@[^\s@"]+$/.test(address)) return false;
  // That mailbox first, then the user's other mailboxes.
  const { data: accounts } = await db.from("accounts").select("*").eq("user_id", userId);
  for (const x of [account, ...((accounts ?? []) as unknown as Account[]).filter((other) => other.id !== account.id)]) {
    try {
      if (await mail(x).hasSentTo(x, address)) return true;
    } catch {
      // A mailbox that cannot be asked counts as not written to.
    }
  }
  return false;
}

// Of these addresses, the ones the user corresponds with: in their Google
// contacts, written to or answered (senders.ts), or written to in the sent
// mail stored here. Local data only.
export async function correspondents(userId: string, addresses: string[]): Promise<Set<string>> {
  const wanted = new Set(addresses.map(lc).filter(Boolean));
  const found = new Set<string>();
  if (!wanted.size) return found;
  const [{ data: contacts }, { data: senders }, { data: sent }] = await Promise.all([
    db.from("contacts").select("email").eq("user_id", userId).eq("source", "contact").in("email", [...wanted]),
    db.from("senders").select("address").eq("user_id", userId).in("address", [...wanted]).or("sent_to.gt.0,replied.gt.0"),
    db.from("emails").select("recipients, cc_recipients").eq("user_id", userId).contains("label_ids", ["SENT"]).order("received_at", { ascending: false }).limit(2000),
  ]);
  for (const c of contacts ?? []) found.add(lc(c.email));
  for (const s of senders ?? []) found.add(lc(s.address));
  for (const e of sent ?? []) {
    for (const m of `${e.recipients ?? ""} ${e.cc_recipients ?? ""}`.matchAll(/[^\s<>,;"]+@[^\s<>,;"]+/g)) {
      if (wanted.has(lc(m[0]))) found.add(lc(m[0]));
    }
  }
  return found;
}

// Does the user know this sender: a contact, someone they wrote to, or someone
// whose mail they have opened before?
export async function knowsSender(userId: string, address: string, opts: { exceptEmailId?: string; account?: Account | null } = {}): Promise<boolean> {
  const a = lc(address);
  if (!a) return false;
  if ((await correspondents(userId, [a])).size) return true;
  // Opened their mail before, by the first read's count (this email aside).
  const { data: seen } = await db.from("senders").select("opened").eq("user_id", userId).eq("address", a).maybeSingle();
  let before = Number(seen?.opened ?? 0);
  if (before && opts.exceptEmailId) {
    const { data: e } = await db.from("emails").select("is_read").eq("id", opts.exceptEmailId).maybeSingle();
    if (e?.is_read) before--;
  }
  if (before > 0) return true;
  const { count: opened } = await db
    .from("emails")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("sender_email", a)
    .eq("is_read", true)
    .neq("id", opts.exceptEmailId ?? "");
  if (opened) return true;
  return wroteTo(userId, a, opts.account ?? null);
}

// ── The prompt block ────────────────────────────────────────────────────────

// At most about 400 tokens: who the user is, what Tabellar was told about this
// email's sender and topics, then facts, rules and what they never want.
export async function profileContext(
  userId: string,
  email?: { sender_email?: string | null; subject?: string | null; text?: string | null },
): Promise<string> {
  const [{ data: me }, rows, { data: accounts }] = await Promise.all([
    db.from("profiles").select("display_name, email").eq("id", userId).maybeSingle(),
    allPrefs(userId),
    db.from("accounts").select("address, send_as").eq("user_id", userId),
  ]);
  // Every address the user writes from: their accounts and their aliases.
  const mine = [...new Set([me?.email, ...(accounts ?? []).flatMap((a) => [a.address, ...((a.send_as as { address: string }[] | null) ?? []).map((x) => x.address)])].map(lc).filter(Boolean))];
  // What is said about this email's sender and topics goes last, so the
  // block before it is the same for every email and a local model can reuse
  // the work it did on it. It is also kept first when the block runs long.
  const about: string[] = [];
  if (email?.sender_email) {
    const address = lc(email.sender_email);
    for (const r of pick(rows, address, `${email.subject ?? ""} ${String(email.text ?? "").slice(0, 3000)}`)) {
      if (r.kind === "topic") {
        about.push(`This email is about ${r.subject}, which the user is not interested in.`);
        continue;
      }
      const what = r.kind === "domain" ? `Mail from ${r.subject}` : `This sender (${address})`;
      about.push(`${what}: ${DESCRIBE[r.value] ?? r.value}.`);
    }
  }
  const lines: string[] = [];
  const who = [me?.display_name, mine.length ? mine.map((a) => `<${a}>`).join(", ") : ""].filter(Boolean).join(" ");
  if (who) lines.push(`The user is ${who}.`);
  for (const f of rows.filter((r) => r.kind === "fact")) lines.push(`- ${f.value}`);
  const rules = rows.filter((r) => r.kind === "rule");
  if (rules.length) lines.push(`Rules from the user: ${rules.map((r) => r.value).join("; ")}.`);
  const vips = rows.filter((r) => r.value === "vip").map((r) => r.subject);
  if (vips.length) lines.push(`Most important to the user: ${vips.slice(0, 15).join(", ")}.`);
  const notInterested = rows.filter((r) => r.kind === "topic" && STOPS[r.value]).map((r) => r.subject);
  if (notInterested.length) lines.push(`Not interested in: ${notInterested.slice(0, 20).join(", ")}.`);
  const never = rows.filter((r) => r.kind !== "topic" && (r.value === "quiet" || r.value === "ignore")).map((r) => r.subject);
  if (never.length) lines.push(`Wants nothing from: ${never.slice(0, 20).join(", ")}.`);

  const tail = about.map((l) => `${l}\n`).join("");
  let text = "";
  for (const l of lines) {
    if (text.length + l.length + 1 + tail.length > CONTEXT_CHARS) break;
    text += `${l}\n`;
  }
  text += tail;
  return text ? `What Tabellar knows about the user:\n${text.trim()}` : "";
}

// ── Writing preferences ─────────────────────────────────────────────────────

export async function setPref(userId: string, kind: string, subject: string, value: string, source: string, evidence?: string): Promise<void> {
  if (!(KINDS as readonly string[]).includes(kind)) throw Object.assign(new Error(`Unknown kind "${kind}"`), { status: 400 });
  const free = kind === "fact" || kind === "rule" || kind === "writing";
  const subj = free ? "" : lc(subject);
  const val = free ? String(value).trim() : value;
  if (!val || (!free && !subj)) throw Object.assign(new Error("Nothing to save"), { status: 400 });
  if (!free && !(VALUES as readonly string[]).includes(val)) throw Object.assign(new Error(`Unknown value "${val}"`), { status: 400 });
  if (STANDING.has(val)) {
    await db.from("preferences").delete().eq("user_id", userId).eq("kind", kind).eq("subject", subj).in("value", [...STANDING].filter((v) => v !== val));
  }
  await db
    .from("preferences")
    .upsert(
      { user_id: userId, kind, subject: subj, value: val, source, evidence: evidence ?? null, updated_at: new Date().toISOString() },
      { onConflict: "user_id,kind,subject,value" },
    );
}

async function emailIdsFor(userId: string, kind: string, subject: string): Promise<string[]> {
  if (kind === "sender") {
    const { data } = await db.from("emails").select("id").eq("user_id", userId).eq("sender_email", lc(subject)).limit(5000);
    return (data ?? []).map((e) => e.id as string);
  }
  if (kind === "domain") {
    const d = like(subject);
    const { data } = await db.from("emails").select("id").eq("user_id", userId).or(`sender_email.ilike.%@${d},sender_email.ilike.%.${d}`).limit(5000);
    return (data ?? []).map((e) => e.id as string);
  }
  if (kind === "topic") {
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const { data } = await db.from("emails").select("id, subject, snippet").eq("user_id", userId).gte("received_at", since).limit(5000);
    return (data ?? []).filter((e) => mentions(`${e.subject ?? ""} ${e.snippet ?? ""}`, subject)).map((e) => e.id as string);
  }
  return [];
}

// Take back what a preference now stops: proposals waiting for this mail are
// dismissed, and open todos from it, proposed meetings and Tabellar's drafts
// are removed. Completed todos and confirmed meetings stay.
export async function applyPref(userId: string, kind: string, subject: string, value: string): Promise<void> {
  const things = STOPS[value] ?? [];
  const kinds = (["todo", "meeting", "draft"] as const).filter((k) => things.includes(k));
  if (!kinds.length) return;
  const ids = await emailIdsFor(userId, kind, subject);
  if (!ids.length) return;
  const now = new Date().toISOString();
  await db
    .from("action_log")
    .update({ status: "dismissed", decided_at: now, reason: "Your preference" })
    .eq("user_id", userId)
    .eq("status", "proposed")
    .in("kind", kinds)
    .in("email_id", ids);
  const removed = new Set<string>();
  const gone = (r: { data: Record<string, unknown>[] | null }) => (r.data ?? []).forEach((x) => removed.add(String(x.id)));
  if (kinds.includes("todo")) gone(await db.from("todos").delete().eq("user_id", userId).neq("source", "manual").eq("is_completed", false).in("email_id", ids).select("id"));
  if (kinds.includes("meeting")) gone(await db.from("meetings").delete().eq("user_id", userId).eq("status", "proposed").in("email_id", ids).select("id"));
  if (kinds.includes("draft")) {
    const { data: drafts } = await db.from("draft_emails").select("id").eq("user_id", userId).eq("source", "tabellar").in("email_id", ids);
    if (drafts?.length) for (const id of await import("./drafts.ts").then((m) => m.discardDrafts(userId, drafts.map((d) => String(d.id)))).catch(() => [])) removed.add(id);
  }
  if (!removed.size) return;
  const { data: done } = await db.from("action_log").select("id, detail").eq("user_id", userId).eq("status", "done").in("kind", kinds).in("email_id", ids);
  for (const r of done ?? []) {
    const d = r.detail as Record<string, unknown>;
    if (![d.todoId, d.meetingId, d.draftId].some((x) => removed.has(String(x)))) continue;
    await db.from("action_log").update({ status: "undone", undone_at: now, reason: "Your preference" }).eq("id", r.id);
  }
}

async function senderOf(emailId: string | null | undefined): Promise<string> {
  if (!emailId) return "";
  const { data } = await db.from("emails").select("sender_email").eq("id", emailId).maybeSingle();
  return lc(data?.sender_email);
}

// ── Learning from what the user does ────────────────────────────────────────

export type Signal = {
  thing: "todo" | "meeting" | "draft" | "followup" | "newsletter";
  outcome: "approved" | "dismissed" | "never_sender" | "never_topic";
  emailId?: string | null;
  sender?: string;
  topic?: string;
};

// approved: an unknown sender becomes someone the user deals with.
// dismissed: the second todo, meeting or draft dismissed or undone for the
// same sender becomes a never_ preference.
// never_sender, never_topic: written as said.
export async function learn(userId: string, s: Signal): Promise<void> {
  if (s.outcome === "never_topic") {
    const topic = String(s.topic ?? "").trim();
    if (!topic) return;
    await setPref(userId, "topic", topic, "ignore", "user", `Said not interested, on a ${s.thing}`);
    await applyPref(userId, "topic", topic, "ignore");
    return;
  }
  const sender = lc(s.sender) || (await senderOf(s.emailId));
  if (!sender) return;
  const value = s.thing === "newsletter" ? "not_newsletter" : `never_${s.thing}`;
  const rows = await allPrefs(userId);
  const own = rows.filter((r) => r.kind === "sender" && r.subject === sender);
  if (s.outcome === "never_sender") {
    await setPref(userId, "sender", sender, value, "user", `Said never, on a ${s.thing}`);
    await applyPref(userId, "sender", sender, value);
    return;
  }
  if (s.outcome === "approved") {
    // Their company may have a standing already (most important), which one of their own would replace.
    if (!pick(rows, sender, "").some((r) => STANDING.has(r.value))) await setPref(userId, "sender", sender, "normal", "learned", `Approved a ${s.thing} from their mail`);
    return;
  }
  if (!["todo", "meeting", "draft"].includes(s.thing) || own.some((r) => r.value === value)) return;
  const ids = await emailIdsFor(userId, "sender", sender);
  const { data: turnedDown } = await db
    .from("action_log")
    .select("reason")
    .eq("user_id", userId)
    .eq("kind", s.thing)
    .in("status", ["dismissed", "undone"])
    .in("email_id", ids);
  // What a preference took back on its own does not count as the user's choice.
  const count = (turnedDown ?? []).filter((r) => r.reason !== "Your preference").length;
  if (count < 2) return;
  await setPref(userId, "sender", sender, value, "learned", `Turned down ${count} ${s.thing}s from their mail`);
  await applyPref(userId, "sender", sender, value);
}

// "Not this", "Never for this sender" and "Not interested in this topic" on a
// todo, meeting, follow-up or newsletter row. Not this removes the one item
// (a follow-up is dismissed by the window itself); the others also write the
// preference, which takes back everything else it stops. A todo or meeting
// still waiting for approval is named by its `proposal` (the action_log id).
export type Feedback = {
  thing: "todo" | "meeting" | "followup" | "newsletter";
  outcome: "not_this" | "never_sender" | "never_topic";
  id?: string;
  proposal?: string;
  sender?: string;
  topic?: string;
};

export async function feedback(userId: string, f: Feedback): Promise<void> {
  let emailId: string | null = null;
  if ((f.thing === "todo" || f.thing === "meeting") && f.proposal) {
    const { data: row } = await db.from("action_log").select("id, email_id").eq("id", f.proposal).eq("user_id", userId).eq("kind", f.thing).eq("status", "proposed").maybeSingle();
    if (!row) throw Object.assign(new Error(`That ${f.thing} is already gone`), { status: 404 });
    emailId = (row.email_id as string | null) ?? null;
    await db.from("action_log").update({ status: "dismissed", decided_at: new Date().toISOString(), reason: "Not this" }).eq("id", row.id);
  } else if ((f.thing === "todo" || f.thing === "meeting") && f.id) {
    const table = f.thing === "todo" ? "todos" : "meetings";
    const { data: item } = await db.from(table).select(f.thing === "todo" ? "id, email_id" : "id, email_id, status").eq("id", f.id).eq("user_id", userId).maybeSingle();
    if (!item) throw Object.assign(new Error(`That ${f.thing} is already gone`), { status: 404 });
    emailId = (item.email_id as string | null) ?? null;
    // A meeting already on the calendar stays; it is changed in Meetings.
    if (f.thing === "todo" || item.status === "proposed") {
      await db.from(table).delete().eq("id", f.id);
      const key = f.thing === "todo" ? "todoId" : "meetingId";
      const { data: rows } = emailId
        ? await db.from("action_log").select("id, detail").eq("user_id", userId).eq("kind", f.thing).eq("status", "done").eq("email_id", emailId)
        : { data: [] as Record<string, unknown>[] };
      for (const r of rows ?? []) {
        if ((r.detail as Record<string, unknown>)[key] !== f.id) continue;
        await db.from("action_log").update({ status: "undone", undone_at: new Date().toISOString(), reason: "Not this" }).eq("id", r.id);
      }
    }
    // A proposal for the same thing from the same email no longer waits.
    if (emailId) {
      await db.from("action_log").update({ status: "dismissed", decided_at: new Date().toISOString(), reason: "Not this" }).eq("user_id", userId).eq("kind", f.thing).eq("status", "proposed").eq("email_id", emailId);
    }
  }
  if (f.outcome === "not_this") {
    if (f.thing === "newsletter") await learn(userId, { thing: "newsletter", outcome: "never_sender", sender: f.sender });
    else if (f.thing !== "followup") await learn(userId, { thing: f.thing, outcome: "dismissed", emailId, sender: f.sender });
    return;
  }
  await learn(userId, { thing: f.thing, outcome: f.outcome, emailId, sender: f.sender, topic: f.topic });
}

// ── Questions ───────────────────────────────────────────────────────────────

// Adds a question unless one about the same subject is open, waiting or was
// answered. Returns whether it was added.
export async function ask(userId: string, q: { text: string; detail?: string; about: string; emailId?: string | null; options: Option[] }): Promise<boolean> {
  const about = lc(q.about);
  const { data: seen } = await db.from("questions").select("status").eq("user_id", userId).eq("about", about).in("status", ["open", "waiting", "answered"]);
  // An answer whose preference the user has deleted since no longer answers it.
  const forgotten = about.includes("@") && !covers(await prefsFor(userId, about));
  if ((seen ?? []).some((q) => q.status !== "answered" || !forgotten)) return false;
  const { count: open } = await db.from("questions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "open");
  await db.from("questions").insert({
    user_id: userId, text: q.text, detail: q.detail ?? null, about, email_id: q.emailId ?? null, options: q.options,
    status: (open ?? 0) < MAX_OPEN ? "open" : "waiting",
  });
  return true;
}

// The question Tabellar asks before making a todo or draft from someone the
// user does not know.
export function senderQuestion(sender: string | null, address: string, detail: string, emailId: string): Parameters<typeof ask>[1] {
  const a = lc(address);
  return {
    text: `Do you deal with ${displayName(sender, a)}?`,
    detail,
    about: a,
    emailId,
    options: [
      { label: "Yes", pref: { kind: "sender", subject: a, value: "normal" } },
      { label: "No, ignore them", pref: { kind: "sender", subject: a, value: "quiet" } },
      { label: "Not now" },
    ],
  };
}

async function promote(userId: string): Promise<void> {
  const { count: open } = await db.from("questions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "open");
  const room = MAX_OPEN - (open ?? 0);
  if (room <= 0) return;
  const { data: next } = await db.from("questions").select("id").eq("user_id", userId).eq("status", "waiting").order("created_at", { ascending: true }).limit(room);
  for (const q of next ?? []) await db.from("questions").update({ status: "open" }).eq("id", q.id);
}

// Stores the answer as a preference and applies it now. An answer that lets
// Tabellar act returns the email to plan again.
export async function answer(userId: string, id: string, index: number): Promise<{ replan: string | null }> {
  const { data: q } = await db.from("questions").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!q) throw Object.assign(new Error("No such question"), { status: 404 });
  if (q.status !== "open" && q.status !== "waiting") throw Object.assign(new Error("This question was already answered"), { status: 409 });
  const opt = ((q.options as Option[]) ?? [])[index];
  if (!opt) throw Object.assign(new Error("No such answer"), { status: 400 });
  if (opt.pref) {
    await setPref(userId, opt.pref.kind, opt.pref.subject, opt.pref.value, "asked", `${q.text} ${opt.label}`);
    await applyPref(userId, opt.pref.kind, opt.pref.subject, opt.pref.value);
  }
  await db.from("questions").update({ status: opt.pref ? "answered" : "skipped", answer: opt.label, answered_at: new Date().toISOString() }).eq("id", id);
  await promote(userId);
  const replan = opt.pref && !STOPS[opt.pref.value] && q.email_id ? (q.email_id as string) : null;
  if (replan) {
    // Everything recent from that sender waited on this answer, not only the email it was asked about.
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: theirs } = opt.pref!.kind === "sender" ? await db.from("emails").select("id").eq("user_id", userId).eq("sender_email", opt.pref!.subject).gte("received_at", since).limit(200) : { data: [] };
    await db.from("email_processed").update({ engine_at: null }).in("email_id", [...new Set([replan, ...(theirs ?? []).map((e) => String(e.id))])]);
  }
  return { replan };
}

// Take an answer back: the preference it wrote goes and the question is open again.
export async function reopen(userId: string, id: string): Promise<void> {
  const { data: q } = await db.from("questions").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!q) throw Object.assign(new Error("No such question"), { status: 404 });
  if (q.status !== "answered" && q.status !== "skipped") return;
  const opt = ((q.options as Option[]) ?? []).find((o) => o.label === q.answer);
  if (opt?.pref) await db.from("preferences").delete().eq("user_id", userId).eq("kind", opt.pref.kind).eq("subject", opt.pref.subject).eq("value", opt.pref.value).eq("source", "asked");
  await db.from("questions").update({ status: "open", answer: null, answered_at: null }).eq("id", id);
}

// ── Knowledge ───────────────────────────────────────────────────────────────

// The knowledge base keeps people and companies only; topics, locations and
// projects pulled out of single emails were trivia.
export async function retireTrivia(userId: string): Promise<void> {
  await db.from("knowledge_base").delete().eq("user_id", userId).eq("source", "email").not("entity_type", "in", "(person,company)");
}
