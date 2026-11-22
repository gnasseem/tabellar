// The local API: every route the interface calls under /api.
//
//   POST /fetch-emails          Fetch and analyze new Gmail messages
//   POST /send-email            Send an email now
//   POST /draft-email           Draft a new email or reply
//   POST /refine-draft          Rewrite a draft
//   POST /generate-draft        Draft a reply to a stored email
//   POST /analyze-inbox         Re-analyze unprocessed or all emails
//   POST /learn-style           Learn the user's writing style from sent mail
//   GET  /briefing              Morning briefing
//   POST /briefing/update       Incremental briefing update
//   GET  /calendar/free-slots   Free calendar slots
//   GET  /calendar/events       Calendar events
//   POST /calendar/create-event Create a Google Calendar event
//   POST /calendar/update-event Update a Google Calendar event
//   POST /rethink-email         Re-categorize one email
//   POST /extract-todos         Todos from one email
//   GET  /suggest-todos         Todo suggestions from recent mail
//   GET  /contacts/search       Search contacts
//   POST /contacts/sync         Import Google contacts
//   POST /remove-gmail-account  Disconnect a Gmail account
//   DELETE /delete-all-data     Wipe local mail data
//   POST /chat                  Assistant chat with inbox tools
//   GET|POST /follow-ups, PATCH|DELETE /follow-ups/:id
//   GET|POST /signatures, PATCH|DELETE /signatures/:id
//   GET  /attachment            Fetch a Gmail attachment
//   POST /agent/start|step|answer|execute|cancel   The agent

import { db, type Db } from "./db.ts";
import { modelConfigured } from "./llm.ts";
import { freshAccessToken, revokeGoogleTokens } from "./google.ts";
import {
  fetchEmailsByHistoryId,
  fetchEmails,
  fetchSentEmails,
  fetchGoogleContacts,
  searchGoogleContacts,
  listAllGoogleContacts,
  fetchAttachment,
  sendEmail,
  currentHistoryId,
  type EmailData,
} from "./gmail.ts";
import {
  analyzeWritingStyle,
  chatWithAssistant,
  extractTodos,
  briefingSummaryNeedsRecovery,
  generateBriefingExecutiveSummary,
  updateBriefing,
  composeDraft,
  refineDraft,
  generateDraft,
  suggestTodosFromEmails,
  processFullEmail,
  type ChatContext,
} from "./ai.ts";
import { analyzeEmailsForUser } from "./analyzeEmails.ts";
import { buildBriefingForUser } from "./buildBriefing.ts";
import {
  runAgentStep,
  runAgentStepParallel,
  startAgentSession,
  answerPendingQuestion,
} from "./agentLoop.ts";
import { executeAgentPlan } from "./agentExecute.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// Simple RFC-5322-ish regex; good enough for our UI-entered addresses. Reused
// by /send-email and the chat assistant's send_email tool to keep validation
// rules consistent across entry points.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRecipients(list: unknown): {
  ok: boolean;
  error?: string;
  emails?: string[];
} {
  if (!Array.isArray(list) || list.length === 0) {
    return {
      ok: false,
      error: "to[] is required and must be a non-empty array",
    };
  }
  if (list.length > 100) {
    return { ok: false, error: "Too many recipients (max 100)" };
  }
  const emails: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") {
      return { ok: false, error: "Recipient must be a string" };
    }
    const addr = raw.trim();
    if (!EMAIL_REGEX.test(addr) || addr.length > 254) {
      return { ok: false, error: `Invalid email address: ${raw}` };
    }
    emails.push(addr);
  }
  return { ok: true, emails };
}

function json(
  data: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

// There is one local user: the profile created at first sign-in. The server
// has already checked the request's access token before it gets here.
async function getUserId(_req: Request): Promise<string> {
  const { data } = await db.from("profiles").select("id").limit(1).maybeSingle();
  if (!data) throw Object.assign(new Error("Not signed in. Connect a Google account first."), { status: 401 });
  return data.id as string;
}

// An access token for Calendar calls, from the first active account.
async function getCalendarAccessTokenSafe(
  db: Db,
  userId: string,
): Promise<string | null> {
  const { data: accounts } = await db
    .from("gmail_accounts")
    .select("token_ref")
    .eq("user_id", userId)
    .eq("is_active", true)
    .limit(1);
  if (!accounts?.length) return null;
  try {
    return await freshAccessToken(accounts[0].token_ref as string);
  } catch (err) {
    console.error("[calendar] token refresh failed:", err);
    return null;
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────

// `path` is the route without its /api prefix.
export async function handleApi(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  const corsHeaders: Record<string, string> = {};

  try {
    if (path === "/health" && req.method === "GET") {
      return json({ status: modelConfigured() ? "ok" : "no-model" }, 200);
    }

    const userId = await getUserId(req);

    // ── POST /fetch-emails ─────────────────────────────────────────────────
    if (path === "/fetch-emails" && req.method === "POST") {
      let body: { initial?: boolean } = {};
      try {
        body = await req.json();
      } catch {
        /* empty body is fine */
      }
      const isInitialFetch = body.initial === true;

      const initialLimit = 50;

      const { data: accounts } = await db
        .from("gmail_accounts")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true);

      if (!accounts?.length) {
        return json({ error: "No Gmail account connected" }, 400, corsHeaders);
      }

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
              console.warn("[fetch-emails] could not read the mailbox history id:", err);
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
                  console.warn("[fetch-emails] could not read the mailbox history id:", err);
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
              console.error("[analyze-inbox] email_memory upsert:", err);
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
                `[fetch-emails] upserted ${contactRows.length} Google contacts`,
              );
            }
          } catch (contactErr) {
            console.warn(
              "[fetch-emails] Google contacts import failed:",
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
              console.warn("[fetch-emails] sent email import failed:", e);
            }
          }
        } catch (e) {
          console.error(`Fetch failed for account ${account.id}:`, e);
        }
      }

      // On initial fetch, kick off analysis + briefing as a background task so
      // the frontend can return from this call immediately and start polling
      // email_processed via Realtime. This eliminates two serial HTTP round
      // trips (/analyze-inbox + /briefing) and lets the briefing LLM run
      // while the frontend is still re-fetching the inbox list for display.
      let backgroundPipeline = false;
      if (isInitialFetch && allNew.length > 0) {
        backgroundPipeline = true;
        const pipeline = (async () => {
          try {
            await analyzeEmailsForUser(userId, db);
          } catch (err) {
            console.error("[fetch-emails] background analysis:", err);
          }
          try {
            const normalized = await buildBriefingForUser(
              userId,
              db,
              "all_recent",
            );
            await db
              .from("profiles")
              .update({
                last_briefing: normalized,
                last_briefing_at: new Date().toISOString(),
              })
              .eq("id", userId);
          } catch (err) {
            console.error("[fetch-emails] background briefing:", err);
          }
        })();

        try {
          // deno-lint-ignore no-explicit-any
          (globalThis as any)[Symbol.for("EdgeRuntime")]?.waitUntil(pipeline);
        } catch {
          // If waitUntil isn't available in this runtime, fire and forget.
          void pipeline;
        }
      }

      return json(
        {
          fetched: allNew.length,
          email_ids: allNew,
          background_pipeline: backgroundPipeline,
        },
        200,
        corsHeaders,
      );
    }

    // ── POST /analyze-inbox ─────────────────────────────────────────────────
    if (path === "/analyze-inbox" && req.method === "POST") {
      const result = await analyzeEmailsForUser(userId, db);
      return json(result, 200, corsHeaders);
    }

    // ── POST /learn-style ───────────────────────────────────────────────────
    if (path === "/learn-style" && req.method === "POST") {
      const { data: accounts } = await db
        .from("gmail_accounts")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true)
        .limit(1);

      if (!accounts?.length) {
        return json({ error: "No Gmail account connected" }, 400, corsHeaders);
      }

      const sent = await fetchSentEmails(
        accounts[0].token_ref as string,
        15,
      );

      if (sent.length < 3) {
        return json(
          { error: "Need at least 3 sent emails to analyze" },
          400,
          corsHeaders,
        );
      }

      const emailsText = sent
        .map(
          (e) =>
            `Subject: ${e.subject}\nTo: ${e.to}\n\n${(e.body || e.snippet || "").slice(0, 600)}`,
        )
        .join("\n---\n");

      const style = await analyzeWritingStyle(emailsText);

      await db.from("style_profiles").upsert(
        {
          user_id: userId,
          greeting_style: style.greeting_style,
          closing_style: style.closing_style,
          tone: style.tone,
          avg_length: style.avg_length,
          sample_count: sent.length,
          last_learned_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

      return json(
        { learned: true, sample_count: sent.length, style },
        200,
        corsHeaders,
      );
    }

    // ── POST /send-email ───────────────────────────────────────────────────
    if (path === "/send-email" && req.method === "POST") {
      const body = await req.json();

      // Input validation
      const toCheck = validateRecipients(body.to);
      if (!toCheck.ok) {
        return json({ error: toCheck.error }, 400, corsHeaders);
      }
      body.to = toCheck.emails;
      if (Array.isArray(body.cc)) {
        const ccCheck = validateRecipients(body.cc);
        if (!ccCheck.ok)
          return json({ error: ccCheck.error }, 400, corsHeaders);
        body.cc = ccCheck.emails;
      }
      if (Array.isArray(body.bcc)) {
        const bccCheck = validateRecipients(body.bcc);
        if (!bccCheck.ok)
          return json({ error: bccCheck.error }, 400, corsHeaders);
        body.bcc = bccCheck.emails;
      }
      if (!body.subject && !body.body_html) {
        return json(
          { error: "subject or body_html is required" },
          400,
          corsHeaders,
        );
      }
      if (
        body.body_html &&
        typeof body.body_html === "string" &&
        body.body_html.length > 25 * 1024 * 1024
      ) {
        return json(
          { error: "Email body exceeds 25 MB limit" },
          413,
          corsHeaders,
        );
      }

      // Pick the right Gmail account: prefer explicit account_id, then
      // match by gmail_address (for replies), then fall back to first account.
      let accountQuery = db
        .from("gmail_accounts")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true);

      if (body.gmail_account_id) {
        accountQuery = accountQuery.eq("id", body.gmail_account_id);
      } else if (body.from_address) {
        accountQuery = accountQuery.eq("gmail_address", body.from_address);
      }

      const { data: accounts } = await accountQuery.limit(1);

      // If specific account not found, fall back to any active account
      const { data: fallbackAccounts } = !accounts?.length
        ? await db
            .from("gmail_accounts")
            .select("*")
            .eq("user_id", userId)
            .eq("is_active", true)
            .limit(1)
        : { data: accounts };

      const account = (accounts?.length ? accounts : fallbackAccounts)?.[0];
      if (!account) {
        return json({ error: "No Gmail account connected" }, 400, corsHeaders);
      }

      const result = await sendEmail(
        account.token_ref as string,
        body.to ?? [],
        body.subject ?? "",
        body.body_html ?? "",
        body.in_reply_to,
        body.thread_id,
        body.attachments ?? undefined,
        body.cc,
        body.bcc,
      );

      // Persist sent email to DB so SentView reads from local storage
      {
        const { error: insertErr } = await db
          .from("emails")
          .upsert(
            {
              user_id: userId,
              gmail_id: result.id,
              gmail_account_id: account.id,
              subject: body.subject ?? "",
              recipients: (body.to as string[]).join(", "),
              body_html: body.body_html ?? "",
              received_at: new Date().toISOString(),
              is_read: true,
              label_ids: ["SENT"],
            },
            { onConflict: "user_id,gmail_id", ignoreDuplicates: false },
          );
        if (insertErr)
          console.error("[send-email] failed to save to emails table:", insertErr.message);
      }

      return json(
        { sent: true, message_id: result.id },
        200,
        corsHeaders,
      );
    }

    // ── POST /draft-email ──────────────────────────────────────────────────
    // Compose-from-scratch or reply draft. Used by ComposeModal.
    if (path === "/draft-email" && req.method === "POST") {
      const body = await req.json();

      // Fetch sender's display name
      let senderName: string = body.senderName || "";
      if (!senderName) {
        const { data: profileRow } = await db
          .from("profiles")
          .select("display_name")
          .eq("id", userId)
          .single();
        senderName = profileRow?.display_name || "";
      }

      // Parse recipient name from "Name <email>" or bare email
      const toRaw: string = body.to || "";
      const angleMatch = toRaw.match(/^(.*?)<[^>]+>\s*$/);
      const recipientName = angleMatch
        ? angleMatch[1].trim().replace(/^"|"$/g, "").trim()
        : "";

      // Extract recipient email
      const emailMatch = toRaw.match(/<([^>]+)>/);
      const recipientEmail = emailMatch
        ? emailMatch[1].trim()
        : toRaw.split(/\s/)[0].trim();

      // Fetch style + knowledge context in parallel
      const [
        { data: styleData },
        { data: profileData },
        { data: kbData },
        { data: memData },
      ] = await Promise.all([
        db
          .from("style_profiles")
          .select("*")
          .eq("user_id", userId)
          .limit(1),
        db
          .from("profiles")
          .select("style_notes")
          .eq("id", userId)
          .single(),
        (async () => {
          // Prioritize entries relevant to the recipient, then fill with most-used entries
          const recipientDomain = recipientEmail?.split("@")[1] ?? "";
          const recipientFirstName = recipientName?.split(" ")[0] ?? "";
          const filters: string[] = [];
          if (recipientFirstName.length > 1)
            filters.push(
              `entity.ilike.%${recipientFirstName}%`,
              `info.ilike.%${recipientFirstName}%`,
            );
          if (recipientDomain.length > 3)
            filters.push(
              `entity.ilike.%${recipientDomain}%`,
              `info.ilike.%${recipientDomain}%`,
            );

          const [relevantRes, topRes] = await Promise.all([
            filters.length > 0
              ? db
                  .from("knowledge_base")
                  .select("entity, entity_type, info")
                  .eq("user_id", userId)
                  .or(filters.join(","))
                  .limit(10)
              : Promise.resolve({
                  data: [] as {
                    entity: string;
                    entity_type: string;
                    info: string;
                  }[],
                }),
            db
              .from("knowledge_base")
              .select("entity, entity_type, info")
              .eq("user_id", userId)
              .order("use_count", { ascending: false })
              .order("updated_at", { ascending: false })
              .limit(15),
          ]);

          const seen = new Set<string>();
          const merged: {
            entity: string;
            entity_type: string;
            info: string;
          }[] = [];
          for (const row of [
            ...(relevantRes.data ?? []),
            ...(topRes.data ?? []),
          ]) {
            if (!seen.has(row.entity)) {
              seen.add(row.entity);
              merged.push(row);
            }
            if (merged.length >= 20) break;
          }
          return { data: merged };
        })(),
        recipientEmail
          ? db
              .from("email_memory")
              .select("interaction_count, relationship_notes")
              .eq("user_id", userId)
              .eq("sender_email", recipientEmail)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      let styleContext: string | undefined;
      if (styleData?.[0]) {
        const s = styleData[0];
        styleContext = `Greeting: ${s.greeting_style || "Hi"}. Closing: ${s.closing_style || "Best"}. Tone: ${s.tone || "professional"}.`;
      }
      if (profileData?.style_notes) {
        styleContext = (styleContext || "") + " " + profileData.style_notes;
      }

      let knowledgeContext: string | undefined;
      const kbParts: string[] = [];
      if (kbData?.length) {
        kbParts.push(
          kbData
            .map(
              (k: { entity: string; entity_type: string; info: string }) =>
                `${k.entity} (${k.entity_type}): ${k.info}`,
            )
            .join("\n"),
        );
      }
      if (memData) {
        kbParts.push(
          `Email history with ${recipientEmail}: ${memData.interaction_count} emails exchanged${memData.relationship_notes ? `. ${memData.relationship_notes}` : ""}`,
        );
      }
      if (kbParts.length) knowledgeContext = kbParts.join("\n");

      const draft = await composeDraft({
        intent: body.intent ?? "",
        subject: body.subject ?? "",
        recipientName,
        senderName,
        replyTo: body.replyTo,
        styleContext,
        knowledgeContext,
      });

      return json({ draft }, 200, corsHeaders);
    }

    // ── POST /refine-draft ─────────────────────────────────────────────────
    // Refine an AI-generated draft based on user feedback. Also persists the
    // feedback as a knowledge-base entry so future drafts learn from it.
    if (path === "/refine-draft" && req.method === "POST") {
      const body = await req.json();
      const currentDraft: string = body.currentDraft ?? "";
      const feedback: string = body.feedback ?? "";
      const senderName: string = body.senderName ?? "";
      // Tone rephrasing reuses this route but is a one-off transformation, not
      // a statement of preference. Without this it would write a knowledge_base
      // row on every click and skew all later drafts toward the last tone tried.
      const skipLearning: boolean = body.skip_learning === true;

      if (!currentDraft || !feedback) {
        return json(
          { error: "currentDraft and feedback are required" },
          400,
          corsHeaders,
        );
      }

      // Fetch style + top knowledge context in parallel
      const [{ data: styleData3 }, { data: profileData3 }, { data: kbData3 }] =
        await Promise.all([
          db
            .from("style_profiles")
            .select("*")
            .eq("user_id", userId)
            .limit(1),
          db
            .from("profiles")
            .select("style_notes")
            .eq("id", userId)
            .single(),
          db
            .from("knowledge_base")
            .select("entity, entity_type, info")
            .eq("user_id", userId)
            .order("use_count", { ascending: false })
            .order("updated_at", { ascending: false })
            .limit(10),
        ]);

      let styleContext3: string | undefined;
      if (styleData3?.[0]) {
        const s = styleData3[0];
        styleContext3 = `Greeting: ${s.greeting_style || "Hi"}. Closing: ${s.closing_style || "Best"}. Tone: ${s.tone || "professional"}.`;
      }
      if (profileData3?.style_notes) {
        styleContext3 = (styleContext3 || "") + " " + profileData3.style_notes;
      }

      const knowledgeContext3 = kbData3?.length
        ? kbData3
            .map(
              (k: { entity: string; entity_type: string; info: string }) =>
                `${k.entity} (${k.entity_type}): ${k.info}`,
            )
            .join("\n")
        : undefined;

      // Save feedback as a knowledge-base learning entry so future drafts improve
      if (!skipLearning) {
        db
          .from("knowledge_base")
          .insert({
            user_id: userId,
            entity: `draft_feedback_${Date.now()}`,
            entity_type: "style_preference",
            info: `Writing preference: ${feedback}`,
            source: "draft_refinement",
            importance: "normal",
            use_count: 1,
          })
          .then(({ error }) => {
            if (error)
              console.error(
                "[refine-draft] knowledge insert error:",
                error.message,
              );
          });
      }

      const refined = await refineDraft({
        currentDraft,
        feedback,
        senderName,
        styleContext: styleContext3,
        knowledgeContext: knowledgeContext3,
      });

      return json({ draft: refined }, 200, corsHeaders);
    }

    // ── POST /generate-draft ───────────────────────────────────────────────
    if (path === "/generate-draft" && req.method === "POST") {
      const body = await req.json();

      const { data: emails } = await db
        .from("emails")
        .select("*")
        .eq("id", body.email_id ?? "")
        .eq("user_id", userId);

      if (!emails?.length) {
        return json({ error: "Email not found" }, 404, corsHeaders);
      }

      const e = emails[0];
      const emailText = `Subject: ${e.subject}\nFrom: ${e.sender}\n\n${
        e.body_text || e.snippet
      }`;

      // Fetch style + knowledge context in parallel
      const senderName =
        e.sender?.split("<")[0]?.trim().split(" ")[0]?.toLowerCase() || "";
      const [
        { data: styleData2 },
        { data: profileData2 },
        { data: relevantKb2 },
        { data: recentKb2 },
      ] = await Promise.all([
        db
          .from("style_profiles")
          .select("*")
          .eq("user_id", userId)
          .limit(1),
        db
          .from("profiles")
          .select("style_notes")
          .eq("id", userId)
          .single(),
        senderName
          ? db
              .from("knowledge_base")
              .select("entity, entity_type, info")
              .eq("user_id", userId)
              .ilike("entity", `%${senderName}%`)
              .limit(10)
          : Promise.resolve({ data: [] }),
        db
          .from("knowledge_base")
          .select("entity, entity_type, info")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false })
          .limit(20),
      ]);
      const kbSeen2 = new Set(
        (relevantKb2 || []).map((k: { entity: string }) => k.entity),
      );
      const kbData2 = [
        ...(relevantKb2 || []),
        ...(recentKb2 || []).filter(
          (k: { entity: string }) => !kbSeen2.has(k.entity),
        ),
      ].slice(0, 20);

      let styleContext: string | undefined;
      if (styleData2?.[0]) {
        const s = styleData2[0];
        styleContext = `Greeting: ${s.greeting_style || "Hi"}. Closing: ${s.closing_style || "Best"}. Tone: ${s.tone || "professional"}.`;
      }
      if (profileData2?.style_notes) {
        styleContext = (styleContext || "") + " " + profileData2.style_notes;
      }

      let knowledgeContext2: string | undefined;
      if (kbData2?.length) {
        knowledgeContext2 = kbData2
          .map(
            (k: { entity: string; entity_type: string; info: string }) =>
              `${k.entity} (${k.entity_type}): ${k.info}`,
          )
          .join("\n");
      }

      const emailTextWithKnowledge = knowledgeContext2
        ? `${emailText}\n\nBackground context:\n${knowledgeContext2}`
        : emailText;

      const draft = await generateDraft(
        emailTextWithKnowledge,
        body.instructions ?? "",
        styleContext,
      );

      return json({ draft }, 200, corsHeaders);
    }

    // ── GET /briefing ──────────────────────────────────────────────────────
    if (path === "/briefing" && req.method === "GET") {
      try {
        const urlObj = new URL(req.url);
        const scopeParam = urlObj.searchParams.get("scope");
        const scopeArg =
          scopeParam &&
          ["today_new", "today_unread", "past_2_days", "past_week", "all_recent"].includes(
            scopeParam,
          )
            ? (scopeParam as
                | "today_new"
                | "today_unread"
                | "past_2_days"
                | "past_week"
                | "all_recent")
            : undefined;

        const normalized = await buildBriefingForUser(
          userId,
          db,
          scopeArg,
        );
        return json(normalized, 200, corsHeaders);
      } catch (err) {
        console.error("Briefing error:", err);
        const errorMessage =
          (err as Error).message === "LLM_API_ERROR"
            ? "AI service temporarily unavailable. Please try again later."
            : "Could not generate briefing. Please try again later.";
        return json({ error: errorMessage }, 500, corsHeaders);
      }
    }

    // ── POST /briefing/update ── Incremental briefing update ──────────────
    if (path === "/briefing/update" && req.method === "POST") {
      try {
        const body = await req.json();
        const previousBriefing = body.previous_briefing;
        const since = body.since; // ISO timestamp: only consider emails newer than this

        if (!previousBriefing || !since) {
          return json(
            { error: "previous_briefing and since are required" },
            400,
            corsHeaders,
          );
        }

        // Fetch only NEW emails since the given timestamp, with their processed data
        const { data: newEmails } = await db
          .from("emails")
          .select(
            "id, subject, sender, snippet, email_processed(category, summary)",
          )
          .eq("user_id", userId)
          .gt("received_at", since)
          .order("received_at", { ascending: false })
          .limit(50);

        if (!newEmails?.length) {
          // No new emails at all, return previous briefing unchanged
          return json(
            { briefing: previousBriefing, updated: false },
            200,
            corsHeaders,
          );
        }

        // Filter to only briefing-worthy emails (skip newsletters, informational, promotional)
        const SKIP_CATEGORIES = new Set([
          "newsletter",
          "informational",
          "promotional",
        ]);
        const relevant = newEmails.filter((e: any) => {
          const p = Array.isArray(e.email_processed)
            ? e.email_processed[0]
            : e.email_processed;
          if (!p) return true; // unprocessed = might be important
          return !SKIP_CATEGORIES.has(p.category);
        });

        if (relevant.length === 0) {
          // Only newsletters/spam arrived. Update stats.total but don't regenerate.
          const updated = { ...previousBriefing };
          if (updated.stats && typeof updated.stats === "object") {
            const stats = updated.stats as Record<string, number>;
            stats.total = (stats.total || 0) + newEmails.length;
            stats.filtered = (stats.filtered || 0) + newEmails.length;
          }
          return json({ briefing: updated, updated: false }, 200, corsHeaders);
        }

        // Build text for only the relevant new emails
        const newEmailsText = relevant
          .map((e: any) => {
            const p = Array.isArray(e.email_processed)
              ? e.email_processed[0]
              : e.email_processed;
            return `Subject: ${e.subject}\nFrom: ${e.sender}\nCategory: ${p?.category ?? "unknown"}\nSummary: ${p?.summary ?? e.snippet ?? ""}`;
          })
          .join("\n\n---\n\n");

        // Call the incremental update (cheaper than full rebuild)
        const updatedBriefing = await updateBriefing(
          JSON.stringify(previousBriefing),
          newEmailsText,
        );

        if (!updatedBriefing) {
          return json(
            { briefing: previousBriefing, updated: false },
            200,
            corsHeaders,
          );
        }

        const ub = updatedBriefing as Record<string, unknown>;
        let executiveSummary = String(ub.executiveSummary ?? "");
        if (briefingSummaryNeedsRecovery(executiveSummary)) {
          const lines: string[] = [];
          const cr = Array.isArray(ub.crucial)
            ? (ub.crucial as Record<string, unknown>[])
            : [];
          const rep = Array.isArray(ub.replyNeeded)
            ? (ub.replyNeeded as Record<string, unknown>[])
            : [];
          const dl = Array.isArray(ub.deadlines)
            ? (ub.deadlines as Record<string, unknown>[])
            : [];
          const ne = Array.isArray(ub.nonEssential)
            ? (ub.nonEssential as Record<string, unknown>[])
            : [];
          const tp = Array.isArray(ub.topPriority)
            ? (ub.topPriority as Record<string, unknown>[])
            : [];
          const wr = Array.isArray(ub.waitingForReply)
            ? (ub.waitingForReply as Record<string, unknown>[])
            : [];
          if (cr.length || rep.length || dl.length || ne.length) {
            lines.push(
              `Buckets: crucial=${cr.length}, replyNeeded=${rep.length}, deadlines=${dl.length}, nonEssential=${ne.length}.`,
            );
            const pick = (
              arr: Record<string, unknown>[],
              label: string,
              n: number,
            ) => {
              for (let i = 0; i < Math.min(n, arr.length); i++) {
                const c = arr[i];
                lines.push(
                  `[${label}] ${String(c.subject ?? "")} (from ${String(c.sender ?? "")})`,
                );
              }
            };
            pick(rep, "reply", 8);
            pick(dl, "deadline", 5);
            pick(cr, "crucial", 8);
          } else {
            lines.push(
              `Legacy shape: ${tp.length} top priority, ${wr.length} waiting for reply.`,
            );
            for (let i = 0; i < Math.min(8, tp.length); i++) {
              const c = tp[i];
              lines.push(
                `[priority] ${String(c.subject ?? "")} (from ${String(c.sender ?? "")})`,
              );
            }
            for (let i = 0; i < Math.min(5, wr.length); i++) {
              const c = wr[i];
              lines.push(
                `[waiting] ${String(c.subject ?? "")} (from ${String(c.sender ?? "")})`,
              );
            }
          }
          try {
            executiveSummary = await generateBriefingExecutiveSummary(
              lines.join("\n"),
            );
          } catch {
            executiveSummary =
              "Briefing updated; review sections for what changed.";
          }
        }

        // Normalize the structure (v1 fields + optional v2 arrays from the model)
        const normalized: Record<string, unknown> = {
          executiveSummary,
          topPriority: (updatedBriefing as any).topPriority || [],
          deadlines: (updatedBriefing as any).deadlines || [],
          waitingForReply: (updatedBriefing as any).waitingForReply || [],
          stats: (updatedBriefing as any).stats || previousBriefing.stats || {},
        };
        if (Array.isArray(ub.crucial)) normalized.crucial = ub.crucial;
        if (Array.isArray(ub.replyNeeded))
          normalized.replyNeeded = ub.replyNeeded;
        if (Array.isArray(ub.nonEssential)) {
          normalized.nonEssential = ub.nonEssential;
        }

        // Attach email_id to new cards; preserve existing email_id on carried-over cards
        const newSubjectToId = new Map<string, string>();
        for (const e of newEmails) {
          newSubjectToId.set(
            ((e as any).subject ?? "").toLowerCase(),
            (e as any).id,
          );
        }
        const attachIdsUpdate = (cards: any[]) =>
          cards.map((card) => {
            if (card.email_id) return card; // already set from previous briefing
            const key = (card.subject ?? "").toLowerCase();
            let id = newSubjectToId.get(key);
            if (!id) {
              for (const [s, eid] of newSubjectToId) {
                if (s.includes(key) || key.includes(s)) {
                  id = eid;
                  break;
                }
              }
            }
            return id ? { ...card, email_id: id } : card;
          });
        normalized.topPriority = attachIdsUpdate(
          normalized.topPriority as any[],
        );
        normalized.waitingForReply = attachIdsUpdate(
          normalized.waitingForReply as any[],
        );
        if (Array.isArray(normalized.crucial)) {
          normalized.crucial = attachIdsUpdate(normalized.crucial as any[]);
        }
        if (Array.isArray(normalized.replyNeeded)) {
          normalized.replyNeeded = attachIdsUpdate(
            normalized.replyNeeded as any[],
          );
        }
        if (Array.isArray(normalized.nonEssential)) {
          normalized.nonEssential = attachIdsUpdate(
            normalized.nonEssential as any[],
          );
        }

        return json({ briefing: normalized, updated: true }, 200, corsHeaders);
      } catch (err: any) {
        console.error("Briefing update error:", err);
        return json({ error: "Could not update briefing" }, 500, corsHeaders);
      }
    }

    // ── GET /calendar/free-slots ───────────────────────────────────────────
    if (path === "/calendar/free-slots" && req.method === "GET") {
      const accessToken = await getCalendarAccessTokenSafe(db, userId);
      if (!accessToken) {
        return json({ error: "No calendar access" }, 400, corsHeaders);
      }

      const url = new URL(req.url);
      const durationMin = parseInt(
        url.searchParams.get("duration") || "30",
        10,
      );
      const dateParam = url.searchParams.get("date"); // YYYY-MM-DD
      const timezone = url.searchParams.get("timezone") || "UTC";

      const now = new Date();

      // Helper: convert a local date+time in the user's timezone to a UTC Date.
      // Works by computing the offset Intl reports for a UTC guess, then correcting.
      function zonedToUtc(
        year: number,
        month: number,
        day: number,
        hour: number,
        minute: number,
        tz: string,
      ): Date {
        const guess = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          hour12: false,
        });
        const parts = Object.fromEntries(
          fmt.formatToParts(guess).map((p) => [p.type, p.value]),
        );
        const tzMs = Date.UTC(
          parseInt(parts.year),
          parseInt(parts.month) - 1,
          parseInt(parts.day),
          parseInt(parts.hour) % 24,
          parseInt(parts.minute),
        );
        return new Date(guess.getTime() + (guess.getTime() - tzMs));
      }

      // Parse the requested date components
      const today = new Date();
      const [y, mo, d] = dateParam
        ? dateParam.split("-").map(Number)
        : [today.getFullYear(), today.getMonth() + 1, today.getDate()];

      // Day of week for the requested date in the user's timezone
      // Use noon UTC of the date components so there is no day-boundary ambiguity
      const noonUtc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
      const dowFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
      });
      const dowStr = dowFmt.format(noonUtc);
      const dowMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      const dayOfWeek = dowMap[dowStr] ?? noonUtc.getDay();

      // Query freeBusy for the full target day in the user's timezone
      const dayMin = zonedToUtc(y, mo - 1, d, 0, 0, timezone);
      const dayMax = zonedToUtc(y, mo - 1, d, 23, 59, timezone);
      dayMax.setSeconds(59, 999);

      const busyRes = await fetch(
        "https://www.googleapis.com/calendar/v3/freeBusy",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            timeMin: dayMin.toISOString(),
            timeMax: dayMax.toISOString(),
            items: [{ id: "primary" }],
          }),
        },
      );

      if (!busyRes.ok) {
        return json(
          { error: "Calendar API failed", slots: [] },
          200,
          corsHeaders,
        );
      }

      const busyData = await busyRes.json();
      const busyPeriods = busyData.calendars?.primary?.busy || [];

      // Get working hours from profile
      const { data: profileData } = await db
        .from("profiles")
        .select("working_hours")
        .eq("id", userId)
        .single();

      const wh = (profileData?.working_hours as {
        start?: string;
        end?: string;
        days?: number[];
      } | null) || {
        start: "09:00",
        end: "17:00",
        days: [1, 2, 3, 4, 5],
      };

      // Return empty if not a working day (checked in user's timezone)
      if (!(wh.days || [1, 2, 3, 4, 5]).includes(dayOfWeek)) {
        return json({ slots: [] }, 200, corsHeaders);
      }

      // Working hours as UTC timestamps for the target date in user's timezone
      const [startH, startM] = (wh.start || "09:00").split(":").map(Number);
      const [endH, endM] = (wh.end || "17:00").split(":").map(Number);
      const slotMs = durationMin * 60000;
      const stepMs = 15 * 60000;

      const dayStart = zonedToUtc(y, mo - 1, d, startH, startM, timezone);
      const dayEnd = zonedToUtc(y, mo - 1, d, endH, endM, timezone);

      // Clamp to now for today
      if (dayStart < now) {
        dayStart.setTime(Math.max(dayStart.getTime(), now.getTime()));
      }

      // Round up to next 15-min mark (in UTC ms, which aligns with any tz)
      const rawMinutes = Math.floor(dayStart.getTime() / (15 * 60000));
      dayStart.setTime(
        (rawMinutes + (dayStart.getTime() % (15 * 60000) > 0 ? 1 : 0)) *
          15 *
          60000,
      );

      // Generate all free slots for the target date (no cap)
      const slots: { start: string; end: string }[] = [];

      for (
        let t = dayStart.getTime();
        t + slotMs <= dayEnd.getTime();
        t += stepMs
      ) {
        const slotStart = new Date(t);
        const slotEnd = new Date(t + slotMs);

        const isBusy = busyPeriods.some((b: { start: string; end: string }) => {
          const bs = new Date(b.start).getTime();
          const be = new Date(b.end).getTime();
          return slotStart.getTime() < be && slotEnd.getTime() > bs;
        });

        if (!isBusy) {
          slots.push({
            start: slotStart.toISOString(),
            end: slotEnd.toISOString(),
          });
        }
      }

      return json({ slots }, 200, corsHeaders);
    }

    // ── GET /calendar/events ───────────────────────────────────────────────
    if (path === "/calendar/events" && req.method === "GET") {
      const accessToken = await getCalendarAccessTokenSafe(db, userId);
      if (!accessToken) {
        return json({ error: "No calendar access", events: [] }, 200, corsHeaders);
      }
      const url = new URL(req.url);
      const dateParam = url.searchParams.get("date"); // YYYY-MM-DD, defaults to today
      const timezone = url.searchParams.get("timezone") || "UTC";

      const now = new Date();
      const [y, mo, d] = dateParam
        ? dateParam.split("-").map(Number)
        : [now.getFullYear(), now.getMonth() + 1, now.getDate()];

      // Build day boundaries in the user's timezone by shifting to midnight UTC equivalent
      function zonedMidnight(year: number, month: number, day: number, tz: string, endOfDay: boolean): Date {
        const guess = new Date(Date.UTC(year, month, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
          hour: "numeric", minute: "numeric", hour12: false,
        });
        const parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]));
        const tzMs = Date.UTC(parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day),
          parseInt(parts.hour) % 24, parseInt(parts.minute));
        return new Date(guess.getTime() + (guess.getTime() - tzMs));
      }

      const timeMin = zonedMidnight(y, mo - 1, d, timezone, false);
      const timeMax = zonedMidnight(y, mo - 1, d, timezone, true);

      const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
          new URLSearchParams({
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "25",
            fields: "items(id,summary,start,end,attendees,location,hangoutLink,conferenceData,htmlLink,status,description)",
          }),
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      if (!calRes.ok) {
        console.error("[calendar/events] google error:", await calRes.text());
        return json({ error: "Calendar API failed", events: [] }, 200, corsHeaders);
      }
      const calData = await calRes.json();
      const items = (calData.items ?? []) as any[];
      const events = items
        .filter((ev: any) => ev.status !== "cancelled")
        .map((ev: any) => ({
          id: ev.id,
          title: ev.summary ?? "(No title)",
          start: ev.start?.dateTime ?? ev.start?.date ?? null,
          end: ev.end?.dateTime ?? ev.end?.date ?? null,
          allDay: !ev.start?.dateTime,
          attendees: (ev.attendees ?? []).map((a: any) => a.displayName || a.email).filter(Boolean),
          location: ev.location ?? null,
          meetingLink: ev.hangoutLink ?? ev.conferenceData?.entryPoints?.[0]?.uri ?? null,
          htmlLink: ev.htmlLink ?? null,
          status: ev.status ?? "confirmed",
          source: "google_calendar",
        }));

      return json({ events }, 200, corsHeaders);
    }

    // ── POST /calendar/create-event ────────────────────────────────────────
    if (path === "/calendar/create-event" && req.method === "POST") {
      const body = await req.json();
      const accessToken = await getCalendarAccessTokenSafe(db, userId);
      if (!accessToken) {
        return json({ error: "No calendar access" }, 400, corsHeaders);
      }

      // Check user preference for sending invites
      const { data: calProfile } = await db
        .from("profiles")
        .select("calendar_send_invites")
        .eq("id", userId)
        .single();
      const sendUpdates =
        calProfile?.calendar_send_invites === false ? "none" : "all";

      const event: Record<string, unknown> = {
        summary: body.title,
        description: body.description || "",
        start: { dateTime: body.start_time, timeZone: body.timezone || "UTC" },
        end: { dateTime: body.end_time, timeZone: body.timezone || "UTC" },
      };

      if (body.location) {
        event.location = body.location;
      }

      if (body.attendees?.length) {
        event.attendees = body.attendees.map((email: string) => ({ email }));
      }

      const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${sendUpdates}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(event),
        },
      );

      if (!calRes.ok) {
        try {
          console.error(
            `[calendar/create-event] google error status=${calRes.status} body=${await calRes.text()}`,
          );
        } catch {
          /* ignore */
        }
        return json({ error: "Calendar API error" }, 400, corsHeaders);
      }

      const calEvent = await calRes.json();
      return json(
        { event_id: calEvent.id, html_link: calEvent.htmlLink },
        200,
        corsHeaders,
      );
    }

    // ── POST /calendar/update-event ────────────────────────────────────────
    if (path === "/calendar/update-event" && req.method === "POST") {
      const body = await req.json();
      if (!body.event_id) {
        return json({ error: "event_id required" }, 400, corsHeaders);
      }
      const accessToken = await getCalendarAccessTokenSafe(db, userId);
      if (!accessToken) {
        return json({ error: "No calendar access" }, 400, corsHeaders);
      }

      // Check user preference for sending invites
      const { data: calUpdateProfile } = await db
        .from("profiles")
        .select("calendar_send_invites")
        .eq("id", userId)
        .single();
      const sendUpdatesVal =
        calUpdateProfile?.calendar_send_invites === false ? "none" : "all";

      const patch: Record<string, unknown> = {};
      if (body.title) patch.summary = body.title;
      if (body.description !== undefined) patch.description = body.description;
      if (body.start_time)
        patch.start = {
          dateTime: body.start_time,
          timeZone: body.timezone || "UTC",
        };
      if (body.end_time)
        patch.end = {
          dateTime: body.end_time,
          timeZone: body.timezone || "UTC",
        };
      if (body.location !== undefined) patch.location = body.location;
      if (body.attendees)
        patch.attendees = body.attendees.map((email: string) => ({ email }));

      const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${body.event_id}?sendUpdates=${sendUpdatesVal}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(patch),
        },
      );

      if (!calRes.ok) {
        try {
          console.error(
            `[calendar/update-event] google error status=${calRes.status} body=${await calRes.text()}`,
          );
        } catch {
          /* ignore */
        }
        return json({ error: "Calendar API error" }, 400, corsHeaders);
      }

      const calEvent = await calRes.json();
      return json(
        { event_id: calEvent.id, html_link: calEvent.htmlLink },
        200,
        corsHeaders,
      );
    }

    // ── POST /rethink-email ────────────────────────────────────────────────
    if (path === "/rethink-email" && req.method === "POST") {
      const body = await req.json();
      const emailId = body.email_id as string;

      const { data: emails } = await db
        .from("emails")
        .select("id, subject, sender, body_text, snippet")
        .eq("id", emailId)
        .eq("user_id", userId);

      if (!emails?.length) {
        return json({ error: "Email not found" }, 404, corsHeaders);
      }

      const email = emails[0];
      const { data: rethinkProfile } = await db
        .from("profiles")
        .select("working_hours")
        .eq("id", userId)
        .maybeSingle();
      const result = await processFullEmail(
        (email.subject as string) || "",
        (email.sender as string) || "",
        (email.body_text as string) || (email.snippet as string) || "",
        undefined,
        undefined,
        undefined,
        ((rethinkProfile?.working_hours as { timezone?: string } | null)
          ?.timezone) || "UTC",
      );

      await db.from("email_processed").upsert(
        {
          user_id: userId,
          email_id: emailId,
          category: result.category,
          urgency: result.urgency,
          summary: result.summary,
          quick_actions: result.quick_actions,
        },
        { onConflict: "email_id" },
      );

      return json({ ...result, email_id: emailId }, 200, corsHeaders);
    }

    // ── POST /extract-todos ────────────────────────────────────────────────
    if (path === "/extract-todos" && req.method === "POST") {
      const body = await req.json();
      const emailId = body.email_id as string;

      const { data: emails } = await db
        .from("emails")
        .select("subject, sender, body_text, snippet")
        .eq("id", emailId)
        .eq("user_id", userId);

      if (!emails?.length) {
        return json({ error: "Email not found" }, 404, corsHeaders);
      }

      const email = emails[0];
      const tasks = await extractTodos(
        (email.subject as string) || "",
        (email.sender as string) || "",
        (email.body_text as string) || (email.snippet as string) || "",
      );

      if (!tasks.length) {
        return json({ todos: [], count: 0 }, 200, corsHeaders);
      }

      const { data: inserted, error: insertErr } = await db
        .from("todos")
        .insert(
          tasks.map((text: string) => ({
            user_id: userId,
            text,
            source: "email",
          })),
        )
        .select();

      if (insertErr) throw insertErr;

      return json(
        { todos: inserted ?? [], count: (inserted ?? []).length },
        200,
        corsHeaders,
      );
    }

    // ── GET /suggest-todos ─────────────────────────────────────────────────
    if (path === "/suggest-todos" && req.method === "GET") {
      const { data: recent } = await db
        .from("emails")
        .select("subject, sender, snippet, email_processed(category, summary)")
        .eq("user_id", userId)
        .order("received_at", { ascending: false })
        .limit(15);

      if (!recent?.length) {
        return json({ suggestions: [] }, 200, corsHeaders);
      }

      const emailsText = recent
        .map((e) => {
          const proc = Array.isArray(e.email_processed)
            ? e.email_processed[0]
            : e.email_processed;
          return `Subject: ${e.subject}\nFrom: ${e.sender}\nSummary: ${(proc as { summary?: string } | null)?.summary ?? e.snippet}`;
        })
        .join("\n\n");

      const suggestions = await suggestTodosFromEmails(emailsText);
      return json({ suggestions }, 200, corsHeaders);
    }

    // ── GET /contacts/search ───────────────────────────────────────────────
    // Live contact search via Google People API (directory + personal contacts).
    if (path === "/contacts/search" && req.method === "GET") {
      const query = url.searchParams.get("q") ?? "";
      const accountId = url.searchParams.get("account_id") ?? "";
      if (query.length < 2 || !accountId) {
        return json({ contacts: [] }, 200, corsHeaders);
      }
      const { data: account } = await db
        .from("gmail_accounts")
        .select("token_ref")
        .eq("id", accountId)
        .eq("user_id", userId)
        .single();
      if (!account?.token_ref) {
        return json({ contacts: [] }, 200, corsHeaders);
      }
      const contacts = await searchGoogleContacts(
        account.token_ref,
        query,
      );
      return json({ contacts }, 200, corsHeaders);
    }

    // ── POST /contacts/sync ────────────────────────────────────────────────
    // Bulk-downloads all Google Contacts + Workspace directory for all active
    // accounts and upserts them into the contacts table.
    if (path === "/contacts/sync" && req.method === "POST") {
      const { data: accounts } = await db
        .from("gmail_accounts")
        .select("id, token_ref")
        .eq("user_id", userId)
        .eq("is_active", true);

      if (!accounts?.length) {
        return json({ synced: 0 }, 200, corsHeaders);
      }

      let totalSynced = 0;
      let needsReauth = false;
      for (const account of accounts) {
        if (!account.token_ref) continue;
        try {
          const all = await listAllGoogleContacts(account.token_ref);
          if (!all.length) {
            // Google returned nothing — likely missing contacts/directory scope
            needsReauth = true;
            continue;
          }
          const chunkSize = 500;
          for (let i = 0; i < all.length; i += chunkSize) {
            const chunk = all.slice(i, i + chunkSize).map((c) => ({
              user_id: userId,
              gmail_account_id: account.id,
              email: c.email,
              name: c.name,
              source: c.source,
              updated_at: new Date().toISOString(),
            }));
            await db
              .from("contacts")
              .upsert(chunk, { onConflict: "user_id,email", ignoreDuplicates: false });
          }
          totalSynced += all.length;
        } catch {
          needsReauth = true;
        }
      }
      return json({ synced: totalSynced, needs_reauth: needsReauth && totalSynced === 0 }, 200, corsHeaders);
    }

    // ── POST /remove-gmail-account ─────────────────────────────────────────
    if (path === "/remove-gmail-account" && req.method === "POST") {
      const body = await req.json();
      const accountId = body.account_id as string;
      if (!accountId)
        return json({ error: "Missing account_id" }, 400, corsHeaders);
      // Best-effort Google token revocation. Ignoring failures is intentional;
      // the user-visible effect is the row being deactivated regardless.
      try {
        const { data: acct } = await db
          .from("gmail_accounts")
          .select("token_ref")
          .eq("id", accountId)
          .eq("user_id", userId)
          .maybeSingle();
        if (acct?.token_ref) await revokeGoogleTokens(acct.token_ref as string);
      } catch (err) {
        console.error("[remove-gmail-account] revoke error:", err);
      }
      // Soft-delete: mark inactive so data is preserved and can be restored on re-link
      await db
        .from("gmail_accounts")
        .update({ is_active: false })
        .eq("id", accountId)
        .eq("user_id", userId);
      return json({ removed: true }, 200, corsHeaders);
    }

    // ── DELETE /delete-all-data ────────────────────────────────────────────
    if (path === "/delete-all-data" && req.method === "DELETE") {
      // Wipe everything Tabellar learned or stored. The profile and the
      // connected accounts stay, so the user remains signed in.
      for (const t of ["agent_sessions", "email_processed", "todos", "meetings", "follow_up_reminders",
        "scheduled_emails", "draft_emails", "email_memory", "contacts", "knowledge_base", "categories",
        "category_rules", "delegation_rules", "style_profiles", "email_templates", "email_signatures", "emails"]) {
        const { error } = await db.from(t).delete().eq("user_id", userId);
        if (error) return json({ error: "Failed to delete data: " + error.message }, 500, corsHeaders);
      }
      await db.from("gmail_accounts").update({ history_id: null }).eq("user_id", userId);
      await db.from("profiles").update({ last_briefing: null, last_briefing_at: null, style_notes: null }).eq("id", userId);
      return json({ deleted: true }, 200, corsHeaders);
    }

    // ── POST /chat ───────────────────────────────────────────────────────────
    if (path === "/chat" && req.method === "POST") {
      const { message, history = [], timezone = "UTC" } = await req.json();

      if (!message?.trim()) {
        return json({ error: "Message required" }, 400, corsHeaders);
      }

      // Load only what's needed for the system prompt; everything else is fetched on demand by the AI via tools.
      const [styleResult, profileResult] = await Promise.all([
        db
          .from("style_profiles")
          .select("greeting_style, closing_style, tone, avg_length")
          .eq("user_id", userId)
          .maybeSingle(),
        db
          .from("profiles")
          .select("display_name")
          .eq("id", userId)
          .single(),
      ]);

      const context: ChatContext = {
        userDisplayName:
          (profileResult.data as { display_name?: string } | null)
            ?.display_name || "User",
        timezone: timezone as string,
        styleProfile: styleResult.data as ChatContext["styleProfile"],
      };

      const { reply, tool_calls } = await chatWithAssistant(
        context,
        message,
        history,
        db,
        userId,
      );
      console.log(
        "[chat] tool_calls returned:",
        JSON.stringify(
          tool_calls.map((t) => ({ name: t.name, args: t.arguments })),
        ),
      );

      // Execute tool calls (search_emails is handled in-memory by chatWithAssistant)
      const actions: { type: string; data: Record<string, unknown> }[] = [];

      // Convert a local-time ISO (no offset) + IANA timezone to a UTC ISO
      // string so stored timestamps match what Google Calendar records.
      const userTimezone = (timezone as string) || "UTC";
      const hasOffset = (s: string) => /Z$|[+-]\d{2}:?\d{2}$/.test(s.trim());
      const toUtcIso = (local: string, tz: string): string => {
        if (hasOffset(local)) return new Date(local).toISOString();
        try {
          const m = local.match(
            /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/,
          );
          if (!m) return new Date(local).toISOString();
          const [, y, mo, d, h, mi, s] = m;
          let utc = Date.UTC(
            Number(y),
            Number(mo) - 1,
            Number(d),
            Number(h),
            Number(mi),
            s ? Number(s) : 0,
          );
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }).formatToParts(new Date(utc));
          const pick = (t: string) =>
            Number(parts.find((p) => p.type === t)?.value);
          const zoned = Date.UTC(
            pick("year"),
            pick("month") - 1,
            pick("day"),
            pick("hour") % 24,
            pick("minute"),
            pick("second"),
          );
          utc += utc - zoned;
          return new Date(utc).toISOString();
        } catch {
          return new Date(local).toISOString();
        }
      };

      for (const tc of tool_calls) {
        if (tc.name === "create_todo") {
          const args = tc.arguments as { text: string };
          console.log("[chat/create_todo] inserting:", args.text);
          const { data: todo, error: todoErr } = await db
            .from("todos")
            .insert({ user_id: userId, text: args.text, source: "assistant" })
            .select("id")
            .single();
          if (todoErr) console.error("[chat/create_todo] error:", todoErr);
          if (todo)
            actions.push({
              type: "create_todo",
              data: { text: args.text, id: (todo as { id: string }).id },
            });
        } else if (tc.name === "save_draft") {
          const args = tc.arguments as {
            to: string;
            subject: string;
            body: string;
          };
          const { data: draft } = await db
            .from("draft_emails")
            .insert({
              user_id: userId,
              to_addresses: [args.to],
              subject: args.subject,
              body_html: args.body.replace(/\n/g, "<br>"),
            })
            .select("id")
            .single();
          if (draft)
            actions.push({
              type: "save_draft",
              data: {
                subject: args.subject,
                to: args.to,
                id: (draft as { id: string }).id,
              },
            });
        } else if (tc.name === "add_knowledge") {
          const args = tc.arguments as {
            entity: string;
            entity_type: string;
            info: string;
          };
          await db.from("knowledge_base").upsert(
            {
              user_id: userId,
              entity: args.entity,
              entity_type: args.entity_type,
              info: args.info,
              source: "assistant",
              confidence: 1.0,
            },
            { onConflict: "user_id,entity,entity_type" },
          );
          actions.push({ type: "add_knowledge", data: args });
        } else if (tc.name === "create_tag") {
          const args = tc.arguments as {
            display_name: string;
            slug: string;
            color?: string;
          };
          const { data: tag, error: tagErr } = await db
            .from("categories")
            .insert({
              user_id: userId,
              slug: args.slug,
              display_name: args.display_name,
              color: args.color ?? "#6b7280",
            })
            .select("id")
            .single();
          if (tagErr) console.error("[chat/create_tag] error:", tagErr);
          if (tag)
            actions.push({
              type: "create_tag",
              data: {
                display_name: args.display_name,
                slug: args.slug,
                color: args.color ?? "#6b7280",
                id: (tag as { id: string }).id,
              },
            });
        } else if (tc.name === "send_email") {
          const args = tc.arguments as {
            to: string;
            subject: string;
            body: string;
          };
          console.log(
            "[chat/send_email] attempting to send to:",
            args.to,
            "subject:",
            args.subject,
          );
          const toCheck = validateRecipients(
            typeof args.to === "string" ? [args.to] : args.to,
          );
          if (!toCheck.ok) {
            actions.push({
              type: "send_email_failed",
              data: { error: toCheck.error ?? "Invalid recipient" },
            });
            continue;
          }
          if (!args.subject || typeof args.subject !== "string") {
            actions.push({
              type: "send_email_failed",
              data: { error: "Missing subject" },
            });
            continue;
          }
          try {
            const { data: accounts, error: accountErr } = await db
              .from("gmail_accounts")
              .select("*")
              .eq("user_id", userId)
              .eq("is_active", true)
              .limit(1);
            if (accountErr)
              console.error(
                "[chat/send_email] account lookup error:",
                accountErr,
              );
            const account = accounts?.[0];
            if (account) {
              const bodyHtml = (args.body ?? "").replace(/\n/g, "<br>");
              const result = await sendEmail(
                account.token_ref as string,
                toCheck.emails!,
                args.subject,
                bodyHtml,
              );
              console.log("[chat/send_email] sent OK, message_id:", result.id);

              // Save to emails table so SentView can display it
              try {
                await db.from("emails").insert({
                  user_id: userId,
                  gmail_id: result.id,
                  gmail_account_id: account.id,
                  subject: args.subject,
                  recipients: toCheck.emails!.join(", "),
                  body_html: bodyHtml,
                  received_at: new Date().toISOString(),
                  is_read: true,
                  label_ids: ["SENT"],
                });
              } catch (e) {
                console.warn("[chat/send_email] failed to save to emails:", e);
              }

              actions.push({
                type: "send_email",
                data: {
                  to: args.to,
                  subject: args.subject,
                  message_id: result.id,
                },
              });
            } else {
              console.error(
                "[chat/send_email] no active Gmail account found for userId:",
                userId,
              );
              actions.push({
                type: "send_email_failed",
                data: { error: "No Gmail account connected" },
              });
            }
          } catch (err) {
            console.error("[chat/send_email] error:", err);
            actions.push({
              type: "send_email_failed",
              data: { error: String(err) },
            });
          }
        } else if (tc.name === "reply_to_email") {
          const args = tc.arguments as { email_id: string; body: string };
          try {
            const { data: accounts } = await db
              .from("gmail_accounts")
              .select("*")
              .eq("user_id", userId)
              .eq("is_active", true)
              .limit(1);
            const account = accounts?.[0];
            if (!account) {
              actions.push({
                type: "send_email_failed",
                data: { error: "No Gmail account connected" },
              });
            } else {
              // Fetch original email for threading headers
              const { data: original } = await db
                .from("emails")
                .select("subject, sender_email, gmail_id, thread_id")
                .eq("id", args.email_id)
                .eq("user_id", userId)
                .maybeSingle();
              if (!original) {
                actions.push({
                  type: "send_email_failed",
                  data: { error: "Original email not found" },
                });
              } else {
                const subject = (original as any).subject?.startsWith("Re:")
                  ? (original as any).subject
                  : `Re: ${(original as any).subject}`;
                const result = await sendEmail(
                  account.token_ref as string,
                  [(original as any).sender_email],
                  subject,
                  args.body.replace(/\n/g, "<br>"),
                  (original as any).gmail_id,
                  (original as any).thread_id,
                );
                actions.push({
                  type: "send_email",
                  data: {
                    to: (original as any).sender_email,
                    subject,
                    message_id: result.id,
                  },
                });
              }
            }
          } catch (err) {
            actions.push({
              type: "send_email_failed",
              data: { error: String(err) },
            });
          }
        } else if (tc.name === "update_todo") {
          const args = tc.arguments as {
            id: string;
            text?: string;
            is_completed?: boolean;
          };
          const updates: Record<string, unknown> = {};
          if (args.text !== undefined) updates.text = args.text;
          if (args.is_completed !== undefined)
            updates.is_completed = args.is_completed;
          await db
            .from("todos")
            .update(updates)
            .eq("id", args.id)
            .eq("user_id", userId);
          actions.push({ type: "update_todo", data: tc.arguments });
        } else if (tc.name === "delete_todo") {
          const args = tc.arguments as { id: string };
          await db
            .from("todos")
            .delete()
            .eq("id", args.id)
            .eq("user_id", userId);
          actions.push({ type: "delete_todo", data: tc.arguments });
        } else if (tc.name === "update_meeting") {
          const args = tc.arguments as {
            id: string;
            title?: string;
            start_time?: string;
            end_time?: string;
            attendees?: string[];
          };
          const updates: Record<string, unknown> = {};
          if (args.title) updates.title = args.title;
          if (args.start_time)
            updates.start_time = toUtcIso(args.start_time, userTimezone);
          if (args.end_time)
            updates.end_time = toUtcIso(args.end_time, userTimezone);
          if (args.attendees) updates.attendees = args.attendees;
          await db
            .from("meetings")
            .update(updates)
            .eq("id", args.id)
            .eq("user_id", userId);
          actions.push({ type: "update_meeting", data: tc.arguments });
        } else if (tc.name === "delete_meeting") {
          const args = tc.arguments as { id: string };
          await db
            .from("meetings")
            .delete()
            .eq("id", args.id)
            .eq("user_id", userId);
          actions.push({ type: "delete_meeting", data: tc.arguments });
        } else if (tc.name === "delete_draft") {
          const args = tc.arguments as { id: string };
          await db
            .from("draft_emails")
            .delete()
            .eq("id", args.id)
            .eq("user_id", userId);
          actions.push({ type: "delete_draft", data: tc.arguments });
        } else if (tc.name === "archive_email") {
          const args = tc.arguments as { email_id: string };
          await db
            .from("emails")
            .update({ is_archived: true })
            .eq("id", args.email_id)
            .eq("user_id", userId);
          actions.push({ type: "archive_email", data: tc.arguments });
        } else if (tc.name === "suggest_reply_options") {
          const args = tc.arguments as {
            options: { label: string; description: string }[];
            recommended: number;
            context?: string;
          };
          actions.push({
            type: "suggest_options",
            data: {
              options: args.options,
              recommended: args.recommended,
              context: args.context ?? "",
            },
          });
        } else if (tc.name === "set_follow_up") {
          const args = tc.arguments as {
            email_id?: string;
            recipient_email: string;
            subject: string;
            remind_at: string;
          };
          try {
            let threadId: string | null = null;
            if (args.email_id) {
              const { data: emailRow } = await db
                .from("emails")
                .select("thread_id")
                .eq("id", args.email_id)
                .eq("user_id", userId)
                .maybeSingle();
              threadId = (emailRow as any)?.thread_id ?? null;
            }
            // Use a synthetic thread_id if none found
            if (!threadId) threadId = crypto.randomUUID();

            const { data: followUp } = await db
              .from("follow_up_reminders")
              .upsert(
                {
                  user_id: userId,
                  email_id: args.email_id ?? null,
                  thread_id: threadId,
                  recipient_email: args.recipient_email,
                  subject: args.subject,
                  remind_at: args.remind_at,
                  status: "waiting",
                },
                { onConflict: "user_id,thread_id" },
              )
              .select("id, remind_at")
              .single();
            actions.push({
              type: "set_follow_up",
              data: {
                subject: args.subject,
                recipient_email: args.recipient_email,
                remind_at: args.remind_at,
                id: (followUp as any)?.id,
              },
            });
          } catch (err) {
            console.error("[chat/set_follow_up] error:", err);
          }
        } else if (tc.name === "create_meeting") {
          const args = tc.arguments as {
            title: string;
            start_time: string;
            end_time: string;
            attendees?: string[];
            description?: string;
          };
          const userTz = (timezone as string) || "UTC";
          try {
            const startDt = args.start_time.includes("T")
              ? args.start_time
              : args.start_time + "T00:00:00";
            const endDt = args.end_time.includes("T")
              ? args.end_time
              : args.end_time + "T00:00:00";

            // AI returns local times (no offset); convert to UTC ISO for DB.
            const startIso = toUtcIso(startDt, userTz);
            const endIso = toUtcIso(endDt, userTz);

            const accessToken = await getCalendarAccessTokenSafe(
              db,
              userId,
            );
            if (accessToken) {
              const { data: calProfile } = await db
                .from("profiles")
                .select("calendar_send_invites")
                .eq("id", userId)
                .single();
              const sendUpdates =
                calProfile?.calendar_send_invites === false ? "none" : "all";

              const event: Record<string, unknown> = {
                summary: args.title,
                description: args.description || "",
                start: { dateTime: startDt, timeZone: userTz },
                end: { dateTime: endDt, timeZone: userTz },
              };
              if (args.attendees?.length) {
                event.attendees = args.attendees.map((email: string) => ({
                  email,
                }));
              }
              const calRes = await fetch(
                `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${sendUpdates}`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(event),
                },
              );
              if (calRes.ok) {
                const calEvent = await calRes.json();
                await db.from("meetings").insert({
                  user_id: userId,
                  title: args.title,
                  start_time: startIso,
                  end_time: endIso,
                  attendees: args.attendees ?? [],
                  description: args.description || "",
                  calendar_event_id: calEvent.id,
                  status: "confirmed",
                });
                actions.push({
                  type: "create_meeting",
                  data: {
                    title: args.title,
                    start_time: startIso,
                    attendees: args.attendees,
                  },
                });
              } else {
                try {
                  console.error(
                    `[chat/create-meeting] google error status=${calRes.status} body=${await calRes.text()}`,
                  );
                } catch {
                  /* ignore */
                }
                actions.push({
                  type: "create_meeting_failed",
                  data: { error: "Calendar API error" },
                });
              }
            } else {
              await db.from("meetings").insert({
                user_id: userId,
                title: args.title,
                start_time: startIso,
                end_time: endIso,
                attendees: args.attendees ?? [],
                description: args.description || "",
                status: "proposed",
              });
              actions.push({
                type: "create_meeting",
                data: {
                  title: args.title,
                  start_time: startIso,
                  attendees: args.attendees,
                },
              });
            }
          } catch (err) {
            actions.push({
              type: "create_meeting_failed",
              data: { error: String(err) },
            });
          }
        }
      }

      // Note: knowledge use_count is incremented by the search_knowledge_base tool
      // inside chatWithAssistant when entries are explicitly searched and returned.

      return json({ reply, actions }, 200, corsHeaders);
    }

    // ── GET /follow-ups — list follow-up reminders ────────────────────────
    if (path === "/follow-ups" && req.method === "GET") {
      const { data, error } = await db
        .from("follow_up_reminders")
        .select("*")
        .eq("user_id", userId)
        .order("remind_at", { ascending: true });
      if (error) return json({ error: error.message }, 500, corsHeaders);
      return json({ followUps: data ?? [] }, 200, corsHeaders);
    }

    // ── POST /follow-ups — create a follow-up reminder ────────────────────
    if (path === "/follow-ups" && req.method === "POST") {
      const {
        email_id,
        thread_id,
        recipient_email,
        recipient_name,
        subject,
        remind_at,
      } = await req.json();
      if (!thread_id || !recipient_email || !subject || !remind_at) {
        return json({ error: "Missing required fields" }, 400, corsHeaders);
      }
      const { data, error } = await db
        .from("follow_up_reminders")
        .upsert(
          {
            user_id: userId,
            email_id: email_id ?? null,
            thread_id,
            recipient_email,
            recipient_name: recipient_name ?? null,
            subject,
            remind_at,
            status: "waiting",
          },
          { onConflict: "user_id,thread_id" },
        )
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500, corsHeaders);
      return json({ followUp: data }, 200, corsHeaders);
    }

    // ── PATCH /follow-ups/:id — update a follow-up reminder ───────────────
    if (path.startsWith("/follow-ups/") && req.method === "PATCH") {
      const followUpId = path.replace("/follow-ups/", "");
      if (!UUID_RE.test(followUpId))
        return json({ error: "Invalid id" }, 400, corsHeaders);
      const patch = await req.json();
      const allowed: Record<string, unknown> = {};
      for (const k of ["status", "snooze_until", "remind_at"]) {
        if (k in patch) allowed[k] = patch[k];
      }
      const { data, error } = await db
        .from("follow_up_reminders")
        .update(allowed)
        .eq("id", followUpId)
        .eq("user_id", userId)
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500, corsHeaders);
      return json({ followUp: data }, 200, corsHeaders);
    }

    // ── DELETE /follow-ups/:id — delete a follow-up reminder ──────────────
    if (path.startsWith("/follow-ups/") && req.method === "DELETE") {
      const followUpId = path.replace("/follow-ups/", "");
      if (!UUID_RE.test(followUpId))
        return json({ error: "Invalid id" }, 400, corsHeaders);
      await db
        .from("follow_up_reminders")
        .delete()
        .eq("id", followUpId)
        .eq("user_id", userId);
      return json({ ok: true }, 200, corsHeaders);
    }

    // ── GET /signatures — list all signatures for user ────────────────────
    if (path === "/signatures" && req.method === "GET") {
      const { data, error } = await db
        .from("email_signatures")
        .select("id, name, html, is_default, gmail_account_id, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 500, corsHeaders);
      return json({ signatures: data ?? [] }, 200, corsHeaders);
    }

    // ── POST /signatures — create a new signature ─────────────────────────
    if (path === "/signatures" && req.method === "POST") {
      const { name, html, is_default, gmail_account_id } = await req.json();
      if (!name?.trim())
        return json({ error: "Name is required" }, 400, corsHeaders);
      // If setting as default, clear existing default for this account scope first
      if (is_default) {
        const clear = db
          .from("email_signatures")
          .update({ is_default: false })
          .eq("user_id", userId)
          .eq("is_default", true);
        // A global signature has a null account scope, and eq never matches
        // NULL in PostgREST, so it must be matched with is().
        await (gmail_account_id
          ? clear.eq("gmail_account_id", gmail_account_id)
          : clear.is("gmail_account_id", null));
      }
      const { data, error } = await db
        .from("email_signatures")
        .insert({
          user_id: userId,
          name: name.trim(),
          html: html ?? "",
          is_default: !!is_default,
          gmail_account_id: gmail_account_id ?? null,
        })
        .select("id, name, html, is_default, gmail_account_id, created_at")
        .single();
      if (error) return json({ error: error.message }, 500, corsHeaders);
      return json({ signature: data }, 200, corsHeaders);
    }

    // ── PATCH /signatures/:id — update a signature ────────────────────────
    if (path.startsWith("/signatures/") && req.method === "PATCH") {
      const sigId = path.replace("/signatures/", "");
      if (!UUID_RE.test(sigId))
        return json({ error: "Invalid id" }, 400, corsHeaders);
      const { name, html, is_default, gmail_account_id } = await req.json();
      // Fetch current row to get its account scope
      const { data: existing } = await db
        .from("email_signatures")
        .select("gmail_account_id")
        .eq("id", sigId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!existing) return json({ error: "Not found" }, 404, corsHeaders);
      if (is_default) {
        const accountScope =
          gmail_account_id ?? existing.gmail_account_id ?? null;
        const clear = db
          .from("email_signatures")
          .update({ is_default: false })
          .eq("user_id", userId)
          .eq("is_default", true)
          .neq("id", sigId);
        // See the POST handler: eq never matches NULL, so a global signature's
        // scope has to be matched with is().
        await (accountScope
          ? clear.eq("gmail_account_id", accountScope)
          : clear.is("gmail_account_id", null));
      }
      const patch: Record<string, unknown> = {};
      if (name !== undefined) patch.name = name.trim();
      if (html !== undefined) patch.html = html;
      if (is_default !== undefined) patch.is_default = is_default;
      if (gmail_account_id !== undefined)
        patch.gmail_account_id = gmail_account_id;
      const { data, error } = await db
        .from("email_signatures")
        .update(patch)
        .eq("id", sigId)
        .eq("user_id", userId)
        .select("id, name, html, is_default, gmail_account_id, created_at")
        .single();
      if (error) return json({ error: error.message }, 500, corsHeaders);
      return json({ signature: data }, 200, corsHeaders);
    }

    // ── DELETE /signatures/:id — delete a signature ───────────────────────
    if (path.startsWith("/signatures/") && req.method === "DELETE") {
      const sigId = path.replace("/signatures/", "");
      if (!UUID_RE.test(sigId))
        return json({ error: "Invalid id" }, 400, corsHeaders);
      await db
        .from("email_signatures")
        .delete()
        .eq("id", sigId)
        .eq("user_id", userId);
      return json({ ok: true }, 200, corsHeaders);
    }

    // ── GET /attachment — fetch a Gmail attachment by ID ───────────────────
    if (path === "/attachment" && req.method === "GET") {
      const urlObj = new URL(req.url);
      const gmailId = urlObj.searchParams.get("gmail_id");
      const attachmentId = urlObj.searchParams.get("attachment_id");
      if (!gmailId || !attachmentId) {
        return json(
          { error: "Missing gmail_id or attachment_id" },
          400,
          corsHeaders,
        );
      }

      const { data: emailRow } = await db
        .from("emails")
        .select("gmail_account_id")
        .eq("user_id", userId)
        .eq("gmail_id", gmailId)
        .maybeSingle();
      if (!emailRow?.gmail_account_id) {
        return json({ error: "Email not found" }, 404, corsHeaders);
      }

      const { data: account } = await db
        .from("gmail_accounts")
        .select("token_ref")
        .eq("id", emailRow.gmail_account_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!account) {
        return json({ error: "Gmail account not found" }, 404, corsHeaders);
      }

      const result = await fetchAttachment(
        account.token_ref as string,
        gmailId,
        attachmentId,
      );
      if (!result)
        return json({ error: "Failed to fetch attachment" }, 502, corsHeaders);

      return json({ data: result.data, size: result.size }, 200, corsHeaders);
    }

    // ── Solve-Everything agent routes ────────────────────────────────────
    // Start a new agent session for the current briefing. Returns the session id.
    if (path === "/agent/start" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        timezone?: string;
      };
      const sessionId = await startAgentSession(db, userId);
      // Fire-and-forget: kick off the parallel bucket orchestrator.
      // waitUntil keeps the execution context alive after the response is sent
      // so the orchestrator's consolidation step actually completes.
      const bgStart = runAgentStepParallel(
        sessionId,
        db,
        body.timezone ?? "UTC",
      ).catch((e) =>
        console.error("[agent/start] initial parallel step failed:", e),
      );
      (globalThis as unknown as Record<symbol, { waitUntil: (p: Promise<unknown>) => void }>)[
        Symbol.for("EdgeRuntime")
      ]?.waitUntil(bgStart);
      return json({ session_id: sessionId }, 200, corsHeaders);
    }

    // Run the next iteration of the planning loop. Frontend calls this on
    // status changes to "planning" (e.g. after an /agent/answer).
    if (path === "/agent/step" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        session_id?: string;
        timezone?: string;
      };
      if (!body.session_id) {
        return json({ error: "session_id required" }, 400, corsHeaders);
      }
      // Authorize: session must belong to this user.
      const { data: session } = await db
        .from("agent_sessions")
        .select("id")
        .eq("id", body.session_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!session) {
        return json({ error: "Session not found" }, 404, corsHeaders);
      }
      const bgStep = runAgentStepParallel(
        body.session_id,
        db,
        body.timezone ?? "UTC",
      ).catch((e) => console.error("[agent/step] parallel step failed:", e));
      (globalThis as unknown as Record<symbol, { waitUntil: (p: Promise<unknown>) => void }>)[
        Symbol.for("EdgeRuntime")
      ]?.waitUntil(bgStep);
      return json({ status: "planning" }, 200, corsHeaders);
    }

    // Submit the user's answer to a pending question and resume planning.
    if (path === "/agent/answer" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        session_id?: string;
        option_id?: string;
        custom_text?: string;
        skip?: boolean;
        not_sure?: boolean;
        question_id?: string;
        timezone?: string;
      };
      if (!body.session_id) {
        return json({ error: "session_id required" }, 400, corsHeaders);
      }
      const { data: session } = await db
        .from("agent_sessions")
        .select("id")
        .eq("id", body.session_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!session) {
        return json({ error: "Session not found" }, 404, corsHeaders);
      }
      // Support batched answers: caller may POST { answers: [{...}, {...}] }
      // alongside or instead of a single answer. Each entry is applied in
      // order against the session's pending_questions array.
      const batch = (
        body as unknown as { answers?: Array<Record<string, unknown>> }
      ).answers;
      if (Array.isArray(batch) && batch.length) {
        for (const a of batch) {
          await answerPendingQuestion(db, body.session_id, {
            option_id: a.option_id as string | undefined,
            custom_text: a.custom_text as string | undefined,
            skip: a.skip as boolean | undefined,
            not_sure: a.not_sure as boolean | undefined,
            question_id: a.question_id as string | undefined,
          });
        }
      } else {
        await answerPendingQuestion(db, body.session_id, body);
      }
      // Fire-and-forget: resume the orchestrator. waitUntil keeps the context
      // alive so consolidation completes; the frontend learns the new state
      // via its existing Realtime subscription.
      const bgAnswer = runAgentStepParallel(
        body.session_id,
        db,
        body.timezone ?? "UTC",
      ).catch((e) => console.error("[agent/answer] parallel step failed:", e));
      (globalThis as unknown as Record<symbol, { waitUntil: (p: Promise<unknown>) => void }>)[
        Symbol.for("EdgeRuntime")
      ]?.waitUntil(bgAnswer);
      return json({ status: "planning" }, 200, corsHeaders);
    }

    // Execute an approved plan.
    if (path === "/agent/execute" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        session_id?: string;
        approved?: {
          id: string;
          type: "reply" | "todo" | "meeting" | "archive";
          payload: Record<string, unknown>;
          reasoning?: string;
          linked_email_id?: string;
        }[];
        timezone?: string;
      };
      if (!body.session_id) {
        return json({ error: "session_id required" }, 400, corsHeaders);
      }
      const { data: session } = await db
        .from("agent_sessions")
        .select("id")
        .eq("id", body.session_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!session) {
        return json({ error: "Session not found" }, 404, corsHeaders);
      }
      const approved = body.approved ?? [];
      if (!approved.length) {
        return json({ error: "approved actions required" }, 400, corsHeaders);
      }
      const results = await executeAgentPlan(
        db,
        userId,
        body.session_id,
        approved,
        body.timezone ?? "UTC",
      );
      return json({ results }, 200, corsHeaders);
    }

    // Cancel an in-flight agent session.
    if (path === "/agent/cancel" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        session_id?: string;
      };
      if (!body.session_id) {
        return json({ error: "session_id required" }, 400, corsHeaders);
      }
      await db
        .from("agent_sessions")
        .update({ status: "cancelled", pending_question: null })
        .eq("id", body.session_id)
        .eq("user_id", userId);
      return json({ ok: true }, 200, corsHeaders);
    }

    return json({ error: "Not found" }, 404, corsHeaders);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    const message =
      (err as { message?: string }).message ?? "Internal server error";
    console.error(`[${status}] ${message}`);
    return json({ error: message }, status, corsHeaders);
  }
}
