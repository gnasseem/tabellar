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
 * - Bulk mail (senders.readWithoutModel: promotions, a mailing list's
 *   headers, or List-Unsubscribe outside Gmail's Primary tab, never from
 *   someone the user wrote to) is sorted from its headers alone; the model
 *   never reads it. Neither does
 *   calendar mail (rules.ts): it is linked to its event on the user's Google
 *   Calendar instead, and never becomes a todo or a meeting proposal.
 * - Each email is read with the user's profile (profile.ts), in one model
 *   call. For mail from people the user corresponds with, the same call also
 *   names the people and companies worth remembering.
 * - Mail older than rules.ACT_WITHIN_MS is only sorted and summarised: the
 *   model is not asked for todos, meetings or a reply, since none are made,
 *   and what Gmail kept out of Primary from strangers is sorted without it.
 * - Mail from the most important people goes to the model first, then from
 *   those, then the rest, newest
 *   first in each group. A local model takes a batch of 20 at a time, so new
 *   mail that arrives meanwhile is read before the rest of an older backlog.
 * - The user's labels (labels.ts) go to the model with their examples, and
 *   mail from an example's sender gets the label without it.
 * - Preamble DB reads (labels, sender memory) run in
 *   parallel via Promise.all.
 * - Results are flushed to email_processed / knowledge_base as they complete
 *   (micro-batched) so Realtime streams rows to the UI progressively instead
 *   of waiting for the slowest email.
 */

import type { Db } from "./db.ts";
import { unprocessedIds } from "./db.ts";
import { getEnv } from "./config.ts";
import { ModelDown, processFullEmail, UnreadableAnswer } from "./ai.ts";
import { isLocalModel } from "./llm.ts";
import { allPrefs, correspondents, pick, profileContext } from "./profile.ts";
import { readWithoutModel, writtenTo } from "./senders.ts";
import { labelsBySender, labelsForPrompt, userLabels } from "./labels.ts";
import { calendarAccount, type LinkedEvent } from "./providers.ts";
import type { Account } from "./accounts.ts";
import { ACT_WITHIN_MS, type CalendarEvent } from "./rules.ts";

// The event a calendar email is about: on the user's calendar when it has
// it, otherwise what its .ics says.
async function linkCalendar(cal: ReturnType<typeof calendarAccount>, e: Record<string, unknown>): Promise<LinkedEvent | null> {
  const ics = e.calendar_event as CalendarEvent | null;
  try {
    if (cal && (ics?.uid || ics?.start)) {
      const found = await cal.calendar.find(cal.account, { uid: ics.uid, start: ics.start, people: [String(e.sender_email ?? "")] });
      if (found) return { ...found, method: ics.method };
    }
  } catch (err) {
    console.error("[analyzeEmailsForUser] calendar lookup:", (err as Error).message);
  }
  return ics?.start ? { id: null, title: ics.title, start: ics.start, end: ics.end, all_day: ics.all_day, link: null, on_calendar: false, method: ics.method } : null;
}


// What the model said last when it did not answer, until it does.
export const modelStatus = { error: null as string | null };
const unreadable = new Map<string, number>();

/**
 * Analyze all unprocessed emails for a given user.
 * Returns the number of emails analyzed.
 */
export async function analyzeEmailsForUser(
  userId: string,
  db: Db,
): Promise<{ analyzed: number }> {
  const ids = unprocessedIds(userId, isLocalModel("fast") ? 20 : 100);
  if (!ids.length) return { analyzed: 0 };
  const { data: unprocessed } = await db
    .from("emails")
    .select("id, subject, sender, sender_email, recipients, body_text, snippet, received_at, label_ids, has_attachments, has_list_unsubscribe, is_reply, reply_to_email, cc_recipients, precedence_header, list_id, is_calendar, is_receipt, calendar_event, account_id")
    .in("id", ids)
    .order("received_at", { ascending: false });
  const emailsToProcess = unprocessed || [];

  if (emailsToProcess.length === 0) {
    return { analyzed: 0 };
  }

  // ── Parallel preamble: fetch all per-user config + sender memory at once ──
  const senderEmails = [
    ...new Set(emailsToProcess.map((e) => e.sender_email as string).filter(Boolean)),
  ];

  const [
    labels,
    memRowsRes,
    profileRes,
    accountsRes,
  ] = await Promise.all([
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
    db.from("accounts").select("*").eq("user_id", userId),
  ]);
  const cal = calendarAccount((accountsRes.data ?? []) as unknown as Account[]);

  const [known, written] = await Promise.all([correspondents(userId, senderEmails as string[]), writtenTo(userId)]);
  // Mail new enough that todos, drafts and meetings are made from it.
  const recent = (e: Record<string, unknown>) => Date.now() - new Date(String(e.received_at)).getTime() <= ACT_WITHIN_MS;
  const corresponds = (e: Record<string, unknown>) => known.has(String(e.sender_email ?? "").toLowerCase());
  // The user's most important people first, then those they write to, then
  // everyone else; the sort keeps newest first within each.
  const prefs = await allPrefs(userId);
  const order = new Map<string, number>(emailsToProcess.map((e): [string, number] => [String(e.id), pick(prefs, String(e.sender_email ?? ""), "").some((p) => p.value === "vip") ? 2 : corresponds(e) ? 1 : 0]));
  emailsToProcess.sort((a, b) => order.get(String(b.id))! - order.get(String(a.id))!);

  // Meeting extraction has to resolve relative dates ("Friday", "tomorrow")
  // against the user's day, not the edge runtime's UTC day.
  const userTimezone =
    ((profileRes.data?.working_hours as { timezone?: string } | null)
      ?.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

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
          calendar: await linkCalendar(cal, email),
        });
        processed += 1;
        if (rowBuffer.length >= FLUSH_SIZE) await flushRows();
        return;
      }
      if (email.is_receipt) {
        rowBuffer.push({ user_id: userId, email_id: email.id as string, category: "updates", urgency: "low", summary: "Read receipt", quick_actions: [], extra_labels: null });
        processed += 1;
        if (rowBuffer.length >= FLUSH_SIZE) await flushRows();
        return;
      }
      if (readWithoutModel(email as Parameters<typeof readWithoutModel>[0], written, !recent(email))) {
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
      const result = await processFullEmail(
        subject,
        sender,
        body,
        signals,
        userTags.length > 0 ? userTags : undefined,
        userTimezone,
        profile,
        corresponds(email),
        recent(email),
        new Date(String(email.received_at)),
      );

      modelStatus.error = null;
      const finalCategory = result.category;
      const extraLabels = [...(result.tags || []), ...bySender(email)];

      rowBuffer.push({
        user_id: userId,
        email_id: email.id as string,
        category: finalCategory,
        urgency: result.urgency,
        summary: result.summary,
        quick_actions: result.quick_actions as object[],
        extra_labels: extra(extraLabels),
      });

      // People and companies only; topics and places from one email are trivia.
      if (finalCategory !== "promotions") {
        for (const entity of result.people) {
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
      if (e instanceof ModelDown) {
        // The rest would fail the same way; they are read when it answers again.
        modelStatus.error = e.message;
        nextIdx = emailsToProcess.length;
      } else if (e instanceof UnreadableAnswer) {
        // An email the model never answers properly about is kept without a
        // summary rather than asked about forever.
        const id = email.id as string;
        const tries = (unreadable.get(id) ?? 0) + 1;
        unreadable.set(id, tries);
        if (tries >= 3) rowBuffer.push({ user_id: userId, email_id: id, category: "updates", urgency: "low", summary: null, quick_actions: [], extra_labels: extra(bySender(email)) });
      }
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
