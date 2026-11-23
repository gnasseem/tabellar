// Follow-ups Tabellar suggests: mail the user sent in the last 30 days that
// went two days or more without an answer, and that is worth chasing.
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

export type Suggested = {
  email_id: string;
  thread_id: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  sent_at: string;
  days_waiting: number;
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

// The first person a sent email went to, or null when it went to no person.
function personOf(recipients: string | null, own: Set<string>, lists: Set<string>): { email: string; name: string } | null {
  for (const part of String(recipients ?? "").split(",")) {
    const [email] = addressesIn(part);
    if (!email || own.has(email)) continue;
    const name = displayName(part.trim(), email);
    if (NO_REPLY.test(email) || SERVICE.test(email.split("@")[0]) || SERVICE_NAME.test(name) || lists.has(email)) return null;
    return { email, name: name === email ? email.split("@")[0] : name };
  }
  return null;
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

  // An answer is any message in the thread from someone else after the user's last one.
  const answeredAfter = new Map<string, string>();
  for (let i = 0; i < threads.length; i += 300) {
    const ids = threads.slice(i, i + 300);
    const [{ data: inbox }, { data: index }] = await Promise.all([
      db.from("emails").select("thread_id, received_at").eq("user_id", userId).in("thread_id", ids).not("label_ids", "cs", '{"SENT"}'),
      db.from("mail_index").select("thread_id, at").eq("user_id", userId).in("thread_id", ids).eq("sent", false),
    ]);
    for (const r of inbox ?? []) answeredAfter.set(String(r.thread_id), [answeredAfter.get(String(r.thread_id)) ?? "", String(r.received_at)].sort().at(-1)!);
    for (const r of index ?? []) answeredAfter.set(String(r.thread_id), [answeredAfter.get(String(r.thread_id)) ?? "", String(r.at)].sort().at(-1)!);
  }

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

export async function suggestedFollowups(userId: string): Promise<Suggested[]> {
  const prefs = await allPrefs(userId);
  return (await candidates(userId))
    .filter(({ sent, to }) => sent.awaits_reply === true && Date.now() - new Date(sent.received_at).getTime() >= WAIT_DAYS * DAY && !stops(pick(prefs, to.email, sent.subject ?? ""), "followup"))
    .map(({ sent, to }) => ({
      email_id: sent.id,
      thread_id: sent.thread_id!,
      recipient_email: to.email,
      recipient_name: to.name,
      subject: sent.subject || "(no subject)",
      sent_at: sent.received_at,
      days_waiting: Math.floor((Date.now() - new Date(sent.received_at).getTime()) / DAY),
    }));
}
