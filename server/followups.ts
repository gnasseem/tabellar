// Follow-ups: reminders the user set on sent mail, and the ones Tabellar
// suggests: mail the user sent in the last 30 days that went two days or
// more without an answer, and that is worth chasing.
//
// A sent thread counts only when
//   - its last message from the user asks something or promises something
//     (one fast-model call per sent email, kept in emails.awaits_reply),
//   - it went to a person: not the user, not a no-reply, list or service
//     address (senders.ts tells a list from its headers),
//   - nobody has written in the thread since, and it is not tracked already,
//   - no preference rules out follow-ups with that address.

import { db } from "./db.ts";
import { expectsAnswer } from "./ai.ts";
import { modelConfigured } from "./llm.ts";
import { serial } from "./sync.ts";
import { addressesIn, bulkHeaders, ownAddresses } from "./senders.ts";
import { allPrefs, displayName, pick, stops } from "./profile.ts";

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const WAIT_DAYS = 2;

const NO_REPLY = /no.?reply|donotreply|do-not-reply|notifications?@|mailer-daemon|postmaster|bounce/i;
const SERVICE = /print|scan|mailer|daemon|robot/i;
const SERVICE_NAME = /\b(service account|no.?reply|notifications?|printer)\b/i;

// One line of the Follow-ups list: a reminder the user set, or sent mail
// Tabellar suggests; `reminder_id` tells them apart.
export type Followup = {
  key: string;
  reminder_id: string | null;
  email_id: string;
  thread_id: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  sent_at: string;
  asked: string; // the sentence of the sent email that asks or promises something
  remind_at: string | null;
};

type Sent = { id: string; thread_id: string | null; recipients: string | null; subject: string | null; body_text: string | null; received_at: string; awaits_reply: boolean | null };

// What the user wrote, without the message quoted below it.
function ownText(body: string | null): string {
  const lines: string[] = [];
  for (const line of String(body ?? "").split("\n")) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .{4,200}(wrote|écrit|schrieb|escribió):?\s*$/i.test(line.trim()) || /^-{2,}\s*(original|forwarded) message/i.test(line.trim())) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

// The sentence that waits on an answer: the first question, else the first
// request or promise, else the first sentence. Greetings and sign-offs skipped.
export function askedOf(body: string | null): string {
  const greeting = /^\s*(hi|hello|hey|dear|good (morning|afternoon|evening))\b.{0,40}$/i;
  // Paragraphs, with hard-wrapped lines joined and an opening greeting line dropped.
  const sentences = ownText(body)
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").filter((l, i) => !(i === 0 && greeting.test(l))).join(" "))
    .flatMap((p) => p.split(/(?<=[.?!])\s+(?=[A-Z"(])/))
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 3 && !greeting.test(x) && !/^(best|thanks|thank you|regards|cheers|kind regards|sincerely|sent from)\b/i.test(x));
  const ask =
    sentences.find((x) => x.endsWith("?")) ??
    sentences.find((x) => /\b(could|can|would|will) you\b|\bplease\b|\blet me know\b|\bi('ll| will)\b/i.test(x)) ??
    sentences[0] ??
    "";
  return ask.length > 200 ? `${ask.slice(0, 200).replace(/\s+\S*$/, "")}...` : ask;
}

// The first person a sent email went to, or null when it went to no person.
function personOf(recipients: string | null, own: Set<string>, lists: Set<string>): { email: string; name: string } | null {
  for (const part of String(recipients ?? "").split(",")) {
    const [email] = addressesIn(part);
    if (!email || own.has(email)) continue;
    const name = displayName(part.trim(), email);
    if (NO_REPLY.test(email) || SERVICE.test(email.split("@")[0]) || SERVICE_NAME.test(name) || lists.has(email)) return null;
    return { email, name };
  }
  return null;
}

// When someone else last wrote in each thread: an answer is any message in
// the thread from someone else after the user's last one.
async function lastAnswers(userId: string, threads: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const later = (t: string, at: string) => out.set(t, [out.get(t) ?? "", at].sort().at(-1)!);
  for (let i = 0; i < threads.length; i += 300) {
    const ids = threads.slice(i, i + 300);
    const [{ data: inbox }, { data: index }] = await Promise.all([
      db.from("emails").select("thread_id, received_at").eq("user_id", userId).in("thread_id", ids).not("label_ids", "cs", '{"SENT"}'),
      db.from("mail_index").select("thread_id, at").eq("user_id", userId).in("thread_id", ids).eq("sent", false),
    ]);
    for (const r of inbox ?? []) later(String(r.thread_id), String(r.received_at));
    for (const r of index ?? []) later(String(r.thread_id), String(r.at));
  }
  return out;
}

// The newest sent email of each unanswered, untracked thread from the window,
// with who it went to. Shared by the judging and the list.
async function candidates(userId: string): Promise<{ sent: Sent; to: { email: string; name: string } }[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * DAY).toISOString();
  const [{ data: sentRows }, { data: tracked }, own, { data: listy }] = await Promise.all([
    db.from("emails").select("id, thread_id, recipients, subject, body_text, received_at, awaits_reply").eq("user_id", userId).contains("label_ids", ["SENT"]).gte("received_at", since).order("received_at", { ascending: false }).limit(500),
    db.from("follow_up_reminders").select("thread_id").eq("user_id", userId),
    ownAddresses(userId),
    db.from("senders").select("address, list_id, precedence, category").eq("user_id", userId).or("list_unsubscribe.eq.true,category.eq.promotions"),
  ]);
  // Addresses whose own mail is bulk by the same headers as senders.isBulk.
  const lists = new Set<string>((listy ?? []).filter((s) => s.category === "promotions" || bulkHeaders(true, s.list_id as string | null, s.precedence as string | null)).map((s) => String(s.address)));
  const isTracked = new Set((tracked ?? []).map((t) => String(t.thread_id)));
  const latest = new Map<string, Sent>();
  for (const e of (sentRows ?? []) as Sent[]) if (e.thread_id && !latest.has(e.thread_id)) latest.set(e.thread_id, e);
  const threads = [...latest.keys()].filter((t) => !isTracked.has(t));
  if (!threads.length) return [];

  const answeredAfter = await lastAnswers(userId, threads);
  const out: { sent: Sent; to: { email: string; name: string } }[] = [];
  for (const t of threads) {
    const sent = latest.get(t)!;
    if ((answeredAfter.get(t) ?? "") > sent.received_at) continue;
    const to = personOf(sent.recipients, own, lists);
    if (to) out.push({ sent, to });
  }
  return out;
}

// Ask the model about every candidate not judged yet. Empty mail expects
// nothing and costs no call. Runs one at a time.
export const judgeSent = serial(async (userId: string): Promise<number> => {
  if (!modelConfigured()) return 0;
  let judged = 0;
  for (const { sent, to } of await candidates(userId)) {
    if (sent.awaits_reply !== null) continue;
    const text = ownText(sent.body_text);
    let expects = false;
    try {
      expects = text.length > 0 && (await expectsAnswer(sent.subject ?? "", to.email, text));
    } catch (e) {
      console.error("[followups] judging failed:", (e as Error).message);
      continue;
    }
    await db.from("emails").update({ awaits_reply: expects }).eq("id", sent.id);
    judged++;
  }
  return judged;
});

// The Follow-ups list: reminders the user set that are due or waiting (not
// put off until later, not answered since), then the sent mail Tabellar
// suggests. A reminder whose thread got an answer is marked replied here.
export async function followupList(userId: string): Promise<Followup[]> {
  const prefs = await allPrefs(userId);
  const now = new Date().toISOString();
  const { data: reminders } = await db.from("follow_up_reminders").select("*").eq("user_id", userId).in("status", ["waiting", "snoozed"]);
  const active = (reminders ?? []).filter((r) => r.status === "waiting" || String(r.snooze_until ?? "") <= now);
  const ids = active.map((r) => r.email_id).filter(Boolean) as string[];
  const { data: sentRows } = ids.length ? await db.from("emails").select("id, received_at, body_text").in("id", ids) : { data: [] };
  const sent = new Map<string, Record<string, unknown>>((sentRows ?? []).map((e: Record<string, unknown>) => [String(e.id), e]));
  const answered = await lastAnswers(userId, active.map((r) => String(r.thread_id)));
  const out: Followup[] = [];
  for (const r of active) {
    const e = sent.get(String(r.email_id));
    const sentAt = String(e?.received_at ?? r.created_at);
    if ((answered.get(String(r.thread_id)) ?? "") > sentAt) {
      await db.from("follow_up_reminders").update({ status: "replied" }).eq("id", r.id);
      continue;
    }
    if (stops(pick(prefs, String(r.recipient_email), String(r.subject ?? "")), "followup")) continue;
    out.push({
      key: String(r.id), reminder_id: String(r.id), email_id: String(r.email_id ?? ""), thread_id: String(r.thread_id),
      recipient_email: String(r.recipient_email), recipient_name: String(r.recipient_name || r.recipient_email),
      subject: String(r.subject || "(no subject)"), sent_at: sentAt, asked: askedOf((e?.body_text as string | null) ?? null), remind_at: String(r.remind_at),
    });
  }
  for (const { sent: e, to } of await candidates(userId)) {
    if (e.awaits_reply !== true || Date.now() - new Date(e.received_at).getTime() < WAIT_DAYS * DAY) continue;
    if (stops(pick(prefs, to.email, e.subject ?? ""), "followup")) continue;
    out.push({
      key: `s:${e.thread_id}`, reminder_id: null, email_id: e.id, thread_id: e.thread_id!, recipient_email: to.email, recipient_name: to.name,
      subject: e.subject || "(no subject)", sent_at: e.received_at, asked: askedOf(e.body_text), remind_at: null,
    });
  }
  // Longest wait first.
  return out.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
}
