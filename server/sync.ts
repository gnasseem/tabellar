// Bringing new mail in from Gmail, shared by the window's refresh
// (/fetch-emails) and the background engine.
//
// Syncs and analyses each run one at a time: two overlapping syncs would race
// to insert the same messages, and two overlapping analyses would pay for the
// same model calls twice.

import { db } from "./db.ts";
import {
  fetchEmailsByHistoryId,
  fetchEmails,
  fetchSentEmails,
  fetchGoogleContacts,
  currentHistoryId,
  type EmailData,
} from "./gmail.ts";
import { analyzeEmailsForUser } from "./analyzeEmails.ts";

// Run fn after every earlier call on the same queue has finished.
export function serial<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const run = tail.then(() => fn(...args));
    tail = run.catch(() => {});
    return run;
  };
}

// Fetch new inbox mail (and recent sent mail) for every active account.
// Initial: the latest 50 inbox messages. Otherwise: whatever Gmail's change
// history says arrived since the last sync, falling back to the latest 15
// when that history has expired. Returns the ids of the emails inserted.
export const syncMail = serial(async (userId: string, isInitialFetch = false): Promise<string[]> => {
  const initialLimit = 50;
  const { data: accounts } = await db
    .from("gmail_accounts")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (!accounts?.length) return [];

  const allNew: string[] = [];

  for (const account of accounts) {
    try {
      // Incremental sync needs a starting point in Gmail's change history.
      // Take it before a full fetch so mail arriving in between is not missed.
      if (isInitialFetch || !account.history_id) {
        try {
          const historyId = await currentHistoryId(account.token_ref as string);
          await db.from("gmail_accounts").update({ history_id: historyId }).eq("id", account.id);
        } catch (err) {
          console.warn("[sync] could not read the mailbox history id:", err);
        }
      }

      // Initial fetch: grab the 15 most recent inbox emails.
      // Non-initial refresh: use Gmail history API to fetch only NEW emails
      // since the last sync (stored history_id). Falls back to latest 15 if
      // no history_id is stored yet or the history has expired.
      let rawEmails: EmailData[] = [];
      let updatedTokenRef: string | undefined;

      if (isInitialFetch) {
        const result = await fetchEmails(
          account.token_ref as string,
          initialLimit,
          db,
          account.id as string,
          false,
        );
        rawEmails = result.emails;
        updatedTokenRef = result.updatedTokenRef;
      } else {
        const storedHistoryId = account.history_id as string | null;
        if (storedHistoryId) {
          const {
            emails: histEmails,
            newHistoryId,
            tooOld,
          } = await fetchEmailsByHistoryId(
            account.token_ref as string,
            storedHistoryId,
            db,
            account.id as string,
          );
          if (tooOld) {
            // History expired; fall back to recent 15 and start over from now
            try {
              const historyId = await currentHistoryId(account.token_ref as string);
              await db.from("gmail_accounts").update({ history_id: historyId }).eq("id", account.id);
            } catch (err) {
              console.warn("[sync] could not read the mailbox history id:", err);
            }
            const result = await fetchEmails(
              account.token_ref as string,
              15,
              db,
              account.id as string,
              false,
            );
            rawEmails = result.emails;
            updatedTokenRef = result.updatedTokenRef;
          } else {
            rawEmails = histEmails;
            if (newHistoryId) {
              await db
                .from("gmail_accounts")
                .update({ history_id: newHistoryId })
                .eq("id", account.id);
            }
          }
        } else {
          // No history_id yet; fetch latest 15
          const result = await fetchEmails(
            account.token_ref as string,
            15,
            db,
            account.id as string,
            false,
          );
          rawEmails = result.emails;
          updatedTokenRef = result.updatedTokenRef;
        }
      }

      if (updatedTokenRef) {
        await db
          .from("gmail_accounts")
          .update({ token_ref: updatedTokenRef })
          .eq("id", account.id);
      }

      // Batch-check which gmail_ids already exist (1 query instead of N)
      const incomingGmailIds = rawEmails.map((e) => e.gmail_id);
      const { data: existingEmails } = await db
        .from("emails")
        .select("gmail_id")
        .eq("user_id", userId)
        .in("gmail_id", incomingGmailIds);
      const existingGmailIds = new Set(
        (existingEmails || []).map((e) => e.gmail_id as string),
      );

      // Track senders for batch memory update (count per sender)
      const senderMap = new Map<
        string,
        { sender: string; subject: string; count: number }
      >();

      // Collect new email rows to bulk-insert in a single query
      const newEmailRows: Record<string, unknown>[] = [];
      const newEmailSenders: {
        email: string;
        sender: string;
        subject: string;
      }[] = [];

      for (const emailData of rawEmails) {
        if (existingGmailIds.has(emailData.gmail_id)) continue;
        // Skip sent mail: check both the SENT label and the sender address matching the account
        if (
          emailData.label_ids.includes("SENT") ||
          !emailData.label_ids.includes("INBOX") ||
          (account.gmail_address &&
            emailData.sender_email?.toLowerCase() ===
              (account.gmail_address as string).toLowerCase())
        )
          continue;

        newEmailRows.push({
          user_id: userId,
          gmail_id: emailData.gmail_id,
          thread_id: emailData.thread_id,
          gmail_account_id: account.id,
          subject: emailData.subject,
          sender: emailData.sender,
          sender_email: emailData.sender_email,
          recipients: emailData.recipients,
          snippet: emailData.snippet,
          body_text: emailData.body_text,
          body_html: emailData.body_html,
          received_at: emailData.received_at,
          is_read: emailData.is_read,
          label_ids: emailData.label_ids,
          has_attachments: emailData.has_attachments,
          attachments: emailData.attachments ?? [],
          has_list_unsubscribe: emailData.has_list_unsubscribe,
          is_reply: emailData.is_reply,
          reply_to_email: emailData.reply_to_email,
          cc_recipients: emailData.cc_recipients,
          precedence_header: emailData.precedence_header,
        });

        if (emailData.sender_email) {
          newEmailSenders.push({
            email: emailData.sender_email,
            sender: emailData.sender,
            subject: emailData.subject,
          });
        }
      }

      if (newEmailRows.length > 0) {
        const { data: insertedEmails } = await db
          .from("emails")
          .insert(newEmailRows)
          .select("id");

        if (insertedEmails?.length) {
          allNew.push(
            ...(insertedEmails as { id: string }[]).map((e) => e.id),
          );
        }
      }

      for (const { email, sender, subject } of newEmailSenders) {
        const prev = senderMap.get(email);
        if (prev) {
          prev.count++;
          prev.subject = subject;
        } else {
          senderMap.set(email, { sender, subject, count: 1 });
        }
      }

      // Batch-update sender memory (2 queries instead of 2N)
      if (senderMap.size > 0) {
        try {
          const senderEmails = [...senderMap.keys()];
          const { data: existingMemory } = await db
            .from("email_memory")
            .select("sender_email, interaction_count")
            .eq("user_id", userId)
            .in("sender_email", senderEmails);
          const memMap = new Map(
            (existingMemory || []).map((m) => [
              m.sender_email as string,
              m.interaction_count as number,
            ]),
          );
          const now = new Date().toISOString();
          const upsertRows = [...senderMap.entries()].map(
            ([email, info]) => ({
              user_id: userId,
              sender_email: email,
              sender_name: info.sender,
              last_subject: info.subject,
              last_interaction_at: now,
              interaction_count: Number(memMap.get(email) ?? 0) + info.count,
            }),
          );
          await db
            .from("email_memory")
            .upsert(upsertRows, { onConflict: "user_id,sender_email" });
        } catch (err) {
          console.error("[sync] email_memory upsert:", err);
        }
      }

      // Import Google Contacts into email_memory (runs every sync, upserts safely)
      try {
        const gContacts = await fetchGoogleContacts(
          account.token_ref as string,
        );
        if (gContacts.length > 0) {
          const contactRows = gContacts.map((c) => ({
            user_id: userId,
            sender_email: c.email,
            sender_name: c.name,
            interaction_count: 0,
            last_interaction_at: new Date().toISOString(),
          }));
          await db.from("email_memory").upsert(contactRows, {
            onConflict: "user_id,sender_email",
            ignoreDuplicates: true,
          });
          console.log(
            `[sync] upserted ${contactRows.length} Google contacts`,
          );
        }
      } catch (contactErr) {
        console.warn(
          "[sync] Google contacts import failed:",
          contactErr,
        );
      }

      // Import recent sent emails on every fetch (20 on initial, 5 on subsequent)
      // so SentView stays up to date for both Tabellar and Gmail-client sends.
      {
        const sentLimit = isInitialFetch ? 20 : 5;
        try {
          const sentEmails = await fetchSentEmails(
            account.token_ref as string,
            sentLimit,
          );
          const sentGmailIds = sentEmails.map((e) => e.id);
          if (sentGmailIds.length > 0) {
            const { data: existingSent } = await db
              .from("emails")
              .select("gmail_id")
              .eq("user_id", userId)
              .in("gmail_id", sentGmailIds);
            const existingSentIds = new Set(
              (existingSent || []).map((e) => e.gmail_id as string),
            );
            const sentRows = sentEmails
              .filter((sent) => !existingSentIds.has(sent.id))
              .map((sent) => {
                const sentDate = new Date(sent.date);
                return {
                  user_id: userId,
                  gmail_id: sent.id,
                  gmail_account_id: account.id,
                  subject: sent.subject,
                  recipients: sent.to,
                  body_html: sent.body_html,
                  body_text: sent.body,
                  snippet: sent.snippet,
                  received_at: isNaN(sentDate.getTime())
                    ? new Date().toISOString()
                    : sentDate.toISOString(),
                  is_read: true,
                  label_ids: ["SENT"],
                  has_attachments: sent.has_attachments ?? false,
                  attachments: sent.attachments ?? [],
                };
              });
            if (sentRows.length > 0) {
              await db
                .from("emails")
                .upsert(sentRows, { onConflict: "user_id,gmail_id", ignoreDuplicates: true });
            }
          }
        } catch (e) {
          console.warn("[sync] sent email import failed:", e);
        }
      }
    } catch (e) {
      console.error(`Fetch failed for account ${account.id}:`, e);
    }
  }

  return allNew;
});

export const analyzeInbox = serial((userId: string) => analyzeEmailsForUser(userId, db));
