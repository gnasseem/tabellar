// Answering a line of the Brief, whatever it is: a draft (send it, with the
// answer chosen where it leaves one open, or discard it), something proposed,
// a meeting, a todo, a question, mail to look at, someone who owes an answer;
// and a reply Autopilot is about to send, or an automation not turned on yet.
// The window, and anything else the user answers from, calls options() and
// answer() and nothing else.
//
// A `pick` names an answer and carries a hash of what the line showed, so what
// is done is what was read: when the line changed meanwhile, no answer of it
// has that name any more and nothing happens.
//
// Every answer can be taken back for ten minutes (a send until it goes out),
// and the line is there again. How is kept in memory; a restart forgets it.

import { createHash, randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { act, approve, confirmMeeting, dismiss, engineSettings, setMailState, unapprove, undo as undoAction } from "./actions.ts";
import { archivedByHand, listAutomations, remove as removeAutomation, setEnabled } from "./automations.ts";
import { choicesOf, choose } from "./choices.ts";
import { discardDrafts, putInDrafts, queueDraft, textToHtml, UNDO_SEND_MS, unqueue, unsendable } from "./drafts.ts";
import { followupList } from "./followups.ts";
import { localToUtc } from "./ai.ts";
import { modelConfigured } from "./llm.ts";
import { htmlToText } from "./mime.ts";
import { wallClock, type Hours } from "./notify.ts";
import { answer as answerQuestion, feedback, type Option as QuestionOption } from "./profile.ts";
import { reversible } from "./reversible.ts";
import { writeTo } from "./replies.ts";
import { snooze } from "./snooze.ts";
import { accountById, addressesOf, defaultAccount, defaultFrom } from "./accounts.ts";

const UNDO_MS = 10 * 60_000;
const DAY = 86_400_000;
const LATER_DAYS = 3;
const MOST = 3; // answers to a line

type Row = Record<string, any>;
// `undo` takes it back; `ms` is how long that lasts, when not the ten minutes.
// `next` is the line that goes on from here, when one answer was not all;
// `queued` the scheduled_emails row it became.
type Done = { said: string; undo?: () => Promise<unknown>; ms?: number; link?: string | null; next?: string; queued?: string; replan?: boolean };
type Choice = { label: string; run: () => Promise<Done>; sends?: string };
// What a line says beyond its one row (who a draft goes to and its text, the
// sentence a meeting came from), and the answers it takes. `stamp` is the rest
// of what the answers stand on.
type Line = { to: string; shows: string; stamp?: unknown; choices: Choice[] };

export type Options = { to: string; shows: string; options: { pick: string; label: string; sends?: string }[] };

const said = (message: string, status = 409) => Object.assign(new Error(message), { status });

function pickOf(key: string, line: Line, i: number): string {
  const c = line.choices[i];
  return `${i}.${createHash("sha256").update(JSON.stringify([key, line.to, line.shows, line.stamp ?? null, c.label, c.sends ?? ""])).digest("hex").slice(0, 12)}`;
}

// The answers of a line, or null when it no longer waits.
export async function options(userId: string, key: string): Promise<Options | null> {
  const line = await lineOf(userId, key);
  return line && { to: line.to, shows: line.shows, options: line.choices.map((c, i) => ({ pick: pickOf(key, line, i), label: c.label, ...(c.sends === undefined ? {} : { sends: c.sends }) })) };
}

const busy = new Set<string>();
const undos = new Map<string, { run: () => Promise<unknown>; until: number }>();

export type Answered = { said: string; undo: string | null; ms: number | null; link: string | null; next: string | null; queued: string | null; replan: boolean };
export async function answer(userId: string, key: string, pick: string): Promise<Answered> {
  if (busy.has(key)) throw said("That is being answered already");
  busy.add(key);
  try {
    const line = await lineOf(userId, key);
    if (!line) throw said("That was already answered");
    const i = line.choices.findIndex((_, n) => pickOf(key, line, n) === pick);
    if (i < 0) throw said("This changed after you saw it. Look again.");
    const done = await line.choices[i].run();
    for (const [id, u] of undos) if (u.until < Date.now()) undos.delete(id);
    const id = done.undo ? randomUUID() : null;
    if (id) undos.set(id, { run: done.undo!, until: Date.now() + (done.ms ?? UNDO_MS) + 1000 });
    return { said: done.said, undo: id, ms: done.ms ?? null, link: done.link ?? null, next: done.next ?? null, queued: done.queued ?? null, replan: !!done.replan };
  } finally {
    busy.delete(key);
  }
}

// Takes an answer back. `said` when there is more to say than that.
export async function undoAnswer(id: string): Promise<{ said?: string }> {
  const u = undos.get(id);
  undos.delete(id);
  if (!u || u.until < Date.now()) throw said("Too late to undo that");
  const out = await u.run();
  return typeof out === "string" ? { said: out } : {};
}

async function lineOf(userId: string, key: string): Promise<Line | null> {
  const kind = key.slice(0, key.indexOf(":"));
  const id = key.slice(key.indexOf(":") + 1);
  const of: Record<string, (userId: string, id: string) => Promise<Line | null>> = { draft, act: proposal, meeting, todo, question, back, read, wait, proof, sending, automation };
  const line = of[kind] ? await of[kind](userId, id) : null;
  return line && { ...line, choices: line.choices.slice(0, MOST) };
}

// ── Drafts ──────────────────────────────────────────────────────────────────

const namesOf = (d: Row) => {
  const some = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const [to, cc, bcc] = [some(d.to_addresses), some(d.cc_addresses), some(d.bcc_addresses)];
  return [to.join(", "), cc.length ? `cc ${cc.join(", ")}` : "", bcc.length ? `bcc ${bcc.join(", ")}` : ""].filter(Boolean).join(", ");
};

async function sendIt(userId: string, draftId: string, html?: string): Promise<Done> {
  const q = await queueDraft(userId, draftId, { html });
  return {
    said: `Sending to ${q.to[0]}${q.to.length > 1 ? ` and ${q.to.length - 1} more` : ""} in ${UNDO_SEND_MS / 1000} seconds`,
    ms: UNDO_SEND_MS,
    queued: q.id,
    undo: async () => ((await unqueue(userId, [q.id])).length ? "Not sent" : "Too late, already sent"),
  };
}

// One of two decisions is taken: the draft stays, with that one settled.
async function settle(userId: string, draftId: string, text: string, label: string): Promise<Done> {
  const { data: before } = await db.from("draft_emails").select("body_html").eq("id", draftId).eq("user_id", userId).maybeSingle();
  if (!before) throw said("That draft was already sent or discarded");
  const put = async (html: string) => {
    await db.from("draft_emails").update({ body_html: html }).eq("id", draftId);
    await putInDrafts(userId, draftId).catch((e) => console.error("[answers] not in the mailbox yet:", (e as Error).message));
  };
  await put(textToHtml(text));
  return { said: `${label}, one more to decide`, next: `draft:${draftId}`, undo: () => put(String(before.body_html ?? "")) };
}

// The answers a draft's text leaves open, else Send; nothing when it cannot go
// out as it is. `ready` is the draft's id, made first where it is a proposal.
function sends(userId: string, d: { to: string[]; text: string; html?: string }, ready: () => Promise<string>): Choice[] {
  const open = choicesOf(d.text);
  if (!open.length) {
    if (unsendable(d.to, d.text)) return [];
    return [{ label: "Send", sends: d.text, run: async () => sendIt(userId, await ready(), d.html) }];
  }
  return open[0].flatMap((c, i): Choice[] => {
    const text = choose(d.text, [i]);
    if (open.length > 1) return d.to.length ? [{ label: c.label, sends: text, run: async () => settle(userId, await ready(), text, c.label) }] : [];
    return unsendable(d.to, text) ? [] : [{ label: c.label, sends: text, run: async () => sendIt(userId, await ready(), textToHtml(text)) }];
  });
}

async function draft(userId: string, id: string): Promise<Line | null> {
  const { data: d } = await db.from("draft_emails").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!d) return null;
  const text = htmlToText(String(d.body_html ?? ""));
  const discard: Choice = {
    label: "Discard",
    run: async () => {
      if (!(await discardDrafts(userId, [id])).length) throw said("That draft was already sent or discarded");
      return {
        said: "Draft discarded",
        undo: async () => {
          await db.from("draft_emails").insert({ ...d, gmail_draft_id: null, mailbox_version: null });
          await putInDrafts(userId, id).catch((e) => console.error("[answers] not in the mailbox yet:", (e as Error).message));
        },
      };
    },
  };
  const out = sends(userId, { to: (d.to_addresses as string[] | null) ?? [], text }, async () => id);
  // One that cannot go out as it is can wait.
  if (!out.length && d.email_id) return { to: namesOf(d), shows: text, choices: [discard, ...(await tomorrowFor(userId, String(d.email_id)))] };
  return { to: namesOf(d), shows: text, stamp: [d.subject, d.body_html, d.forward], choices: [...out, discard] };
}

// ── What waits for approval ─────────────────────────────────────────────────

async function proposal(userId: string, id: string): Promise<Line | null> {
  const { data: p } = await db.from("action_log").select("*").eq("id", id).eq("user_id", userId).eq("status", "proposed").maybeSingle();
  if (!p) return null;
  const d = (p.detail as Row | null) ?? {};
  const yes = () => approve(userId, id, String(p.hash ?? ""));
  // Taken back, it waits again; what approving taught is forgotten.
  const reverse = async (change: () => Promise<unknown>) => {
    const forget = await reversible(db, userId, change);
    return async () => {
      await unapprove(userId, p);
      await forget();
    };
  };
  const no: Choice = { label: "Dismiss", run: async () => ({ said: "Dismissed", undo: await reversible(db, userId, () => dismiss(userId, id)) }) };
  if (p.kind === "draft") {
    const text = String(d.body ?? "");
    const to = (d.to as string[] | undefined) ?? [];
    let draftId = "";
    let back = async () => {};
    const ready = async () => {
      back = await reverse(async () => void (draftId = String((await yes()).draftId)));
      return draftId;
    };
    const taken = (c: Choice): Choice => ({
      ...c,
      run: async () => {
        // Not queued, or taken back in time: the draft is here, and is a proposal again.
        const restore = async () => void ((await draft(userId, draftId)) && (await back()));
        const done = await c.run().catch(async (e) => {
          await restore();
          throw e;
        });
        return {
          ...done,
          undo: async () => {
            const words = await done.undo?.();
            await restore();
            return words;
          },
        };
      },
    });
    return { to: namesOf({ to_addresses: to }), shows: text, stamp: p.hash, choices: [...sends(userId, { to, text }, ready).map(taken), no] };
  }
  if (p.kind === "meeting") {
    const add = async (): Promise<Done> => {
      let made: Awaited<ReturnType<typeof confirmMeeting>> | null = null;
      const back = await reverse(async () => {
        const { meetingId } = await yes();
        try {
          made = await confirmMeeting(userId, String(meetingId));
        } catch (e) {
          // Not on the calendar: the proposal waits as it was.
          await unapprove(userId, p);
          throw e;
        }
      });
      return { said: "On your calendar", link: made!.link, undo: async () => (await made!.undo(), await back()) };
    };
    return { to: "", shows: aboutMeeting(d), stamp: p.hash, choices: [{ label: "Add to calendar", run: add }, no] };
  }
  const label = p.kind === "todo" ? "Add" : "Approve";
  const run = async (): Promise<Done> => ({ undo: await reverse(yes), said: p.kind === "todo" ? "Todo added" : String(p.summary) });
  return { to: "", shows: p.kind === "todo" ? [d.quote ? `"${d.quote}"` : "", d.due ? `By ${d.due}` : ""].filter(Boolean).join("\n") : "", stamp: p.hash, choices: [{ label, run }, no] };
}

// ── Meetings, todos, questions ──────────────────────────────────────────────

const aboutMeeting = (m: Row) =>
  [m.quote ? `"${m.quote}"` : "", m.as_written ? `${m.as_written}, as written` : "", m.location ? `At ${m.location}` : "", Array.isArray(m.attendees) && m.attendees.length ? `Invites ${m.attendees.join(", ")}` : ""].filter(Boolean).join("\n");

async function meeting(userId: string, id: string): Promise<Line | null> {
  const { data: m } = await db.from("meetings").select("*").eq("id", id).eq("user_id", userId).eq("status", "proposed").maybeSingle();
  if (!m) return null;
  return {
    to: "",
    shows: aboutMeeting(m),
    stamp: [m.title, m.start_time, m.end_time],
    choices: [
      {
        label: "Add to calendar",
        run: async () => {
          const made = await confirmMeeting(userId, id);
          return { said: "On your calendar", link: made.link, undo: made.undo };
        },
      },
      { label: "Dismiss", run: async () => ({ said: "Dismissed", undo: await reversible(db, userId, () => feedback(userId, { thing: "meeting", outcome: "not_this", id })) }) },
    ],
  };
}

// A day so many days from today, as the user's clock has it.
async function dayAhead(userId: string, days: number): Promise<{ day: string; morning: string }> {
  const { data: me } = await db.from("profiles").select("working_hours").eq("id", userId).maybeSingle();
  const hours = me?.working_hours as Hours | null;
  const tz = hours?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = wallClock(tz).day;
  const day = new Date(new Date(`${today}T12:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
  return { day, morning: localToUtc(`${day}T${hours?.start || "09:00"}`, tz) };
}

async function todo(userId: string, id: string): Promise<Line | null> {
  const { data: t } = await db.from("todos").select("*").eq("id", id).eq("user_id", userId).eq("is_completed", false).maybeSingle();
  if (!t) return null;
  const set = async (patch: Row, words: string): Promise<Done> => {
    await db.from("todos").update(patch).eq("id", id);
    return { said: words, undo: () => Promise.resolve(db.from("todos").update({ is_completed: false, due: t.due }).eq("id", id)) };
  };
  return {
    to: "",
    shows: "",
    stamp: [t.text, t.due],
    choices: [
      { label: "Done", run: () => set({ is_completed: true }, "Done") },
      { label: "Tomorrow", run: async () => set({ due: (await dayAhead(userId, 1)).day }, "Due tomorrow") },
      { label: "Next week", run: async () => set({ due: (await dayAhead(userId, 7)).day }, "Due in a week") },
    ],
  };
}

async function question(userId: string, id: string): Promise<Line | null> {
  const { data: q } = await db.from("questions").select("*").eq("id", id).eq("user_id", userId).eq("status", "open").maybeSingle();
  if (!q) return null;
  return {
    to: "",
    shows: [q.text, q.detail].filter(Boolean).join("\n"),
    choices: ((q.options as QuestionOption[] | null) ?? []).map((o, i) => ({
      label: o.label,
      run: async () => {
        let replan: string | null = null;
        const undo = await reversible(db, userId, async () => ({ replan } = await answerQuestion(userId, id, i)));
        return { said: `Answered: ${o.label}`, undo, replan: !!replan };
      },
    })),
  };
}

// ── Mail to look at ─────────────────────────────────────────────────────────

const MAIL = "id, thread_id, subject, snippet, is_read, is_archived, is_snoozed, snooze_until, resolved_at";
const FLAGS = ["is_snoozed", "snooze_until", "resolved_at"] as const;

// Before and after a change to an email and the rest of its thread: how they
// stood is put back, in the mailbox where the change reached it.
async function mailChange(userId: string, emailId: string, words: string, change: () => Promise<unknown>): Promise<Done> {
  const { data: e } = await db.from("emails").select(MAIL).eq("id", emailId).eq("user_id", userId).single();
  const { data: thread } = e!.thread_id ? await db.from("emails").select(MAIL).eq("user_id", userId).eq("thread_id", e!.thread_id).not("label_ids", "cs", '{"SENT"}') : { data: [e] };
  await change();
  return {
    said: words,
    undo: async () => {
      for (const was of (thread ?? []) as Row[]) {
        const { data: now } = await db.from("emails").select(MAIL).eq("id", was.id).maybeSingle();
        if (!now) continue;
        const state = { ...(now.is_archived !== was.is_archived ? { archived: !!was.is_archived } : {}), ...(now.is_read !== was.is_read ? { read: !!was.is_read } : {}) };
        if (Object.keys(state).length) await setMailState(userId, [String(was.id)], state);
        await db.from("emails").update(Object.fromEntries(FLAGS.map((f) => [f, was[f]]))).eq("id", was.id);
      }
    },
  };
}

// Out of sight until tomorrow morning.
const tomorrowFor = async (userId: string, emailId: string): Promise<Choice[]> => [
  { label: "Tomorrow", run: async () => mailChange(userId, emailId, "Back tomorrow", async () => snooze(userId, [emailId], (await dayAhead(userId, 1)).morning)) },
];

const archive = (userId: string, emailId: string): Choice => ({
  label: "Archive",
  run: () =>
    mailChange(userId, emailId, "Archived", async () => {
      await setMailState(userId, [emailId], { archived: true });
      void archivedByHand(userId, [emailId]).catch((e) => console.error("[automations] by hand:", (e as Error).message));
    }),
});

async function emailOf(userId: string, id: string) {
  const { data } = await db.from("emails").select(`${MAIL}, email_processed(summary)`).eq("id", id).eq("user_id", userId).eq("is_archived", false).eq("is_snoozed", false).maybeSingle();
  if (!data) return null;
  const p = (Array.isArray(data.email_processed) ? data.email_processed[0] : data.email_processed) as Row | null;
  return { ...data, shows: String(p?.summary || data.snippet || "") } as Row;
}

async function back(userId: string, id: string): Promise<Line | null> {
  const e = await emailOf(userId, id);
  if (!e?.snooze_until || e.resolved_at) return null;
  const done: Choice = { label: "Done", run: () => mailChange(userId, id, "Done", async () => db.from("emails").update({ resolved_at: new Date().toISOString() }).eq("id", id)) };
  return { to: "", shows: e.shows, choices: [done, archive(userId, id), ...(await tomorrowFor(userId, id))] };
}

async function read(userId: string, id: string): Promise<Line | null> {
  const e = await emailOf(userId, id);
  if (!e || e.is_read) return null;
  const seen: Choice = { label: "Mark read", run: () => mailChange(userId, id, "Marked read", () => setMailState(userId, [id], { read: true })) };
  return { to: "", shows: e.shows, choices: [seen, archive(userId, id), ...(await tomorrowFor(userId, id))] };
}

// ── Who owes the user an answer ─────────────────────────────────────────────

async function wait(userId: string, id: string): Promise<Line | null> {
  const f = (await followupList(userId)).find((x) => x.key === id);
  if (!f) return null;
  // A suggestion gets a row of its own, so what is said about it stays.
  const mark = async (words: string, fields: Row): Promise<Done> => {
    const { data: had } = await db.from("follow_up_reminders").select("*").eq("user_id", userId).eq("thread_id", f.thread_id).maybeSingle();
    const { error } = await db
      .from("follow_up_reminders")
      .upsert({ user_id: userId, email_id: f.email_id, thread_id: f.thread_id, recipient_email: f.recipient_email, recipient_name: f.recipient_name, subject: f.subject, remind_at: had?.remind_at ?? new Date().toISOString(), created_at: f.reminder_id ? had!.created_at : new Date().toISOString(), ...fields }, { onConflict: "user_id,thread_id" });
    if (error) throw new Error(error.message);
    return {
      said: words,
      undo: async () => {
        if (had) await db.from("follow_up_reminders").update({ status: had.status, snooze_until: had.snooze_until, created_at: had.created_at }).eq("id", had.id);
        else await db.from("follow_up_reminders").delete().eq("user_id", userId).eq("thread_id", f.thread_id);
      },
    };
  };
  const nudge = async (): Promise<Done> => {
    const { data: e } = await db.from("emails").select("account_id, body_text, sender_email").eq("id", f.email_id).eq("user_id", userId).maybeSingle();
    const account = (await accountById(userId, e?.account_id as string | null)) ?? (await defaultAccount(userId));
    if (!e || !account) throw said("That email is no longer in Tabellar");
    const days = Math.floor((Date.now() - new Date(f.sent_at).getTime()) / DAY);
    const body = await writeTo(userId, {
      to: `${f.recipient_name} <${f.recipient_email}>`,
      subject: f.subject,
      intent: `I sent this ${days ? `${days} day${days === 1 ? "" : "s"} ago` : "earlier today"} and have had no answer. Write a short, friendly follow-up that asks again${f.asked ? `: ${f.asked}` : "."}`,
      replyTo: { subject: f.subject, body: String(e.body_text || f.asked) },
    });
    if (!body.trim()) throw said("No follow-up could be written", 502);
    const { data: rows } = await db.from("draft_emails").select("id").eq("user_id", userId).eq("email_id", f.email_id);
    const had = new Set((rows ?? []).map((r) => String(r.id)));
    const from = addressesOf(account).find((s) => s.address === String(e.sender_email ?? "").toLowerCase())?.address ?? defaultFrom(account);
    const outcome = await act(
      userId,
      { kind: "draft", emailId: f.email_id, summary: `Draft a follow-up to ${f.recipient_name}`, detail: { to: [f.recipient_email], subject: /^re:/i.test(f.subject) ? f.subject : `Re: ${f.subject}`, body, accountId: account.id, from } },
      { ...(await engineSettings(userId)), source: "assistant" },
    );
    if (outcome !== "done") throw said((await engineSettings(userId)).paused ? "Tabellar is paused" : "The follow-up could not be kept");
    const { data: now } = await db.from("draft_emails").select("id").eq("user_id", userId).eq("email_id", f.email_id);
    const made = (now ?? []).map((r) => String(r.id)).filter((x) => !had.has(x));
    return { said: "Follow-up drafted", next: made.length ? `draft:${made[0]}` : undefined, undo: () => discardDrafts(userId, made) };
  };
  return {
    to: f.recipient_email,
    shows: f.asked || f.subject,
    choices: [
      ...(modelConfigured() ? [{ label: "Nudge", run: nudge }] : []),
      { label: `In ${LATER_DAYS} days`, run: () => mark(`Back in ${LATER_DAYS} days`, { status: "snoozed", snooze_until: new Date(Date.now() + LATER_DAYS * DAY).toISOString() }) },
      { label: "Drop", run: () => mark("Dropped", { status: "dismissed", snooze_until: null }) },
    ],
  };
}

// ── What Autopilot is about to send ─────────────────────────────────────────

async function sending(userId: string, id: string): Promise<Line | null> {
  const { data: s } = await db.from("scheduled_emails").select("id, action_id, to_addresses, cc_addresses, bcc_addresses, subject, body_html").eq("id", id).eq("user_id", userId).eq("status", "pending").not("action_id", "is", null).maybeSingle();
  if (!s) return null;
  const cancel = async (): Promise<Done> => {
    await undoAction(userId, String(s.action_id));
    return { said: "Cancelled, kept as a draft" };
  };
  return { to: namesOf(s), shows: htmlToText(String(s.body_html ?? "")), stamp: s.subject, choices: [{ label: "Cancel", run: cancel }] };
}

// ── An automation that is off ───────────────────────────────────────────────

const MATCHES = 3;

// Once its trial is there to look at.
async function automation(userId: string, id: string): Promise<Line | null> {
  const a = (await listAutomations(userId)).find((x) => x.id === id);
  if (!a || a.enabled || !a.tried_at || a.trial?.state !== "done") return null;
  const count = a.trial.matches.length + a.trial.more;
  const some = a.trial.matches.slice(0, MATCHES).map((m) => `${m.who}: ${m.subject}`);
  const shows = [`${a.when}: ${a.then.join("; ")}.`, count ? `It would have matched ${count}${count > some.length ? `, ${some.length} of them` : ""}:` : "It would have matched nothing yet.", ...some].join("\n");
  return {
    to: "",
    shows,
    stamp: [a.text, a.mode],
    choices: [
      {
        label: "Turn on",
        run: async () => {
          await setEnabled(userId, id, true);
          return { said: "On from now on", undo: () => setEnabled(userId, id, false) };
        },
      },
      {
        label: "Delete",
        run: async () => {
          const { data: row } = await db.from("automations").select("*").eq("id", id).eq("user_id", userId).single();
          await removeAutomation(userId, id);
          return { said: "Deleted", undo: () => Promise.resolve(db.from("automations").insert(row!)) };
        },
      },
    ],
  };
}

// ── Proof before trust ──────────────────────────────────────────────────────

// The drafts went out as written: let the ones to people the user has written
// to go out on their own.
async function proof(userId: string): Promise<Line | null> {
  const { data: me } = await db.from("profiles").select("autonomy_level, autopilot_known_only, proof").eq("id", userId).maybeSingle();
  if (!me || me.proof === "done") return null;
  const set = async (words: string, patch: Row): Promise<Done> => {
    await db.from("profiles").update({ ...patch, proof: "done" }).eq("id", userId);
    return { said: words, undo: () => Promise.resolve(db.from("profiles").update({ autonomy_level: me.autonomy_level, autopilot_known_only: me.autopilot_known_only, proof: me.proof }).eq("id", userId)) };
  };
  return {
    to: "",
    shows: "",
    stamp: me.autonomy_level,
    choices: [
      { label: "Autopilot for people I know", run: () => set("Autopilot is on, for people you know", { autonomy_level: "autopilot", autopilot_known_only: true }) },
      { label: "No", run: () => set("Left as it is", {}) },
    ],
  };
}
