// The first read of a new mailbox: wide and cheap, then deep where it matters.
//
//   headers  The headers of the last 90 days of mail, inbox and sent, at most
//            5,000, into mail_index, and from them the senders table, with no
//            model call. The newest inbox mail, fetched first so the window
//            has something to show, is read by the model meanwhile.
//   sent     The last 200 sent emails: kept for Follow-ups, the writing style
//            learned from all of them, and one careful-model call that writes
//            the first facts about the user; then one more that suggests
//            labels from the senders and subjects (labels.ts). The sent mail
//            is read as soon as there is a model, beside the headers, so
//            About you fills in early; labels are suggested once there are
//            a few hundred headers.
//   deep     Inbox mail from the last 30 days, real people before bulk, newest
//            first, 300 in all: bodies fetched, then sorted. Bulk mail is
//            sorted from its headers alone (analyzeEmails.ts).
//
// Progress is kept in profiles.first_read for the window. Every step can be
// cut off and carries on where it was after a restart: the engine starts the
// first read again until it is done.
//
// An account connected after that gets the same read of its own mailbox
// (readAccount): headers, its sent mail, the last 30 days. The style and the
// facts stay those learned from the first. accounts.read_at marks it done.

import { db } from "./db.ts";
import { modelConfigured } from "./llm.ts";
import { analyzeWritingStyle, factsFromSent } from "./ai.ts";
import { mail } from "./providers.ts";
import { notStored, readBacklog, sentHeaderRow, storeInbox, storeSent, syncMail, type Account } from "./sync.ts";
import { indexMail, isBulk, ownAddresses, rebuildSenders, writtenTo } from "./senders.ts";
import { ROLE, WORK, setPref } from "./profile.ts";
import { suggestLabels } from "./labels.ts";
import { judgeSent } from "./followups.ts";

const HEADER_DAYS = 90;
const HEADER_CAP = 5000;
const DEEP_DAYS = 30;
const DEEP_CAP = 300;
const SENT_CAP = 200;
const LABELS_FROM = 300;
const DAY = 86_400_000;

export type FirstRead = {
  step: "headers" | "sent" | "deep" | "done";
  headers: number; // messages whose headers are indexed
  headers_total: number;
  senders: number;
  sent: number; // sent emails read for style and facts
  facts: number; // facts about the user written from them
  learned: boolean; // the sent mail has been read for style and facts
  deep: number; // inbox mail of the last 30 days sorted
  deep_total: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

const FRESH: FirstRead = { step: "headers", headers: 0, headers_total: 0, senders: 0, sent: 0, facts: 0, learned: false, deep: 0, deep_total: 0, started_at: null, finished_at: null, error: null };

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
  if (modelConfigured()) void learnOnce(userId).catch((e) => console.error("[first read] sent mail:", (e as Error).message));
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

// One change at a time: the headers and the sent mail are read side by side.
let saving: Promise<unknown> = Promise.resolve();
function save(userId: string, patch: Partial<FirstRead>): Promise<FirstRead> {
  const next = saving.then(async () => {
    const state = { ...(await firstReadState(userId)), ...patch };
    await db.from("profiles").update({ first_read: state }).eq("id", userId);
    return state;
  });
  saving = next.catch(() => {});
  return next;
}

// The sent mail being fetched; indexing the headers waits for it.
let sentFetch: Promise<unknown> = Promise.resolve();

// The style and the facts from the first mailbox's sent mail, once.
let learning: Promise<void> | null = null;
function learnOnce(userId: string): Promise<void> {
  learning ??= (async () => {
    const state = await firstReadState(userId);
    if (state.learned || state.step === "deep" || state.step === "done") return;
    const { data } = await db.from("accounts").select("*").eq("user_id", userId).eq("paused", false).order("created_at", { ascending: true }).limit(1);
    const account = (data ?? [])[0] as unknown as Account | undefined;
    if (!account) return;
    const read = await learnFromSent(userId, account, { facts: true });
    await save(userId, { sent: read.sent, facts: read.facts, learned: true });
    // Enough senders to suggest labels from already: the headers come newest first.
    if ((await firstReadState(userId)).headers >= LABELS_FROM) await suggestLabels(userId).catch((e) => console.error("[first read] labels:", e));
    // Which of it waits on an answer, for Follow-ups.
    await judgeSent(userId).catch((e) => console.error("[first read] follow-ups:", (e as Error).message));
  })().finally(() => {
    learning = null;
  });
  return learning;
}

async function firstRead(userId: string, plan: () => unknown): Promise<void> {
  let state = await firstReadState(userId);
  const { data } = await db.from("accounts").select("*").eq("user_id", userId).eq("paused", false);
  const accounts = (data ?? []) as unknown as Account[];
  if (!accounts.length) return;
  if (state.step === "done") {
    for (const account of accounts.filter((a) => !a.read_at)) {
      // Connected before the first read finished: that read covered it.
      if (state.finished_at && account.created_at <= state.finished_at) {
        await db.from("accounts").update({ read_at: state.finished_at }).eq("id", account.id);
      } else if (modelConfigured()) await readAccount(userId, account, plan);
    }
    return;
  }
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
    await learnOnce(userId);
    // Labels to offer, from who writes and about what.
    const { data: me } = await db.from("profiles").select("label_suggestions").eq("id", userId).maybeSingle();
    if (!Array.isArray(me?.label_suggestions)) await suggestLabels(userId).catch((e) => console.error("[first read] labels:", e));
    state = await save(userId, { step: "deep", learned: true });
  }

  if (state.step === "deep") {
    for (const account of accounts) await fetchDeep(userId, account);
    await sortDeep(userId, plan);
    const at = new Date().toISOString();
    await db.from("accounts").update({ read_at: at }).in("id", accounts.map((a) => a.id));
    await save(userId, { step: "done", finished_at: at });
  }
}

// The first read of one more account.
async function readAccount(userId: string, account: Account, plan: () => unknown): Promise<void> {
  await indexHeaders(userId, [account], false);
  const sent = await mail(account).sent(account, SENT_CAP);
  await storeSent(userId, account, sent);
  await indexMail(userId, account.id, sent.map((e) => sentHeaderRow(e, account)), await ownAddresses(userId));
  await rebuildSenders(userId);
  await fetchDeep(userId, account);
  await readBacklog(userId, plan);
  await db.from("accounts").update({ read_at: new Date().toISOString() }).eq("id", account.id);
}

// ── Headers ─────────────────────────────────────────────────────────────────

async function indexHeaders(userId: string, accounts: Account[], progress = true): Promise<void> {
  const own = await ownAddresses(userId);
  const todo: { account: Account; ids: string[] }[] = [];
  let total = 0;
  let done = 0;
  for (const account of accounts) {
    const ids = await mail(account).list(account, { days: HEADER_DAYS, cap: HEADER_CAP, inbox: false });
    const have = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await db.from("mail_index").select("gmail_id").eq("user_id", userId).in("gmail_id", ids.slice(i, i + 500));
      for (const r of data ?? []) have.add(r.gmail_id as string);
    }
    total += ids.length;
    done += have.size;
    todo.push({ account, ids: ids.filter((id) => !have.has(id)) });
  }
  if (progress) await save(userId, { headers: done, headers_total: total });
  for (const { account, ids } of todo) {
    for (let i = 0; i < ids.length; i += 50) {
      // Both draw on the same quota; the sent mail goes first, since About
      // you waits for it.
      await sentFetch.catch(() => {});
      const rows = await mail(account).headerRows(account, ids.slice(i, i + 50));
      await indexMail(userId, account.id, rows, own);
      done += Math.min(50, ids.length - i);
      if (progress) await save(userId, { headers: done });
    }
  }
}

// Sort what is already stored and plan it.
async function readNewest(userId: string, plan: () => unknown): Promise<void> {
  if (!modelConfigured()) return;
  await readBacklog(userId, plan);
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
  const fetching = mail(account).sent(account, SENT_CAP);
  sentFetch = fetching;
  const sent = await fetching;
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
  const read = await factsFromSent(sample);
  const facts = [read.role && `${ROLE}${read.role}`, read.work && `${WORK}${read.work}`, ...read.facts].filter((f): f is string => !!f);
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
    .eq("account_id", account.id)
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
    await storeInbox(userId, account, await mail(account).fetch(account, ordered.slice(i, i + 50)));
  }
}

// Sort everything stored that is not sorted yet, a batch at a time, newest
// first, keeping the count of the last 30 days up to date. Each batch is
// planned while the next is sorted.
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
  if (modelConfigured()) await readBacklog(userId, plan, progress);
}
