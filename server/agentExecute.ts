/**
 * Execute an approved Solve-Everything plan.
 *
 * Takes a session id + a selection of approved action ids (with optional
 * edits the user made in the review UI) and runs each action against the
 * appropriate backend:
 *   - reply     -> sent from the mailbox OR a draft_emails row
 *   - todo      -> todos row
 *   - meeting   -> meetings row + Google Calendar event
 *   - archive   -> archived in the mailbox and logged in action_log (undoable)
 *
 * Every action first asks the policy, so nothing runs while Tabellar is paused.
 *
 * Results are written back to agent_sessions.results keyed by action id:
 *   { status: 'success' | 'error', info?: string, error?: string }
 */

import type { Db } from "./db.ts";
import { mail, userCalendar } from "./providers.ts";
import { accountById, defaultAccount, fromLine, replyFrom } from "./accounts.ts";
import { decide } from "./policy.ts";
import { act, record, engineSettings } from "./actions.ts";
import { messageIdOf } from "./forward.ts";
import { answered } from "./snooze.ts";


interface ApprovedAction {
  id: string;
  type: "reply" | "todo" | "meeting" | "archive";
  payload: Record<string, unknown> & { resolve_only?: boolean };
  reasoning?: string;
  linked_email_id?: string;
}

// ── Wall-clock time helpers ──────────────────────────────────────────────
// A "wall clock" here is a calendar reading with no zone attached, carried as
// the epoch ms it would have if it were UTC. That keeps date arithmetic exact
// and independent of the runtime's own zone, which may not be the user's
// and so silently hid the distinction.

export function parseWallClock(iso: string): number | null {
  const m = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  );
  return Number.isNaN(ms) ? null : ms;
}

function formatWallClock(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

// Resolve a wall clock in a named zone to the instant it refers to. Computes
// the zone's offset at a first guess, then corrects; the second pass settles
// readings near a DST transition, where the offset before and after differs.
export function wallClockToUtc(wallMs: number, tz: string): Date {
  const offsetAt = (instantMs: number): number => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
        .formatToParts(new Date(instantMs))
        .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return asUtc - instantMs;
  };
  let instant = wallMs - offsetAt(wallMs);
  instant = wallMs - offsetAt(instant);
  return new Date(instant);
}

function plainToHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n/)
    .map((line) => `<p>${line || "&nbsp;"}</p>`)
    .join("");
}

export async function executeAgentPlan(
  db: Db,
  userId: string,
  sessionId: string,
  approved: ApprovedAction[],
  userTimezone = "UTC",
): Promise<
  Record<string, { status: "success" | "error"; info?: string; error?: string }>
> {
  const results: Record<
    string,
    { status: "success" | "error"; info?: string; error?: string }
  > = {};

  // Claimed once, so a second click cannot run it twice, and only what the
  // plan shows can be run.
  const { data: claimed } = await db.from("agent_sessions").update({ status: "executing" }).eq("id", sessionId).eq("status", "ready").select("plan");
  if (!claimed?.length) throw Object.assign(new Error("This plan was already run or cancelled"), { status: 409 });
  const planned = new Map((((claimed[0].plan as { actions?: ApprovedAction[] } | null)?.actions ?? []) as ApprovedAction[]).map((a) => [a.id, a]));

  const { paused } = await engineSettings(userId);

  for (const action of approved) {
    try {
      const shown = planned.get(action.id);
      if (!shown || shown.type !== action.type) throw new Error("This is not in the plan");
      const { data: now } = await db.from("agent_sessions").select("status").eq("id", sessionId).single();
      if (now?.status === "cancelled") throw new Error("Cancelled");
      const kind = action.type === "reply" ? (action.payload.send_now === false ? "draft" : "send") : action.type;
      const verdict = decide({ kind, source: "agent", level: "suggest", paused });
      if (verdict.verdict !== "do") throw new Error(verdict.reason);
      if (action.type === "reply") {
        const to = String(action.payload.to ?? "").trim();
        const subject = String(action.payload.subject ?? "").trim();
        const body = String(action.payload.body ?? "").trim();
        const resolveOnly = action.payload.resolve_only === true;
        // Resolve-only: mark the source email handled without sending or
        // drafting anything. Lets the user answer a reply-confirm question
        // with "yes, no email needed".
        if (resolveOnly) {
          if (action.linked_email_id) {
            await db
              .from("emails")
              .update({ is_read: true, resolved_at: new Date().toISOString() })
              .eq("id", action.linked_email_id)
              .eq("user_id", userId);
          }
          results[action.id] = {
            status: "success",
            info: `Marked resolved without replying${to ? ` (would have gone to ${to})` : ""}`,
          };
          continue;
        }
        // Default to sending when send_now is undefined/null/true; only fall
        // back to draft when explicitly false.
        const sendNow = action.payload.send_now !== false;
        if (!to || !subject || !body) {
          throw new Error("Reply missing to/subject/body");
        }
        if (sendNow) {
          // From the account and address the email it answers was sent to.
          const { data: linked } = action.linked_email_id
            ? await db.from("emails").select("gmail_id, thread_id, sender_email, reply_to_email, account_id, recipients, cc_recipients").eq("id", action.linked_email_id).eq("user_id", userId).maybeSingle()
            : { data: null };
          const account = (await accountById(userId, linked?.account_id as string | undefined)) ?? (await defaultAccount(userId));
          if (!account) throw new Error("No account connected");
          const from = linked ? replyFrom(account, linked) : null;
          // In the thread of the email it answers, when it goes to who wrote it.
          const answers = linked && [linked.sender_email, linked.reply_to_email].some((x) => String(x ?? "").toLowerCase() === to.toLowerCase()) ? linked : null;
          const inReplyTo = answers ? await messageIdOf(account, answers.gmail_id as string) : undefined;
          const threadId = (answers?.thread_id as string | null) ?? undefined;
          const result = await mail(account).send(account, { from: await fromLine(userId, account, from), to: [to], subject, html: plainToHtml(body), inReplyTo }, threadId);
          await answered(userId, threadId, new Date().toISOString());
          await db.from("emails").insert({
            user_id: userId,
            gmail_id: result.id,
            thread_id: threadId ?? null,
            account_id: account.id,
            body_text: body,
            subject,
            recipients: to,
            body_html: plainToHtml(body),
            received_at: new Date().toISOString(),
            is_read: true,
            label_ids: ["SENT"],
          });
          if (action.linked_email_id) {
            await db
              .from("emails")
              .update({ resolved_at: new Date().toISOString() })
              .eq("id", action.linked_email_id)
              .eq("user_id", userId)
              .is("resolved_at", null);
          }
          await record(userId, { kind: "send", emailId: action.linked_email_id ?? null, summary: `Sent reply to ${to}`, detail: { to: [to], subject } }, "agent");
          results[action.id] = {
            status: "success",
            info: `Sent reply to ${to}`,
          };
        } else {
          // Save as draft (schema uses to_addresses array)
          await db.from("draft_emails").insert({
            user_id: userId,
            email_id: action.linked_email_id ?? null,
            source: "tabellar",
            to_addresses: [to],
            subject,
            body_html: plainToHtml(body),
          });
          if (action.linked_email_id) {
            await db
              .from("emails")
              .update({ resolved_at: new Date().toISOString() })
              .eq("id", action.linked_email_id)
              .eq("user_id", userId)
              .is("resolved_at", null);
          }
          results[action.id] = {
            status: "success",
            info: `Draft saved for ${to}`,
          };
        }
      } else if (action.type === "todo") {
        const title = String(action.payload.title ?? "").trim();
        if (!title) throw new Error("Todo missing title");
        // todos schema: { user_id, email_id?, text, is_completed, source }
        const row: Record<string, unknown> = {
          user_id: userId,
          text: title,
          due: /^\d{4}-\d{2}-\d{2}/.test(String(action.payload.due ?? "")) ? String(action.payload.due).slice(0, 10) : null,
          is_completed: false,
          source: "solver",
        };
        if (action.linked_email_id) {
          row.email_id = action.linked_email_id;
        }
        await db.from("todos").insert(row);
        if (action.linked_email_id) {
          await db
            .from("emails")
            .update({ resolved_at: new Date().toISOString() })
            .eq("id", action.linked_email_id)
            .eq("user_id", userId)
            .is("resolved_at", null);
        }
        results[action.id] = {
          status: "success",
          info: `Added todo "${title}"`,
        };
      } else if (action.type === "meeting") {
        const title = String(action.payload.meeting_title ?? "").trim();
        const startIso = String(action.payload.start_iso ?? "").trim();
        const durationMins = Number(action.payload.duration_mins ?? 30);
        const attendees = (action.payload.attendees as string[]) ?? [];
        if (!title || !startIso) {
          throw new Error("Meeting missing title or start_iso");
        }
        // start_iso is wall-clock time in the user's zone with no offset (the
        // agent tool is specified that way). Keep the two representations
        // apart: Calendar wants the wall clock plus a timeZone, while the
        // meetings row is a timestamptz and needs the true instant.
        const wallStartMs = parseWallClock(startIso);
        if (wallStartMs === null) throw new Error("Invalid start time");
        const wallEndMs = wallStartMs + durationMins * 60_000;
        const startLocal = formatWallClock(wallStartMs);
        const endLocal = formatWallClock(wallEndMs);

        // Previously the row stored the wall clock as though it were UTC, so a
        // 3pm meeting for a UTC-4 user was written as 15:00Z and Tabellar's own
        // Meetings view showed it at 11am while Google Calendar showed 3pm.
        const startInstant = wallClockToUtc(wallStartMs, userTimezone);
        const endInstant = wallClockToUtc(wallEndMs, userTimezone);

        // On the calendar first; without it, it waits in Meetings.
        const cal = await userCalendar(userId);
        const ev = cal
          ? await cal.calendar.create(cal.account, { title, description: "", start: startLocal, end: endLocal, timeZone: userTimezone, attendees }, cal.invite)
          : null;
        await db.from("meetings").insert({
          user_id: userId,
          email_id: action.linked_email_id ?? null,
          title,
          start_time: startInstant.toISOString(),
          end_time: endInstant.toISOString(),
          attendees,
          calendar_event_id: ev?.id ?? null,
          status: ev ? "confirmed" : "proposed",
        });

        if (action.linked_email_id) {
          await db
            .from("emails")
            .update({ resolved_at: new Date().toISOString() })
            .eq("id", action.linked_email_id)
            .eq("user_id", userId)
            .is("resolved_at", null);
        }
        results[action.id] = {
          status: "success",
          info: ev ? `On your calendar: "${title}"` : `"${title}" waits in Meetings: no calendar is connected`,
        };
      } else if (action.type === "archive") {
        // The emails the plan listed.
        const ids = ((shown.payload.email_ids as string[]) ?? []).filter(Boolean);
        if (!ids.length) throw new Error("Archive action has no email_ids");
        // One change in the mailbox, and one line in History that undoes it.
        const r = await act(userId, { kind: "archive", emailId: null, summary: `Archive ${ids.length} email${ids.length === 1 ? "" : "s"} (cleanup plan)`, detail: { emailIds: ids } }, { level: "suggest", paused, source: "agent" });
        if (r !== "done") throw new Error("The mailbox did not archive them");
        results[action.id] = { status: "success", info: `Archived ${ids.length} email${ids.length === 1 ? "" : "s"}` };
      } else {
        throw new Error(`Unknown action type: ${action.type}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[action.id] = { status: "error", error: msg };
    }
  }

  await db.from("agent_sessions").update({ results }).eq("id", sessionId);
  await db.from("agent_sessions").update({ status: "done" }).eq("id", sessionId).eq("status", "executing");

  return results;
}
