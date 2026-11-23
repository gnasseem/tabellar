// Bringing mail in from Gmail and keeping the stored copies true to it,
// shared by the window's first fetch (/fetch-emails), the watcher and the
// background engine (engine.ts).
//
// Syncs and analyses each run one at a time: two overlapping syncs would race
// to insert the same messages, and two overlapping analyses would pay for the
// same model calls twice.

import { db } from "./db.ts";
import {
  readHistory,
  fetchEmails,
  fetchMessages,
  fetchSentEmails,
  listMessageIds,
  threadIdOf,
  fetchGoogleContacts,
  currentHistoryId,
  headerRowOf,
  htmlToText,
  type EmailData,
  type HeaderRow,
  type MailboxChanges,
} from "./gmail.ts";
import { analyzeEmailsForUser } from "./analyzeEmails.ts";
import { addressesIn, indexMail, ownAddresses, rebuildSenders } from "./senders.ts";

// Run fn after every earlier call on the same queue has finished.
export function serial<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const run = tail.then(() => fn(...args));
    tail = run.catch(() => {});
    return run;
  };
}

export type Account = { id: string; token_ref: string; gmail_address: string | null; history_id: string | null };
type Sent = Awaited<ReturnType<typeof fetchSentEmails>>[number];

const RECENT_DAYS = 30;
const RECENT_CAP = 300;

// Inbox mail from the last 30 days that is not stored yet, newest first, at
// most 300. What a sync falls back on when Gmail's change history has expired.
async function fetchRecent(userId: string, account: Account): Promise<EmailData[]> {
  const ids = await listMessageIds(account.token_ref, `in:inbox newer_than:${RECENT_DAYS}d`, RECENT_CAP);
  return fetchMessages(account.token_ref, await notStored(userId, ids));
}

// Of these Gmail ids, the ones not in emails yet.
export async function notStored(userId: string, gmailIds: string[]): Promise<string[]> {
  const have = new Set<string>();
  for (let i = 0; i < gmailIds.length; i += 500) {
    const { data } = await db.from("emails").select("gmail_id").eq("user_id", userId).in("gmail_id", gmailIds.slice(i, i + 500));
    for (const e of data ?? []) have.add(e.gmail_id as string);
  }
  return gmailIds.filter((id) => !have.has(id));
}

// Store fetched inbox mail (sent mail and mail already stored are skipped)
// and count it in email_memory. Returns the ids of the emails inserted.
export async function storeInbox(userId: string, account: Account, rawEmails: EmailData[]): Promise<string[]> {
  const own = (account.gmail_address ?? "").toLowerCase();
  const fresh = new Set(await notStored(userId, rawEmails.map((e) => e.gmail_id)));
  const emails = rawEmails.filter(
    (e) => fresh.has(e.gmail_id) && !e.label_ids.includes("SENT") && e.label_ids.includes("INBOX") && !(own && e.sender_email?.toLowerCase() === own),
  );
  if (!emails.length) return [];

  const inserted: string[] = [];
  for (let i = 0; i < emails.length; i += 100) {
    const rows = emails.slice(i, i + 100).map((e) => ({
      user_id: userId,
      gmail_id: e.gmail_id,
      thread_id: e.thread_id,
      gmail_account_id: account.id,
      subject: e.subject,
      sender: e.sender,
      sender_email: e.sender_email,
      recipients: e.recipients,
      snippet: e.snippet,
      body_text: e.body_text,
      body_html: e.body_html,
      received_at: e.received_at,
      is_read: e.is_read,
      label_ids: e.label_ids,
      has_attachments: e.has_attachments,
      attachments: e.attachments ?? [],
      has_list_unsubscribe: e.has_list_unsubscribe,
      is_reply: e.is_reply,
      reply_to_email: e.reply_to_email,
      cc_recipients: e.cc_recipients,
      precedence_header: e.precedence_header,
      list_id: e.list_id ?? null,
      is_calendar: e.is_calendar,
      calendar_event: e.calendar_event,
    }));
    const { data } = await db.from("emails").insert(rows).select("id");
    inserted.push(...((data ?? []) as { id: string }[]).map((e) => e.id));
  }

  // How often each sender wrote, for the briefing and the assistant.
  const senderMap = new Map<string, { sender: string; subject: string; count: number }>();
  for (const e of emails) {
    if (!e.sender_email) continue;
    const prev = senderMap.get(e.sender_email);
    if (prev) {
      prev.count++;
      prev.subject = e.subject;
    } else {
      senderMap.set(e.sender_email, { sender: e.sender, subject: e.subject, count: 1 });
    }
  }
  try {
    const { data: existingMemory } = await db
      .from("email_memory")
      .select("sender_email, interaction_count")
      .eq("user_id", userId)
      .in("sender_email", [...senderMap.keys()]);
    const memMap = new Map((existingMemory || []).map((m) => [m.sender_email as string, m.interaction_count as number]));
    const now = new Date().toISOString();
    await db.from("email_memory").upsert(
      [...senderMap.entries()].map(([email, info]) => ({
        user_id: userId,
        sender_email: email,
        sender_name: info.sender,
        last_subject: info.subject,
        last_interaction_at: now,
        interaction_count: Number(memMap.get(email) ?? 0) + info.count,
      })),
      { onConflict: "user_id,sender_email" },
    );
  } catch (err) {
    console.error("[sync] email_memory upsert:", err);
  }
  return inserted;
}

// Keep sent mail (Follow-ups and the Sent view read it). Returns how many
// were new.
export async function storeSent(userId: string, account: Account, sent: Sent[]): Promise<number> {
  const fresh = new Set(await notStored(userId, sent.map((e) => e.id)));
  const rows = sent
    .filter((e) => fresh.has(e.id))
    .map((e) => {
      const date = new Date(e.date);
      return {
        user_id: userId,
        gmail_id: e.id,
        thread_id: e.thread_id,
        gmail_account_id: account.id,
        subject: e.subject,
        recipients: e.to,
        cc_recipients: e.cc || null,
        body_html: e.body_html,
        body_text: e.body,
        snippet: e.snippet,
        received_at: isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
        is_read: true,
        label_ids: ["SENT"],
        has_attachments: e.has_attachments ?? false,
        attachments: e.attachments ?? [],
      };
    });
  for (let i = 0; i < rows.length; i += 100) {
    await db.from("emails").upsert(rows.slice(i, i + 100), { onConflict: "user_id,gmail_id", ignoreDuplicates: true });
  }
  return rows.length;
}

export function sentHeaderRow(e: Sent, account: Account): HeaderRow {
  const date = new Date(e.date);
  return {
    gmail_id: e.id,
    thread_id: e.thread_id,
    at: isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    labels: ["SENT"],
    from: e.from || account.gmail_address || "",
    to: e.to,
    cc: e.cc,
    list_unsubscribe: false,
    list_id: "",
    precedence: "",
  };
}

// Changes made in Gmail itself (read, starred, archived, snoozed, moved back
// to the inbox, trashed, deleted) applied to the stored copies, in the order
// they happened. Returns the ids of messages moved back into the inbox that
// are not stored, to be fetched like new mail.
async function applyChanges(userId: string, ch: MailboxChanges): Promise<string[]> {
  const ids = [...new Set([...ch.labels.map((c) => c.id), ...ch.deleted])];
  if (!ids.length) return [];
  type Row = { id: string; gmail_id: string; label_ids: string[] | null; is_read: boolean; is_starred: boolean; is_archived: boolean };
  const stored = new Map<string, Row>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await db.from("emails").select("id, gmail_id, label_ids, is_read, is_starred, is_archived").eq("user_id", userId).in("gmail_id", ids.slice(i, i + 500));
    for (const r of (data ?? []) as unknown as Row[]) stored.set(r.gmail_id, r);
  }
  const back = new Set<string>();
  const labels = new Map<string, Set<string>>();
  for (const c of ch.labels) {
    const row = stored.get(c.id);
    if (!row) {
      if (c.add.includes("INBOX")) back.add(c.id);
      if (c.remove.includes("INBOX")) back.delete(c.id);
      continue;
    }
    const set = labels.get(c.id) ?? new Set(row.label_ids ?? []);
    for (const l of c.add) set.add(l);
    for (const l of c.remove) set.delete(l);
    labels.set(c.id, set);
  }
  for (const gmailId of ch.deleted) {
    back.delete(gmailId);
    const row = stored.get(gmailId);
    if (!row) continue;
    const set = labels.get(gmailId) ?? new Set(row.label_ids ?? []);
    set.delete("INBOX");
    labels.set(gmailId, set);
  }
  for (const [gmailId, set] of labels) {
    const row = stored.get(gmailId)!;
    const next = { label_ids: [...set], is_read: !set.has("UNREAD"), is_starred: set.has("STARRED"), is_archived: set.has("SENT") ? row.is_archived : !set.has("INBOX") };
    const same =
      next.is_read === row.is_read && next.is_starred === row.is_starred && next.is_archived === row.is_archived &&
      [...set].sort().join() === [...(row.label_ids ?? [])].sort().join();
    if (!same) await db.from("emails").update(next).eq("id", row.id);
  }
  return [...back];
}

// Sent mail and Google Contacts are fetched on their own, less often: sent
// mail when the history shows some (or every 10 minutes), contacts every 6 hours.
const SENT_EVERY_MS = 10 * 60_000;
const CONTACTS_EVERY_MS = 6 * 3600_000;
const lastSent = new Map<string, number>();
const lastContacts = new Map<string, number>();

// Fetch new inbox mail (and recent sent mail) for every active account.
// Initial: the latest 50 inbox messages. Otherwise: whatever Gmail's change
// history says arrived or changed since the last sync, falling back to the
// last 30 days when that history has expired. New mail is also added to the sender
// statistics (senders.ts). Returns the ids of the emails inserted.
export const syncMail = serial(async (userId: string, isInitialFetch = false): Promise<string[]> => {
  const { data: accounts } = await db
    .from("gmail_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (!accounts?.length) return [];

  const allNew: string[] = [];
  const own = await ownAddresses(userId);

  for (const account of accounts as unknown as Account[]) {
    try {
      // Incremental sync needs a starting point in Gmail's change history.
      // Take it before a full fetch so mail arriving in between is not missed.
      const startOver = async () => {
        try {
          const historyId = await currentHistoryId(account.token_ref);
          await db.from("gmail_accounts").update({ history_id: historyId }).eq("id", account.id);
        } catch (err) {
          console.warn("[sync] could not read the mailbox history id:", err);
        }
      };

      let rawEmails: EmailData[] = [];
      let sentArrived = true;
      if (isInitialFetch) {
        await startOver();
        const result = await fetchEmails(account.token_ref, 50, db, account.id, false);
        rawEmails = result.emails;
        if (result.updatedTokenRef) account.token_ref = result.updatedTokenRef;
      } else if (account.history_id) {
        const changes = await readHistory(account.token_ref, account.history_id);
        if (changes.tooOld) {
          await startOver();
          rawEmails = await fetchRecent(userId, account);
        } else {
          const back = await applyChanges(userId, changes);
          rawEmails = await fetchMessages(account.token_ref, await notStored(userId, [...new Set([...changes.added, ...back])]));
          sentArrived = changes.sentAdded;
          if (changes.historyId) await db.from("gmail_accounts").update({ history_id: changes.historyId }).eq("id", account.id);
        }
      } else {
        await startOver();
        rawEmails = await fetchRecent(userId, account);
      }

      allNew.push(...(await storeInbox(userId, account, rawEmails)));

      // Google Contacts into email_memory, for names and autocomplete.
      if (Date.now() - (lastContacts.get(account.id) ?? 0) > CONTACTS_EVERY_MS) try {
        lastContacts.set(account.id, Date.now());
        const gContacts = await fetchGoogleContacts(account.token_ref);
        if (gContacts.length > 0) {
          await db.from("email_memory").upsert(
            gContacts.map((c) => ({
              user_id: userId,
              sender_email: c.email,
              sender_name: c.name,
              interaction_count: 0,
              last_interaction_at: new Date().toISOString(),
            })),
            { onConflict: "user_id,sender_email", ignoreDuplicates: true },
          );
        }
      } catch (contactErr) {
        console.warn("[sync] Google contacts import failed:", contactErr);
      }

      // Recent sent mail (20 on the first fetch, then 5), so the Sent view
      // and Follow-ups see mail sent from Gmail too.
      let sent: Sent[] = [];
      if (isInitialFetch || sentArrived || Date.now() - (lastSent.get(account.id) ?? 0) > SENT_EVERY_MS) try {
        lastSent.set(account.id, Date.now());
        sent = await fetchSentEmails(account.token_ref, isInitialFetch ? 20 : 5);
        await storeSent(userId, account, sent);
      } catch (e) {
        console.warn("[sync] sent email import failed:", e);
      }

      // What arrived and what was sent counts toward the sender statistics.
      const seen = [...rawEmails.map(headerRowOf), ...sent.map((e) => sentHeaderRow(e, account))];
      if (seen.length) {
        try {
          await indexMail(userId, account.id, seen, own);
          const touched = new Set<string>();
          for (const r of seen) for (const a of addressesIn(`${r.from}, ${r.to}, ${r.cc}`)) touched.add(a);
          await rebuildSenders(userId, touched);
        } catch (e) {
          console.warn("[sync] sender statistics:", e);
        }
      }

      // Sent mail saved before thread ids were kept gets its thread from
      // Gmail, so Follow-ups can tell which sent mail got an answer.
      try {
        const { data: missing } = await db
          .from("emails")
          .select("id, gmail_id")
          .eq("user_id", userId)
          .eq("gmail_account_id", account.id)
          .contains("label_ids", ["SENT"])
          .is("thread_id", null)
          .limit(50);
        for (const row of missing ?? []) {
          const threadId = await threadIdOf(account.token_ref, row.gmail_id as string);
          await db.from("emails").update({ thread_id: threadId }).eq("id", row.id);
        }
      } catch (e) {
        console.warn("[sync] sent thread backfill failed:", e);
      }
    } catch (e) {
      console.error(`Fetch failed for account ${account.id}:`, e);
    }
  }

  return allNew;
});

export const analyzeInbox = serial((userId: string) => analyzeEmailsForUser(userId, db));

// Mail stored before HTML-only emails got a text body: fill it in, and have
// the model read those emails again with their real text instead of the
// snippet. Proposals made from the snippet are withdrawn; what was already
// done stays, and planNew does not repeat it.
export async function fillMissingBodies(userId: string): Promise<number> {
  const { data } = await db
    .from("emails")
    .select("id, body_html, label_ids")
    .eq("user_id", userId)
    .or("body_text.is.null,body_text.eq.")
    .neq("body_html", "");
  const rows = (data ?? []).filter((e) => e.body_html);
  if (!rows.length) return 0;
  const reread: string[] = [];
  for (const e of rows) {
    const text = htmlToText(e.body_html as string);
    if (!text) continue;
    await db.from("emails").update({ body_text: text }).eq("id", e.id);
    if (!((e.label_ids as string[] | null) ?? []).includes("SENT")) reread.push(e.id as string);
  }
  for (let i = 0; i < reread.length; i += 200) {
    const ids = reread.slice(i, i + 200);
    await db.from("email_processed").delete().in("email_id", ids);
    await db.from("action_log").delete().in("email_id", ids).eq("status", "proposed");
  }
  return rows.length;
}

// Fetch stored inbox mail of the last `days` again and update what is read
// from its headers and parts: calendar mail and its event, list headers,
// attachments. For mail stored before those were kept.
export async function refreshStored(userId: string, days: number): Promise<number> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: accounts } = await db.from("gmail_accounts").select("id, token_ref").eq("user_id", userId).eq("is_active", true);
  let updated = 0;
  for (const account of accounts ?? []) {
    const { data: stored } = await db
      .from("emails")
      .select("id, gmail_id")
      .eq("gmail_account_id", account.id)
      .not("label_ids", "cs", '{"SENT"}')
      .gte("received_at", since)
      .limit(5000);
    const byGmailId = new Map<string, string>((stored ?? []).map((e) => [String(e.gmail_id), String(e.id)]));
    const ids = [...byGmailId.keys()];
    for (let i = 0; i < ids.length; i += 50) {
      for (const e of await fetchMessages(account.token_ref as string, ids.slice(i, i + 50))) {
        await db
          .from("emails")
          .update({
            is_calendar: e.is_calendar, calendar_event: e.calendar_event, list_id: e.list_id ?? null, precedence_header: e.precedence_header ?? null,
            has_list_unsubscribe: e.has_list_unsubscribe, attachments: e.attachments ?? [], has_attachments: e.has_attachments,
          })
          .eq("id", byGmailId.get(e.gmail_id)!);
        updated++;
      }
    }
  }
  return updated;
}
