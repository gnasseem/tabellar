// The first read of a new mailbox: wide and cheap, then deep where it matters.
//
//   headers  The headers of the last 90 days of mail, inbox and sent, at most
//            5,000, into mail_index, and from them the senders table, with no
//            model call. The newest inbox mail, fetched first so the window
//            has something to show, is read by the model meanwhile.
//   sent     The last 200 sent emails: kept for Follow-ups, the writing style
//            learned from all of them, and one careful-model call that writes
//            the first facts about the user.
//   deep     Inbox mail from the last 30 days, real people before bulk, newest
//            first, 300 in all: bodies fetched, then sorted. Bulk mail is
//            sorted from its headers alone (analyzeEmails.ts).
//
// Progress is kept in profiles.first_read for the window. Every step can be
// cut off and carries on where it was after a restart: the engine starts the
// first read again until it is done.

import { db } from "./db.ts";
import { modelConfigured } from "./llm.ts";
import { analyzeWritingStyle, factsFromSent } from "./ai.ts";
import { fetchHeaderRows, fetchMessages, fetchSentEmails, listMessageIds } from "./gmail.ts";
import { analyzeInbox, notStored, sentHeaderRow, storeInbox, storeSent, syncMail, type Account } from "./sync.ts";
import { indexMail, isBulk, ownAddresses, rebuildSenders, writtenTo } from "./senders.ts";
import { setPref } from "./profile.ts";
import { buildBriefingForUser } from "./buildBriefing.ts";

const HEADER_DAYS = 90;
const HEADER_CAP = 5000;
const DEEP_DAYS = 30;
const DEEP_CAP = 300;
const SENT_CAP = 200;
const DAY = 86_400_000;

export type FirstRead = {
  step: "headers" | "sent" | "deep" | "done";
  headers: number; // messages whose headers are indexed
  headers_total: number;
  senders: number;
  sent: number; // sent emails read for style and facts
  facts: number; // facts about the user written from them
  deep: number; // inbox mail of the last 30 days sorted
  deep_total: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

const FRESH: FirstRead = { step: "headers", headers: 0, headers_total: 0, senders: 0, sent: 0, facts: 0, deep: 0, deep_total: 0, started_at: null, finished_at: null, error: null };

export async function firstReadState(userId: string): Promise<FirstRead> {
  const { data } = await db.from("profiles").select("first_read").eq("id", userId).maybeSingle();
  return { ...FRESH, ...((data?.first_read as Partial<FirstRead> | null) ?? {}) };
}

let running: Promise<void> | null = null;
let failures = 0;

// Start the first read, or join the one already running. `plan` runs after
// each batch of mail is sorted (the engine's planNew), so todos and drafts
// appear as the read goes. After a failure (Google busy, the Mac offline) it
// tries again on its own, a minute later, then less and less often.
export function startFirstRead(userId: string, plan: () => unknown): Promise<void> {
  running ??= firstRead(userId, plan)
    .then(() => {
      failures = 0;
    })
    .catch(async (e) => {
      console.error("[first read]", e);
      await save(userId, { error: (e as Error).message });
      const wait = Math.min(30, 2 ** failures++) * 60_000;
      setTimeout(() => void startFirstRead(userId, plan), wait).unref();
    })
    .finally(() => {
      running = null;
    });
  return running;
}

async function save(userId: string, patch: Partial<FirstRead>): Promise<FirstRead> {
  const state = { ...(await firstReadState(userId)), ...patch };
  await db.from("profiles").update({ first_read: state }).eq("id", userId);
  return state;
}

async function firstRead(userId: string, plan: () => unknown): Promise<void> {
  let state = await firstReadState(userId);
  if (state.step === "done") return;
  const { data } = await db.from("gmail_accounts").select("*").eq("user_id", userId).eq("is_active", true);
  const accounts = (data ?? []) as unknown as Account[];
  if (!accounts.length) return;
  state = await save(userId, { started_at: state.started_at ?? new Date().toISOString(), error: null });

  // The newest mail first, so the inbox is never empty while the rest is read.
  const { count } = await db.from("emails").select("id", { count: "exact", head: true }).eq("user_id", userId).not("label_ids", "cs", '{"SENT"}');
  if (!count) await syncMail(userId, true);

  if (state.step === "headers") {
    await Promise.all([indexHeaders(userId, accounts), readNewest(userId, plan)]);
    state = await save(userId, { step: "sent", senders: await rebuildSenders(userId) });
  }
  if (!modelConfigured()) return;

  if (state.step === "sent") {
    const read = await learnFromSent(userId, accounts[0], { facts: true });
    state = await save(userId, { step: "deep", sent: read.sent, facts: read.facts });
  }

  if (state.step === "deep") {
    for (const account of accounts) await fetchDeep(userId, account);
    await sortDeep(userId, plan);
    await save(userId, { step: "done", finished_at: new Date().toISOString() });
  }
}

// ── Headers ─────────────────────────────────────────────────────────────────

async function indexHeaders(userId: string, accounts: Account[]): Promise<void> {
  const own = await ownAddresses(userId);
  const todo: { account: Account; ids: string[] }[] = [];
  let total = 0;
  let done = 0;
  for (const account of accounts) {
    const ids = await listMessageIds(account.token_ref, `newer_than:${HEADER_DAYS}d -in:chats -in:drafts`, HEADER_CAP);
    const have = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await db.from("mail_index").select("gmail_id").eq("user_id", userId).in("gmail_id", ids.slice(i, i + 500));
      for (const r of data ?? []) have.add(r.gmail_id as string);
    }
    total += ids.length;
    done += have.size;
    todo.push({ account, ids: ids.filter((id) => !have.has(id)) });
  }
  await save(userId, { headers: done, headers_total: total });
  for (const { account, ids } of todo) {
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await fetchHeaderRows(account.token_ref, ids.slice(i, i + 200));
      await indexMail(userId, account.id, rows, own);
      done += Math.min(200, ids.length - i);
      await save(userId, { headers: done });
    }
  }
}

// Sort what is already stored, plan it, and write the first briefing.
async function readNewest(userId: string, plan: () => unknown): Promise<void> {
  if (!modelConfigured()) return;
  await analyzeInbox(userId);
  await plan();
  const { data: p } = await db.from("profiles").select("last_briefing").eq("id", userId).maybeSingle();
  if (p?.last_briefing) return;
  try {
    const briefing = await buildBriefingForUser(userId, db, "all_recent");
    await db.from("profiles").update({ last_briefing: briefing, last_briefing_at: new Date().toISOString() }).eq("id", userId);
  } catch (e) {
    console.error("[first read] briefing:", e);
  }
}

// ── Sent mail ───────────────────────────────────────────────────────────────

// The user's own words in a sent email: the quoted reply and forwarded mail cut off.
function ownWords(body: string): string {
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

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

// Read the last 200 sent emails: keep them, learn the writing style from all
// of them, and with `facts` write the first facts about the user.
export async function learnFromSent(userId: string, account: Account, opts: { facts: boolean }): Promise<{ sent: number; facts: number }> {
  const sent = await fetchSentEmails(account.token_ref, SENT_CAP);
  await storeSent(userId, account, sent);
  await indexMail(userId, account.id, sent.map((e) => sentHeaderRow(e, account)), await ownAddresses(userId));
  const mine = sent.map((e) => ({ ...e, own: ownWords(e.body || e.snippet || "") })).filter((e) => e.own);
  if (mine.length < 3) return { sent: sent.length, facts: 0 };

  // Style: how each email opens and closes, and how long it is.
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const style = await analyzeWritingStyle(
    mine
      .map((e) => {
        const l = lines(e.own);
        return `${words(e.own)} words | opens: ${JSON.stringify(clip(l[0] ?? "", 60))} | ends: ${JSON.stringify(clip(l.slice(-2).join("\n"), 70))}`;
      })
      .join("\n"),
  );
  const median = mine.map((e) => words(e.own)).sort((a, b) => a - b)[Math.floor(mine.length / 2)];
  await db.from("style_profiles").upsert(
    {
      user_id: userId,
      greeting_style: style.greeting_style,
      closing_style: style.closing_style,
      tone: style.tone,
      avg_length: median < 60 ? "short" : median < 150 ? "medium" : "long",
      sample_count: sent.length,
      last_learned_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (!opts.facts) return { sent: sent.length, facts: 0 };

  // Facts: the newest emails in full, every subject, and who they write to most.
  await rebuildSenders(userId);
  const { data: top } = await db.from("senders").select("address, name, sent_to, received").eq("user_id", userId).gt("sent_to", 0).order("sent_to", { ascending: false }).limit(15);
  const sample = [
    "Written to most (address, name, emails sent):",
    ...(top ?? []).map((s) => `${s.address}, ${s.name ?? ""}, ${s.sent_to}`),
    "",
    "Subjects of the last sent emails:",
    ...mine.map((e) => clip(e.subject || "(no subject)", 70)),
    "",
    "The newest sent emails:",
    ...mine.slice(0, 20).map((e) => `To: ${clip(e.to, 80)}\nSubject: ${e.subject}\n${clip(e.own, 500)}\n---`),
  ].join("\n");
  const facts = await factsFromSent(sample);
  for (const f of facts) await setPref(userId, "fact", "", f, "learned", "From your sent mail");
  return { sent: sent.length, facts: facts.length };
}

// ── The last 30 days ────────────────────────────────────────────────────────

// Fetch the bodies of the inbox mail from the last 30 days that is not stored
// yet: people before bulk, newest first, up to 300 stored in all.
async function fetchDeep(userId: string, account: Account): Promise<void> {
  const since = new Date(Date.now() - DEEP_DAYS * DAY).toISOString();
  const { data } = await db
    .from("mail_index")
    .select("gmail_id, from_addr, from_name, category, list_unsubscribe, list_id, precedence")
    .eq("user_id", userId)
    .eq("gmail_account_id", account.id)
    .eq("inbox", true)
    .eq("sent", false)
    .gte("at", since)
    .order("at", { ascending: false })
    .limit(5000);
  const rows = data ?? [];
  const missing = new Set(await notStored(userId, rows.map((r) => r.gmail_id as string)));
  const room = Math.max(0, DEEP_CAP - (rows.length - missing.size));
  const written = await writtenTo(userId);
  const bulk = (r: Record<string, unknown>) =>
    isBulk(
      {
        sender_email: r.from_addr as string,
        sender: r.from_name as string,
        label_ids: r.category === "promotions" ? ["CATEGORY_PROMOTIONS"] : [],
        has_list_unsubscribe: r.list_unsubscribe as boolean,
        list_id: r.list_id as string,
        precedence_header: r.precedence as string,
      },
      written,
    );
  const want = rows.filter((r) => missing.has(r.gmail_id as string));
  const ordered = [...want.filter((r) => !bulk(r)), ...want.filter(bulk)].slice(0, room).map((r) => r.gmail_id as string);
  for (let i = 0; i < ordered.length; i += 50) {
    await storeInbox(userId, account, await fetchMessages(account.token_ref, ordered.slice(i, i + 50)));
  }
}

// Sort everything stored that is not sorted yet, a batch at a time, newest
// first, keeping the count of the last 30 days up to date.
async function sortDeep(userId: string, plan: () => unknown): Promise<void> {
  const since = new Date(Date.now() - DEEP_DAYS * DAY).toISOString();
  const progress = async () => {
    const { data: recent } = await db.from("emails").select("id").eq("user_id", userId).not("label_ids", "cs", '{"SENT"}').gte("received_at", since).limit(5000);
    const ids = (recent ?? []).map((e) => e.id as string);
    let sorted = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const { count } = await db.from("email_processed").select("id", { count: "exact", head: true }).in("email_id", ids.slice(i, i + 500));
      sorted += count ?? 0;
    }
    await save(userId, { deep: sorted, deep_total: ids.length });
  };
  await progress();
  while (modelConfigured()) {
    const { analyzed } = await analyzeInbox(userId);
    await progress();
    await plan();
    if (!analyzed) break;
  }
}
