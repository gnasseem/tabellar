// A draft the user saves in compose is kept in draft_emails and in the
// mailbox's own Drafts, From the address chosen, so it is in the mailbox too.
// When it is sent from Tabellar it goes out from Drafts, which takes it out
// of Drafts (outbox.ts). Tabellar never deletes a draft in the mailbox: one
// discarded here stays there.
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
    return { id, inGmail: true };
  } catch (e) {
    console.error("[drafts] mailbox draft:", (e as Error).message);
    return { id, inGmail: false };
  }
}
