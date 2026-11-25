// Ask: a question about the mail, or something to do about it, in the user's
// words. The window and Telegram ask here. It reads mail, so it never sends or
// invites: what it writes is a draft, a meeting it makes is a proposal, and
// "from now on ..." is an automation that is off.

import { accountById, replyFrom } from "./accounts.ts";
import { engineSettings } from "./actions.ts";
import { runAgentStepParallel, startAgentSession } from "./agentLoop.ts";
import { chatWithAssistant, localToUtc, type ChatContext } from "./ai.ts";
import * as automations from "./automations.ts";
import { db } from "./db.ts";
import { escapeHtml } from "./mime.ts";
import { realAttendees } from "./senders.ts";
import { stylePrompt, writingFor } from "./writing.ts";

// Who an email may go to, for /send-email and for what Ask drafts.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRecipients(list: unknown): {
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

export type AskAction = { type: string; data: Record<string, unknown> };
type Said = { message: string; history?: { role: "user" | "assistant"; content: string }[]; timezone?: string; conversation_id?: unknown };

export async function askTabellar(userId: string, { message, history = [], timezone = "UTC", conversation_id }: Said): Promise<{ reply: string; actions: AskAction[] }> {
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
    void runAgentStepParallel(id, db, timezone).catch((e) => console.error("[ask] plan:", e));
    return id;
  };

  // "Clean up my inbox" and the like start the plan without asking the
  // model whether to: a small model would rather describe a plan.
  if (message.length < 120 && /^\s*(please\s+)?((can|could|would) you\s+)?(please\s+)?(clean\s*up|clear|tidy( up)?|triage|go through|sort out|deal with)\s+(my\s+|the\s+)?(inbox|mail|emails)\b/i.test(message)) {
    const reply = "A cleanup plan for the last week of your inbox. Nothing runs until you approve it.";
    const actions = [{ type: "plan_cleanup", data: { session_id: await cleanupPlan() } }];
    await keep(reply, actions);
    return { reply, actions };
  }

  // What to do from now on, from the user's own words: kept, but off.
  const automate = async (said: string): Promise<{ reply: string; action: { type: string; data: Record<string, unknown> } | null }> => {
    try {
      const made = await automations.compile(userId, said, { source: "ask" });
      if ("rule" in made) return { reply: `Kept as a rule: ${made.rule}`, action: { type: "kept_rule", data: { text: made.rule } } };
      const a = (await automations.listAutomations(userId)).find((x) => x.id === made.id);
      return { reply: `${a?.when}: ${a?.then.join("; ")}. It is off until you turn it on in Automations.`, action: { type: "make_automation", data: { id: made.id, text: said } } };
    } catch (e) {
      return { reply: (e as Error).message, action: null };
    }
  };
  if (message.length < 400 && /^\s*(please\s+)?from now on\b/i.test(message)) {
    const { reply, action } = await automate(message);
    await keep(reply, action ? [action] : []);
    return { reply, actions: action ? [action] : [] };
  }

  // Load only what's needed for the system prompt; everything else is fetched on demand by the AI via tools.
  const [writing, profileResult] = await Promise.all([
    writingFor(userId, null),
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
    timezone: timezone,
    style: stylePrompt(writing),
  };

  const { reply: said, tool_calls } = await chatWithAssistant(
    context,
    message,
    history,
    db,
    userId,
  );
  console.log(
    "[ask] tool_calls returned:",
    JSON.stringify(
      tool_calls.map((t) => ({ name: t.name, args: t.arguments })),
    ),
  );

  // Execute tool calls (search_emails is handled in-memory by chatWithAssistant)
  const actions: AskAction[] = [];

  // Pause stops these too; the assistant is told and nothing runs.
  const { paused } = await engineSettings(userId);
  // Paused: nothing is done, but reading and planning go on.
  const ACTS = new Set(["create_todo", "update_todo", "delete_todo", "save_draft", "delete_draft", "add_knowledge", "create_tag", "send_email", "reply_to_email", "create_meeting", "update_meeting", "delete_meeting", "archive_email", "set_follow_up"]);
  for (const tc of tool_calls.filter((t) => !paused || !ACTS.has(t.name))) {
    if (tc.name === "create_todo") {
      const args = tc.arguments as { text: string };
            const { data: todo, error: todoErr } = await db
        .from("todos")
        .insert({ user_id: userId, text: args.text, source: "assistant" })
        .select("id")
        .single();
      if (todoErr) console.error("[ask/create_todo] error:", todoErr);
      if (todo)
        actions.push({
          type: "create_todo",
          data: { text: args.text, id: (todo as { id: string }).id },
        });
    } else if (tc.name === "save_draft" || tc.name === "send_email") {
      // Ask never sends: what it writes waits in Replies. It reads mail,
      // and nothing an email says may make it write to anyone unseen.
      const args = tc.arguments as { to: string | string[]; subject: string; body: string };
      const check = validateRecipients(typeof args.to === "string" ? args.to.split(",").map((x) => x.trim()).filter(Boolean) : args.to);
      if (!check.ok) {
        actions.push({ type: "send_email_failed", data: { error: check.error ?? "Invalid recipient" } });
        continue;
      }
      const { data: draft } = await db
        .from("draft_emails")
        .insert({ user_id: userId, source: "tabellar", to_addresses: check.emails, subject: String(args.subject ?? ""), body_html: escapeHtml(String(args.body ?? "")).replace(/\n/g, "<br>") })
        .select("id")
        .single();
      if (draft) actions.push({ type: "save_draft", data: { subject: args.subject, to: check.emails!.join(", "), id: draft.id } });
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
      if (tagErr) console.error("[ask/create_tag] error:", tagErr);
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
    } else if (tc.name === "reply_to_email") {
      const args = tc.arguments as { email_id: string; body: string };
      const { data: original } = await db.from("emails").select("id, subject, sender_email, reply_to_email, account_id, recipients, cc_recipients").eq("id", String(args.email_id ?? "")).eq("user_id", userId).maybeSingle();
      const to = String(original?.reply_to_email || original?.sender_email || "");
      if (!original || !to) {
        actions.push({ type: "send_email_failed", data: { error: "Original email not found" } });
        continue;
      }
      const account = await accountById(userId, original.account_id as string);
      const subject = /^re:/i.test(String(original.subject ?? "")) ? String(original.subject) : `Re: ${original.subject ?? ""}`;
      const { data: draft } = await db
        .from("draft_emails")
        .insert({
          user_id: userId, source: "tabellar", email_id: original.id, account_id: account?.id ?? null, from_address: account ? replyFrom(account, original as { recipients?: string | null }) : null,
          to_addresses: [to], subject, body_html: escapeHtml(String(args.body ?? "")).replace(/\n/g, "<br>"),
        })
        .select("id")
        .single();
      if (draft) actions.push({ type: "save_draft", data: { subject, to, id: draft.id } });
    } else if (["update_todo", "delete_todo", "update_meeting", "delete_meeting", "delete_draft", "archive_email"].includes(tc.name)) {
      // Carried out while the model was answering (ai.ts).
      if (tc.done) actions.push({ type: tc.name, data: tc.arguments });
    } else if (tc.name === "plan_cleanup") {
      actions.push({ type: "plan_cleanup", data: { session_id: await cleanupPlan() } });
    } else if (tc.name === "make_automation") {
      // Read from what the user wrote, not from what the model passed on:
      // an address it found in an email is in no sentence of theirs.
      const said = String(tc.arguments.sentence ?? "").trim();
      const { reply, action } = await automate(said && message.toLowerCase().includes(said.toLowerCase()) ? said : message);
      actions.push(action ?? { type: "make_automation_failed", data: { error: reply } });
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
              remind_at: localToUtc(String(args.remind_at), timezone),
              created_at: new Date().toISOString(),
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
        console.error("[ask/set_follow_up] error:", err);
      }
    } else if (tc.name === "create_meeting") {
      // Waits in Meetings; the user adds it to the calendar there, which is what invites anyone.
      const args = tc.arguments as { title: string; start_time: string; end_time: string; attendees?: string[]; description?: string };
      try {
        const start = localToUtc(String(args.start_time), timezone);
        const end = args.end_time ? localToUtc(String(args.end_time), timezone) : new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
        const attendees = await realAttendees(userId, args.attendees, [message, ...history.filter((h) => h.role === "user").map((h) => h.content)].join(" "));
        const { data: m } = await db.from("meetings").insert({ user_id: userId, title: String(args.title || "Meeting"), start_time: start, end_time: end, attendees, description: args.description || "", status: "proposed" }).select("id").single();
        actions.push({ type: "create_meeting", data: { title: args.title, start_time: start, attendees, id: m?.id } });
      } catch {
        actions.push({ type: "create_meeting_failed", data: { error: "The time could not be read" } });
      }
    }
  }

  // Note: knowledge use_count is incremented by the search_knowledge_base tool
  // inside chatWithAssistant when entries are explicitly searched and returned.

  // What the model says it did is not taken on its word: paused, nothing was.
  const reply = paused && tool_calls.some((t) => ACTS.has(t.name)) ? "Tabellar is paused, so I did nothing. Resume it with the play button above Settings, then ask again." : said;
  await keep(reply, actions);
  return { reply, actions };
}
