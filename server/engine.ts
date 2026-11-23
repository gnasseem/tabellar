// The background engine: works while the window is closed.
//
// Every two minutes (and straight away after the Mac wakes, since the timer
// then finds the interval long passed) it syncs new mail through Gmail's
// change history, has the model sort and summarise it, and then plans what to
// do with each new email: a Tabellar label, a reply draft, a todo, a meeting
// proposal. Each planned action goes through actions.act(), which asks the
// policy whether to do it, propose it, or refuse it.
//
// The model that reads the email has no tools: it returns a category, a
// summary and suggested actions as JSON. What those suggestions can turn into
// is fixed here in code: a draft always goes back to the sender of the email,
// nothing is made that the user's preferences rule out (profile.ts), and a
// todo or draft from a sender the user does not know becomes a question.
// A todo is only text, a meeting is only a proposal. Only at Autopilot is a
// reply sent, and then only to the person who wrote, inside the thread, after
// a cancel window (policy.checkAutoSend, outbox.ts).

import { db } from "./db.ts";
import { modelConfigured } from "./llm.ts";
import { generateDraft } from "./ai.ts";
import { messageHeaders } from "./gmail.ts";
import { syncMail, analyzeInbox, serial, fillMissingBodies } from "./sync.ts";
import { act, applyWaitingLabels, engineSettings, type Planned } from "./actions.ts";
import { decide, looksLikeInstructions, type AutoSend } from "./policy.ts";
import { parseWallClock, wallClockToUtc } from "./agentExecute.ts";
import { notify } from "./notify.ts";
import { ask, covers, type Thing, knowsSender, prefsFor, profileContext, retireTrivia, senderQuestion, stops, wroteTo } from "./profile.ts";

const INTERVAL_MS = 2 * 60_000;
const TICK_MS = 20_000;
const MAX_AGE_MS = 7 * 24 * 3600_000; // older mail is sorted but not acted on

const LABELS: Record<string, string> = {
  "action-required": "Tabellar/Action required",
  important: "Tabellar/Important",
  updates: "Tabellar/Updates",
  promotions: "Tabellar/Promotions",
};
const SUSPICIOUS_LABEL = "Tabellar/Suspicious";
const NO_REPLY = /no.?reply|noreply|donotreply|do-not-reply|notifications?@|mailer-daemon|bounce/i;

export const engineStatus = {
  lastCycleAt: null as string | null,
  lastError: null as string | null,
  running: false,
};

async function localUser(): Promise<string | null> {
  const { data } = await db.from("profiles").select("id").limit(1).maybeSingle();
  return (data?.id as string) ?? null;
}

// ── Drafting ────────────────────────────────────────────────────────────────

type EmailRow = {
  id: string;
  subject: string | null;
  sender: string | null;
  sender_email: string | null;
  reply_to_email: string | null;
  body_text: string | null;
  body_html?: string | null;
  snippet: string | null;
  received_at: string | null;
  thread_id?: string | null;
  gmail_id?: string | null;
  gmail_account_id?: string | null;
  attachments?: { mime_type?: string }[] | null;
};

// Added to the drafting instructions when the reply will go out without the
// user reading it. The model's answer is only text; who it goes to is fixed in
// code. HOLD turns the reply back into a draft for the user.
const AUTOPILOT_INSTRUCTIONS =
  "This reply will be sent automatically, without the user reading it first. Answer only what the email and the background context let you answer. " +
  "If a good reply needs a decision, a commitment (money, a date, attending something, agreeing to something), an attachment, or facts you do not have, write only the word HOLD and nothing else.";

const HOLD = /^\W*HOLD\W*$/;

// `tabellar check` swaps this for canned text so Autopilot can be run without a model.
export const drafter = { draft: (userId: string, e: EmailRow, instructions: string) => draftReply(userId, e, instructions) };

// A reply to one email in the user's writing style, with what Tabellar knows
// about the sender. Used by the engine and by /generate-draft.
export async function draftReply(userId: string, e: EmailRow, instructions: string): Promise<string> {
  const emailText = `Subject: ${e.subject}\nFrom: ${e.sender}\n\n${e.body_text || e.snippet}`;
  const senderName = e.sender?.split("<")[0]?.trim().replace(/"/g, "") || "";
  const [{ data: style }, { data: profile }, { data: known }, about] = await Promise.all([
    db.from("style_profiles").select("*").eq("user_id", userId).limit(1),
    db.from("profiles").select("style_notes").eq("id", userId).single(),
    senderName.length > 1
      ? db.from("knowledge_base").select("entity, entity_type, info").eq("user_id", userId).in("entity_type", ["person", "company"]).ilike("entity", `%${senderName.replace(/[%_]/g, "")}%`).limit(5)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    profileContext(userId, { sender_email: e.sender_email, subject: e.subject, text: e.body_text || e.snippet }),
  ]);

  let styleContext: string | undefined;
  if (style?.[0]) {
    const s = style[0];
    styleContext = `Greeting: ${s.greeting_style || "Hi"}. Closing: ${s.closing_style || "Best"}. Tone: ${s.tone || "professional"}.`;
  }
  if (profile?.style_notes) styleContext = (styleContext || "") + " " + profile.style_notes;
  const background = [about, (known ?? []).map((k) => `${k.entity} (${k.entity_type}): ${k.info}`).join("\n")].filter(Boolean).join("\n\n");
  return generateDraft(background ? `${emailText}\n\nBackground context:\n${background}` : emailText, instructions, styleContext);
}

// ── Planning ────────────────────────────────────────────────────────────────

type QuickAction = {
  action?: string;
  label?: string;
  text?: string;
  meetingDetails?: { title?: string; dateTime?: string | null; duration?: number | null; location?: string | null };
};

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function countsToday(userId: string): Promise<Record<string, number>> {
  const { data } = await db
    .from("action_log")
    .select("kind")
    .eq("user_id", userId)
    .eq("source", "engine")
    .in("status", ["done", "proposed", "running"])
    .gte("created_at", startOfToday());
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[r.kind as string] = (counts[r.kind as string] ?? 0) + 1;
  return counts;
}

// Plan and carry out actions for every analysed email the engine has not
// looked at yet. Runs one at a time.
export const planNew = serial(async (userId: string): Promise<void> => {
  const settings = await engineSettings(userId);
  // Paused: leave new mail unplanned (and unannounced) until resumed.
  if (settings.paused) return;

  const { data: rows } = await db
    .from("email_processed")
    .select("id, category, urgency, summary, quick_actions, emails!inner(id, subject, sender, sender_email, reply_to_email, body_text, body_html, snippet, received_at, thread_id, gmail_id, gmail_account_id, attachments)")
    .eq("user_id", userId)
    .is("engine_at", null)
    .limit(100);
  if (!rows?.length) return;

  const { data: profile } = await db
    .from("profiles")
    .select("working_hours, notification_level, notification_preview, autopilot_delay_min, autopilot_daily_cap, autopilot_known_only")
    .eq("id", userId)
    .maybeSingle();
  const delayMinutes = Math.min(Math.max(Number(profile?.autopilot_delay_min) || 5, 1), 120);
  const sendCap = Math.max(0, Number(profile?.autopilot_daily_cap ?? 5));
  const timezone = (profile?.working_hours as { timezone?: string } | null)?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = await countsToday(userId);
  let cycleCount = 0;
  const notes: { sender: string; summary: string; drafted: boolean; replying?: boolean }[] = [];

  const tokens = new Map<string, string | null>();
  const tokenFor = async (accountId: string | null | undefined): Promise<string | null> => {
    if (!accountId) return null;
    if (!tokens.has(accountId)) {
      const { data: acct } = await db.from("gmail_accounts").select("token_ref").eq("id", accountId).maybeSingle();
      tokens.set(accountId, (acct?.token_ref as string | undefined) ?? null);
    }
    return tokens.get(accountId)!;
  };

  const sorted = [...rows].sort((a, b) =>
    String((a.emails as EmailRow).received_at).localeCompare(String((b.emails as EmailRow).received_at)),
  );

  for (const row of sorted) {
    const email = row.emails as EmailRow;
    await db.from("email_processed").update({ engine_at: new Date().toISOString() }).eq("id", row.id);
    if (!email.received_at || Date.now() - new Date(email.received_at).getTime() > MAX_AGE_MS) continue;

    const category = String(row.category);
    const suspicious = looksLikeInstructions(email.subject, email.body_text, email.body_html);
    const actions = (Array.isArray(row.quick_actions) ? row.quick_actions : []) as QuickAction[];
    const from = email.sender?.split("<")[0]?.trim() || email.sender_email || "someone";
    // An email read again (its text was filled in later) keeps what was
    // already done or proposed for it; nothing is done twice.
    const { data: before } = await db.from("action_log").select("kind").eq("email_id", email.id).in("status", ["done", "running", "proposed"]);
    const already = new Set((before ?? []).map((r) => r.kind as string));
    const run = async (p: Planned, send?: AutoSend) => {
      if (already.has(p.kind)) return "refused";
      const r = await act(userId, p, { ...settings, source: "engine", suspicious, todayCount: today[p.kind] ?? 0, cycleCount, send, sendCap });
      if (r === "done" || r === "proposed") {
        today[p.kind] = (today[p.kind] ?? 0) + 1;
        cycleCount++;
      }
      return r;
    };

    // What the user said about this sender and these topics.
    const sender = (email.sender_email ?? "").trim().toLowerCase();
    const prefs = await prefsFor(userId, sender, `${email.subject ?? ""} ${row.summary ?? ""}`);
    const stopped = (t: Thing) => !!stops(prefs, t);

    // Label. A planted-instruction email gets the Suspicious label and nothing else.
    const label = suspicious ? SUSPICIOUS_LABEL : LABELS[category];
    if (label) await run({ kind: "label", emailId: email.id, summary: `Label "${label.replace("Tabellar/", "")}"`, detail: { label } });

    const replyTo = (email.reply_to_email || email.sender_email || "").trim();
    const reply = actions.find((a) => a.action === "reply");
    const wantsDraft = category === "action-required" && !!reply && !!replyTo && !NO_REPLY.test(replyTo) && !already.has("draft") && !already.has("send") && !stopped("draft");
    const todo = actions.find((a) => a.action === "add_todo" && a.label);
    const wantsTodo = !!todo && !already.has("todo") && !stopped("todo");

    // From someone the user does not know and has said nothing about: ask
    // instead of guessing, when the draft or todo would otherwise happen.
    let asked = false;
    if ((wantsDraft || wantsTodo) && sender && !covers(prefs)) {
      const kind = wantsDraft ? "draft" : "todo";
      const would = decide({ kind, ...settings, source: "engine", suspicious, todayCount: today[kind] ?? 0, cycleCount }).verdict !== "refuse";
      if (would && !(await knowsSender(userId, sender, { exceptEmailId: email.id, tokenRef: await tokenFor(email.gmail_account_id) }))) {
        const plan = [wantsDraft && `draft a reply to "${email.subject ?? ""}"`, wantsTodo && `add the todo "${todo!.label}"`].filter(Boolean).join(" and ");
        await ask(userId, senderQuestion(email.sender, sender, `Tabellar would ${plan}.`, email.id));
        asked = true;
      }
    }

    // Reply, only to a real person who is waiting on the user: sent by
    // Autopilot when everything allows it, otherwise saved as a draft.
    let drafted = false;
    let replying = false;
    if (wantsDraft && !asked && reply) {
      const subject = /^re:/i.test(email.subject ?? "") ? email.subject! : `Re: ${email.subject ?? ""}`;
      const base: Planned = { kind: "draft", emailId: email.id, summary: `Draft a reply to ${from}`, detail: { to: [replyTo], subject } };
      const autoSend: AutoSend = { to: [replyTo], threadId: email.thread_id, writer: replyTo };
      const sendCtx = { ...settings, source: "engine" as const, suspicious, todayCount: today.send ?? 0, cycleCount, send: autoSend, sendCap };
      const tokenRef = settings.level === "autopilot" ? await tokenFor(email.gmail_account_id) : null;
      const trySend =
        settings.level === "autopilot" &&
        decide({ kind: "send", ...sendCtx }).verdict === "do" &&
        (!profile?.autopilot_known_only || (await wroteTo(userId, replyTo, tokenRef)));
      // Ask before paying for the model call; a refusal is logged by act().
      const pre = decide({ kind: "draft", ...settings, source: "engine", suspicious, todayCount: today.draft ?? 0, cycleCount });
      const { count: existing } = await db.from("draft_emails").select("id", { count: "exact", head: true }).eq("email_id", email.id);
      if (pre.verdict === "refuse" && !trySend) await run(base);
      else if (!existing) {
        try {
          const instructions = reply.text || reply.label || "";
          let body = (await drafter.draft(userId, email, trySend ? `${instructions}\n\n${AUTOPILOT_INSTRUCTIONS}` : instructions)).trim();
          if (trySend && HOLD.test(body)) {
            body = pre.verdict === "refuse" ? "" : (await drafter.draft(userId, email, instructions)).trim();
          } else if (trySend && body) {
            let inReplyTo: string | null = null;
            try {
              if (tokenRef && email.gmail_id) inReplyTo = (await messageHeaders(tokenRef, email.gmail_id, ["Message-ID"]))["message-id"] ?? null;
            } catch {
              // Without the Message-ID the reply still lands in the thread by its thread id.
            }
            const r = await run(
              {
                kind: "send",
                emailId: email.id,
                summary: `Reply to ${from}`,
                detail: { to: [replyTo], subject, body, threadId: email.thread_id, accountId: email.gmail_account_id, inReplyTo, delayMinutes },
              },
              autoSend,
            );
            replying = r === "done";
          }
          if (replying) {
            // Sent (after the cancel window); no draft as well.
          } else if (pre.verdict === "refuse") await run(base);
          else if (body) drafted = (await run({ ...base, detail: { ...base.detail, body } })) === "done";
        } catch (e) {
          console.error("[engine] reply failed:", (e as Error).message);
        }
      }
    }

    // Todo.
    if (wantsTodo && !asked) await run({ kind: "todo", emailId: email.id, summary: `Todo: ${todo.label}`, detail: { text: todo.label } });

    // Meeting proposal, when the email names a time that has not passed.
    // Calendar invitations and their replies carry an .ics: Google Calendar
    // already has that event.
    const fromCalendar = (email.attachments ?? []).some((a) => a.mime_type === "text/calendar");
    const meeting = fromCalendar || stopped("meeting") ? undefined : actions.find((a) => a.action === "schedule_meeting" && a.meetingDetails?.dateTime);
    const wall = meeting ? parseWallClock(meeting.meetingDetails!.dateTime!) : null;
    if (meeting && wall !== null) {
      const start = wallClockToUtc(wall, timezone);
      const minutes = Math.min(Math.max(Number(meeting.meetingDetails!.duration) || 60, 5), 24 * 60);
      if (start.getTime() > Date.now()) {
        const title = meeting.meetingDetails!.title || meeting.label || email.subject || "Meeting";
        await run({
          kind: "meeting",
          emailId: email.id,
          summary: `Propose "${title}" on ${start.toLocaleString("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" })}`,
          detail: {
            title,
            start_time: start.toISOString(),
            end_time: new Date(start.getTime() + minutes * 60_000).toISOString(),
            location: meeting.meetingDetails!.location ?? null,
            description: meeting.text ?? null,
          },
        });
      }
    }

    const level = String(profile?.notification_level ?? "important");
    const vip = prefs.some((r) => r.value === "vip");
    const worthIt = !stopped("notify") && (level === "all" || (level !== "none" && vip) || (level === "important" && (category === "action-required" || category === "important")));
    if (replying) notes.push({ sender: from, summary: String(row.summary || email.subject || ""), drafted: false, replying: true });
    else if (worthIt && !suspicious) notes.push({ sender: from, summary: String(row.summary || email.subject || ""), drafted });
  }

  // One notification per email, or one summary when several arrive together.
  const preview = profile?.notification_preview !== false;
  // Autopilot replies are always announced, with the window to cancel them.
  for (const n of notes.filter((n) => n.replying)) {
    notify({
      title: preview ? n.sender : "Tabellar",
      subtitle: `Autopilot replies in ${delayMinutes} min`,
      body: preview ? `${n.summary} Cancel it in Activity.` : "Autopilot will send a reply. Cancel it in Activity.",
    });
  }
  const rest = notes.filter((n) => !n.replying);
  notes.length = 0;
  notes.push(...rest);
  if (notes.length > 3) {
    notify({ title: "Tabellar", body: `${notes.length} new emails need your attention${notes.some((n) => n.drafted) ? ", with reply drafts ready" : ""}.` });
  } else {
    for (const n of notes) {
      notify({
        title: preview ? n.sender : "Tabellar",
        subtitle: n.drafted ? "Reply draft ready" : undefined,
        body: preview ? n.summary : "A new email needs your attention.",
      });
    }
  }
});

// Plan right away after the window triggered an analysis.
export function kickEngine(): void {
  localUser()
    .then((id) => (id ? planNew(id) : undefined))
    .catch((e) => console.error("[engine] plan:", e));
}

// ── The loop ────────────────────────────────────────────────────────────────

// Once per start: fill in text for HTML-only mail stored earlier.
let startedUp = false;

export async function runCycle(): Promise<void> {
  if (engineStatus.running) return;
  const userId = await localUser();
  if (!userId) return;
  const { count } = await db.from("gmail_accounts").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("is_active", true);
  if (!count) return;
  engineStatus.running = true;
  try {
    if (!startedUp) {
      await fillMissingBodies(userId);
      await retireTrivia(userId);
      startedUp = true;
    }
    await applyWaitingLabels(userId);
    await syncMail(userId);
    if (modelConfigured()) {
      await analyzeInbox(userId);
      await planNew(userId);
    }
    engineStatus.lastError = null;
  } catch (e) {
    engineStatus.lastError = (e as Error).message;
    console.error("[engine]", e);
  } finally {
    engineStatus.running = false;
    engineStatus.lastCycleAt = new Date().toISOString();
  }
}

export function startEngine(): () => void {
  let last = 0;
  const tick = () => {
    if (Date.now() - last < INTERVAL_MS) return;
    last = Date.now();
    void runCycle();
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
