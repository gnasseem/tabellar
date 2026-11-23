/**
 * Auto-Resolve (Solve-Everything) agent loop.
 *
 * A single call to `runAgentStep(sessionId, db)` advances the agent
 * until one of:
 *   - `ask_user` is called -> session.status = 'asking', pending_questions[] set
 *   - `finalize` is called -> session.status = 'ready', plan set
 *   - MAX_ROUNDS_PER_STEP LLM rounds elapse without a terminal tool
 *   - an error happens -> session.status = 'error'
 *
 * Parallel sub-agents: when `bucket` is passed, the loop only replays turns
 * matching that bucket when rebuilding LLM messages, so each bucket gets its
 * own isolated conversation thread. Actions, questions and final plan all
 * merge into the single session row so the frontend only needs to subscribe
 * to one session.
 */

import type { Db } from "./db.ts";
import { llmWithTools, PROMPTS } from "./ai.ts";
import { isLocalModel } from "./llm.ts";
import {
  AGENT_TOOLS,
  type AgentToolContext,
  type BriefingCard,
  READ_TOOL_NAMES,
  runReadTool,
} from "./agentTools.ts";

const MAX_ROUNDS_PER_STEP = 18;
export const AGENT_BUCKETS = ["replies", "meetings", "todos", "noise"] as const;
export type AgentBucket = (typeof AGENT_BUCKETS)[number] | "single";

function briefingCardsHaveEmails(
  cards: AgentToolContext["briefingCards"],
): boolean {
  return (
    cards.crucial.length +
      cards.replyNeeded.length +
      cards.deadlines.length +
      cards.nonEssential.length >
    0
  );
}

interface AgentTurnRow {
  idx: number;
  role: string;
  content: unknown;
  tool_name: string | null;
  tool_call_id: string | null;
  reasoning?: string | null;
  bucket?: string | null;
}

interface DraftAction {
  id: string;
  type: "reply" | "todo" | "meeting" | "archive";
  reasoning?: string;
  priority?: string;
  linked_email_id?: string;
  recommended?: boolean;
  bucket?: AgentBucket;
  payload: Record<string, unknown>;
  selected: boolean;
  created_at: string;
  updated_at: string;
}

interface PendingQuestion {
  id: string;
  tool_call_id: string;
  eyebrow: string;
  question: string;
  brief: string;
  options: {
    id: string;
    label: string;
    rationale?: string;
    preview?: string;
    recommended?: boolean;
    no_reply?: boolean;
  }[];
  allow_custom: boolean;
  related_email_id?: string | null;
  bucket?: AgentBucket;
}

interface SessionRow {
  id: string;
  user_id: string;
  status: string;
  draft_actions: DraftAction[];
  pending_question: PendingQuestion | null;
  pending_questions: PendingQuestion[] | null;
  plan: unknown | null;
  summary: string | null;
  briefing_at: string | null;
  bucket: string | null;
}

function uid(): string {
  return crypto.randomUUID();
}

// One action per id, and one reply, todo or meeting per email: parallel
// lanes can each propose the same reply.
function mergeDraftsById(actions: DraftAction[]): DraftAction[] {
  const byKey = new Map<string, DraftAction>();
  for (const a of actions) {
    byKey.set(a.linked_email_id && a.type !== "archive" ? `${a.type}:${a.linked_email_id}` : a.id, a);
  }
  return [...byKey.values()];
}

/** PostgREST errors often are not `instanceof Error`; String(err) becomes useless. */
function formatUnknownError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) return o.message;
    if (typeof o.details === "string" && o.details.trim()) return o.details;
    if (typeof o.hint === "string" && o.hint.trim()) return o.hint;
    if (typeof o.code === "string" && o.code.trim()) return o.code;
  }
  try {
    const s = JSON.stringify(err);
    if (s && s !== "{}") return s;
  } catch {
    /* ignore */
  }
  return "Unexpected error";
}

function planActionsFromStep(plan: unknown): DraftAction[] {
  if (!plan || typeof plan !== "object") return [];
  const actions = (plan as { actions?: DraftAction[] }).actions;
  return Array.isArray(actions) ? actions : [];
}

function mergeDraftsFromParallelResults(
  results: PromiseSettledResult<StepResult>[],
): DraftAction[] {
  const acc: DraftAction[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const v = r.value;
    const da = v.draft_actions;
    if (Array.isArray(da) && da.length) {
      acc.push(...da);
    } else {
      const fromPlan = planActionsFromStep(v.plan);
      if (fromPlan.length) acc.push(...fromPlan);
    }
  }
  return mergeDraftsById(acc);
}

async function persistTurn(
  db: Db,
  sessionId: string,
  idx: number,
  row: {
    role: "system" | "user" | "assistant" | "tool" | "status";
    content: unknown;
    tool_name?: string | null;
    tool_call_id?: string | null;
    reasoning?: string | null;
    bucket?: AgentBucket | null;
  },
) {
  await db.from("agent_turns").insert({
    session_id: sessionId,
    idx,
    role: row.role,
    content: row.content,
    tool_name: row.tool_name ?? null,
    tool_call_id: row.tool_call_id ?? null,
    reasoning: row.reasoning ?? null,
    bucket: row.bucket ?? null,
  });
}

/** Reserves `count` consecutive idx values on the session row (row-locked UPDATE). */
async function allocTurnIdx(
  db: Db,
  sessionId: string,
  count = 1,
): Promise<number> {
  const n = Math.max(1, count);
  const { data, error } = await Promise.race([
    db.rpc("alloc_agent_turn_idx", { p_session_id: sessionId, p_count: n }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("allocTurnIdx timed out after 6s")), 6_000)
    ),
  ]);
  if (error) throw error;
  if (typeof data !== "number" || !Number.isFinite(data)) {
    throw new Error("alloc_agent_turn_idx returned invalid value");
  }
  return data;
}

function buildSystemPrompt(
  timezone: string,
  bucket: AgentBucket | undefined,
): string {
  const today = new Date().toISOString().split("T")[0];
  const base =
    bucket && bucket !== "single"
      ? PROMPTS.agent_system_bucket.replace("{BUCKET}", bucket)
      : PROMPTS.agent_system;
  return base
    .replace("{TODAY}", today)
    .replace("{TIMEZONE}", timezone || "UTC");
}

/**
 * Convert stored agent_turns into OpenAI chat messages. When bucket is set,
 * only turns tagged with that bucket (or null bucket for back-compat) are
 * replayed — sub-agents each see their own isolated thread.
 */
function turnsToMessages(
  system: string,
  briefingSnapshot: string,
  turns: AgentTurnRow[],
): {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  _anthropic?: unknown[];
}[] {
  const messages: {
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
    name?: string;
    _anthropic?: unknown[];
  }[] = [
    { role: "system", content: system },
    { role: "user", content: briefingSnapshot },
  ];
  for (const t of turns) {
    if (t.role === "status") continue;
    if (t.role === "assistant") {
      const c = t.content as {
        content?: string | null;
        tool_calls?: unknown[];
        raw?: unknown[];
      };
      messages.push({
        role: "assistant",
        content: c.content ?? null,
        tool_calls: c.tool_calls,
        _anthropic: c.raw,
      });
    } else if (t.role === "tool") {
      const c = t.content as { output: string };
      messages.push({
        role: "tool",
        content: c.output,
        tool_call_id: t.tool_call_id ?? undefined,
        name: t.tool_name ?? undefined,
      });
    } else if (t.role === "user") {
      const c = t.content as { text?: string };
      messages.push({ role: "user", content: c.text ?? "" });
    }
  }
  return messages;
}

function filterToBucket(
  turns: AgentTurnRow[],
  bucket: AgentBucket | undefined,
): AgentTurnRow[] {
  if (!bucket || bucket === "single") {
    return turns.filter((t) => !t.bucket || t.bucket === "single");
  }
  return turns.filter((t) => t.bucket === bucket);
}

// What the plan works on: inbox mail of the last week that arrived before the
// plan started (so every step sees the same list), sorted by what the
// engine made of it. Mail with a drafted reply waiting counts as reply
// needed; mail with an open todo that has a day, as a deadline.
export async function getOrCreateBriefingSnapshot(
  db: Db,
  userId: string,
  at?: string | null,
): Promise<{
  snapshotText: string;
  cards: AgentToolContext["briefingCards"];
  briefingAt: string;
  executiveSummary: string;
}> {
  const briefingAt = at || new Date().toISOString();
  const weekAgo = new Date(new Date(briefingAt).getTime() - 7 * 86_400_000).toISOString();
  const [{ data: mail }, { data: drafts }, { data: todos }] = await Promise.all([
    db
      .from("emails")
      .select("id, subject, sender, sender_email, snippet, label_ids, is_archived, email_processed(category, urgency, summary, quick_actions)")
      .eq("user_id", userId)
      .eq("is_archived", false)
      .contains("label_ids", ["INBOX"])
      .gte("received_at", weekAgo)
      .lte("received_at", briefingAt)
      .order("received_at", { ascending: false })
      .limit(80),
    db.from("draft_emails").select("email_id").eq("user_id", userId),
    db.from("todos").select("email_id, due").eq("user_id", userId).eq("is_completed", false),
  ]);
  const drafted = new Set((drafts ?? []).map((d: Record<string, unknown>) => String(d.email_id ?? "")));
  const due = new Map((todos ?? []).filter((t: Record<string, unknown>) => t.email_id && t.due).map((t: Record<string, unknown>) => [String(t.email_id), String(t.due)]));
  const cards: AgentToolContext["briefingCards"] = { crucial: [], replyNeeded: [], deadlines: [], nonEssential: [] };
  for (const e of (mail ?? []) as Record<string, unknown>[]) {
    const raw = e.email_processed as Record<string, unknown> | Record<string, unknown>[] | null;
    const p = (Array.isArray(raw) ? raw[0] : raw) ?? null;
    if (!p) continue;
    const id = String(e.id);
    const category = String(p.category ?? "");
    const asksReply = Array.isArray(p.quick_actions) && (p.quick_actions as { action?: string }[]).some((q) => q?.action === "reply");
    const card: BriefingCard = {
      email_id: id,
      subject: String(e.subject ?? ""),
      sender: String(e.sender ?? e.sender_email ?? ""),
      senderName: String(e.sender ?? "").replace(/<.*>/, "").replace(/"/g, "").trim() || String(e.sender_email ?? ""),
      summary: String(p.summary || e.snippet || ""),
      urgency: String(p.urgency ?? "medium"),
      deadline: (due.get(id) as string | undefined) ?? null,
      waitingForReply: drafted.has(id) || (category === "action-required" && asksReply),
      tags: [],
    };
    if (card.waitingForReply) cards.replyNeeded.push(card);
    else if (card.deadline) cards.deadlines.push(card);
    else if (category === "action-required" || category === "important") cards.crucial.push(card);
    else cards.nonEssential.push(card);
  }

  const fmtCard = (c: BriefingCard, bucket: string) => {
    const id = c.email_id ?? "no-id";
    const signal = (c as unknown as { signal?: string }).signal ?? "";
    const suggestedAction =
      (c as unknown as { suggestedAction?: string }).suggestedAction ?? "";
    const evidence = (c as unknown as { evidence?: string }).evidence ?? "";
    const rel =
      (c as unknown as { relationshipHint?: string }).relationshipHint ?? "";
    const head = `  [${id}] (${bucket}${c.deadline ? `, due ${c.deadline}` : ""}${rel ? `, ${rel}` : ""}) ${c.senderName ?? c.sender ?? "?"} — ${c.subject ?? ""}`;
    const lines = [head];
    if (signal) lines.push(`       signal: ${signal}`);
    if (suggestedAction) lines.push(`       suggested: ${suggestedAction}`);
    if (evidence) lines.push(`       evidence: "${evidence}"`);
    if (!signal && c.summary) lines.push(`       ${c.summary}`);
    return lines.join("\n");
  };
  const fmtCards = (arr: BriefingCard[], bucket: string) =>
    arr.map((c) => fmtCard(c, bucket)).join("\n");

  const snapshotText = `CURRENT INBOX (call get_briefing_context for the structured view):\n\nEMAILS:\n${[
    cards.crucial.length
      ? `CRUCIAL (${cards.crucial.length}):\n${fmtCards(cards.crucial, "crucial")}`
      : "",
    cards.replyNeeded.length
      ? `REPLY NEEDED (${cards.replyNeeded.length}):\n${fmtCards(cards.replyNeeded, "reply")}`
      : "",
    cards.deadlines.length
      ? `DEADLINES (${cards.deadlines.length}):\n${fmtCards(cards.deadlines, "deadline")}`
      : "",
    cards.nonEssential.length
      ? `NON-ESSENTIAL (${cards.nonEssential.length}):\n${fmtCards(cards.nonEssential, "noise")}`
      : "",
  ]
    .filter(Boolean)
    .join(
      "\n\n",
    )}\n\nGoal: produce a confirmed plan that clears as much of this as possible. Begin.`;
  return { snapshotText, cards, briefingAt, executiveSummary: "" };
}

/** Scope a briefing snapshot to a single bucket for a sub-agent. */
function bucketSnapshot(
  cards: AgentToolContext["briefingCards"],
  execSummary: string,
  bucket: AgentBucket,
): { text: string; scoped: AgentToolContext["briefingCards"] } {
  const fmtCard = (c: BriefingCard, bk: string) => {
    const id = c.email_id ?? "no-id";
    const signal = (c as unknown as { signal?: string }).signal ?? "";
    const suggestedAction =
      (c as unknown as { suggestedAction?: string }).suggestedAction ?? "";
    const evidence = (c as unknown as { evidence?: string }).evidence ?? "";
    const rel =
      (c as unknown as { relationshipHint?: string }).relationshipHint ?? "";
    const head = `  [${id}] (${bk}${c.deadline ? `, due ${c.deadline}` : ""}${rel ? `, ${rel}` : ""}) ${c.senderName ?? c.sender ?? "?"} — ${c.subject ?? ""}`;
    const lines = [head];
    if (signal) lines.push(`       signal: ${signal}`);
    if (suggestedAction) lines.push(`       suggested: ${suggestedAction}`);
    if (evidence) lines.push(`       evidence: "${evidence}"`);
    if (!signal && c.summary) lines.push(`       ${c.summary}`);
    return lines.join("\n");
  };

  const suggest = (c: BriefingCard): string =>
    (c as unknown as { suggestedAction?: string }).suggestedAction ?? "";

  let scoped: AgentToolContext["briefingCards"];
  if (bucket === "replies") {
    scoped = {
      crucial: cards.crucial.filter(
        (c) => suggest(c) === "reply" || c.waitingForReply === true,
      ),
      replyNeeded: cards.replyNeeded,
      deadlines: [],
      nonEssential: [],
    };
  } else if (bucket === "meetings") {
    scoped = {
      crucial: cards.crucial.filter((c) => suggest(c) === "meeting"),
      replyNeeded: cards.replyNeeded.filter((c) => suggest(c) === "meeting"),
      deadlines: cards.deadlines.filter((c) => suggest(c) === "meeting"),
      nonEssential: [],
    };
  } else if (bucket === "todos") {
    scoped = {
      crucial: cards.crucial.filter((c) => suggest(c) === "todo"),
      replyNeeded: [],
      deadlines: cards.deadlines.filter((c) => suggest(c) !== "meeting"),
      nonEssential: [],
    };
  } else {
    // noise
    scoped = {
      crucial: [],
      replyNeeded: [],
      deadlines: [],
      nonEssential: cards.nonEssential,
    };
  }

  const sections = [
    scoped.crucial.length
      ? `CRUCIAL (${scoped.crucial.length}):\n${scoped.crucial
          .map((c) => fmtCard(c, "crucial"))
          .join("\n")}`
      : "",
    scoped.replyNeeded.length
      ? `REPLY NEEDED (${scoped.replyNeeded.length}):\n${scoped.replyNeeded
          .map((c) => fmtCard(c, "reply"))
          .join("\n")}`
      : "",
    scoped.deadlines.length
      ? `DEADLINES (${scoped.deadlines.length}):\n${scoped.deadlines
          .map((c) => fmtCard(c, "deadline"))
          .join("\n")}`
      : "",
    scoped.nonEssential.length
      ? `NON-ESSENTIAL (${scoped.nonEssential.length}):\n${scoped.nonEssential
          .map((c) => fmtCard(c, "noise"))
          .join("\n")}`
      : "",
  ].filter(Boolean);

  const text = `YOUR BUCKET: ${bucket.toUpperCase()}.\n\nEXECUTIVE SUMMARY (full inbox context):\n${execSummary}\n\nEMAILS IN YOUR SCOPE:\n${sections.join("\n\n") || "(none — finalize immediately with an empty plan.)"}\n\nOther buckets are handled by parallel sub-agents. Only propose actions for emails in YOUR scope.`;
  return { text, scoped };
}

function argsJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}

interface StepResult {
  status: string;
  pending_question?: unknown;
  pending_questions?: unknown[];
  plan?: unknown;
  draft_actions: DraftAction[];
  summary?: string;
  error?: string;
}

/**
 * Server-side guard: validates a propose_action call and returns either a
 * canonicalized action to append OR an error string to send back to the LLM.
 * Rules:
 *  - todos / replies: linked_email_id must NOT be in nonEssential bucket.
 *  - reasoning is required (empty string rejected).
 *  - no duplicate (type, linked_email_id).
 *  - archive: merge with existing archive action instead of adding a new one.
 */
function validateAndApplyPropose(
  existing: DraftAction[],
  args: Record<string, unknown>,
  ctx: AgentToolContext,
  bucket: AgentBucket | undefined,
): { actions: DraftAction[]; error?: string; merged?: boolean } {
  const type = (args.type as DraftAction["type"]) ?? "todo";
  const reasoning = String(args.reasoning ?? "").trim();
  if (!reasoning) {
    return {
      actions: existing,
      error:
        "propose_action rejected: reasoning is required. Write ONE first-person sentence explaining why this action is right for THIS user given their style and the email's ask. Call more read tools if you cannot.",
    };
  }
  const linkedId = args.linked_email_id ? String(args.linked_email_id) : "";

  if (type === "todo" || type === "reply") {
    if (linkedId) {
      const noise = ctx.briefingCards.nonEssential.some(
        (c) => c.email_id === linkedId,
      );
      if (noise) {
        return {
          actions: existing,
          error: `propose_action rejected: ${type} cannot link to a nonEssential email (${linkedId}). Newsletters, receipts, no-reply senders only qualify for archive. Drop this proposal or switch to archive.`,
        };
      }
    }
    // Dedup: same (type, linked_email_id) already staged.
    if (linkedId) {
      const dup = existing.find(
        (a) => a.type === type && a.linked_email_id === linkedId,
      );
      if (dup) {
        return {
          actions: existing,
          error: `propose_action rejected: a ${type} action for email ${linkedId} is already staged (id ${dup.id}). Use revise_action if you want to change it.`,
        };
      }
    }
  }

  if (type === "archive") {
    const newIds = Array.isArray(args.email_ids)
      ? (args.email_ids as string[]).filter(Boolean)
      : [];
    const existingArchive = existing.find((a) => a.type === "archive");
    if (existingArchive) {
      const currentIds = new Set<string>(
        (existingArchive.payload.email_ids as string[]) ?? [],
      );
      for (const id of newIds) currentIds.add(id);
      const merged = existing.map((a) =>
        a.id === existingArchive.id
          ? {
              ...a,
              payload: {
                ...a.payload,
                email_ids: Array.from(currentIds),
                summary:
                  (args.summary as string) ??
                  (a.payload.summary as string) ??
                  "",
              },
              reasoning: a.reasoning || reasoning,
              updated_at: new Date().toISOString(),
            }
          : a,
      );
      return { actions: merged, merged: true };
    }
  }

  const action: DraftAction = {
    id: uid(),
    type,
    reasoning,
    priority: (args.priority as string) ?? "medium",
    linked_email_id: linkedId || undefined,
    recommended: args.recommended === true ? true : undefined,
    bucket: bucket ?? "single",
    payload: {
      to: args.to,
      subject: args.subject,
      body: args.body,
      send_now: args.send_now ?? true,
      resolve_only: args.resolve_only ?? false,
      title: args.title,
      due: args.due,
      meeting_title: args.meeting_title,
      start_iso: args.start_iso,
      duration_mins: args.duration_mins,
      attendees: args.attendees,
      email_ids: args.email_ids,
      summary: args.summary,
    },
    selected: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return { actions: [...existing, action] };
}

function applyReviseAction(
  existing: DraftAction[],
  args: Record<string, unknown>,
): DraftAction[] {
  const id = String(args.id ?? "");
  const patch = (args.patch as Record<string, unknown>) ?? {};
  return existing.map((a) =>
    a.id === id
      ? {
          ...a,
          payload: { ...a.payload, ...patch },
          reasoning: (patch.reasoning as string) ?? a.reasoning,
          priority: (patch.priority as string) ?? a.priority,
          updated_at: new Date().toISOString(),
        }
      : a,
  );
}

function applyDiscardAction(
  existing: DraftAction[],
  args: Record<string, unknown>,
): DraftAction[] {
  const id = String(args.id ?? "");
  return existing.filter((a) => a.id !== id);
}

/** Parse ask_user args into one or more PendingQuestion rows. */
function extractQuestions(
  args: Record<string, unknown>,
  toolCallId: string,
  ctx: AgentToolContext,
  bucket: AgentBucket | undefined,
): PendingQuestion[] {
  const parseOne = (
    q: Record<string, unknown>,
    idSuffix: string,
  ): PendingQuestion => {
    const relatedEmailId = q.related_email_id
      ? String(q.related_email_id)
      : null;
    const rawOptions = Array.isArray(q.options)
      ? (q.options as Record<string, unknown>[])
      : [];
    const options: {
      id: string;
      label: string;
      rationale?: string;
      preview?: string;
      recommended?: boolean;
      no_reply?: boolean;
    }[] = rawOptions.map((o) => ({
      id: String(o.id ?? ""),
      label: String(o.label ?? ""),
      rationale: o.rationale ? String(o.rationale) : undefined,
      preview: o.preview ? String(o.preview) : undefined,
      recommended: o.recommended === true ? true : undefined,
    }));

    // For reply-style confirmations, inject the "yes, mark resolved without
    // replying" option if not already there. Heuristic: eyebrow or question
    // mentions reply, and related_email_id points to a known briefing card.
    const eyebrowText = String(q.eyebrow ?? "");
    const questionText = String(q.question ?? "");
    const isReplyConfirm =
      /reply|respond|send/i.test(eyebrowText + " " + questionText) &&
      !options.some((o) =>
        /resolve|no email|skip reply|don.?t reply/i.test(o.label),
      );

    if (isReplyConfirm) {
      options.push({
        id: `yes_no_reply_${idSuffix}`,
        label: "Yes, mark resolved without replying",
        rationale:
          "Confirms receipt and closes the thread without sending anything.",
        recommended: undefined,
        // non-standard extras picked up by the frontend type widening
        ...({ no_reply: true } as Record<string, unknown>),
      } as PendingQuestion["options"][number]);
    }

    return {
      id: `${toolCallId}:${idSuffix}`,
      tool_call_id: toolCallId,
      eyebrow: eyebrowText,
      question: questionText,
      brief: String(q.brief ?? ""),
      options,
      allow_custom: q.allow_custom !== false,
      related_email_id: relatedEmailId,
      bucket: bucket ?? "single",
    };
  };

  if (Array.isArray(args.questions) && args.questions.length > 0) {
    return (args.questions as Record<string, unknown>[]).map((q, i) =>
      parseOne(q, String(i)),
    );
  }
  // Back-compat: single-question shape.
  return [parseOne(args, "0")];
}

export async function runAgentStep(
  sessionId: string,
  db: Db,
  userTimezone = "UTC",
  opts: {
    bucket?: AgentBucket;
    bucketCards?: AgentToolContext["briefingCards"];
    bucketSnapshotText?: string;
  } = {},
): Promise<StepResult> {
  const { data: session } = await db
    .from("agent_sessions")
    .select(
      "id, user_id, status, draft_actions, pending_question, pending_questions, plan, summary, briefing_at, bucket",
    )
    .eq("id", sessionId)
    .single<SessionRow>();

  if (!session) throw new Error("Session not found");
  if (["ready", "done", "cancelled", "error"].includes(session.status)) {
    return {
      status: session.status,
      draft_actions: session.draft_actions,
      plan: session.plan,
      summary: session.summary ?? undefined,
    };
  }

  const bucket =
    opts.bucket ?? (session.bucket as AgentBucket | null) ?? undefined;

  // Either the caller passes a scoped snapshot (parallel sub-agent flow) or
  // we build the full briefing snapshot for a single-agent run.
  let snapshotText: string;
  let cards: AgentToolContext["briefingCards"];
  if (opts.bucketSnapshotText && opts.bucketCards) {
    snapshotText = opts.bucketSnapshotText;
    cards = opts.bucketCards;
  } else {
    const snap = await getOrCreateBriefingSnapshot(db, session.user_id, session.briefing_at);
    snapshotText = snap.snapshotText;
    cards = snap.cards;
  }

  const ctx: AgentToolContext = {
    db,
    userId: session.user_id,
    timezone: userTimezone,
    briefingCards: cards,
  };

  let draftActions = [...(session.draft_actions ?? [])];

  // If this sub-agent's bucket was already finalized in a previous run (e.g.
  // another bucket asked a question causing a re-launch), skip it immediately.
  // Without this, previously-finalized sub-agents loop on text-only responses
  // after seeing their completed turn history.
  if (bucket && bucket !== "single") {
    const { data: ft } = await db
      .from("agent_turns")
      .select("id")
      .eq("session_id", sessionId)
      .eq("role", "tool")
      .eq("tool_name", "finalize")
      .eq("bucket", bucket)
      .limit(1);
    if (ft?.length) {
      return { status: "bucket_done", plan: null, draft_actions: draftActions, summary: "" };
    }
  }

  const system = buildSystemPrompt(userTimezone, bucket);

  try {
    for (let round = 0; round < MAX_ROUNDS_PER_STEP; round++) {
      const { data: turnsRows } = await db
        .from("agent_turns")
        .select(
          "idx, role, content, tool_name, tool_call_id, reasoning, bucket",
        )
        .eq("session_id", sessionId)
        .order("idx", { ascending: true });
      const turns = filterToBucket((turnsRows ?? []) as AgentTurnRow[], bucket);
      const nextTurnIdx = await allocTurnIdx(db, sessionId, 1);

      const messages = turnsToMessages(system, snapshotText, turns);

      const completion = await llmWithTools({
        messages,
        tools: AGENT_TOOLS,
        temperature: 0.4,
        maxTokens: 2048,
      });

      await persistTurn(db, sessionId, nextTurnIdx, {
        role: "assistant",
        content: {
          content: completion.content,
          tool_calls: completion.tool_calls,
          raw: completion.raw,
        },
        reasoning: completion.reasoning,
        bucket: bucket ?? "single",
      });

      // No tool calls: model replied with text.
      if (!completion.tool_calls?.length) {
        const msg = (completion.content ?? "").trim();
        const curIdx = await allocTurnIdx(db, sessionId, msg ? 2 : 1);
        if (msg) {
          await persistTurn(db, sessionId, curIdx, {
            role: "status",
            content: { text: msg },
            bucket: bucket ?? "single",
          });
        }
        await persistTurn(db, sessionId, curIdx + (msg ? 1 : 0), {
          role: "user",
          content: {
            text: "Please either call a read tool to gather context, propose_action for a confirmed action with reasoning, ask_user for an ambiguity, or finalize when done.",
          },
          bucket: bucket ?? "single",
        });
        continue;
      }

      let paused = false;
      let finalized = false;
      let pendingQuestions: PendingQuestion[] = [];
      let plan: unknown = null;
      let summary: string | undefined;

      const pushToolOutput = async (
        tc: (typeof completion.tool_calls)[0],
        output: string,
      ) => {
        const nm = tc.function?.name ?? "";
        const idxTool = await allocTurnIdx(db, sessionId, 1);
        await persistTurn(db, sessionId, idxTool, {
          role: "tool",
          content: { output },
          tool_name: nm,
          tool_call_id: tc.id,
          bucket: bucket ?? "single",
        });
      };

      const toolCalls = completion.tool_calls;
      for (let ti = 0; ti < toolCalls.length; ti++) {
        const tc = toolCalls[ti];
        const name = tc.function?.name ?? "";

        if (READ_TOOL_NAMES.has(name)) {
          const batch: typeof toolCalls = [];
          let j = ti;
          while (j < toolCalls.length) {
            const tj = toolCalls[j];
            const nm = tj.function?.name ?? "";
            if (!READ_TOOL_NAMES.has(nm)) break;
            batch.push(tj);
            j++;
          }
          const readOuts = await Promise.all(
            batch.map(async (bt) => {
              const nm = bt.function?.name ?? "";
              const ag = argsJson(bt.function?.arguments ?? "{}");
              const output = await runReadTool(nm, ag, ctx);
              return { tc: bt, output };
            }),
          );
          for (const { tc: btc, output } of readOuts) {
            await pushToolOutput(btc, output);
          }
          ti = j - 1;
          continue;
        }

        const args = argsJson(tc.function?.arguments ?? "{}");

        if (name === "propose_action") {
          const result = validateAndApplyPropose(
            draftActions,
            args,
            ctx,
            bucket,
          );
          if (result.error) {
            await pushToolOutput(tc, result.error);
          } else {
            draftActions = result.actions;
            const latest =
              !result.merged && draftActions[draftActions.length - 1];
            await pushToolOutput(
              tc,
              result.merged
                ? `Merged archive into existing action. It now covers ${
                    (
                      draftActions.find((a) => a.type === "archive")?.payload
                        .email_ids as string[]
                    )?.length ?? 0
                  } emails.`
                : `Staged ${args.type} action with id ${latest ? latest.id : "?"}.`,
            );
          }
        } else if (name === "revise_action") {
          draftActions = applyReviseAction(draftActions, args);
          await pushToolOutput(tc, `Revised action ${args.id}.`);
        } else if (name === "discard_action") {
          draftActions = applyDiscardAction(draftActions, args);
          await pushToolOutput(tc, `Discarded action ${args.id}.`);
        } else if (name === "ask_user") {
          pendingQuestions = extractQuestions(args, tc.id, ctx, bucket);
          paused = true;
          break;
        } else if (name === "finalize") {
          const cardSource = opts.bucketCards ?? ctx.briefingCards;
          const emailsInScope =
            (cardSource.crucial?.length ?? 0) +
            (cardSource.replyNeeded?.length ?? 0) +
            (cardSource.deadlines?.length ?? 0) +
            (cardSource.nonEssential?.length ?? 0);
          const explicitEmptyScope =
            typeof opts.bucketSnapshotText === "string" &&
            opts.bucketSnapshotText.includes(
              "(none — finalize immediately with an empty plan.)",
            );
          if (
            draftActions.length === 0 &&
            emailsInScope > 0 &&
            !explicitEmptyScope
          ) {
            await pushToolOutput(
              tc,
              "finalize rejected: your scope still lists emails but no actions are staged. Call propose_action first (reply/todo/meeting with required read tools, or one archive bundling every nonEssential email_id in the noise bucket), or ask_user if you need a decision. Do not finalize until at least one action is staged or the user answered your questions.",
            );
            continue;
          }
          summary = (args.summary as string) ?? "";
          plan = {
            actions: draftActions,
            summary,
            finalized_at: new Date().toISOString(),
          };
          finalized = true;
          await pushToolOutput(tc, "Plan finalized.");
          break;
        } else {
          await pushToolOutput(tc, `Unknown tool: ${name}`);
        }
      }

      if (paused) {
        // Re-read session so parallel buckets merge questions and drafts safely.
        const { data: live } = await db
          .from("agent_sessions")
          .select("draft_actions, pending_questions, pending_question")
          .eq("id", sessionId)
          .single();
        const existingQ = (() => {
          const pq = (live?.pending_questions ?? []) as PendingQuestion[];
          if (pq.length) return pq;
          const one = live?.pending_question as PendingQuestion | null;
          return one ? [one] : [];
        })();
        const merged = [...existingQ, ...pendingQuestions];
        const isSub = bucket && bucket !== "single";
        let mergedDraft = draftActions;
        if (isSub) {
          const prev = (live?.draft_actions as DraftAction[]) ?? [];
          mergedDraft = mergeDraftsById([...prev, ...draftActions]);
        }
        await db
          .from("agent_sessions")
          .update({
            status: "asking",
            pending_question: merged[0] ?? null,
            pending_questions: merged,
            draft_actions: mergedDraft,
          })
          .eq("id", sessionId);
        return {
          status: "asking",
          pending_question: merged[0] ?? null,
          pending_questions: merged,
          draft_actions: mergedDraft,
        };
      }

      if (finalized) {
        // If this is a sub-agent run (bucket is set and session is multi-bucket),
        // don't flip the session to ready here — the parent orchestrator decides.
        if (bucket && bucket !== "single") {
          // Best-effort: persist this bucket's actions into session.draft_actions
          // so the orchestrator can recover them on a re-run after a timeout.
          // Uses a 4-second timeout so a slow/hung RPC never blocks the return.
          if (draftActions.length > 0) {
            const mergeRpc = db.rpc("merge_bucket_draft_actions", {
              p_session_id: sessionId,
              p_actions: draftActions,
            });
            await Promise.race([
              mergeRpc,
              new Promise<void>((resolve) => setTimeout(resolve, 4000)),
            ]).catch(() => {/* best-effort — orchestrator has in-memory copy */});
          }
          return {
            status: "bucket_done",
            plan,
            draft_actions: draftActions,
            summary,
          };
        }
        await db
          .from("agent_sessions")
          .update({
            status: "ready",
            plan,
            summary: summary ?? null,
            draft_actions: draftActions,
            pending_question: null,
            pending_questions: [],
          })
          .eq("id", sessionId);
        return {
          status: "ready",
          plan,
          draft_actions: draftActions,
          summary,
        };
      }

      if (!bucket || bucket === "single") {
        await db
          .from("agent_sessions")
          .update({ draft_actions: draftActions })
          .eq("id", sessionId);
      }
    }

    return { status: "planning", draft_actions: draftActions };
  } catch (err) {
    const message = formatUnknownError(err);
    // Only flip session to error for single-agent runs; sub-agents swallow.
    if (!bucket || bucket === "single") {
      await db
        .from("agent_sessions")
        .update({ status: "error", error: message })
        .eq("id", sessionId);
    }
    return {
      status: "error",
      draft_actions: draftActions,
      error: message,
    };
  }
}

/**
 * Orchestrator for the parallel bucket flow. Kicks off up to 4 concurrent
 * `runAgentStep` calls each scoped to one bucket. When all buckets resolve
 * (or one pauses for a question), consolidates state on the session row.
 * Called once from /agent/start and again from /agent/answer when a question
 * is cleared and the remaining buckets still have work.
 */
export async function runAgentStepParallel(
  sessionId: string,
  db: Db,
  userTimezone = "UTC",
): Promise<StepResult> {
  try {
    return await _runAgentStepParallel(sessionId, db, userTimezone);
  } catch (err) {
    const message = formatUnknownError(err);
    console.error("[runAgentStepParallel] unhandled error:", message);
    await db
      .from("agent_sessions")
      .update({
        status: "error",
        error: message,
        pending_question: null,
        pending_questions: [],
      })
      .eq("id", sessionId);
    return { status: "error", draft_actions: [], error: message };
  }
}

async function _runAgentStepParallel(
  sessionId: string,
  db: Db,
  userTimezone = "UTC",
): Promise<StepResult> {
  const { data: session } = await db
    .from("agent_sessions")
    .select(
      "id, user_id, status, draft_actions, pending_question, pending_questions, plan, summary, briefing_at, bucket",
    )
    .eq("id", sessionId)
    .single<SessionRow>();
  if (!session) throw new Error("Session not found");
  if (["ready", "done", "cancelled", "error"].includes(session.status)) {
    return {
      status: session.status,
      draft_actions: session.draft_actions,
      plan: session.plan,
      summary: session.summary ?? undefined,
    };
  }

  const snap = await getOrCreateBriefingSnapshot(db, session.user_id, session.briefing_at);

  const exec = snap.cards as AgentToolContext["briefingCards"];
  const executiveSummary =
    "Use get_briefing_context and the email lists in your scope.";

  // Build bucket contexts. Skip buckets with no emails entirely.
  const bucketPlans: Array<{
    bucket: AgentBucket;
    scoped: AgentToolContext["briefingCards"];
    text: string;
  }> = [];
  for (const b of AGENT_BUCKETS) {
    const sn = bucketSnapshot(exec, executiveSummary, b);
    const has =
      sn.scoped.crucial.length ||
      sn.scoped.replyNeeded.length ||
      sn.scoped.deadlines.length ||
      sn.scoped.nonEssential.length;
    if (!has) continue;
    bucketPlans.push({ bucket: b, scoped: sn.scoped, text: sn.text });
  }

  if (!bucketPlans.length) {
    await db
      .from("agent_sessions")
      .update({
        status: "ready",
        plan: {
          actions: [],
          summary: "Your inbox was already clear.",
          finalized_at: new Date().toISOString(),
        },
        summary: "Your inbox was already clear.",
      })
      .eq("id", sessionId);
    return {
      status: "ready",
      draft_actions: [],
      summary: "Your inbox was already clear.",
    };
  }

  // One non-empty bucket: a single coordinator is cheaper than parallel lanes.
  if (bucketPlans.length < 2) {
    return runAgentStep(sessionId, db, userTimezone);
  }

  const hadBriefingWork = briefingCardsHaveEmails(snap.cards);

  // Parallel buckets share one session; allocTurnIdx serializes on the session row.
  // A hard cap, so a stuck bucket ends as an error: 100s for a cloud model, 15
  // minutes for a local one, which answers the lanes one after another, so a
  // few lanes of several model turns each take minutes.
  const capMs = isLocalModel("careful") ? 900_000 : 100_000;
  const raced = await Promise.race([
    Promise.allSettled(
      bucketPlans.map((bp) =>
        runAgentStep(sessionId, db, userTimezone, {
          bucket: bp.bucket,
          bucketCards: bp.scoped,
          bucketSnapshotText: bp.text,
        }),
      ),
    ),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), capMs)),
  ]);

  // Out of time: what was proposed by then is the plan, for the user to
  // review; with nothing proposed, it is an error.
  if (raced === "timeout") {
    const { data: late } = await db.from("agent_sessions").select("status, draft_actions").eq("id", sessionId).single();
    const drafts = mergeDraftsById((late?.draft_actions as DraftAction[] | null) ?? []);
    if (late?.status === "cancelled") return { status: "cancelled", draft_actions: drafts };
    if (!drafts.length) throw new Error(`The plan took longer than ${capMs / 60_000} minutes and proposed nothing`);
    const summary = `Stopped after ${capMs / 60_000} minutes with what was proposed by then.`;
    const plan = { actions: drafts, summary, finalized_at: new Date().toISOString() };
    await db.from("agent_sessions").update({ status: "ready", plan, summary, draft_actions: drafts, pending_question: null, pending_questions: [] }).eq("id", sessionId);
    return { status: "ready", plan, draft_actions: drafts, summary };
  }
  const results = raced;

  // Consolidate: if any sub-agent paused, session is "asking".
  const { data: refreshed } = await db
    .from("agent_sessions")
    .select(
      "id, status, draft_actions, pending_question, pending_questions, plan, summary",
    )
    .eq("id", sessionId)
    .single();

  const mergedFromRuns = mergeDraftsFromParallelResults(results);

  if (refreshed?.status === "cancelled") {
    return {
      status: "cancelled",
      draft_actions: (refreshed.draft_actions as DraftAction[]) ?? [],
      plan: refreshed.plan ?? undefined,
      summary: refreshed.summary ?? undefined,
    };
  }

  if (refreshed?.status === "asking") {
    const finalDraft = mergeDraftsById([
      ...((refreshed.draft_actions as DraftAction[]) ?? []),
      ...mergedFromRuns,
    ]);
    // Merge questions from all sub-agents' returned values — the DB may have
    // lost some due to concurrent writes (last writer wins per row update).
    const allRunQuestions = results
      .filter((r) => r.status === "fulfilled")
      .flatMap(
        (r) =>
          ((r as PromiseFulfilledResult<StepResult>).value
            .pending_questions as PendingQuestion[]) ?? [],
      );
    const dbQuestions =
      ((refreshed.pending_questions as PendingQuestion[]) ?? []).length > 0
        ? (refreshed.pending_questions as PendingQuestion[])
        : refreshed.pending_question
          ? [refreshed.pending_question as PendingQuestion]
          : [];
    const questionById = new Map<string, PendingQuestion>();
    for (const q of [...dbQuestions, ...allRunQuestions]) {
      if (q?.id) questionById.set(q.id, q);
    }
    const mergedQuestions = [...questionById.values()];
    const firstQ = mergedQuestions[0] ?? null;
    await db
      .from("agent_sessions")
      .update({
        draft_actions: finalDraft,
        pending_question: firstQ,
        pending_questions: mergedQuestions,
      })
      .eq("id", sessionId);
    return {
      status: "asking",
      pending_question: firstQ,
      pending_questions: mergedQuestions,
      draft_actions: finalDraft,
    };
  }

  // All buckets done without pausing -> consolidate final plan.
  let draftActions = mergedFromRuns.length
    ? mergedFromRuns
    : ((refreshed?.draft_actions as DraftAction[]) ?? []);

  if (
    draftActions.length === 0 &&
    hadBriefingWork &&
    refreshed?.status !== "cancelled"
  ) {
    await runAgentStep(sessionId, db, userTimezone);
    const { data: post } = await db
      .from("agent_sessions")
      .select(
        "id, status, draft_actions, pending_question, pending_questions, plan, summary, error",
      )
      .eq("id", sessionId)
      .single();

    if (post?.status === "cancelled") {
      return {
        status: "cancelled",
        draft_actions: (post.draft_actions as DraftAction[]) ?? [],
        plan: post.plan ?? undefined,
        summary: post.summary ?? undefined,
      };
    }
    if (post?.status === "asking") {
      return {
        status: "asking",
        pending_question: post.pending_question,
        pending_questions: post.pending_questions,
        draft_actions: (post.draft_actions as DraftAction[]) ?? [],
      };
    }
    if (post?.status === "ready") {
      const fromPlan = planActionsFromStep(post.plan);
      const mergedReady = mergeDraftsById([
        ...((post.draft_actions as DraftAction[]) ?? []),
        ...fromPlan,
      ]);
      if (mergedReady.length > 0) {
        return {
          status: "ready",
          plan: post.plan ?? undefined,
          draft_actions: mergedReady,
          summary: post.summary ?? undefined,
        };
      }
    }
    if (post?.status === "error") {
      return {
        status: "error",
        draft_actions: (post.draft_actions as DraftAction[]) ?? [],
        error:
          typeof post.error === "string" && post.error.trim()
            ? post.error
            : "Agent run failed",
        plan: post.plan ?? undefined,
        summary: post.summary ?? undefined,
      };
    }

    draftActions = (post?.draft_actions as DraftAction[]) ?? [];
  }

  if (draftActions.length === 0 && hadBriefingWork) {
    const errMsg =
      "The plan could not be worked out. Ask again in a moment.";
    await db
      .from("agent_sessions")
      .update({
        status: "error",
        error: errMsg,
        pending_question: null,
        pending_questions: [],
      })
      .eq("id", sessionId);
    return {
      status: "error",
      draft_actions: [],
      error: errMsg,
    };
  }

  const bucketSummaries = results
    .map((r, i) =>
      r.status === "fulfilled" && (r.value as StepResult).summary
        ? `${bucketPlans[i].bucket}: ${(r.value as StepResult).summary}`
        : "",
    )
    .filter(Boolean);
  const finalSummary = bucketSummaries.length
    ? bucketSummaries.join(" · ")
    : `Planned ${draftActions.length} action${draftActions.length === 1 ? "" : "s"} across ${bucketPlans.length} bucket${bucketPlans.length === 1 ? "" : "s"}.`;

  const plan = {
    actions: draftActions,
    summary: finalSummary,
    finalized_at: new Date().toISOString(),
  };
  const { error: finalWriteError } = await db
    .from("agent_sessions")
    .update({
      status: "ready",
      plan,
      summary: finalSummary,
      draft_actions: draftActions,
      pending_question: null,
      pending_questions: [],
    })
    .eq("id", sessionId);
  if (finalWriteError) {
    throw new Error(
      `Failed to mark session ready: ${finalWriteError.message ?? JSON.stringify(finalWriteError)}`,
    );
  }
  return {
    status: "ready",
    plan,
    draft_actions: draftActions,
    summary: finalSummary,
  };
}

export async function startAgentSession(
  db: Db,
  userId: string,
): Promise<string> {
  const { briefingAt } = await getOrCreateBriefingSnapshot(db, userId);
  const { data: session, error } = await db
    .from("agent_sessions")
    .insert({
      user_id: userId,
      briefing_at: briefingAt,
      status: "planning",
    })
    .select("id")
    .single();
  if (error || !session)
    throw new Error(error?.message ?? "Create session failed");
  return session.id as string;
}

/**
 * Apply the user's answer to the pending question batch and resume.
 *
 * When `question_id` is omitted, the answer targets the first pending
 * question (back-compat). Answers are written as ask_user tool results
 * scoped to the originating bucket so each sub-agent sees only its own
 * answer in its message thread.
 */
export async function answerPendingQuestion(
  db: Db,
  sessionId: string,
  answer: {
    option_id?: string;
    custom_text?: string;
    skip?: boolean;
    not_sure?: boolean;
    question_id?: string;
  },
): Promise<void> {
  const { data: session } = await db
    .from("agent_sessions")
    .select("pending_question, pending_questions")
    .eq("id", sessionId)
    .single();
  if (!session) return;
  const batch = (session.pending_questions ?? []) as PendingQuestion[];
  const legacy = session.pending_question as PendingQuestion | null;
  const all = batch.length ? batch : legacy ? [legacy] : [];
  if (!all.length) return;

  const target =
    (answer.question_id && all.find((q) => q.id === answer.question_id)) ||
    all[0];
  if (!target) return;

  const selected = answer.option_id
    ? target.options.find((o) => o.id === answer.option_id)
    : null;
  let userText: string;
  if (answer.skip) userText = "[User skipped this question for now.]";
  else if (answer.not_sure)
    userText =
      "[User is not sure. Pick the safest default and flag it in reasoning.]";
  else if (answer.custom_text?.trim())
    userText = `[User custom answer] ${answer.custom_text.trim()}`;
  else if (selected) {
    const tags: string[] = [];
    if (selected.no_reply)
      tags.push(
        "mark resolved without replying — do NOT create a draft or send anything; propose a reply action with resolve_only=true",
      );
    if (selected.recommended) tags.push("was the recommended option");
    userText = `[User picked] ${selected.label}${selected.preview ? ` — ${selected.preview}` : ""}${tags.length ? ` (${tags.join("; ")})` : ""}`;
  } else userText = "[User did not answer explicitly.]";

  const idx = await allocTurnIdx(db, sessionId, 2);

  await persistTurn(db, sessionId, idx, {
    role: "tool",
    content: { output: userText },
    tool_name: "ask_user",
    tool_call_id: target.tool_call_id,
    bucket: (target.bucket as AgentBucket) ?? "single",
  });
  await persistTurn(db, sessionId, idx + 1, {
    role: "user",
    content: { text: `Continue with: ${userText}` },
    bucket: (target.bucket as AgentBucket) ?? "single",
  });

  // Remove this question from the pending batch. If batch empties, resume.
  const remaining = all.filter((q) => q.id !== target.id);
  const nextStatus = remaining.length ? "asking" : "planning";
  await db
    .from("agent_sessions")
    .update({
      status: nextStatus,
      pending_question: remaining[0] ?? null,
      pending_questions: remaining,
    })
    .eq("id", sessionId);
}
