/**
 * Shared email analysis helper.
 *
 * Called through analyzeInbox (sync.ts) by /fetch-emails, /analyze-inbox and
 * the background engine.
 *
 * Performance notes:
 * - All emails in a batch are analyzed in parallel (no chunk barrier), so one
 *   slow email never stalls the other 49. The only cap is AI_PROCESS_CONCURRENCY
 *   which is a safety ceiling against provider-side throttling.
 * - Bulk mail (senders.isBulk: promotions, or a mailing list's headers) is
 *   sorted from its headers alone; the model never reads it. Neither does
 *   calendar mail (rules.ts): it is linked to its event on the user's Google
 *   Calendar instead, and never becomes a todo or a meeting proposal.
 * - Each email is read with the user's profile (profile.ts). Only mail from
 *   people the user corresponds with also goes through extractEntities, in
 *   parallel, and only the people and companies it names are kept.
 * - The user's labels (labels.ts) go to the model with their examples, and
 *   mail from an example's sender gets the label without it.
 * - Preamble DB reads (delegation rules, labels, sender memory) run in
 *   parallel via Promise.all.
 * - Results are flushed to email_processed / knowledge_base as they complete
 *   (micro-batched) so Realtime streams rows to the UI progressively instead
 *   of waiting for the slowest email.
 */

import type { Db } from "./db.ts";
import { getEnv } from "./config.ts";
import { extractEntities, processFullEmail } from "./ai.ts";
import { isLocalModel } from "./llm.ts";
import { correspondents, profileContext } from "./profile.ts";
import { isBulk, writtenTo } from "./senders.ts";
import { labelsBySender, labelsForPrompt, userLabels } from "./labels.ts";
import { findCalendarEvent, type LinkedEvent } from "./gmail.ts";
import type { CalendarEvent } from "./rules.ts";

// The event a calendar email is about: on the user's calendar when Google
// Calendar has it, otherwise what its .ics says.
async function linkCalendar(tokenRef: string | undefined, e: Record<string, unknown>): Promise<LinkedEvent | null> {
  const ics = e.calendar_event as CalendarEvent | null;
  try {
    if (tokenRef && (ics?.uid || ics?.start)) {
      const found = await findCalendarEvent(tokenRef, { uid: ics.uid, start: ics.start, people: [String(e.sender_email ?? "")] });
      if (found) return { ...found, method: ics.method };
    }
  } catch (err) {
    console.error("[analyzeEmailsForUser] calendar lookup:", (err as Error).message);
  }
  return ics?.start ? { id: null, title: ics.title, start: ics.start, end: ics.end, all_day: ics.all_day, link: null, on_calendar: false, method: ics.method } : null;
}


/**
 * Analyze all unprocessed emails for a given user.
 * Returns the number of emails analyzed.
 */
export async function analyzeEmailsForUser(
  userId: string,
  db: Db,
): Promise<{ analyzed: number }> {
  const { data: alreadyProcessed } = await db
    .from("email_processed")
    .select("email_id")
    .eq("user_id", userId);
  const processedIds = (alreadyProcessed || []).map((p) => p.email_id as string);

  let unprocessedQuery = db
    .from("emails")
    .select("id, subject, sender, sender_email, recipients, body_text, snippet, label_ids, has_attachments, has_list_unsubscribe, is_reply, reply_to_email, cc_recipients, precedence_header, list_id, is_calendar, calendar_event, gmail_account_id")
    .eq("user_id", userId)
    .not("label_ids", "cs", '{"SENT"}')
    .order("received_at", { ascending: false })
    .limit(100);

  if (processedIds.length > 0) {
    unprocessedQuery = unprocessedQuery.not("id", "in", `(${processedIds.join(",")})`);
  }

  const { data: unprocessed } = await unprocessedQuery;
  const emailsToProcess = unprocessed || [];

  if (emailsToProcess.length === 0) {
    return { analyzed: 0 };
  }

  // ── Parallel preamble: fetch all per-user config + sender memory at once ──
  const senderEmails = [
    ...new Set(emailsToProcess.map((e) => e.sender_email as string).filter(Boolean)),
  ];

  const [
    delegationRulesRes,
    labels,
    memRowsRes,
    profileRes,
    accountsRes,
  ] = await Promise.all([
    db
      .from("delegation_rules")
      .select("pattern, target_email")
      .eq("user_id", userId)
      .eq("is_enabled", true),
    userLabels(userId),
    senderEmails.length > 0
      ? db
          .from("email_memory")
          .select("sender_email, interaction_count")
          .eq("user_id", userId)
          .in("sender_email", senderEmails)
      : Promise.resolve({ data: [] as { sender_email: string; interaction_count: number }[] }),
    db
      .from("profiles")
      .select("working_hours")
      .eq("id", userId)
      .maybeSingle(),
    db.from("gmail_accounts").select("id, token_ref").eq("user_id", userId),
  ]);
  const tokenRefs = new Map<string, string>((accountsRes.data ?? []).map((a) => [String(a.id), String(a.token_ref)]));

  const [known, written] = await Promise.all([correspondents(userId, senderEmails as string[]), writtenTo(userId)]);

  // Meeting extraction has to resolve relative dates ("Friday", "tomorrow")
  // against the user's day, not the edge runtime's UTC day.
  const userTimezone =
    ((profileRes.data?.working_hours as { timezone?: string } | null)
      ?.timezone) || "UTC";

  const delegationRules = delegationRulesRes.data ?? [];
  const memRows = memRowsRes.data ?? [];
  const userTags = labelsForPrompt(labels);
  // Labels an email gets from its sender, whatever else is decided.
  const bySender = (email: Record<string, unknown>) => labelsBySender(labels, String(email.sender_email ?? ""));
  const extra = (slugs: string[]) => (slugs.length ? [...new Set(slugs)] : null);

  const senderInteractionMap = new Map<string, number>();
  for (const row of memRows) {
    senderInteractionMap.set(row.sender_email as string, row.interaction_count as number);
  }

  // ── Micro-batching flush: stream rows into email_processed as they finish ──
  // so Realtime updates the UI progressively and the slowest email never
  // delays earlier ones from appearing.
  const rowBuffer: Record<string, unknown>[] = [];
  const kbBuffer: Record<string, unknown>[] = [];
  const FLUSH_SIZE = 8;

  const flushRows = async () => {
    if (rowBuffer.length === 0) return;
    const batch = rowBuffer.splice(0, rowBuffer.length);
    try {
      await db.from("email_processed").upsert(batch, { onConflict: "email_id" });
    } catch (err) {
      console.error("[analyzeEmailsForUser] upsert email_processed:", (err as Error).message);
    }
  };
  const flushKb = async () => {
    if (kbBuffer.length === 0) return;
    const batch = kbBuffer.splice(0, kbBuffer.length);
    try {
      await db
        .from("knowledge_base")
        .upsert(batch, { onConflict: "user_id,entity,entity_type" });
    } catch (err) {
      console.error("[analyzeEmailsForUser] upsert knowledge_base:", (err as Error).message);
    }
  };

  // Concurrency ceiling. For initial loads of ~50 this dispatches everything
  // at once. The cap only matters if we ever hand this function a huge backlog.
  const CONCURRENCY = Math.max(
    1,
    parseInt(getEnv("AI_PROCESS_CONCURRENCY") || (isLocalModel("fast") ? "2" : "8"), 10),
  );

  let processed = 0;
  let nextIdx = 0;

  const analyzeOne = async (email: Record<string, unknown>) => {
    try {
      const gmailLabels = (email.label_ids as string[]) ?? [];
      if (email.is_calendar) {
        rowBuffer.push({
          user_id: userId,
          email_id: email.id as string,
          category: "updates",
          urgency: "low",
          summary: null,
          quick_actions: [],
          extra_labels: extra(bySender(email)),
          calendar: await linkCalendar(tokenRefs.get(String(email.gmail_account_id)), email),
        });
        processed += 1;
        if (rowBuffer.length >= FLUSH_SIZE) await flushRows();
        return;
      }
      if (isBulk(email as Parameters<typeof isBulk>[0], written)) {
        rowBuffer.push({
          user_id: userId,
          email_id: email.id as string,
          category: gmailLabels.includes("CATEGORY_PROMOTIONS") ? "promotions" : "updates",
          urgency: "low",
          summary: null,
          quick_actions: [],
          extra_labels: extra(bySender(email)),
        });
        processed += 1;
        if (rowBuffer.length >= FLUSH_SIZE) await flushRows();
        return;
      }
      const ccStr = (email.cc_recipients as string) ?? "";
      const signals = {
        gmailLabels,
        hasAttachments: email.has_attachments as boolean,
        isReply: email.is_reply as boolean,
        hasListUnsubscribe: email.has_list_unsubscribe as boolean,
        replyToEmail: email.reply_to_email as string | undefined,
        ccRecipients: ccStr || undefined,
        precedenceHeader: email.precedence_header as string | undefined,
        senderInteractionCount: senderInteractionMap.get(email.sender_email as string),
      };

      const subject = (email.subject as string) || "";
      const sender = (email.sender as string) || "";
      const body = (email.body_text as string) || (email.snippet as string) || "";

      const profile = await profileContext(userId, { sender_email: email.sender_email as string, subject, text: body });
      const corresponds = known.has(String(email.sender_email ?? "").toLowerCase());
      const [result, rawEntities] = await Promise.all([
        processFullEmail(
          subject,
          sender,
          body,
          signals,
          userTags.length > 0 ? userTags : undefined,
          userTimezone,
          profile,
        ),
        corresponds
          ? extractEntities(subject, sender, body).catch((err) => {
              console.error("[analyzeEmailsForUser] entity extraction:", err);
              return [] as { entity: string; entity_type: string; info: string }[];
            })
          : Promise.resolve([] as { entity: string; entity_type: string; info: string }[]),
      ]);

      const delegationActions: { label: string; action: string; target: string }[] = [];
      if (delegationRules.length) {
        const searchText = `${subject} ${body}`.toLowerCase();
        for (const rule of delegationRules) {
          if (searchText.includes((rule.pattern as string).toLowerCase())) {
            delegationActions.push({
              label: `Delegate to ${rule.target_email}`,
              action: "delegate",
              target: rule.target_email as string,
            });
          }
        }
      }

      const finalCategory = result.category;
      const extraLabels = [...(result.tags || []), ...bySender(email)];

      rowBuffer.push({
        user_id: userId,
        email_id: email.id as string,
        category: finalCategory,
        urgency: result.urgency,
        summary: result.summary,
        quick_actions: [...(result.quick_actions as object[]), ...delegationActions],
        extra_labels: extra(extraLabels),
      });

      // People and companies only; topics and places from one email are trivia.
      if (finalCategory !== "promotions") {
        for (const entity of rawEntities.filter((x) => x.entity_type === "person" || x.entity_type === "company")) {
          kbBuffer.push({
            user_id: userId,
            entity: entity.entity,
            entity_type: entity.entity_type,
            info: entity.info,
            source: "email",
            confidence: 0.8,
          });
        }
      }

      processed += 1;

      // Opportunistic flushes: when a buffer hits FLUSH_SIZE, write now so the
      // frontend sees rows stream in while later emails are still analyzing.
      if (rowBuffer.length >= FLUSH_SIZE) await flushRows();
      if (kbBuffer.length >= FLUSH_SIZE) await flushKb();
    } catch (e) {
      console.error("[analyzeEmailsForUser] failed for email:", (e as Error).message);
    }
  };

  // Simple rolling worker pool: N workers each pull the next email off the
  // shared index until the list is exhausted. This removes the chunk barrier
  // in the old implementation where the slowest email in each group of 10
  // blocked the next group from starting.
  const worker = async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= emailsToProcess.length) return;
      await analyzeOne(emailsToProcess[i] as Record<string, unknown>);
    }
  };

  const workerCount = Math.min(CONCURRENCY, emailsToProcess.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Final flush for anything that didn't hit the FLUSH_SIZE threshold.
  await Promise.all([flushRows(), flushKb()]);

  return { analyzed: processed };
}
