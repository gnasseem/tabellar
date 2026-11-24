// The background engine: works while the window is closed.
//
// A watcher asks each mailbox every few seconds whether it changed (IMAP
// mailboxes also say so at once through IDLE), and
// when it did, brings the change in at once: new mail is stored (the window
// shows it straight away), then the model sorts and summarises it, and the
// engine plans what to do with each new email: a Tabellar label, a reply draft, a todo, a meeting
// proposal. Every two minutes a full cycle runs as well, as a safety net and
// for the slower work (sent mail for Follow-ups, the first read). Each
// planned action goes through actions.act(), which asks the
// policy whether to do it, propose it, or refuse it.
//
// The model that reads the email has no tools: it returns a category, a
// summary and suggested actions as JSON. What those suggestions can turn into
// is fixed here in code: a draft always goes back to the sender of the email,
// nothing is made that the user's preferences rule out (profile.ts), a todo
// needs the sentence that asks for it (rules.ts), a meeting's time is worked
// out from what the email says and is not proposed when it is already on the
// calendar, and a todo or draft from a sender the user does not know becomes
// a question. A todo is only text, a meeting is only a proposal. Only at
// Autopilot is a reply sent, and then only to the person who wrote, inside the
// thread, after a cancel window (policy.checkAutoSend, outbox.ts).

import { db } from "./db.ts";
import { modelConfigured } from "./llm.ts";
import { generateDraft } from "./ai.ts";
import { keepRules, ownWords, recipients, stylePrompt, writingFor, type Recipient } from "./writing.ts";
import { isBulk, writtenTo } from "./senders.ts";
import { calendarAccount, mail, type LinkedEvent } from "./providers.ts";
import { syncMail, syncErrors, readBacklog, serial, fillMissingBodies, refreshStored } from "./sync.ts";
import { act, applyWaitingLabels, engineSettings, type Planned } from "./actions.ts";
import { CAP_PER_CYCLE, decide, looksLikeInstructions, type AutoSend } from "./policy.ts";
import { parseWallClock, wallClockToUtc } from "./agentExecute.ts";
import { ACT_WITHIN_MS, dueOf, meetingOf, RULES_VERSION, todoOf } from "./rules.ts";
import { judgeSent } from "./followups.ts";
import { inQuietHours, notify, worthNotifying } from "./notify.ts";
import { prepareBrief, tellBrief } from "./brief.ts";
import { tellMeetings } from "./prep.ts";
import { firstReadState, relearnStyle, startFirstRead } from "./firstRead.ts";
import { listAccounts, refreshStaleSendAs, replyFrom, type Account } from "./accounts.ts";
import { gmailLabelOf, userLabels } from "./labels.ts";
import { ask, covers, MOVED_ON, PASSED, displayName, type Thing, knowsSender, prefsFor, profileContext, retireTrivia, senderQuestion, stops, wroteTo } from "./profile.ts";

const INTERVAL_MS = 2 * 60_000;
const TICK_MS = 20_000;

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
  mailError: null as string | null, // set after a few failed checks of a mailbox in a row
  signIn: null as string | null, // the address whose sign-in is no longer accepted
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
  account_id?: string | null;
  recipients?: string | null;
  cc_recipients?: string | null;
  is_calendar?: boolean | null;
};

// Added to the drafting instructions when the reply will go out without the
// user reading it. The model's answer is only text; who it goes to is fixed in
// code. HOLD turns the reply back into a draft for the user.
const AUTOPILOT_INSTRUCTIONS =
  "This reply will be sent automatically, without the user reading it first. Answer only what the email and the background context let you answer. " +
  "If a good reply needs a decision, a commitment (money, a date, attending something, agreeing to something), an attachment, or facts you do not have, write only the word HOLD and nothing else.";

const HOLD = /^\W*HOLD\W*$/;

// A gap the model left for the user to fill in ("[Insert venue]"). Such a
// reply is never sent on its own.
export const GAP = /\[(?:insert|your|add|enter|fill|name|date|time|venue|place|location|address|phone|link|number|amount|company|recipient|details?|tbd|to be|x{2,})\b[^\]\n]{0,60}\]/i;

// A draft the model failed to write is tried again, this often in all.
const DRAFT_TRIES = 3;
const draftTries = new Map<string, number>();

const NEWS_MS = 24 * 3600_000;

// `tabellar check` swaps this for canned text so Autopilot can be run without a model.
export const drafter = { draft: (userId: string, e: EmailRow, instructions: string) => draftReply(userId, e, instructions) };

// The part of an email a reply answers: its own text and the newest of the
// thread quoted under it. A local model reads the prompt at about a hundred
// tokens a second, so a long quoted thread cost more time than anything else.
const DRAFT_BODY_CHARS = 4000;

// A reply to one email in the user's writing style, with what Tabellar knows
// about the sender. Used by the engine and by /generate-draft.
export async function draftReply(userId: string, e: EmailRow, instructions: string, kind?: Recipient): Promise<string> {
  const emailText = `Subject: ${e.subject}\nFrom: ${e.sender}\n\n${String(e.body_text || e.snippet || "").slice(0, DRAFT_BODY_CHARS)}`;
  const senderName = e.sender?.split("<")[0]?.trim().replace(/"/g, "") || "";
  const [writing, { data: known }, about] = await Promise.all([
    writingFor(userId, e.reply_to_email || e.sender_email, kind),
    senderName.length > 1
      ? db.from("knowledge_base").select("entity, entity_type, info").eq("user_id", userId).in("entity_type", ["person", "company"]).ilike("entity", `%${senderName.replace(/[%_]/g, "")}%`).limit(5)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    profileContext(userId, { sender_email: e.sender_email, subject: e.subject, text: e.body_text || e.snippet }),
  ]);
  const background = [about, (known ?? []).map((k) => `${k.entity} (${k.entity_type}): ${k.info}`).join("\n")].filter(Boolean).join("\n\n");
  const prompt = background ? `${emailText}\n\nBackground context:\n${background}` : emailText;
  return keepRules(writing, (extra) => generateDraft(prompt, instructions, stylePrompt(writing), extra));
}

// A reply to a real email from that kind of sender, to show how Tabellar
// writes now. Kept nowhere. With no such email it answers a made-up one.
export async function sampleReply(userId: string, kind?: Recipient): Promise<{ who: string; subject: string; text: string; example: boolean; draft: string }> {
  const [kindOf, written, { data }] = await Promise.all([
    recipients(userId),
    writtenTo(userId),
    db
      .from("email_processed")
      .select("category, quick_actions, emails!inner(id, subject, sender, sender_email, reply_to_email, body_text, body_html, snippet, received_at, label_ids, is_calendar, has_list_unsubscribe, list_id, precedence_header)")
      .eq("user_id", userId)
      .in("category", ["action-required", "important"])
      .order("processed_at", { ascending: false })
      .limit(300),
  ]);
  const asked = (r: Record<string, unknown>) => ((r.quick_actions as QuickAction[] | null) ?? []).find((a) => a.action === "reply");
  const rows = ((data ?? []) as Record<string, unknown>[])
    .map((r) => ({ reply: asked(r), e: r.emails as EmailRow & Parameters<typeof isBulk>[0] & { label_ids: string[] | null } }))
    .filter(({ e }) => {
      const a = e.sender_email ?? "";
      return a && !NO_REPLY.test(a) && !e.is_calendar && !e.label_ids?.includes("SENT") && !isBulk(e, written) && String(e.body_text ?? "").trim().length > 40 && !looksLikeInstructions(e.subject, e.body_text, e.body_html) && (!kind || kindOf(a) === kind);
    })
    .sort((a, b) => Number(!!b.reply) - Number(!!a.reply) || String(b.e.received_at).localeCompare(String(a.e.received_at)));
  const made = { id: "", subject: "Thursday", sender: "Sam Lee <sam@example.org>", sender_email: "sam@example.org", reply_to_email: null, snippet: null, received_at: null, body_text: "Hi,\n\nAre you free on Thursday at 3 to go over the draft? If not, tell me what suits you better.\n\nSam" };
  const e: EmailRow = rows[0]?.e ?? made;
  const draft = await draftReply(userId, e, String(rows[0]?.reply?.text ?? ""), kind);
  return { who: displayName(e.sender, e.sender_email ?? ""), subject: e.subject ?? "", text: ownWords(String(e.body_text ?? "")).slice(0, 600), example: !rows[0], draft };
}

// ── Planning ────────────────────────────────────────────────────────────────

// Whether the thread went on after this email: the user answered it, or a
// newer message came in, which is the one a reply would answer. Either way a
// draft for this one would be stale (and, on a local model, half a minute of
// work for nothing).
async function laterInThread(e: EmailRow): Promise<boolean> {
  if (!e.thread_id || !e.received_at) return false;
  const { count } = await db.from("emails").select("id", { count: "exact", head: true }).eq("thread_id", e.thread_id).eq("is_receipt", false).gt("received_at", e.received_at);
  return !!count;
}

// The same thing asked again (a reminder, a resent form) is the todo already
// there: an open one, or one waiting for approval, in the same words from the
// same sender.
async function sameTodo(userId: string, label: string, sender: string): Promise<boolean> {
  const same = (t: unknown) => String(t ?? "").trim().toLowerCase() === label.trim().toLowerCase();
  const [{ data: open }, { data: waiting }] = await Promise.all([
    db.from("todos").select("text, emails(sender_email)").eq("user_id", userId).eq("is_completed", false).not("email_id", "is", null),
    db.from("action_log").select("detail, emails(sender_email)").eq("user_id", userId).eq("kind", "todo").eq("status", "proposed"),
  ]);
  const from = (r: Record<string, unknown>) => String((r.emails as { sender_email?: string } | null)?.sender_email ?? "").toLowerCase() === sender;
  return (open ?? []).some((r) => same(r.text) && from(r)) || (waiting ?? []).some((r) => same((r.detail as { text?: string } | null)?.text) && from(r));
}

type QuickAction = Record<string, unknown> & { action?: string; label?: string; text?: string };

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
  // Paused: leave new mail unplanned (and unannounced) until resumed. During
  // the first run nothing is planned either: the user is still saying what
  // they want, and the level is not chosen yet. Mail is read meanwhile.
  if (settings.paused) return;
  const { data: me } = await db.from("profiles").select("onboarding").eq("id", userId).maybeSingle();
  if (me && me.onboarding !== "done") return;

  const { data: rows } = await db
    .from("email_processed")
    .select("id, category, urgency, summary, quick_actions, calendar, extra_labels, emails!inner(id, subject, sender, sender_email, reply_to_email, recipients, cc_recipients, body_text, body_html, snippet, received_at, thread_id, gmail_id, account_id, is_calendar)")
    .eq("user_id", userId)
    .is("engine_at", null)
    .limit(100);
  if (!rows?.length) return;

  const { data: profile } = await db
    .from("profiles")
    .select("working_hours, notification_level, notification_preview, notification_quiet, autopilot_delay_min, autopilot_daily_cap, autopilot_known_only")
    .eq("id", userId)
    .maybeSingle();
  const delayMinutes = Math.min(Math.max(Number(profile?.autopilot_delay_min) || 5, 1), 120);
  const sendCap = Math.max(0, Number(profile?.autopilot_daily_cap ?? 5));
  const timezone = (profile?.working_hours as { timezone?: string } | null)?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = await countsToday(userId);
  const userLabelList = await userLabels(userId);
  let cycleCount = 0;
  const notes: { sender: string; summary: string; drafted: boolean; replying?: boolean }[] = [];

  const accounts = new Map((await listAccounts(userId)).map((a) => [a.id, a]));
  const accountOf = (accountId: string | null | undefined) => accounts.get(accountId ?? "") ?? null;
  const calendar = calendarAccount([...accounts.values()]);

  const sorted = [...rows].sort((a, b) =>
    String((a.emails as EmailRow).received_at).localeCompare(String((b.emails as EmailRow).received_at)),
  );

  for (const row of sorted) {
    // The limit for one pass is reached: the rest is planned in the next.
    if (cycleCount >= CAP_PER_CYCLE) break;
    const email = row.emails as EmailRow;
    const planned = (at: string | null) => db.from("email_processed").update({ engine_at: at }).eq("id", row.id);
    await planned(new Date().toISOString());
    if (!email.received_at || Date.now() - new Date(email.received_at).getTime() > ACT_WITHIN_MS) continue;

    const category = String(row.category);
    const suspicious = looksLikeInstructions(email.subject, email.body_text, email.body_html);
    const actions = (Array.isArray(row.quick_actions) ? row.quick_actions : []) as QuickAction[];
    const from = email.sender?.split("<")[0]?.trim() || email.sender_email || "someone";
    // An email read again (its text was filled in later) keeps what was
    // already done or proposed for it; nothing is done twice.
    const { data: before } = await db.from("action_log").select("kind, detail").eq("email_id", email.id).in("status", ["done", "running", "proposed"]);
    const already = new Set((before ?? []).map((r) => r.kind as string));
    // Labels count one by one: an email carries its sort and the user's own.
    const labelled = new Set((before ?? []).filter((r) => r.kind === "label").map((r) => String((r.detail as { label?: string } | null)?.label ?? "")));
    let waiting = false;
    const run = async (p: Planned, send?: AutoSend) => {
      if (p.kind === "label" ? labelled.has(String(p.detail?.label ?? "")) : already.has(p.kind)) return "refused";
      const r = await act(userId, p, { ...settings, source: "engine", suspicious, todayCount: today[p.kind] ?? 0, cycleCount, send, sendCap });
      // A proposal, a drafted reply or a meeting to confirm waits on the user.
      if (r === "proposed" || (r === "done" && (p.kind === "draft" || p.kind === "meeting"))) waiting = true;
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
    if (!suspicious) {
      const own = new Set((row.extra_labels as string[] | null) ?? []);
      for (const l of userLabelList.filter((x) => own.has(x.slug))) {
        const name = gmailLabelOf(l);
        await run({ kind: "label", emailId: email.id, summary: `Label "${l.display_name}"`, detail: { label: name } });
      }
    }

    const replyTo = (email.reply_to_email || email.sender_email || "").trim();
    const reply = actions.find((a) => a.action === "reply");
    const wantsDraft =
      category === "action-required" && !!reply && !!replyTo && !NO_REPLY.test(replyTo) && !already.has("draft") && !already.has("send") && !stopped("draft") && !(await laterInThread(email));
    const todo = todoOf(actions, email, category);
    const wantsTodo = !!todo && !already.has("todo") && !stopped("todo") && !(await sameTodo(userId, String(todo.label), sender));

    // From someone the user does not know and has said nothing about: ask
    // instead of guessing, when the draft or todo would otherwise happen. A
    // no-reply address is never known from opened mail alone: a platform
    // writing for someone is not that someone.
    let asked = false;
    if ((wantsDraft || wantsTodo) && sender && !covers(prefs)) {
      const kind = wantsDraft ? "draft" : "todo";
      const would = decide({ kind, ...settings, source: "engine", suspicious, todayCount: today[kind] ?? 0, cycleCount }).verdict !== "refuse";
      if (would && (NO_REPLY.test(sender) || !(await knowsSender(userId, sender, { exceptEmailId: email.id, account: accountOf(email.account_id) })))) {
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
      // From the address the email was sent to (an alias, another account).
      const account = accounts.get(email.account_id ?? "");
      const fromAddress = account ? replyFrom(account, email) : null;
      const base: Planned = { kind: "draft", emailId: email.id, summary: `Draft a reply to ${from}`, detail: { to: [replyTo], subject, accountId: email.account_id, from: fromAddress } };
      const autoSend: AutoSend = { to: [replyTo], threadId: email.thread_id, writer: replyTo };
      const sendCtx = { ...settings, source: "engine" as const, suspicious, todayCount: today.send ?? 0, cycleCount, send: autoSend, sendCap };
      const asker = settings.level === "autopilot" ? accountOf(email.account_id) : null;
      const trySend =
        settings.level === "autopilot" &&
        decide({ kind: "send", ...sendCtx }).verdict === "do" &&
        (!profile?.autopilot_known_only || (await wroteTo(userId, replyTo, asker)));
      // Ask before paying for the model call; a refusal is logged by act().
      const pre = decide({ kind: "draft", ...settings, source: "engine", suspicious, todayCount: today.draft ?? 0, cycleCount });
      const { count: existing } = await db.from("draft_emails").select("id", { count: "exact", head: true }).eq("email_id", email.id);
      if (pre.verdict === "refuse" && !trySend) await run(base);
      else if (!existing) {
        try {
          const instructions = String(reply.text || reply.label || "");
          let body = (await drafter.draft(userId, email, trySend ? `${instructions}\n\n${AUTOPILOT_INSTRUCTIONS}` : instructions)).trim();
          if (trySend && GAP.test(body)) {
            // Kept as a draft, for the user to fill in.
            if (pre.verdict === "refuse") body = "";
          } else if (trySend && HOLD.test(body)) {
            body = pre.verdict === "refuse" ? "" : (await drafter.draft(userId, email, instructions)).trim();
          } else if (trySend && body) {
            let inReplyTo: string | null = null;
            try {
              if (asker && email.gmail_id) inReplyTo = (await mail(asker).headers(asker, email.gmail_id, ["Message-ID"]))["message-id"] ?? null;
            } catch {
              // Without the Message-ID the reply still lands in the thread by its thread id.
            }
            const r = await run(
              {
                kind: "send",
                emailId: email.id,
                summary: `Reply to ${from}`,
                detail: { to: [replyTo], subject, body, threadId: email.thread_id, accountId: email.account_id, from: fromAddress, inReplyTo, delayMinutes },
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
          // Planned again in the next pass; what is already done is not repeated.
          console.error("[engine] reply failed:", (e as Error).message);
          const tries = (draftTries.get(email.id) ?? 0) + 1;
          draftTries.set(email.id, tries);
          if (tries < DRAFT_TRIES) await planned(null);
        }
      }
    }

    // Todo.
    if (wantsTodo && !asked) {
      const due = dueOf(todo.quote, timezone, new Date(email.received_at));
      await run({ kind: "todo", emailId: email.id, summary: `Todo: ${todo.label}`, detail: { text: String(todo.label).trim(), ...(due ? { due } : {}) } });
    }

    // Meeting proposal, only when the email states a time that has not
    // passed and the calendar has nothing then or with this sender a day
    // either side; if it has, the email is linked to that event instead.
    // Calendar mail never becomes a proposal (the analysis linked it).
    const suggested = email.is_calendar || stopped("meeting") ? undefined : actions.find((a) => a.action === "schedule_meeting");
    const meeting = suggested ? meetingOf(suggested, email, timezone, new Date(email.received_at)) : null;
    const wall = meeting?.dateTime ? parseWallClock(meeting.dateTime) : null;
    if (meeting && wall !== null && !row.calendar) {
      const start = wallClockToUtc(wall, timezone);
      const minutes = Math.min(Math.max(meeting.duration || 60, 5), 24 * 60);
      const cal = start.getTime() > Date.now() ? calendar : null;
      // Ask the calendar only when a proposal could follow; a refusal is logged by act().
      const allowed = decide({ kind: "meeting", ...settings, source: "engine", suspicious, todayCount: today.meeting ?? 0, cycleCount }).verdict !== "refuse";
      let onCalendar: LinkedEvent | null = null;
      try {
        if (cal && allowed) onCalendar = await cal.calendar.find(cal.account, { start: start.toISOString(), people: [sender, replyTo.toLowerCase()].filter(Boolean) });
      } catch (e) {
        console.error("[engine] calendar lookup:", (e as Error).message);
      }
      if (onCalendar) await db.from("email_processed").update({ calendar: onCalendar }).eq("id", row.id);
      else if (cal) {
        const said = meeting.asWritten ? ` (${meeting.asWritten} in the email)` : "";
        await run({
          kind: "meeting",
          emailId: email.id,
          summary: `Propose "${meeting.title}" on ${start.toLocaleString("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" })}${said}`,
          detail: {
            title: meeting.title,
            start_time: start.toISOString(),
            end_time: new Date(start.getTime() + minutes * 60_000).toISOString(),
            location: meeting.location,
            description: suggested!.text ?? null,
            as_written: meeting.asWritten,
            quote: meeting.quote,
          },
        });
      }
    }

    // Mail that has been there a while (the first read, mail read again) is not news.
    const news = Date.now() - new Date(email.received_at).getTime() < NEWS_MS;
    const worthIt = news && !stopped("notify") && worthNotifying(profile?.notification_level, { vip: prefs.some((r) => r.value === "vip"), needsUser: category === "action-required" || waiting || asked });
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
      body: preview ? `${n.summary} Cancel it in Replies.` : "Autopilot will send a reply. Cancel it in Replies.",
    });
  }
  // Nothing else outside the working hours, when the user asked for that.
  const rest = inQuietHours(profile) ? [] : notes.filter((n) => !n.replying);
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

// Start or carry on the first read now (a mailbox was just connected, a
// model was just chosen) instead of at the next cycle.
export function readNow(userId: string): void {
  void startFirstRead(userId, () => planNew(userId), true);
  if (modelConfigured()) void readAll(userId).catch((e) => console.error("[engine] reading:", e));
}

// Ask the mailboxes now, not at the watcher's next turn (an account was signed
// in to again).
export function checkMail(): void {
  wakeWatcher();
}

// Plan right away after the window triggered an analysis.
export function kickEngine(): void {
  localUser()
    .then((id) => (id ? planNew(id) : undefined))
    .catch((e) => console.error("[engine] plan:", e));
}

// ── The loop ────────────────────────────────────────────────────────────────

// Once per start: fill in text for HTML-only mail stored earlier.
let startedUp = false;

// Mail stored under older rules (rules.ts RULES_VERSION) is read again once,
// and what those rules made from it is taken back. Completed todos and
// confirmed meetings stay.
export async function rereadUnderNewRules(userId: string): Promise<void> {
  const { data: p } = await db.from("profiles").select("rules_version").eq("id", userId).maybeSingle();
  if (Number(p?.rules_version ?? 0) >= RULES_VERSION) return;
  await refreshStored(userId, 30);
  // Every email something was made or proposed from, or that suggests a
  // todo or meeting, and all calendar mail.
  const [{ data: rows }, { data: todos }, { data: meetings }, { data: logged }] = await Promise.all([
    db.from("email_processed").select("email_id, quick_actions, emails!inner(is_calendar)").eq("user_id", userId).limit(20_000),
    db.from("todos").select("email_id").eq("user_id", userId).neq("source", "manual").eq("is_completed", false).not("email_id", "is", null),
    db.from("meetings").select("email_id").eq("user_id", userId).eq("status", "proposed").not("email_id", "is", null),
    db.from("action_log").select("email_id").eq("user_id", userId).in("kind", ["todo", "meeting"]).in("status", ["done", "proposed"]).not("email_id", "is", null),
  ]);
  const ids = [
    ...new Set([
      ...(rows ?? [])
        .filter((r) => (r.emails as { is_calendar?: boolean }).is_calendar || ((r.quick_actions as QuickAction[] | null) ?? []).some((a) => a.action === "add_todo" || a.action === "schedule_meeting"))
        .map((r) => String(r.email_id)),
      ...[...(todos ?? []), ...(meetings ?? []), ...(logged ?? [])].map((r) => String(r.email_id)),
    ]),
  ];
  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    await db.from("todos").delete().eq("user_id", userId).neq("source", "manual").eq("is_completed", false).in("email_id", batch);
    await db.from("meetings").delete().eq("user_id", userId).eq("status", "proposed").in("email_id", batch);
    await db.from("action_log").update({ status: "dismissed", decided_at: now, reason: "Read again" }).eq("user_id", userId).eq("status", "proposed").in("kind", ["todo", "meeting"]).in("email_id", batch);
    // A done todo or meeting whose item is gone is no longer done.
    const [{ data: made }, { data: left }, { data: kept }] = await Promise.all([
      db.from("action_log").select("id, detail").eq("user_id", userId).eq("status", "done").in("kind", ["todo", "meeting"]).in("email_id", batch),
      db.from("todos").select("id").eq("user_id", userId).in("email_id", batch),
      db.from("meetings").select("id").eq("user_id", userId).in("email_id", batch),
    ]);
    const exists = new Set([...(left ?? []), ...(kept ?? [])].map((r) => String(r.id)));
    for (const r of made ?? []) {
      const d = r.detail as { todoId?: string; meetingId?: string };
      if (!exists.has(String(d.todoId ?? d.meetingId))) await db.from("action_log").update({ status: "undone", undone_at: now, reason: "Read again" }).eq("id", r.id);
    }
    await db.from("email_processed").delete().in("email_id", batch);
  }
  await db.from("profiles").update({ rules_version: RULES_VERSION }).eq("id", userId);
  console.log(`[engine] read ${ids.length} emails again under the current rules`);
}

// A meeting nobody confirmed in time no longer waits on the user.
export async function closePastMeetings(userId: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: proposals } = await db.from("action_log").select("id, detail").eq("user_id", userId).eq("kind", "meeting").eq("status", "proposed");
  const past = (proposals ?? []).filter((r) => String((r.detail as { end_time?: string } | null)?.end_time ?? "9") < now).map((r) => String(r.id));
  if (past.length) await db.from("action_log").update({ status: "dismissed", decided_at: now, reason: PASSED }).in("id", past);
  const { data: gone } = await db.from("meetings").delete().eq("user_id", userId).eq("status", "proposed").lt("end_time", now).select("id");
  if (!gone?.length) return;
  const ids = new Set(gone.map((m) => String(m.id)));
  const { data: made } = await db.from("action_log").select("id, detail").eq("user_id", userId).eq("kind", "meeting").eq("status", "done");
  for (const r of made ?? []) if (ids.has(String((r.detail as { meetingId?: string }).meetingId))) await db.from("action_log").update({ status: "undone", undone_at: now, reason: PASSED }).eq("id", r.id);
}

// A reply that waits on an email the conversation has moved past is no longer
// the reply to send: a proposal goes once anyone has written since, a draft
// Tabellar wrote (and the user has not saved) once the user has answered.
export async function withdrawStale(userId: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: proposals } = await db.from("action_log").select("id, emails!inner(id, thread_id, received_at)").eq("user_id", userId).eq("kind", "draft").eq("status", "proposed");
  for (const r of proposals ?? []) {
    if (await laterInThread(r.emails as EmailRow)) await db.from("action_log").update({ status: "dismissed", decided_at: now, reason: MOVED_ON }).eq("id", r.id).eq("status", "proposed");
  }
  const { data: drafts } = await db.from("draft_emails").select("id, created_at, emails!inner(id, thread_id, received_at)").eq("user_id", userId).eq("source", "tabellar").is("gmail_draft_id", null);
  for (const d of drafts ?? []) {
    const e = d.emails as EmailRow;
    if (!e.thread_id) continue;
    const { count } = await db.from("emails").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("thread_id", e.thread_id).contains("label_ids", ["SENT"]).gt("received_at", d.created_at);
    if (count) await db.from("draft_emails").delete().eq("id", d.id);
  }
}

// Sort and plan everything not read yet, a batch at a time.
const readAll = (userId: string) => readBacklog(userId, () => planNew(userId));

export async function runCycle(): Promise<void> {
  if (engineStatus.running) return;
  const userId = await localUser();
  if (!userId) return;
  const { count } = await db.from("accounts").select("id", { count: "exact", head: true }).eq("user_id", userId);
  if (!count) return;
  engineStatus.running = true;
  try {
    if (!startedUp) {
      await fillMissingBodies(userId);
      await retireTrivia(userId);
      await rereadUnderNewRules(userId);
      void relearnStyle(userId).catch((e) => console.error("[engine] style:", (e as Error).message));
      startedUp = true;
    }
    // Until the first read of every mailbox is done, carry it on in the background.
    const unread = await db.from("accounts").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("paused", false).is("read_at", null);
    if ((await firstReadState(userId)).step !== "done" || unread.count) void startFirstRead(userId, () => planNew(userId));
    await closePastMeetings(userId);
    await withdrawStale(userId);
    await refreshStaleSendAs(userId);
    await applyWaitingLabels(userId);
    await syncMail(userId);
    if (modelConfigured()) {
      await readAll(userId);
      await judgeSent(userId);
    }
    if (!(await engineSettings(userId)).paused) void prepareBrief(userId).catch((e) => console.error("[engine] brief:", (e as Error).message));
    engineStatus.lastError = [...syncErrors.values()][0] ?? null;
  } catch (e) {
    engineStatus.lastError = (e as Error).message;
    console.error("[engine]", e);
  } finally {
    engineStatus.running = false;
    engineStatus.lastCycleAt = new Date().toISOString();
  }
}

// ── The watcher ─────────────────────────────────────────────────────────────

// Asks each mailbox whether anything changed: every 5 seconds while a window is
// connected to /events, every 20 seconds otherwise. One small request per
// account (where the mailbox's change history stands); when it moved, the
// change is synced at once and new mail is read and planned. Failures (no
// network, a Mac just awake) back off up to 5 minutes, 30 seconds with a window open.
const WATCH_OPEN_MS = 5_000;
const WATCH_CLOSED_MS = 20_000;
const WATCH_MAX_MS = 5 * 60_000;
const WATCH_MAX_OPEN_MS = 30_000; // with someone looking at it

let windowsOpen = 0;
let wakeWatcher = () => {};
export function windowOpened(): void {
  windowsOpen++;
  wakeWatcher();
}
export function windowClosed(): void {
  windowsOpen = Math.max(0, windowsOpen - 1);
}

// One mailbox that cannot be reached does not keep the others from being
// watched. `failures` counts each one's checks that failed in a row.
async function mailboxChanged(userId: string, failures: Map<string, number>): Promise<boolean> {
  const { data } = await db.from("accounts").select("*").eq("user_id", userId).eq("paused", false);
  const accounts = (data ?? []) as unknown as Account[];
  let changed = false;
  let error: string | null = null;
  let signIn: string | null = null;
  for (const id of failures.keys()) if (!accounts.some((a) => a.id === id)) failures.delete(id);
  for (const a of accounts) {
    const box = mail(a);
    try {
      box.watch?.(a, () => wakeWatcher());
      if (a.history_id && (await box.moved(a))) changed = true;
      failures.delete(a.id);
    } catch (e) {
      const n = (failures.get(a.id) ?? 0) + 1;
      failures.set(a.id, n);
      if (n >= 3) error = accounts.length > 1 ? `${a.address}: ${(e as Error).message}` : (e as Error).message;
      if ((e as { status?: number }).status === 401) signIn = a.address;
    }
  }
  engineStatus.mailError = error;
  engineStatus.signIn = signIn;
  return changed;
}

// Read and plan new mail, one run at a time; mail arriving meanwhile is
// picked up by one more run.
let reading = false;
let readAgain = false;
async function readNew(userId: string): Promise<void> {
  if (reading) {
    readAgain = true;
    return;
  }
  reading = true;
  try {
    do {
      readAgain = false;
      await readAll(userId);
    } while (readAgain);
  } catch (e) {
    console.error("[engine] reading new mail:", e);
  } finally {
    reading = false;
  }
}

function startWatcher(): () => void {
  let stopped = false;
  let busy = false;
  let soon = false;
  const failures = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(check, ms);
  };
  const check = async () => {
    if (busy) {
      soon = true;
      return;
    }
    busy = true;
    let delay = windowsOpen ? WATCH_OPEN_MS : WATCH_CLOSED_MS;
    try {
      const userId = await localUser();
      const changed = !!userId && (await mailboxChanged(userId, failures));
      if (userId && changed) {
        const fresh = await syncMail(userId);
        await withdrawStale(userId);
        if (fresh.length && modelConfigured()) void readNew(userId);
      }
      // While none can be reached, ask less and less often.
      const { count } = await db.from("accounts").select("id", { count: "exact", head: true }).eq("paused", false);
      if (failures.size && failures.size === count) delay = Math.min(windowsOpen ? WATCH_MAX_OPEN_MS : WATCH_MAX_MS, delay * 2 ** Math.min(...failures.values()));
    } catch (e) {
      console.error("[engine] watching:", (e as Error).message);
    } finally {
      busy = false;
    }
    if (soon) {
      soon = false;
      delay = 0;
    }
    schedule(delay);
  };
  wakeWatcher = () => schedule(0);
  schedule(3_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
    wakeWatcher = () => {};
  };
}

// The Brief's notification and the ones before a meeting, once a minute and
// apart from the cycle, which a long backlog can hold up. The Brief waits for
// a cycle that has just finished, so it is about this morning's mail.
let telling = false;
async function tellUser(): Promise<void> {
  if (telling) return;
  telling = true;
  try {
    const userId = await localUser();
    if (!userId || (await engineSettings(userId)).paused) return;
    const fresh = !!engineStatus.lastCycleAt && Date.now() - new Date(engineStatus.lastCycleAt).getTime() < 5 * 60_000;
    await tellBrief(userId, { fresh });
    await tellMeetings(userId);
  } catch (e) {
    console.error("[engine] notifications:", (e as Error).message);
  } finally {
    telling = false;
  }
}

export function startEngine(): () => void {
  let last = 0;
  let ticked = Date.now();
  const tell = setInterval(() => void tellUser(), 60_000);
  const tick = () => {
    // The timer did not run for a while: the Mac was asleep. Look at once.
    if (Date.now() - ticked > 3 * TICK_MS) wakeWatcher();
    ticked = Date.now();
    if (Date.now() - last < INTERVAL_MS) return;
    last = Date.now();
    void runCycle();
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, TICK_MS);
  const stopWatcher = startWatcher();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    clearInterval(tell);
    stopWatcher();
  };
}
