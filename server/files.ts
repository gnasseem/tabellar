// Files: attachments found by asking the mailboxes, for what is older than
// the mail Tabellar keeps. The Files page lists the kept mail's own
// attachments from the database; this adds the rest of a search.

import { db } from "./db.ts";
import { listAccounts } from "./accounts.ts";
import { mail, type AttachmentInfo } from "./providers.ts";

const PER_ACCOUNT = 25;

export type FoundFile = { key: string; gmail_id: string; account_id: string; subject: string; sender: string; sender_email: string; recipients: string; received_at: string; sent: boolean; attachments: AttachmentInfo[] };

export async function filesInMailboxes(userId: string, text: string, from: string): Promise<FoundFile[]> {
  if (!text.trim() && !from.trim()) return [];
  const out: FoundFile[] = [];
  for (const a of await listAccounts(userId)) {
    const box = mail(a);
    if (a.paused || !box.files) continue;
    try {
      const ids = await box.files(a, { text: text.trim(), from: from.trim() }, PER_ACCOUNT);
      const { data: kept } = ids.length ? await db.from("emails").select("gmail_id").eq("user_id", userId).in("gmail_id", ids) : { data: [] };
      const have = new Set((kept ?? []).map((e) => String(e.gmail_id)));
      for (const e of await box.fetch(a, ids.filter((id) => !have.has(id)))) {
        if (e.attachments.length) out.push({ key: e.gmail_id, gmail_id: e.gmail_id, account_id: a.id, subject: e.subject, sender: e.sender, sender_email: e.sender_email, recipients: e.recipients, received_at: e.received_at, sent: e.label_ids.includes("SENT"), attachments: e.attachments });
      }
    } catch (err) {
      console.error(`[files] searching ${a.address}:`, (err as Error).message);
    }
  }
  return out.sort((x, y) => y.received_at.localeCompare(x.received_at));
}
