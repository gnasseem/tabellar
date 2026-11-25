// The local API: every route the interface calls under /api.
//
//   POST /fetch-emails          Fetch and analyze new Gmail messages
//   POST /send-email            Send an email now
//   POST /draft-email           Draft a new email or reply
//   POST /refine-draft          Rewrite a draft
//   POST /analyze-inbox         Re-analyze unprocessed or all emails
//   POST /writing/...           How the user writes: learn, set a line, a sample reply
//   GET  /briefing, POST /briefing/answer|undo, GET /briefing/decisions   The Brief, answered in place
//   GET  /calendar/free-slots   Free calendar slots
//   GET  /calendar/events       Calendar events
//   POST /calendar/create-event Create a Google Calendar event
//   POST /calendar/update-event Update a Google Calendar event
//   POST /meetings/confirm      Put a meeting waiting to be confirmed on Google Calendar
//   POST /rethink-email         Re-categorize one email
//   GET  /contacts/search       Search contacts
//   POST /contacts/sync         Import Google contacts
//   POST /accounts/remove       Disconnect a mailbox
//   POST /drafts/save|send|unsend|discard   Drafts, here and in the mailbox
//   POST /chat                  Assistant chat with inbox tools
//   GET|POST /follow-ups, PATCH|DELETE /follow-ups/:id, GET /follow-ups/list
//   GET|POST /signatures, PATCH|DELETE /signatures/:id
//   GET  /attachment            Fetch a Gmail attachment
//   POST /agent/step|answer|execute|cancel   The agent (started from /chat)
//   GET  /engine/status, POST /engine/autostart, POST /mail/state
//   POST /snooze, POST /snooze/back          Hide an email until a time or an answer
//   GET  /files/search          Attachments in the mailboxes beyond the mail kept here
//   POST /calendar/prep         The last thread with a meeting's people and what is open
//   POST /actions/approve|dismiss|undo   The action log
//   GET  /telegram, POST /telegram/connect|code|disconnect   The user's own bot
//   GET  /automations, POST /automations/compile|enable|mode|try|delete   What to do from now on

import { followupList, judgeSent } from "./followups.ts";
import { listNewsletters, unsubscribe, archiveSender, keepSender } from "./newsletters.ts";
import { db } from "./db.ts";
import { modelConfigured } from "./llm.ts";
import { searchGoogleContacts, listAllGoogleContacts } from "./gmail.ts";
import { mail, userCalendar } from "./providers.ts";
import { refineDraft, processFullEmail } from "./ai.ts";
import { syncMail, analyzeInbox } from "./sync.ts";
import { modelStatus } from "./analyzeEmails.ts";
import { accountById, accountFor, accountsForWindow, defaultAccount, fromLine, listAccounts, removeAccount, updateAccount } from "./accounts.ts";
import { discardDrafts, queueDraft, saveUserDraft, unqueue } from "./drafts.ts";
import { messageIdOf, withForward } from "./forward.ts";
import { htmlToText } from "./mime.ts";
import { answered, snooze, unsnooze } from "./snooze.ts";
import { prepFor } from "./prep.ts";
import { askTabellar, validateRecipients } from "./ask.ts";
import { filesInMailboxes } from "./files.ts";
import { kickEngine, engineStatus, planNew } from "./engine.ts";
import { draftReply, sampleReply, writeTo, type EmailRow } from "./replies.ts";
import { displayNameOf, isRule, keepRules, learnFromEdit, RECIPIENTS, setAvoid, setLine, stylePrompt, writingFor } from "./writing.ts";
import { learnFromSent, startFirstRead } from "./firstRead.ts";
import * as onboarding from "./onboarding.ts";
import { approve, confirmMeeting, dismiss, undo, engineSettings, setMailState } from "./actions.ts";
import { answer as answerLine, undoAnswer } from "./answers.ts";
import { freeOn, type Hours } from "./scheduling.ts";
import { wallIn } from "./rules.ts";
import { answer, applyPref, feedback, profileContext, reopen, setPref, type Feedback } from "./profile.ts";
import * as automations from "./automations.ts";
import * as telegram from "./telegram.ts";
import { autostartInstalled, installAutostart, removeAutostart } from "./autostart.ts";
import { brief, decisions, prepareBrief, proofShown } from "./brief.ts";
import { applyLabel, labelsBySender, labelsForPrompt, suggestLabels, userLabels } from "./labels.ts";
import { mcpCall } from "./mcpCalls.ts";
import { runAgentStepParallel, answerPendingQuestion } from "./agentLoop.ts";
import { executeAgentPlan } from "./agentExecute.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


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
  if (!data) throw Object.assign(new Error("No mailbox is connected yet."), { status: 401 });
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
      return json({ ...(await engineSettings(userId)), ...engineStatus, model: modelConfigured(), modelError: modelStatus.error, autostart: autostartInstalled() });
    }
    // Archive or return to the inbox, mark read or unread: in Gmail and here.
    if (path === "/mail/state" && req.method === "POST") {
      const { ids, archived, read } = await req.json();
      if (!Array.isArray(ids) || !ids.length) return json({ error: "ids required" }, 400);
      await setMailState(userId, ids.map(String), {
        archived: typeof archived === "boolean" ? archived : undefined,
        read: typeof read === "boolean" ? read : undefined,
      });
      if (archived === true) void automations.archivedByHand(userId, ids.map(String)).catch((e) => console.error("[automations] by hand:", (e as Error).message));
      return json({ ok: true });
    }
    // Snooze until a time, or until an answer without one; back undoes it.
    if ((path === "/snooze" || path === "/snooze/back") && req.method === "POST") {
      const { ids, until } = await req.json();
      if (!Array.isArray(ids) || !ids.length) return json({ error: "ids required" }, 400);
      if (path === "/snooze") return json({ ids: await snooze(userId, ids.map(String), typeof until === "string" ? until : null) });
      await unsnooze(userId, ids.map(String));
      return json({ ok: true });
    }
    // Files in the mailboxes that are not among the mail kept here.
    if (path === "/files/search" && req.method === "GET") {
      return json({ files: await filesInMailboxes(userId, url.searchParams.get("text") ?? "", url.searchParams.get("from") ?? "") });
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
      let made: Record<string, unknown> = {};
      try {
        if (path === "/actions/approve") made = await approve(userId, id, String(hash ?? ""));
        else if (path === "/actions/dismiss") await dismiss(userId, id);
        else if (path === "/actions/undo") await undo(userId, id);
        else return json({ error: "Not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      return json({ ok: true, ...made });
    }

    // ── What to do from now on (automations.ts) ────────────────────────────
    //   GET  /automations                     each with what it was read as
    //   POST /automations/compile {text, id?} a sentence; id replaces that one's
    //   POST /automations/enable {id, on}     on only once its trial was shown
    //   POST /automations/mode {id, mode}     own or ask
    //   POST /automations/try|delete {id}
    // ── Telegram (telegram.ts) ──────────────────────────────────────────────
    if (path === "/telegram" && req.method === "GET") return json(await telegram.telegramState(userId));
    if (path.startsWith("/telegram/") && req.method === "POST") {
      try {
        if (path === "/telegram/connect") await telegram.connect(userId, String((await req.json()).token ?? ""));
        else if (path === "/telegram/code") await telegram.newCode(userId);
        else if (path === "/telegram/disconnect") await telegram.disconnect(userId);
        else return json({ error: "Not found" }, 404);
        return json(await telegram.telegramState(userId));
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
    }

    if (path === "/automations" && req.method === "GET") return json({ automations: await automations.listAutomations(userId) });
    if (path.startsWith("/automations/") && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const id = typeof b.id === "string" && UUID_RE.test(b.id) ? b.id : undefined;
      try {
        if (path === "/automations/compile") return json(await automations.compile(userId, String(b.text ?? ""), { id }));
        if (!id) return json({ error: "id is required" }, 400);
        if (path === "/automations/enable") await automations.setEnabled(userId, id, b.on === true);
        else if (path === "/automations/mode") await db.from("automations").update({ mode: b.mode === "ask" ? "ask" : "own" }).eq("id", id).eq("user_id", userId);
        else if (path === "/automations/try") await automations.tryOut(userId, id);
        else if (path === "/automations/delete") await automations.remove(userId, id);
        else return json({ error: "Not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      return json({ ok: true });
    }

    // ── What Tabellar knows about the user ─────────────────────────────────
    //   POST /questions/answer {id, option}       option is the index of the answer
    //   POST /questions/reopen {id}               take an answer back
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
    if (path === "/questions/reopen" && req.method === "POST") {
      const { id } = await req.json();
      try {
        await reopen(userId, String(id ?? ""));
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

    // ── The first run (onboarding.ts) ───────────────────────────────────────
    //   GET  /onboarding                       step, first read, model, local download
    //   POST /onboarding/step {step}
    //   GET  /onboarding/about                 POST {role, work, never, removed}
    //   GET  /onboarding/examples              POST /onboarding/examples/answer {kind, address, emailId, answer}
    //   GET  /onboarding/people                POST {address, vip}
    //   GET  /onboarding/labels                suggestions once the sent mail is read, else null
    //   POST /onboarding/finish {level}
    if (path.startsWith("/onboarding")) {
      try {
        if (path === "/onboarding" && req.method === "GET") return json(await onboarding.onboardingState(userId));
        if (path === "/onboarding/step" && req.method === "POST") {
          await onboarding.setStep(userId, String((await req.json()).step ?? ""));
          return json({ ok: true });
        }
        if (path === "/onboarding/about" && req.method === "GET") return json(await onboarding.aboutYou(userId));
        if (path === "/onboarding/about" && req.method === "POST") {
          await onboarding.saveAboutYou(userId, await req.json());
          return json({ ok: true });
        }
        if (path === "/onboarding/examples" && req.method === "GET") return json({ examples: await onboarding.examples(userId) });
        if (path === "/onboarding/examples/answer" && req.method === "POST") {
          await onboarding.answerExample(userId, await req.json());
          return json({ ok: true });
        }
        if (path === "/onboarding/people" && req.method === "GET") return json({ people: await onboarding.people(userId) });
        if (path === "/onboarding/people" && req.method === "POST") {
          const { address, vip } = await req.json();
          await onboarding.setVip(userId, String(address ?? ""), vip === true);
          return json({ ok: true });
        }
        if (path === "/onboarding/labels" && req.method === "GET") {
          const { data } = await db.from("profiles").select("label_suggestions").eq("id", userId).maybeSingle();
          return json({ suggestions: Array.isArray(data?.label_suggestions) ? data.label_suggestions : null });
        }
        if (path === "/onboarding/finish" && req.method === "POST") {
          await onboarding.finish(userId, await req.json());
          return json({ ok: true });
        }
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      return json({ error: "Not found" }, 404);
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

    // ── How the user writes (writing.ts) ────────────────────────────────────
    //   POST /writing/learn                        from the last 200 sent emails
    //   POST /writing/line {kind, field, value}    kind: all, org, known or stranger
    //   POST /writing/avoid {phrases}
    //   POST /writing/edited {to, before, after}   a draft changed before it was sent
    //   POST /writing/sample {kind}                a reply to a real email, kept nowhere
    if (path.startsWith("/writing/") && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      try {
        if (path === "/writing/learn") {
          const account = await defaultAccount(userId);
          if (!account) return json({ error: "No mailbox connected" }, 400);
          const { sent, style } = await learnFromSent(userId, account, { facts: false });
          if (!style) return json({ error: "There are fewer than 3 sent emails to learn from" }, 400);
          await style();
          return json({ sent });
        }
        if (path === "/writing/line") {
          await setLine(userId, String(b.kind ?? ""), String(b.field ?? ""), String(b.value ?? ""));
          return json({ ok: true });
        }
        if (path === "/writing/avoid") {
          await setAvoid(userId, Array.isArray(b.phrases) ? b.phrases : []);
          return json({ ok: true });
        }
        if (path === "/writing/edited") return json({ learned: await learnFromEdit(userId, String(b.to ?? ""), String(b.before ?? ""), String(b.after ?? ""), await displayNameOf(userId)) });
        if (path === "/writing/sample") return json(await sampleReply(userId, RECIPIENTS.find((k) => k === b.kind)));
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
      return json({ error: "Not found" }, 404);
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
      const receipt = body.read_receipt === true;
      const m = await withForward(
        userId,
        { from, to: body.to ?? [], cc: body.cc, bcc: body.bcc, subject: body.subject ?? "", html: body.body_html ?? "", inReplyTo: await messageIdOf(account, body.in_reply_to), attachments: body.attachments ?? undefined, receipt },
        body.forward,
      );
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
              thread_id: body.thread_id ?? null,
              subject: body.subject ?? "",
              recipients: (body.to as string[]).join(", "),
              body_html: m.html,
              body_text: htmlToText(body.body_html ?? ""),
              received_at: new Date().toISOString(),
              is_read: true,
              label_ids: ["SENT"],
              ...(receipt ? { receipt_asked: true, awaits_reply: true } : {}),
            },
            { onConflict: "user_id,gmail_id", ignoreDuplicates: false },
          );
        if (insertErr)
          console.error("[send-email] failed to save to emails table:", insertErr.message);
        await answered(userId, body.thread_id, new Date().toISOString());
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

      // An answer to an email Tabellar has.
      if (body.email_id) {
        const { data: e } = await db.from("emails").select("*").eq("id", body.email_id).eq("user_id", userId).maybeSingle();
        if (!e) return json({ error: "Email not found" }, 404, corsHeaders);
        const { text, from } = await draftReply(userId, e as unknown as EmailRow, String(body.intent ?? ""));
        return json({ draft: text, from }, 200, corsHeaders);
      }

      const { text, from } = await writeTo(userId, { to: String(body.to ?? ""), intent: String(body.intent ?? ""), subject: String(body.subject ?? ""), senderName: body.senderName, replyTo: body.replyTo, forward: body.forward });
      return json({ draft: text, from }, 200, corsHeaders);
    }

    // ── POST /refine-draft ─────────────────────────────────────────────────
    // A draft rewritten as the user asks. With `keep`, what they asked is also
    // kept as a writing rule for later drafts.
    if (path === "/refine-draft" && req.method === "POST") {
      const body = await req.json();
      const currentDraft: string = body.currentDraft ?? "";
      const feedback: string = String(body.feedback ?? "").trim();
      if (!currentDraft || !feedback) return json({ error: "currentDraft and feedback are required" }, 400, corsHeaders);

      const kept = body.keep === true && isRule(feedback);
      if (kept) await setPref(userId, "writing", "", feedback, "user", "Said while changing a draft");
      const [writing, about] = await Promise.all([writingFor(userId, String(body.to ?? "")), profileContext(userId)]);
      const refined = await keepRules(writing, (extra) => refineDraft({ currentDraft, feedback, style: stylePrompt(writing, "rules"), extra, knowledgeContext: about || undefined }));
      return json({ draft: refined, kept }, 200, corsHeaders);
    }

    // ── The Brief: what needs the user today (brief.ts), answered in place
    // (answers.ts). `all=1` lists every line that needs the user.
    if (path === "/briefing" && req.method === "GET") {
      const b = await brief(userId, { all: url.searchParams.get("all") === "1" });
      if (b.proof) await proofShown(userId, b.day);
      return json(b, 200, corsHeaders);
    }
    if ((path === "/briefing/answer" || path === "/briefing/undo") && req.method === "POST") {
      const b = await req.json();
      try {
        if (path === "/briefing/undo") return json({ ok: true, ...(await undoAnswer(String(b.id ?? ""))) });
        const done = await answerLine(userId, String(b.key ?? ""), String(b.pick ?? ""));
        if (done.replan) kickEngine();
        return json(done);
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
    }
    // How much Tabellar asked of the user in the last seven days.
    if (path === "/briefing/decisions" && req.method === "GET") return json(await decisions(userId));
    // The opening paragraph, written now if today's is not there yet.
    if (path === "/briefing/summary" && req.method === "POST") {
      return json({ summary: await prepareBrief(userId, { now: true }) });
    }

    // ── GET /calendar/free-slots ───────────────────────────────────────────
    if (path === "/calendar/free-slots" && req.method === "GET") {
      const cal = await userCalendar(userId);
      if (!cal) {
        return json({ error: "No calendar access" }, 400, corsHeaders);
      }

      const minutes = parseInt(url.searchParams.get("duration") || "30", 10) || 30;
      const timezone = url.searchParams.get("timezone") || "UTC";
      const asked = (url.searchParams.get("date") || wallIn(new Date(), timezone).slice(0, 10)).split("-").map(Number);
      const { data: me } = await db.from("profiles").select("working_hours").eq("id", userId).single();
      try {
        return json(await freeOn(cal, me?.working_hours as Hours, timezone, { y: asked[0], m: asked[1], d: asked[2] }, minutes), 200, corsHeaders);
      } catch {
        return json({ error: "Calendar API failed", slots: [] }, 200, corsHeaders);
      }
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

    // The last thread with a meeting's people and what is open with them (prep.ts).
    if (path === "/calendar/prep" && req.method === "POST") {
      const { title, people } = await req.json();
      return json(await prepFor(userId, { title: String(title ?? ""), people: Array.isArray(people) ? people.map(String) : [] }));
    }

    // ── POST /meetings/confirm ─────────────────────────────────────────────
    // Puts a meeting waiting to be confirmed on the calendar: a meetings row
    // by `id`, or a proposal by `proposal` {id, hash}, which is approved first.
    // `title`, `start_time`, `end_time`, `location` and `attendees` change it
    // on the way.
    if (path === "/meetings/confirm" && req.method === "POST") {
      const body = await req.json();
      let meetingId = typeof body.id === "string" ? body.id : "";
      const changes: Record<string, unknown> = {};
      for (const k of ["title", "start_time", "end_time", "location"]) if (typeof body[k] === "string" && body[k]) changes[k] = body[k];
      if (Array.isArray(body.attendees)) changes.attendees = body.attendees.map(String).filter(Boolean);
      try {
        if (body.proposal?.id) meetingId = String((await approve(userId, String(body.proposal.id), String(body.proposal.hash ?? ""))).meetingId ?? "");
        const { link } = await confirmMeeting(userId, meetingId, changes);
        return json({ ok: true, meetingId, link });
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
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
        .select("id, subject, sender, sender_email, body_text, snippet, received_at")
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
          ?.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        await profileContext(userId, { sender_email: email.sender_email as string, subject: email.subject as string, text: email.body_text as string }),
        false,
        true,
        new Date(String(email.received_at)),
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
            // Google returned nothing, likely missing contacts/directory scope
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

    // Sent through the outbox, with a short window in which it can be taken
    // back: `drafts` [{id, html?}], html when an answer in it was chosen; `at`
    // sends it then instead.
    if (path === "/drafts/send" && req.method === "POST") {
      const { drafts, at } = await req.json();
      if (!Array.isArray(drafts) || !drafts.length) return json({ error: "drafts required" }, 400);
      const queued: string[] = [];
      try {
        for (const d of drafts) queued.push((await queueDraft(userId, String(d.id), { html: typeof d.html === "string" ? d.html : undefined, at: typeof at === "string" ? at : undefined })).id);
      } catch (e) {
        return json({ queued, error: (e as Error).message }, queued.length ? 200 : ((e as { status?: number }).status ?? 500));
      }
      return json({ queued });
    }
    if (path === "/drafts/unsend" && req.method === "POST") {
      const { ids } = await req.json();
      return json({ stopped: await unqueue(userId, Array.isArray(ids) ? ids.map(String) : []) });
    }

    // Discarded here, and in the mailbox's Drafts where Tabellar saved it.
    if (path === "/drafts/discard" && req.method === "POST") {
      const { ids } = await req.json();
      if (!Array.isArray(ids) || !ids.length) return json({ error: "ids required" }, 400);
      return json({ discarded: await discardDrafts(userId, ids.map(String)) });
    }

    // A call from a program connected over MCP (mcp.ts).
    if (path === "/mcp" && req.method === "POST") {
      const { name, arguments: args } = await req.json();
      try {
        return json({ text: await mcpCall(userId, String(name ?? ""), args) });
      } catch (e) {
        return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
      }
    }

    // ── POST /chat ───────────────────────────────────────────────────────────
    if (path === "/chat" && req.method === "POST") {
      const { message, history = [], timezone = "UTC", conversation_id } = await req.json();
      if (!message?.trim()) return json({ error: "Message required" }, 400, corsHeaders);
      return json(await askTabellar(userId, { message, history, timezone, conversation_id }), 200, corsHeaders);
    }

    // ── GET /follow-ups, list follow-up reminders ────────────────────────
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

    // ── POST /follow-ups, create a follow-up reminder ────────────────────
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

    // ── PATCH /follow-ups/:id, update a follow-up reminder ───────────────
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

    // ── DELETE /follow-ups/:id, delete a follow-up reminder ──────────────
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

    // ── GET /signatures, list all signatures for user ────────────────────
    if (path === "/signatures" && req.method === "GET") {
      const { data, error } = await db
        .from("email_signatures")
        .select("id, name, html, is_default, account_id, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 500, corsHeaders);
      return json({ signatures: data ?? [] }, 200, corsHeaders);
    }

    // ── POST /signatures, create a new signature ─────────────────────────
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

    // ── PATCH /signatures/:id, update a signature ────────────────────────
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

    // ── DELETE /signatures/:id, delete a signature ───────────────────────
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

    // ── GET /attachment, fetch a Gmail attachment by ID ───────────────────
    if (path === "/attachment" && req.method === "GET") {
      const urlObj = new URL(req.url);
      const gmailId = urlObj.searchParams.get("gmail_id");
      const attachmentId = urlObj.searchParams.get("attachment_id");
      // Mail that is not kept here (older files found in the mailbox) names its account.
      const accountId = urlObj.searchParams.get("account_id");
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
      if (!emailRow?.account_id && !accountId) {
        return json({ error: "Email not found" }, 404, corsHeaders);
      }

      const account = await accountById(userId, (emailRow?.account_id as string | undefined) ?? accountId);
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
      void runAgentStepParallel(
        body.session_id,
        db,
        body.timezone ?? "UTC",
      ).catch((e) => console.error("[agent/step] parallel step failed:", e));
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
      // Resume the plan; the window follows its row.
      void runAgentStepParallel(
        body.session_id,
        db,
        body.timezone ?? "UTC",
      ).catch((e) => console.error("[agent/answer] parallel step failed:", e));
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
        .update({ status: "cancelled", pending_question: null, pending_questions: [] })
        .eq("id", body.session_id)
        .eq("user_id", userId)
        .in("status", ["planning", "asking", "ready", "executing"]);
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
