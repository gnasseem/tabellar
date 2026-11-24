// Read receipts. An email sent with one asked for carries a
// Disposition-Notification-To header (Outlook has its own flag for it); the
// recipient's mail program may answer with a small report, or not at all.
//
// A report that comes back is kept as mail like any other, sorted without the
// model, and marks the sent email as seen. An email the user asked a receipt
// for always counts as waiting on an answer, so Follow-ups lists it two days
// on, with when it was seen. A report is not an answer and wakes nothing.

import { db } from "./db.ts";
import { mail, type Receipt } from "./providers.ts";
import type { Account } from "./accounts.ts";
import { parseHeaders } from "./mime.ts";

const WINDOW_MS = 90 * 86_400_000;
const bare = (id: string | null | undefined) => String(id ?? "").match(/<([^>]+)>/)?.[1] ?? String(id ?? "").trim();

// Is this message a read receipt, from its headers (lower-case names)?
export function isReceipt(headers: Record<string, string>): boolean {
  return /^multipart\/report\b/i.test(headers["content-type"] ?? "") && /report-type="?disposition-notification/i.test(headers["content-type"] ?? "");
}

// What a receipt says: the sent message it is about and who read it. `report`
// is its message/disposition-notification part; without one, its own headers
// say it. Null when the report says the message was not read.
export function receiptOf(headers: Record<string, string>, report: string): Receipt | null {
  const r = parseHeaders(report);
  if (r.disposition && !/displayed/i.test(r.disposition)) return null;
  const who = (r["final-recipient"] ?? r["original-recipient"] ?? headers.from ?? "").match(/[^\s<>;"]+@[^\s<>;"]+/)?.[0] ?? "";
  return { message_id: bare(r["original-message-id"] ?? headers["in-reply-to"] ?? ""), reader: who.toLowerCase() };
}

// Mark the sent email a receipt is about. The mailbox says which of the
// emails that asked for one has that Message-ID; a receipt that names none
// counts for the only one sent to that reader.
export async function markSeen(userId: string, account: Account, r: Receipt, at: string): Promise<void> {
  const { data } = await db
    .from("emails")
    .select("id, gmail_id, recipients")
    .eq("user_id", userId)
    .eq("account_id", account.id)
    .eq("receipt_asked", true)
    .is("seen_at", null)
    .gte("received_at", new Date(Date.now() - WINDOW_MS).toISOString())
    .order("received_at", { ascending: false })
    .limit(50);
  const asked = data ?? [];
  let hit: Record<string, unknown> | undefined;
  for (const e of r.message_id ? asked : []) {
    const id = bare(String(e.gmail_id)) === r.message_id ? r.message_id : bare((await mail(account).headers(account, String(e.gmail_id), ["Message-ID"]).catch(() => ({}) as Record<string, string>))["message-id"]);
    if (id === r.message_id) {
      hit = e;
      break;
    }
  }
  const theirs = asked.filter((e) => r.reader && String(e.recipients ?? "").toLowerCase().includes(r.reader));
  if (!hit && !r.message_id && theirs.length === 1) hit = theirs[0];
  if (hit) await db.from("emails").update({ seen_at: at }).eq("id", hit.id);
}
