// A draft the user saves in compose is kept in draft_emails and in the
// mailbox's own Drafts, From the address chosen, so it is in the mailbox too.
// When it is sent from Tabellar it goes out from Drafts, which takes it out
// of Drafts (outbox.ts). Discarding it takes that exact draft out of the
// mailbox's Drafts too: discardDrafts is the only caller of a provider's
// discardDraft, always with the id saveUserDraft stored for that row.
//
// Tabellar's own reply drafts stay in draft_emails only.

import { db } from "./db.ts";
import { mail } from "./providers.ts";
import { accountById, defaultAccount, fromLine } from "./accounts.ts";
import { messageIdOf, withForward, type Forward } from "./forward.ts";

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
