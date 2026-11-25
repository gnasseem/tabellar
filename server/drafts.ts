// Drafts, here (draft_emails) and in the mailbox's own Drafts.
//
// One the user saves in compose goes to both, From the address chosen. So does
// a reply Tabellar writes, in its thread, unless the user turned that off
// (profiles.mailbox_drafts): it is then there on a phone too. A thread has one
// such draft: a newer reply takes the place of the last one, and where the
// user has a draft of their own in the thread nothing is added.
//
// syncDrafts reads what happened to them in the mailbox. A change made there
// is picked up and the draft is the user's from then on (edited_at): Tabellar
// neither rewrites nor withdraws it. One gone from there (sent, discarded) goes
// here too.
//
// When a draft is sent from Tabellar it goes out from Drafts, which takes it
// out of Drafts (outbox.ts). Discarding it takes that exact draft out of the
// mailbox's Drafts too: outOfDrafts is the only caller of a provider's
// discardDraft, always with the id kept for that row.

import { db } from "./db.ts";
import { mail, type DraftStub } from "./providers.ts";
import { accountById, addressesOf, defaultAccount, defaultFrom, fromLine, listAccounts, replyFrom, type Account } from "./accounts.ts";
import { messageIdOf, withForward, type Forward } from "./forward.ts";
import { choicesOf, choose, sharedText } from "./choices.ts";
import { escapeHtml, htmlToText } from "./mime.ts";
import { decide, GAP } from "./policy.ts";
import { BY_PLAN, MOVED_ON, PASSED } from "./profile.ts";
import { addressesIn } from "./senders.ts";
import { serial } from "./sync.ts";
import { displayNameOf, learnFromEdit, ownWords } from "./writing.ts";

export type DraftInput = {
  id?: string;
  account_id?: string;
  from_address?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body_html?: string;
  email_id?: string | null;
  in_reply_to?: string;
  thread_id?: string;
  forward?: Forward | null;
  read_receipt?: boolean;
};

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);

// Save the draft here and in the mailbox. Returns the row id, and whether
// the mailbox has it (a failure there keeps the draft in Tabellar).
export async function saveUserDraft(userId: string, d: DraftInput): Promise<{ id: string; inGmail: boolean }> {
  const account = (await accountById(userId, d.account_id)) ?? (await defaultAccount(userId));
  if (!account) throw Object.assign(new Error("No account connected"), { status: 400 });
  const from = await fromLine(userId, account, d.from_address);
  const { data: before } = d.id
    ? await db.from("draft_emails").select("gmail_draft_id, account_id").eq("id", d.id).eq("user_id", userId).maybeSingle()
    : { data: null };
  const row = {
    ...(d.id ? { id: d.id } : {}),
    user_id: userId,
    account_id: account.id,
    from_address: d.from_address?.toLowerCase() || null,
    to_addresses: list(d.to),
    cc_addresses: list(d.cc),
    bcc_addresses: list(d.bcc),
    subject: d.subject ?? "",
    body_html: d.body_html ?? "",
    email_id: d.email_id ?? null,
    forward: d.forward ?? null,
    read_receipt: d.read_receipt === true,
    edited_at: new Date().toISOString(),
    mailbox_version: null,
  };
  const { data, error } = await db.from("draft_emails").upsert(row, { onConflict: "id" }).select("id").single();
  if (error) throw new Error(error.message);
  const id = data.id as string;
  // The same draft is updated while it stays in the same mailbox.
  const gmailId = before?.account_id === account.id ? ((before?.gmail_draft_id as string | null) ?? null) : null;
  try {
    const saved = await mail(account).saveDraft(
      account,
      gmailId,
      await withForward(
        userId,
        { from, to: row.to_addresses, cc: list(d.cc), bcc: list(d.bcc), subject: row.subject, html: row.body_html, inReplyTo: await messageIdOf(account, d.in_reply_to), receipt: row.read_receipt },
        row.forward,
      ),
      d.thread_id,
    );
    await db.from("draft_emails").update({ gmail_draft_id: saved }).eq("id", id);
    // Saved from another account now: it is not left in the first one's Drafts.
    if (before?.gmail_draft_id && before.account_id !== account.id) {
      await outOfDrafts(userId, { account_id: before.account_id as string | null, gmail_draft_id: before.gmail_draft_id as string }).catch((e) => console.error("[drafts] old account's draft:", (e as Error).message));
    }
    return { id, inGmail: true };
  } catch (e) {
    console.error("[drafts] mailbox draft:", (e as Error).message);
    return { id, inGmail: false };
  }
}

// Take the draft a row was saved as out of its mailbox's Drafts.
async function outOfDrafts(userId: string, row: { account_id: string | null; gmail_draft_id: string | null }): Promise<void> {
  if (!row.gmail_draft_id) return;
  const account = await accountById(userId, row.account_id);
  if (account) await mail(account).discardDraft(account, row.gmail_draft_id);
}

// Discard drafts: here, and in the mailbox's Drafts where Tabellar saved
// them. One the mailbox could not be asked about stays here, so it is not
// left behind there unseen. Returns the ids discarded.
export async function discardDrafts(userId: string, ids: string[]): Promise<string[]> {
  const { data } = await db.from("draft_emails").select("id, account_id, gmail_draft_id").eq("user_id", userId).in("id", ids);
  const done: string[] = [];
  let failed: Error | null = null;
  for (const row of (data ?? []) as { id: string; account_id: string | null; gmail_draft_id: string | null }[]) {
    try {
      await outOfDrafts(userId, row);
      await db.from("draft_emails").delete().eq("id", row.id);
      done.push(row.id);
    } catch (e) {
      failed = e as Error;
      console.error("[drafts] discarding:", failed.message);
    }
  }
  if (failed && !done.length) throw Object.assign(new Error("The mailbox could not be reached, so the draft is kept in both places."), { status: 502 });
  return done;
}

// ── Tabellar's replies in the mailbox ───────────────────────────────────────

type Row = {
  id: string; user_id: string; account_id: string | null; from_address: string | null; to_addresses: string[] | null; cc_addresses: string[] | null; bcc_addresses: string[] | null;
  subject: string | null; body_html: string | null; email_id: string | null; source: string | null; gmail_draft_id: string | null; mailbox_version: string | null; edited_at: string | null; created_at: string;
  emails?: { gmail_id: string; thread_id: string | null; account_id: string | null } | null;
};
const FIELDS = "*, emails(gmail_id, thread_id, account_id)";

export function textToHtml(text: string): string {
  return escapeHtml(text).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

const said = (s: string) => ownWords(s).replace(/\s+/g, " ").trim();

// Tabellar's drafts in the thread of an email, newest first.
export async function threadDrafts(userId: string, emailId: string | null): Promise<Row[]> {
  if (!emailId) return [];
  const { data: e } = await db.from("emails").select("thread_id").eq("id", emailId).maybeSingle();
  const { data: ids } = e?.thread_id ? await db.from("emails").select("id").eq("user_id", userId).eq("thread_id", e.thread_id) : { data: [{ id: emailId }] };
  const { data } = await db.from("draft_emails").select(FIELDS).eq("user_id", userId).in("email_id", (ids ?? []).map((x) => String(x.id))).order("created_at", { ascending: false });
  return (data ?? []) as unknown as Row[];
}

// Pause holds the mailbox still, whatever the level.
async function mayTouch(userId: string): Promise<{ touch: boolean; put: boolean }> {
  const { data: p } = await db.from("profiles").select("engine_paused, mailbox_drafts").eq("id", userId).maybeSingle();
  const touch = !!p && decide({ kind: "draft", source: "user", level: "assist", paused: !!p.engine_paused }).verdict === "do";
  return { touch, put: touch && p?.mailbox_drafts !== false };
}

// Put a reply Tabellar wrote into its mailbox's Drafts, in its thread, or
// bring the one already there up to date. A change the user made there since
// is picked up instead.
export const putInDrafts = serial(async (userId: string, id: string): Promise<boolean> => {
  if (!(await mayTouch(userId)).put) return false;
  const { data } = await db.from("draft_emails").select(FIELDS).eq("id", id).eq("user_id", userId).maybeSingle();
  const row = data as unknown as Row | null;
  if (!row?.emails || row.source !== "tabellar" || row.edited_at) return false;
  const account = await accountById(userId, row.emails.account_id);
  if (!account?.token_ref || account.paused || (row.account_id && row.account_id !== account.id)) return false;
  const threadId = row.emails.thread_id ?? undefined;
  const there = await mail(account).drafts(account);
  const own = there.find((d) => d.id === row.gmail_draft_id);
  // A draft of the user's own in the thread is the one that counts. One that
  // says the same was saved by an answer that came too late.
  const other = own || !threadId ? undefined : there.find((d) => d.threadId === threadId);
  if (other) {
    const text = (await mail(account).readDraft(account, other.id))?.text ?? "";
    if (said(text) !== said(htmlToText(row.body_html ?? ""))) return false;
    await db.from("draft_emails").update({ gmail_draft_id: other.id, mailbox_version: other.version, account_id: account.id }).eq("id", id);
    return true;
  }
  if (own && row.mailbox_version && own.version !== row.mailbox_version && (await pickUp(row, account, own))) return false;
  const saved = await mail(account).saveDraft(
    account,
    own ? own.id : null,
    {
      from: await fromLine(userId, account, row.from_address), to: list(row.to_addresses), cc: list(row.cc_addresses), bcc: list(row.bcc_addresses),
      subject: row.subject ?? "", html: row.body_html ?? "", inReplyTo: await messageIdOf(account, row.emails.gmail_id),
    },
    threadId,
  );
  const kept = await db.from("draft_emails").update({ gmail_draft_id: saved, mailbox_version: null, account_id: account.id }).eq("id", id).select("id");
  // Sent or discarded while it was being saved.
  if (!kept.data?.length) await outOfDrafts(userId, { account_id: account.id, gmail_draft_id: saved });
  return !!kept.data?.length;
});

// What the mailbox's draft says now, when that is not what is kept here.
// Returns whether the user changed it.
async function pickUp(row: Row, account: Account, stub: DraftStub): Promise<boolean> {
  const d = await mail(account).readDraft(account, stub.id);
  if (!d) return false;
  const same = said(d.text) === said(htmlToText(row.body_html ?? ""));
  if (same) {
    await db.from("draft_emails").update({ mailbox_version: stub.version, gmail_draft_id: stub.id }).eq("id", row.id);
    return false;
  }
  // A mail program quotes the email under the draft; that stays there.
  const quoted = /gmail_quote|<blockquote|divRplyFwdMsg|appendonsend/i.test(d.html) || !d.html;
  const to = addressesIn(d.to);
  await db
    .from("draft_emails")
    .update({
      body_html: quoted ? textToHtml(ownWords(d.text)) : d.html, subject: d.subject || row.subject, gmail_draft_id: stub.id, mailbox_version: stub.version, edited_at: new Date().toISOString(),
      ...(to.length ? { to_addresses: to, cc_addresses: addressesIn(d.cc), bcc_addresses: addressesIn(d.bcc) } : {}),
    })
    .eq("id", row.id);
  return true;
}

// ── Sending one ─────────────────────────────────────────────────────────────

// How long a send waits in the outbox, so a slip can be taken back.
export const UNDO_SEND_MS = 15_000;

// Why a draft cannot go out as it is, or null.
export function unsendable(to: string[] | null, text: string): string | null {
  if (!list(to).length) return "It has no recipient. Open it to add one.";
  if (choicesOf(text).length) return "Choose an answer first.";
  const gap = sharedText(text).match(GAP)?.[0];
  return gap ? `"${gap}" is still to be filled in. Open it to write it.` : null;
}

// Into the outbox, due after the undo window (or `at`). `html` is the text
// with an answer chosen. The draft goes with it, and comes back if it is undone.
export async function queueDraft(userId: string, id: string, opts: { html?: string; at?: string } = {}): Promise<{ id: string; to: string[] }> {
  const { data } = await db.from("draft_emails").select("*, emails(gmail_id, thread_id, account_id, recipients, cc_recipients)").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw Object.assign(new Error("That draft was already sent or discarded"), { status: 409 });
  const { emails: e, ...row } = data as Record<string, any>;
  const html = opts.html ?? String(row.body_html ?? "");
  const why = unsendable(row.to_addresses, htmlToText(html));
  if (why) throw Object.assign(new Error(why), { status: 409 });
  const account = (await accountById(userId, row.account_id ?? e?.account_id)) ?? (await defaultAccount(userId));
  if (!account) throw Object.assign(new Error("No mailbox is connected"), { status: 400 });
  const from = addressesOf(account).find((s) => s.address === row.from_address)?.address ?? (e ? replyFrom(account, e) : defaultFrom(account));
  const { data: queued, error } = await db
    .from("scheduled_emails")
    .insert({
      user_id: userId, account_id: account.id, from_address: from, to_addresses: row.to_addresses, cc_addresses: list(row.cc_addresses).length ? row.cc_addresses : null, bcc_addresses: list(row.bcc_addresses).length ? row.bcc_addresses : null,
      // A draft that is also in the mailbox's Drafts is sent from there.
      gmail_draft_id: row.account_id === account.id ? row.gmail_draft_id : null,
      subject: row.subject ?? "", body_html: html, in_reply_to: e?.gmail_id ?? null, thread_id: e?.thread_id ?? null,
      send_at: opts.at ?? new Date(Date.now() + UNDO_SEND_MS).toISOString(), email_id: row.email_id, forward: row.forward, read_receipt: !!row.read_receipt, draft: row,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  // Gone meanwhile (sent from another window, or the phone): it is not sent twice.
  const gone = await db.from("draft_emails").delete().eq("id", id).select("id");
  if (!gone.data?.length) {
    await db.from("scheduled_emails").delete().eq("id", queued.id);
    throw Object.assign(new Error("That draft was already sent or discarded"), { status: 409 });
  }
  return { id: queued.id as string, to: list(row.to_addresses) };
}

// Taken back before they went out: each is a draft again, as it was. Returns
// the ones that were stopped.
export async function unqueue(userId: string, ids: string[]): Promise<string[]> {
  const { data } = await db.from("scheduled_emails").update({ status: "cancelled", error_message: "Cancelled" }).eq("user_id", userId).in("id", ids).eq("status", "pending").select("id, draft");
  for (const r of data ?? []) if (r.draft) await db.from("draft_emails").insert(r.draft as Record<string, unknown>);
  return (data ?? []).map((r) => String(r.id));
}

// What became of the drafts Tabellar wrote in the last 30 days: how many the
// user decided on, and how many of those went out word for word.
const KEPT_MS = 30 * 24 * 3600_000;
export async function draftsKept(userId: string): Promise<{ first: string | null; decided: number; unchanged: number }> {
  const since = new Date(Date.now() - KEPT_MS).toISOString();
  const [{ data: log }, { data: signed }, { data: sentRows }, { data: here }, { data: going }] = await Promise.all([
    db.from("action_log").select("id, status, reason, detail, created_at, emails!inner(thread_id)").eq("user_id", userId).eq("kind", "draft").eq("source", "engine").in("status", ["done", "dismissed", "undone"]).gte("created_at", since).order("created_at", { ascending: true }),
    db.from("email_signatures").select("html").eq("user_id", userId),
    db.from("emails").select("thread_id, body_text, received_at").eq("user_id", userId).contains("label_ids", ["SENT"]).gte("received_at", since).order("received_at", { ascending: true }),
    db.from("draft_emails").select("id").eq("user_id", userId),
    db.from("scheduled_emails").select("thread_id").eq("user_id", userId).eq("status", "pending"),
  ]);
  const notTheUser = new Set([PASSED, MOVED_ON, BY_PLAN, "Your preference", "Read again"]);
  const words = (s: unknown) => said(htmlToText(String(s ?? "")));
  const endings = ["", ...(signed ?? []).map((s) => words(s.html))];
  const waiting = new Set((here ?? []).map((d) => String(d.id)));
  const leaving = new Set((going ?? []).map((g) => String(g.thread_id)));
  const all = ((log ?? []) as Record<string, any>[]).filter((r) => !r.detail?.forward && r.emails?.thread_id);
  let decided = 0;
  let unchanged = 0;
  for (const r of all) {
    const thread = r.emails.thread_id;
    const next = all.find((x) => x.emails.thread_id === thread && x.created_at > r.created_at);
    const sent = (sentRows ?? []).find((s) => s.thread_id === thread && String(s.received_at) > r.created_at && (!next || String(s.received_at) <= next.created_at));
    if (!sent) {
      // Not looked at yet, replaced by a newer one, or taken back by a rule or by time.
      if (next || notTheUser.has(String(r.reason)) || waiting.has(String(r.detail.draftId ?? "")) || leaving.has(thread)) continue;
      decided++;
      continue;
    }
    decided++;
    const open = choicesOf(String(r.detail.body ?? ""));
    const texts = open.reduce<(number | undefined)[][]>((sets, c) => sets.flatMap((set) => c.map((_, i) => [...set, i])), [[]]).map((set) => said(choose(String(r.detail.body ?? ""), set)));
    if (texts.some((t) => endings.some((end) => said(String(sent.body_text ?? "")) === `${t} ${end}`.trim()))) unchanged++;
  }
  return { first: all.length ? String(all[0].created_at) : null, decided, unchanged };
}

// What the user sent in place of a draft Tabellar wrote teaches how they write.
async function learnFromSent(userId: string, row: Row): Promise<void> {
  if (!row.emails?.thread_id) return;
  const [{ data: sent }, { data: log }] = await Promise.all([
    db.from("emails").select("body_text").eq("user_id", userId).eq("thread_id", row.emails.thread_id).contains("label_ids", ["SENT"]).gt("received_at", row.created_at).order("received_at", { ascending: true }).limit(1),
    db.from("action_log").select("detail").eq("user_id", userId).eq("kind", "draft").eq("email_id", row.email_id).order("created_at", { ascending: false }).limit(5),
  ]);
  const wrote = (log ?? []).map((r) => r.detail as { draftId?: string; body?: string }).find((d) => d.draftId === row.id)?.body;
  const to = list(row.to_addresses)[0];
  if (sent?.[0]?.body_text && wrote && to && !choicesOf(wrote).length) await learnFromEdit(userId, to, wrote, String(sent[0].body_text), await displayNameOf(userId));
}

// The user answered: drafts of Tabellar's they have not changed are of no use.
export async function withdrawAnswered(userId: string, rows: Row[]): Promise<void> {
  if (!(await mayTouch(userId)).touch) return;
  for (const row of rows) {
    await learnFromSent(userId, row).catch((e) => console.error("[drafts] learning:", (e as Error).message));
    await discardDrafts(userId, [row.id]).catch(() => {});
  }
}

// How the drafts kept here stand in their mailboxes, and the ones that are not
// there yet (the mailbox could not be reached, or they were made another way).
const PUT_FOR_MS = 24 * 3600_000;
export const syncDrafts = serial(async (userId: string): Promise<void> => {
  const { data } = await db.from("draft_emails").select(FIELDS).eq("user_id", userId).or("gmail_draft_id.not.is.null,source.eq.tabellar");
  const rows = (data ?? []) as unknown as Row[];
  if (!rows.length) return;
  for (const account of await listAccounts(userId)) {
    const here = rows.filter((r) => r.gmail_draft_id && r.account_id === account.id);
    if (!here.length || account.paused || !account.token_ref) continue;
    try {
      const there = await mail(account).drafts(account);
      const claimed = new Set(here.map((r) => r.gmail_draft_id));
      for (const row of here) {
        const thread = row.emails?.thread_id;
        // Some mail programs make a changed draft a new one.
        const stub = there.find((d) => d.id === row.gmail_draft_id) ?? (row.mailbox_version && thread ? there.find((d) => d.threadId === thread && !claimed.has(d.id)) : undefined);
        if (stub && stub.version !== row.mailbox_version) await pickUp(row, account, stub);
        else if (!stub && row.mailbox_version && row.source === "tabellar") {
          await learnFromSent(userId, row).catch((e) => console.error("[drafts] learning:", (e as Error).message));
          await db.from("draft_emails").delete().eq("id", row.id);
        }
      }
    } catch (e) {
      console.error(`[drafts] ${account.address}:`, (e as Error).message);
    }
  }
  const since = new Date(Date.now() - PUT_FOR_MS).toISOString();
  for (const row of rows) {
    if (row.source !== "tabellar" || row.gmail_draft_id || !row.email_id || row.edited_at || row.created_at < since) continue;
    await putInDrafts(userId, row.id).catch((e) => console.error("[drafts] not in the mailbox yet:", (e as Error).message));
  }
});
