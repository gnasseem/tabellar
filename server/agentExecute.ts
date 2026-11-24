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

  await db
    .from("agent_sessions")
    .update({ status: "executing" })
    .eq("id", sessionId);

  const { paused } = await engineSettings(userId);

  for (const action of approved) {
    try {
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
            ? await db.from("emails").select("account_id, recipients, cc_recipients").eq("id", action.linked_email_id).eq("user_id", userId).maybeSingle()
            : { data: null };
          const account = (await accountById(userId, linked?.account_id as string | undefined)) ?? (await defaultAccount(userId));
          if (!account) throw new Error("No account connected");
          const from = linked ? replyFrom(account, linked) : null;
          const result = await mail(account).send(account, { from: await fromLine(userId, account, from), to: [to], subject, html: plainToHtml(body) });
          await db.from("emails").insert({
            user_id: userId,
            gmail_id: result.id,
            account_id: account.id,
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
          text: action.payload.due
            ? `${title} (due ${action.payload.due})`
            : title,
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

        // Insert local row so it appears immediately.
        const { data: meetingRow } = await db
          .from("meetings")
          .insert({
            user_id: userId,
            title,
            start_time: startInstant.toISOString(),
            end_time: endInstant.toISOString(),
            attendees,
            status: "confirmed",
          })
          .select("id")
          .single();

        // Put it on the calendar (best effort).
        try {
          const cal = await userCalendar(userId);
          if (cal) {
            await cal.calendar.create(
              cal.account,
              { title, description: (action.reasoning as string) ?? "", start: startLocal, end: endLocal, timeZone: userTimezone, attendees },
              cal.invite,
            );
          }
        } catch (calErr) {
          console.warn("[agentExecute] calendar create failed:", calErr);
        }

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
          info: `Scheduled "${title}" at ${startIso}${meetingRow ? "" : " (local only)"}`,
        };
      } else if (action.type === "archive") {
        const ids = ((action.payload.email_ids as string[]) ?? []).filter(
          Boolean,
        );
        if (!ids.length) throw new Error("Archive action has no email_ids");
        let failed = 0;
        for (const id of ids) {
          const r = await act(userId, { kind: "archive", emailId: id, summary: "Archive", detail: {} }, { level: "suggest", paused, source: "agent" });
          if (r !== "done") failed++;
        }
        // Mark them handled here even if Gmail refused, as before.
        await db
          .from("emails")
          .update({ is_archived: true, resolved_at: new Date().toISOString() })
          .in("id", ids)
          .eq("user_id", userId)
          .is("resolved_at", null);
        results[action.id] = {
          status: "success",
          info: `Archived ${ids.length} email${ids.length === 1 ? "" : "s"}${failed ? ` (${failed} only in Tabellar, the mailbox refused)` : ""}`,
        };
      } else {
        throw new Error(`Unknown action type: ${action.type}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[action.id] = { status: "error", error: msg };
    }
  }

  await db
    .from("agent_sessions")
    .update({ status: "done", results })
    .eq("id", sessionId);

  return results;
}
