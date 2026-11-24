// The local API: every route the interface calls under /api.
//
//   POST /fetch-emails          Fetch and analyze new Gmail messages
//   POST /send-email            Send an email now
//   POST /draft-email           Draft a new email or reply
//   POST /refine-draft          Rewrite a draft
//   POST /generate-draft        Draft a reply to a stored email
//   POST /analyze-inbox         Re-analyze unprocessed or all emails
//   POST /learn-style           Learn the user's writing style from sent mail
//   GET  /briefing              The Brief
//   GET  /calendar/free-slots   Free calendar slots
//   GET  /calendar/events       Calendar events
//   POST /calendar/create-event Create a Google Calendar event
//   POST /calendar/update-event Update a Google Calendar event
//   POST /meetings/confirm      Put a meeting waiting to be confirmed on Google Calendar
//   POST /rethink-email         Re-categorize one email
//   GET  /contacts/search       Search contacts
//   POST /contacts/sync         Import Google contacts
//   POST /remove-gmail-account  Disconnect a Gmail account
//   DELETE /delete-all-data     Wipe local mail data
//   POST /chat                  Assistant chat with inbox tools
//   GET|POST /follow-ups, PATCH|DELETE /follow-ups/:id, GET /follow-ups/list
//   GET|POST /signatures, PATCH|DELETE /signatures/:id
//   GET  /attachment            Fetch a Gmail attachment
//   POST /agent/step|answer|execute|cancel   The agent (started from /chat)
//   GET  /engine/status, POST /engine/autostart, POST /mail/state
//   POST /actions/approve|dismiss|undo   The action log

import { followupList, judgeSent } from "./followups.ts";
import { listNewsletters, unsubscribe, archiveSender, keepSender } from "./newsletters.ts";
import { db, type Db } from "./db.ts";
import { modelConfigured } from "./llm.ts";
import { searchGoogleContacts, listAllGoogleContacts } from "./gmail.ts";
import { mail, userCalendar } from "./providers.ts";
import {
  chatWithAssistant,
  composeDraft,
  refineDraft,
  generateDraft,
  processFullEmail,
  type ChatContext,
} from "./ai.ts";
import { syncMail, analyzeInbox } from "./sync.ts";
import { accountById, accountFor, accountsForWindow, defaultAccount, fromLine, listAccounts, removeAccount, replyFrom, updateAccount } from "./accounts.ts";
import { saveUserDraft } from "./drafts.ts";
import { kickEngine, draftReply, engineStatus, planNew } from "./engine.ts";
import { learnFromSent, startFirstRead } from "./firstRead.ts";
import { approve, dismiss, undo, record, engineSettings, setMailState } from "./actions.ts";
import { answer, applyPref, feedback, profileContext, setPref, type Feedback } from "./profile.ts";
import { autostartInstalled, installAutostart, removeAutostart } from "./launchd.ts";
import { brief } from "./brief.ts";
import { applyLabel, labelsBySender, labelsForPrompt, suggestLabels, userLabels } from "./labels.ts";
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

      const { count: accountCount } = await db
        .from("accounts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (!accountCount) {
        return json({ error: "No mailbox connected" }, 400, corsHeaders);
      }

      const allNew = await syncMail(userId, isInitialFetch);

      // The first fetch starts the first read (firstRead.ts), which sorts
      // this mail and reads further back in the
      // background while the window shows what has arrived.
      if (isInitialFetch) void startFirstRead(userId, () => planNew(userId));

      return json({ fetched: allNew.length, email_ids: allNew }, 200, corsHeaders);
    }

    // ── POST /analyze-inbox ─────────────────────────────────────────────────
    if (path === "/analyze-inbox" && req.method === "POST") {
      const result = await analyzeInbox(userId);
      kickEngine();
      return json(result, 200, corsHeaders);
    }

    // ── Background engine and the action log ───────────────────────────────
    //   GET  /engine/status              level, pause, last run, autostart
    //   POST /engine/autostart {on}      start Tabellar at login (launchd)
    //   POST /mail/state {ids, archived?, read?}  in Gmail and here
    //   POST /actions/approve {id, hash} carry out a proposal exactly as shown
    //   POST /actions/dismiss {id}
    //   POST /actions/undo {id}
    if (path === "/engine/status" && req.method === "GET") {
      return json({ ...(await engineSettings(userId)), ...engineStatus, model: modelConfigured(), autostart: autostartInstalled() });
    }
    // Archive or return to the inbox, mark read or unread: in Gmail and here.
    if (path === "/mail/state" && req.method === "POST") {
      const { ids, archived, read } = await req.json();
      if (!Array.isArray(ids) || !ids.length) return json({ error: "ids required" }, 400);
      await setMailState(userId, ids.map(String), {
        archived: typeof archived === "boolean" ? archived : undefined,
        read: typeof read === "boolean" ? read : undefined,
      });
      return json({ ok: true });
    }
    if (path === "/engine/autostart" && req.method === "POST") {
      const { on } = await req.json();
      if (on) installAutostart();
      else removeAutostart();
      return json({ autostart: autostartInstalled() });
    }
    if (path.startsWith("/actions/") && req.method === "POST") {
      const { id, hash } = await req.json();
      if (typeof id !== "string" || !UUID_RE.test(id)) return json({ error: "id is required" }, 400);
      try {
        if (path === "/actions/approve") await approve(userId, id, String(hash ?? ""));
        else if (path === "/actions/dismiss") await dismiss(userId, id);
        else if (path === "/actions/undo") await undo(userId, id);
        else return json({ error: "Not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      return json({ ok: true });
    }

    // ── What Tabellar knows about the user ─────────────────────────────────
    //   POST /questions/answer {id, option}       option is the index of the answer
    //   POST /profile/feedback {thing, outcome, id?, sender?, topic?}
    //   POST /preferences {kind, subject, value, replace?}   replace: the id of the row it edits
    if (path === "/questions/answer" && req.method === "POST") {
      const { id, option } = await req.json();
      if (typeof id !== "string" || !UUID_RE.test(id) || !Number.isInteger(option)) return json({ error: "id and option are required" }, 400);
      try {
        const { replan } = await answer(userId, id, option);
        if (replan) kickEngine();
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      return json({ ok: true });
    }
    if (path === "/profile/feedback" && req.method === "POST") {
      const f = (await req.json()) as Feedback;
      if (!["todo", "meeting", "followup", "newsletter"].includes(f.thing) || !["not_this", "never_sender", "never_topic"].includes(f.outcome)) {
        return json({ error: "thing and outcome are required" }, 400);
      }
      try {
        await feedback(userId, f);
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      return json({ ok: true });
    }
    if (path === "/preferences" && req.method === "POST") {
      const { kind, subject, value, replace } = await req.json();
      try {
        if (typeof replace === "string" && UUID_RE.test(replace)) await db.from("preferences").delete().eq("id", replace).eq("user_id", userId);
        await setPref(userId, String(kind ?? ""), String(subject ?? ""), String(value ?? ""), "user");
        await applyPref(userId, String(kind), String(subject ?? "").trim().toLowerCase(), String(value));
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      return json({ ok: true });
    }

    // ── Newsletter cleanup ──────────────────────────────────────────────────
    //   GET  /newsletters                         bulk senders, noisiest first
    //   POST /newsletters/unsubscribe {sender, confirm?}
    //   POST /newsletters/archive {sender}        archive their inbox mail (undoable)
    //   POST /newsletters/keep {sender, keep}
    if (path === "/newsletters" && req.method === "GET") {
      return json({ senders: await listNewsletters(userId) });
    }
    if (path.startsWith("/newsletters/") && req.method === "POST") {
      const { sender, confirm, keep } = await req.json();
      if (typeof sender !== "string" || !/^[^\s@]+@[^\s@]+$/.test(sender)) return json({ error: "sender is required" }, 400);
      const addr = sender.toLowerCase();
      try {
        if (path === "/newsletters/unsubscribe") return json(await unsubscribe(userId, addr, typeof confirm === "string" ? confirm : undefined));
        if (path === "/newsletters/archive") return json(await archiveSender(userId, addr));
        if (path === "/newsletters/keep") {
          await keepSender(userId, addr, keep !== false);
          return json({ ok: true });
        }
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      return json({ error: "Not found" }, 404);
    }

    // ── Labels (labels.ts) ─────────────────────────────────────────────────
    //   POST /labels/apply {email_id, slug, on}   put an email in or out of a label
    //   GET  /labels/gmail                        the user's own Gmail labels
    //   GET  /labels/suggestions                  labels to suggest, worked out once
    //   POST /labels/suggestions/dismiss {name}
    if (path === "/labels/apply" && req.method === "POST") {
      const { email_id, slug, on } = await req.json();
      if (typeof email_id !== "string" || typeof slug !== "string") return json({ error: "email_id and slug are required" }, 400);
      try {
        await applyLabel(userId, email_id, slug, on !== false);
        return json({ ok: true });
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
    }
    if (path === "/labels/gmail" && req.method === "GET") {
      const names = new Set<string>();
      for (const a of await listAccounts(userId)) for (const n of await mail(a).labelNames(a).catch(() => [])) names.add(n);
      return json({ labels: [...names].sort((x, y) => x.localeCompare(y)) });
    }
    if (path === "/labels/suggestions" && req.method === "GET") {
      const { data } = await db.from("profiles").select("label_suggestions").eq("id", userId).maybeSingle();
      const stored = data?.label_suggestions as unknown[] | null;
      return json({ suggestions: Array.isArray(stored) ? stored : await suggestLabels(userId).catch(() => []) });
    }
    if (path === "/labels/suggestions/dismiss" && req.method === "POST") {
      const { name } = await req.json();
      const { data } = await db.from("profiles").select("label_suggestions").eq("id", userId).maybeSingle();
      const left = ((data?.label_suggestions as { name: string }[] | null) ?? []).filter((x) => x.name !== name);
      await db.from("profiles").update({ label_suggestions: left }).eq("id", userId);
      return json({ suggestions: left });
    }

    // ── POST /learn-style ───────────────────────────────────────────────────
    if (path === "/learn-style" && req.method === "POST") {
      const account = await defaultAccount(userId);
      if (!account) {
        return json({ error: "No account connected" }, 400, corsHeaders);
      }

      const { sent } = await learnFromSent(userId, account, { facts: false });
      if (sent < 3) return json({ error: "Need at least 3 sent emails to analyze" }, 400, corsHeaders);
      const { data: style } = await db.from("style_profiles").select("greeting_style, closing_style, tone, avg_length").eq("user_id", userId).maybeSingle();
      return json({ learned: true, sample_count: sent, style }, 200, corsHeaders);
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

      // The account sends from the address chosen (or its default); an
      // address alone picks the account that owns it.
      const all = await listAccounts(userId);
      const account = all.find((a) => a.id === body.account_id) ?? accountFor(all, body.from_address) ?? (await defaultAccount(userId));
      if (!account) {
        return json({ error: "No account connected" }, 400, corsHeaders);
      }

      const from = await fromLine(userId, account, body.from_address);
      const m = { from, to: body.to ?? [], cc: body.cc, bcc: body.bcc, subject: body.subject ?? "", html: body.body_html ?? "", inReplyTo: body.in_reply_to, attachments: body.attachments ?? undefined };
      // A saved draft in that mailbox's Drafts is sent from there, so it leaves Drafts.
      const result =
        typeof body.gmail_draft_id === "string"
          ? await mail(account).sendDraft(account, body.gmail_draft_id, m, body.thread_id)
          : await mail(account).send(account, m, body.thread_id);

      // Persist sent email to DB so SentView reads from local storage
      {
        const { error: insertErr } = await db
          .from("emails")
          .upsert(
            {
              user_id: userId,
              gmail_id: result.id,
              account_id: account.id,
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
          // People and companies that match the recipient.
          const recipientDomain = recipientEmail?.split("@")[1] ?? "";
          const recipientFirstName = recipientName?.split(" ")[0] ?? "";
          const filters: string[] = [];
          if (recipientFirstName.length > 1) filters.push(`entity.ilike.%${recipientFirstName}%`, `info.ilike.%${recipientFirstName}%`);
          if (recipientDomain.length > 3) filters.push(`entity.ilike.%${recipientDomain}%`, `info.ilike.%${recipientDomain}%`);
          if (!filters.length) return { data: [] as { entity: string; entity_type: string; info: string }[] };
          return db
            .from("knowledge_base")
            .select("entity, entity_type, info")
            .eq("user_id", userId)
            .in("entity_type", ["person", "company"])
            .or(filters.join(","))
            .limit(8);
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
      const about = await profileContext(userId, { sender_email: recipientEmail, subject: body.subject ?? "", text: body.replyTo?.body ?? "" });
      if (about) kbParts.push(about);
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

      const draft = await draftReply(userId, emails[0] as Parameters<typeof draftReply>[1], body.instructions ?? "");

      return json({ draft }, 200, corsHeaders);
    }

    // ── GET /briefing: what needs the user today (brief.ts) ──────────────
    if (path === "/briefing" && req.method === "GET") {
      return json(await brief(userId), 200, corsHeaders);
    }

    // ── GET /calendar/free-slots ───────────────────────────────────────────
    if (path === "/calendar/free-slots" && req.method === "GET") {
      const cal = await userCalendar(userId);
      if (!cal) {
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

      let busyPeriods: { start: string; end: string }[];
      try {
        busyPeriods = await cal.calendar.busy(cal.account, dayMin, dayMax);
      } catch {
        return json({ error: "Calendar API failed", slots: [] }, 200, corsHeaders);
      }

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
      const cal = await userCalendar(userId);
      if (!cal) {
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

      // `days` from that date on, today alone by default.
      const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "1", 10) || 1, 1), 31);
      const timeMin = zonedMidnight(y, mo - 1, d, timezone, false);
      const timeMax = zonedMidnight(y, mo - 1, d + days - 1, timezone, true);

      let events;
      try {
        events = await cal.calendar.events(cal.account, timeMin, timeMax, Math.min(25 * days, 250));
      } catch (e) {
        console.error("[calendar/events]", (e as Error).message);
        return json({ error: "Calendar API failed", events: [] }, 200, corsHeaders);
      }
      return json({ events }, 200, corsHeaders);
    }

    // ── POST /meetings/confirm ─────────────────────────────────────────────
    // Puts a meeting waiting to be confirmed on Google Calendar: a meetings
    // row by `id`, or a proposal by `proposal` {id, hash}, which is approved
    // first. `title`, `start_time`, `end_time`, `location` and `attendees`
    // change it on the way. Only the
    // people the user added are invited; Tabellar invites nobody by itself.
    if (path === "/meetings/confirm" && req.method === "POST") {
      const body = await req.json();
      let meetingId = typeof body.id === "string" ? body.id : "";
      try {
        if (body.proposal?.id) meetingId = String((await approve(userId, String(body.proposal.id), String(body.proposal.hash ?? ""))).meetingId ?? "");
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      const { data: m } = await db.from("meetings").select("*").eq("id", meetingId).eq("user_id", userId).maybeSingle();
      if (!m) return json({ error: "That meeting is gone" }, 404);
      const changes: Record<string, unknown> = {};
      for (const k of ["title", "start_time", "end_time", "location"]) if (typeof body[k] === "string" && body[k]) changes[k] = body[k];
      if (Array.isArray(body.attendees)) changes.attendees = body.attendees.map(String).filter(Boolean);
      if (Object.keys(changes).length) await db.from("meetings").update(changes).eq("id", m.id);
      const meeting = { ...m, ...changes };
      const cal = await userCalendar(userId);
      if (!cal) return json({ error: "No calendar is connected. Connect a Google or Outlook account in Settings." }, 502);
      const attendees = Array.isArray(meeting.attendees) ? (meeting.attendees as string[]) : [];
      let ev: { id: string; link: string | null };
      try {
        // Only the people the user added are invited.
        ev = await cal.calendar.create(
          cal.account,
          { title: meeting.title, description: meeting.description ?? "", start: meeting.start_time, end: meeting.end_time, ...(meeting.location ? { location: meeting.location } : {}), attendees },
          attendees.length > 0,
        );
      } catch {
        return json({ error: "The calendar did not accept it" }, 502);
      }
      await db.from("meetings").update({ status: "confirmed", calendar_event_id: ev.id }).eq("id", m.id);
      return json({ ok: true, meetingId: m.id, link: ev.link });
    }

    // ── POST /calendar/create-event, /calendar/update-event ────────────────
    if ((path === "/calendar/create-event" || path === "/calendar/update-event") && req.method === "POST") {
      const body = await req.json();
      const update = path === "/calendar/update-event";
      if (update && !body.event_id) return json({ error: "event_id required" }, 400, corsHeaders);
      const cal = await userCalendar(userId);
      if (!cal) return json({ error: "No calendar access" }, 400, corsHeaders);
      const event = {
        ...(body.title ? { title: body.title } : {}),
        ...(body.description !== undefined || !update ? { description: body.description || "" } : {}),
        ...(body.start_time ? { start: body.start_time } : {}),
        ...(body.end_time ? { end: body.end_time } : {}),
        timeZone: body.timezone || "UTC",
        ...(body.location !== undefined && (update || body.location) ? { location: body.location } : {}),
        ...(Array.isArray(body.attendees) && (update || body.attendees.length) ? { attendees: body.attendees as string[] } : {}),
      };
      try {
        const ev = update ? await cal.calendar.update(cal.account, String(body.event_id), event, cal.invite) : await cal.calendar.create(cal.account, event, cal.invite);
        return json({ event_id: ev.id, html_link: ev.link }, 200, corsHeaders);
      } catch {
        return json({ error: "Calendar API error" }, 400, corsHeaders);
      }
    }

    // ── POST /rethink-email ────────────────────────────────────────────────
    if (path === "/rethink-email" && req.method === "POST") {
      const body = await req.json();
      const emailId = body.email_id as string;

      const { data: emails } = await db
        .from("emails")
        .select("id, subject, sender, sender_email, body_text, snippet")
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
      const labels = await userLabels(userId);
      const result = await processFullEmail(
        (email.subject as string) || "",
        (email.sender as string) || "",
        (email.body_text as string) || (email.snippet as string) || "",
        undefined,
        labelsForPrompt(labels),
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
          extra_labels: [...new Set([...result.tags, ...labelsBySender(labels, String(email.sender_email ?? ""))])],
        },
        { onConflict: "email_id" },
      );

      return json({ ...result, email_id: emailId }, 200, corsHeaders);
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
        .from("accounts")
        .select("token_ref, provider")
        .eq("id", accountId)
        .eq("user_id", userId)
        .single();
      // Only Google keeps a contact list Tabellar can search.
      if (!account?.token_ref || account.provider !== "gmail") {
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
        .from("accounts")
        .select("id, token_ref")
        .eq("user_id", userId)
        .eq("provider", "gmail");

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
              account_id: account.id,
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

    // ── Accounts ───────────────────────────────────────────────────────────
    //   GET  /accounts                                   each with its From addresses
    //   POST /accounts/update {id, paused?, is_default?, default_from?}
    //   POST /accounts/remove {id}                       revoke and forget its mail
    if (path === "/accounts" && req.method === "GET") {
      return json({ accounts: await accountsForWindow(userId) });
    }
    if (path === "/accounts/update" && req.method === "POST") {
      const body = await req.json();
      await updateAccount(userId, String(body.id ?? ""), body);
      if (body.paused === false) kickEngine();
      return json({ accounts: await accountsForWindow(userId) });
    }
    if (path === "/accounts/remove" && req.method === "POST") {
      const { id } = await req.json();
      if (typeof id !== "string") return json({ error: "id is required" }, 400);
      await removeAccount(userId, id);
      return json({ accounts: await accountsForWindow(userId) });
    }

    // ── POST /drafts/save ──────────────────────────────────────────────────
    // A draft from compose, kept here and in the mailbox's Drafts.
    if (path === "/drafts/save" && req.method === "POST") {
      return json(await saveUserDraft(userId, await req.json()));
    }

    // ── DELETE /delete-all-data ────────────────────────────────────────────
    if (path === "/delete-all-data" && req.method === "DELETE") {
      // Wipe everything Tabellar learned or stored. The profile and the
      // connected accounts stay, so the user remains signed in.
      for (const t of ["agent_sessions", "email_processed", "todos", "meetings", "follow_up_reminders",
        "scheduled_emails", "draft_emails", "email_memory", "contacts", "knowledge_base", "categories", "preferences", "questions", "conversations",
        "delegation_rules", "style_profiles", "email_templates", "email_signatures", "newsletter_senders", "emails"]) {
        const { error } = await db.from(t).delete().eq("user_id", userId);
        if (error) return json({ error: "Failed to delete data: " + error.message }, 500, corsHeaders);
      }
      await db.from("accounts").update({ history_id: null }).eq("user_id", userId);
      await db.from("profiles").update({ style_notes: null }).eq("id", userId);
      return json({ deleted: true }, 200, corsHeaders);
    }

    // ── POST /chat ───────────────────────────────────────────────────────────
    if (path === "/chat" && req.method === "POST") {
      const { message, history = [], timezone = "UTC", conversation_id } = await req.json();

      if (!message?.trim()) {
        return json({ error: "Message required" }, 400, corsHeaders);
      }

      // The answer kept in its conversation here, so it lands even if the window was closed.
      const keep = async (reply: string, actions: unknown[]) => {
        if (typeof conversation_id !== "string") return;
        const { data: conv } = await db.from("conversations").select("messages").eq("id", conversation_id).eq("user_id", userId).maybeSingle();
        if (!conv) return;
        const messages = [...((conv.messages as unknown[]) ?? []), { role: "assistant", content: reply, actions }];
        await db.from("conversations").update({ messages, updated_at: new Date().toISOString() }).eq("id", conversation_id);
      };

      // The plan a cleanup request shows: the one already going, or a new one.
      const cleanupPlan = async (): Promise<string> => {
        const { data: going } = await db
          .from("agent_sessions")
          .select("id")
          .eq("user_id", userId)
          .is("parent_id", null)
          .in("status", ["planning", "asking", "ready", "executing"])
          .order("created_at", { ascending: false })
          .limit(1);
        if (going?.[0]?.id) return going[0].id as string;
        const id = await startAgentSession(db, userId);
        void runAgentStepParallel(id, db, timezone).catch((e) => console.error("[chat] plan:", e));
        return id;
      };

      // "Clean up my inbox" and the like start the plan without asking the
      // model whether to: a small model would rather describe a plan.
      if (message.length < 120 && /^\s*(please\s+)?((can|could|would) you\s+)?(please\s+)?(clean\s*up|clear|tidy( up)?|triage|go through|sort out|deal with)\s+(my\s+|the\s+)?(inbox|mail|emails)\b/i.test(message)) {
        const reply = "A cleanup plan for the last week of your inbox. Nothing runs until you approve it.";
        const actions = [{ type: "plan_cleanup", data: { session_id: await cleanupPlan() } }];
        await keep(reply, actions);
        return json({ reply, actions }, 200, corsHeaders);
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

      // Pause stops these too; the assistant is told and nothing runs.
      const { paused } = await engineSettings(userId);
      // Paused: nothing is done, but reading and planning go on.
      const ACTS = new Set(["create_todo", "update_todo", "delete_todo", "save_draft", "delete_draft", "add_knowledge", "create_tag", "send_email", "reply_to_email", "create_meeting", "update_meeting", "delete_meeting", "archive_email", "set_follow_up"]);
      for (const tc of tool_calls.filter((t) => !paused || !ACTS.has(t.name))) {
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
              color: args.color ?? "#8a857d",
              position: 10_000,
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
            const account = await defaultAccount(userId);
            if (account) {
              const bodyHtml = (args.body ?? "").replace(/\n/g, "<br>");
              const result = await mail(account).send(account, { from: await fromLine(userId, account, null), to: toCheck.emails!, subject: args.subject, html: bodyHtml });
              console.log("[chat/send_email] sent OK, message_id:", result.id);
              await record(userId, { kind: "send", emailId: null, summary: `Sent "${args.subject}" to ${toCheck.emails!.join(", ")} (asked in chat)`, detail: { to: toCheck.emails, subject: args.subject } }, "assistant");

              // Save to emails table so SentView can display it
              try {
                await db.from("emails").insert({
                  user_id: userId,
                  gmail_id: result.id,
                  account_id: account.id,
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
                "[chat/send_email] no account found for userId:",
                userId,
              );
              actions.push({
                type: "send_email_failed",
                data: { error: "No mailbox connected" },
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
            // Fetch original email for threading headers; the reply goes out
            // from its account, from the address it was sent to.
            const { data: original } = await db
              .from("emails")
              .select("subject, sender_email, gmail_id, thread_id, account_id, recipients, cc_recipients")
              .eq("id", args.email_id)
              .eq("user_id", userId)
              .maybeSingle();
            const account = (await accountById(userId, original?.account_id as string)) ?? (await defaultAccount(userId));
            if (!account) {
              actions.push({
                type: "send_email_failed",
                data: { error: "No account connected" },
              });
            } else {
              if (!original) {
                actions.push({
                  type: "send_email_failed",
                  data: { error: "Original email not found" },
                });
              } else {
                const subject = (original as any).subject?.startsWith("Re:")
                  ? (original as any).subject
                  : `Re: ${(original as any).subject}`;
                const result = await mail(account).send(
                  account,
                  {
                    from: await fromLine(userId, account, replyFrom(account, original as any)),
                    to: [(original as any).sender_email],
                    subject,
                    html: args.body.replace(/\n/g, "<br>"),
                    inReplyTo: (original as any).gmail_id,
                  },
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
          await setMailState(userId, [args.email_id], { archived: true });
          actions.push({ type: "archive_email", data: tc.arguments });
        } else if (tc.name === "plan_cleanup") {
          actions.push({ type: "plan_cleanup", data: { session_id: await cleanupPlan() } });
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

            const cal = await userCalendar(userId);
            if (cal) {
              try {
                const ev = await cal.calendar.create(
                  cal.account,
                  { title: args.title, description: args.description || "", start: startDt, end: endDt, timeZone: userTz, attendees: args.attendees ?? [] },
                  cal.invite,
                );
                await db.from("meetings").insert({
                  user_id: userId,
                  title: args.title,
                  start_time: startIso,
                  end_time: endIso,
                  attendees: args.attendees ?? [],
                  description: args.description || "",
                  calendar_event_id: ev.id,
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
              } catch {
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

      if (paused && tool_calls.some((t) => ACTS.has(t.name))) actions.push({ type: "paused", data: { message: "Tabellar is paused, so nothing was done. Resume it with the play button above Settings." } });
      await keep(reply, actions);
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

    // ── GET /follow-ups/list: reminders that are due and suggested ones ───
    if (path === "/follow-ups/list" && req.method === "GET") {
      void judgeSent(userId).catch((e) => console.error("[follow-ups] judging:", e));
      return json({ followups: await followupList(userId) }, 200, corsHeaders);
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
        .select("id, name, html, is_default, account_id, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 500, corsHeaders);
      return json({ signatures: data ?? [] }, 200, corsHeaders);
    }

    // ── POST /signatures — create a new signature ─────────────────────────
    if (path === "/signatures" && req.method === "POST") {
      const { name, html, is_default, account_id } = await req.json();
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
        await (account_id
          ? clear.eq("account_id", account_id)
          : clear.is("account_id", null));
      }
      const { data, error } = await db
        .from("email_signatures")
        .insert({
          user_id: userId,
          name: name.trim(),
          html: html ?? "",
          is_default: !!is_default,
          account_id: account_id ?? null,
        })
        .select("id, name, html, is_default, account_id, created_at")
        .single();
      if (error) return json({ error: error.message }, 500, corsHeaders);
      return json({ signature: data }, 200, corsHeaders);
    }

    // ── PATCH /signatures/:id — update a signature ────────────────────────
    if (path.startsWith("/signatures/") && req.method === "PATCH") {
      const sigId = path.replace("/signatures/", "");
      if (!UUID_RE.test(sigId))
        return json({ error: "Invalid id" }, 400, corsHeaders);
      const { name, html, is_default, account_id } = await req.json();
      // Fetch current row to get its account scope
      const { data: existing } = await db
        .from("email_signatures")
        .select("account_id")
        .eq("id", sigId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!existing) return json({ error: "Not found" }, 404, corsHeaders);
      if (is_default) {
        const accountScope =
          account_id ?? existing.account_id ?? null;
        const clear = db
          .from("email_signatures")
          .update({ is_default: false })
          .eq("user_id", userId)
          .eq("is_default", true)
          .neq("id", sigId);
        // See the POST handler: eq never matches NULL, so a global signature's
        // scope has to be matched with is().
        await (accountScope
          ? clear.eq("account_id", accountScope)
          : clear.is("account_id", null));
      }
      const patch: Record<string, unknown> = {};
      if (name !== undefined) patch.name = name.trim();
      if (html !== undefined) patch.html = html;
      if (is_default !== undefined) patch.is_default = is_default;
      if (account_id !== undefined)
        patch.account_id = account_id;
      const { data, error } = await db
        .from("email_signatures")
        .update(patch)
        .eq("id", sigId)
        .eq("user_id", userId)
        .select("id, name, html, is_default, account_id, created_at")
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
        .select("account_id")
        .eq("user_id", userId)
        .eq("gmail_id", gmailId)
        .maybeSingle();
      if (!emailRow?.account_id) {
        return json({ error: "Email not found" }, 404, corsHeaders);
      }

      const account = await accountById(userId, emailRow.account_id as string);
      if (!account) {
        return json({ error: "The account for this email is not connected" }, 404, corsHeaders);
      }

      const result = await mail(account).attachment(account, gmailId, attachmentId);
      if (!result)
        return json({ error: "Failed to fetch attachment" }, 502, corsHeaders);

      return json({ data: result.data, size: result.size }, 200, corsHeaders);
    }

    // ── Solve-Everything agent routes ────────────────────────────────────
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
