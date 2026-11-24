import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import { normalizeAgentSessionError } from "@/lib/agentClient";
import type { AgentAction, AgentAnswer, AgentBucket, AgentQuestion, AgentTurnRow } from "@/lib/agentTypes";
import { Glyph } from "../ui";
import QuestionCard from "./QuestionCard";
import AgentActionCard from "./AgentActionCard";

// A cleanup plan, inside the Ask conversation that started it: the steps
// Tabellar took to work it out, the questions it needs answered, and the
// actions it proposes. Nothing is carried out until the user ticks what to
// include and runs it.

type StepStatus = "done" | "running" | "queued";

interface ProgressStep {
  key: string;
  tool: string;
  label: string;
  detail?: string;
  status: StepStatus;
  /** For read tools: a short string taken from the arguments (a sender name, a query). */
  suffix?: string;
  bucket?: AgentBucket;
  /** The model's reasoning for the round this step belongs to, when it gave one. */
  reasoning?: string;
}

const TOOL_LABEL: Record<string, string> = {
  get_briefing_context: "Read the inbox",
  get_thread: "Read a thread",
  search_emails: "Searched the inbox",
  past_replies_by_me: "Checked your past replies",
  calendar_freebusy: "Checked your calendar",
  user_style_profile: "Looked at how you write",
  ask_user: "Asked you to decide",
  propose_action: "Proposed an action",
  revise_action: "Revised an action",
  discard_action: "Dropped an action",
  finalize: "Finished the plan",
};

const BUCKET_LABEL: Record<AgentBucket, string> = { replies: "Replies", meetings: "Meetings", todos: "Todos", noise: "Non-essential", single: "Plan" };

const KINDS: [AgentAction["type"], string][] = [
  ["reply", "Replies"],
  ["todo", "Todos"],
  ["meeting", "Meetings"],
  ["archive", "Archive"],
];

function actionLine(a: AgentAction): string {
  const n = (a.payload.email_ids ?? []).length;
  if (a.type === "reply") return `Reply to ${a.payload.to ?? "the sender"}`;
  if (a.type === "todo") return a.payload.title ?? "Todo";
  if (a.type === "meeting") return a.payload.meeting_title ?? "Meeting";
  return `Archive ${n} ${n === 1 ? "email" : "emails"}`;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shortAddress(s?: string): string {
  if (!s) return "";
  const match = s.match(/<([^>]+)>/);
  const email = match?.[1] ?? s;
  const name = email
    .split("@")[0]
    .replace(/[^a-zA-Z]/g, " ")
    .trim();
  const pretty = name
    .split(/\s+/)
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join(" ");
  return pretty || email;
}

function shortSubject(s?: string, n = 32): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}


export default function AgentWorkspace() {
  const {
    agentSession,
    agentTurns,
    answerSolveAgent,
    answerSolveAgentBatch,
    executeSolveAgent,
    cancelSolveAgent,
    solveAgentCancelInFlight,
    resetSolveAgent,
    addToast,
  } = useApp();

  const [localActions, setLocalActions] = useState<AgentAction[]>([]);
  const [executing, setExecuting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const lastTurnCountRef = useRef(0);
  const lastTurnTimeRef = useRef(Date.now());

  // "Sender: subject" for the threads the plan reads, looked up once each.
  const [threadNames, setThreadNames] = useState<Map<string, string>>(new Map());
  const threadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of agentTurns ?? []) for (const tc of t.content.tool_calls ?? []) if (tc.function.name === "get_thread") ids.add(String(parseArgs(tc.function.arguments || "{}").email_id ?? ""));
    ids.delete("");
    return [...ids].sort().join(",");
  }, [agentTurns]);
  useEffect(() => {
    const ids = threadIds ? threadIds.split(",").filter((id) => !threadNames.has(id)) : [];
    if (!ids.length) return;
    createClient()
      .from("emails")
      .select("id, sender, subject")
      .in("id", ids)
      .then(({ data }) => {
        const next = new Map(threadNames);
        for (const e of (data || []) as { id: string; sender: string | null; subject: string | null }[]) {
          const who = (e.sender || "").replace(/<.*>/, "").replace(/"/g, "").trim();
          next.set(e.id, [who, shortSubject(e.subject ?? "", 28)].filter(Boolean).join(": ") || "this thread");
        }
        setThreadNames(next);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadIds]);

  // Mirror agent session actions locally so user edits feel instant.
  useEffect(() => {
    if (!agentSession) {
      setLocalActions([]);
      return;
    }
    const src = agentSession.plan?.actions ?? agentSession.draft_actions ?? [];
    setLocalActions(src);
  }, [
    agentSession?.id,
    agentSession?.status,
    agentSession?.draft_actions,
    agentSession?.plan?.actions,
    agentSession,
  ]);

  // Derive a progress checklist from assistant tool calls + matching tool
  // results. Each step carries its bucket tag so we can render per-bucket lanes.
  const { steps, assistantStatusLine } = useMemo(() => {
    const items: ProgressStep[] = [];
    const resolved = new Set<string>();
    // Refused by the server, so nothing was staged: not a step worth showing.
    const refused = new Set<string>();
    const sessionDone =
      agentSession?.status === "ready" || agentSession?.status === "done";

    (agentTurns ?? []).forEach((t) => {
      if (t.role === "tool" && t.tool_call_id) resolved.add(t.tool_call_id);
      if (t.role === "tool" && t.tool_call_id && /^\w+ rejected/.test(String(t.content.output ?? ""))) refused.add(t.tool_call_id);
    });

    let lastStatus = "";

    (agentTurns ?? []).forEach((t) => {
      // The server keeps as a status only what is worth reading.
      if (t.role === "status") lastStatus = String(t.content.text ?? "").trim();
      if (t.role !== "assistant") return;
      const tools = t.content.tool_calls ?? [];
      const bucket = (t as AgentTurnRow & { bucket?: AgentBucket | null })
        .bucket as AgentBucket | undefined;
      tools.filter((tc) => !refused.has(tc.id)).forEach((tc) => {
        const label = TOOL_LABEL[tc.function.name] ?? tc.function.name;
        const args = parseArgs(tc.function.arguments || "{}");
        let suffix = "";
        let detail = "";
        if (tc.function.name === "get_thread") {
          const id = String(args.email_id ?? "");
          suffix = threadNames.get(id) ?? "this thread";
        } else if (tc.function.name === "past_replies_by_me") {
          suffix = shortAddress(String(args.to ?? ""));
        } else if (tc.function.name === "search_emails") {
          suffix = String(args.query ?? "").slice(0, 28);
        } else if (tc.function.name === "propose_action") {
          // A model may leave the type out; its fields say it (the server reads them the same way).
          const type = String(args.type ?? (args.meeting_title ? "meeting" : args.body ? "reply" : Array.isArray(args.email_ids) ? "archive" : "todo"));
          if (type === "reply")
            detail = `Reply to ${shortAddress(String(args.to ?? ""))}`;
          else if (type === "meeting")
            detail = `Meeting: ${shortSubject(String(args.meeting_title ?? ""))}`;
          else if (type === "todo")
            detail = shortSubject(String(args.title ?? "Todo"));
          else if (type === "archive")
            detail = shortSubject(String(args.summary ?? "Archive batch"));
          suffix = type;
        } else if (tc.function.name === "ask_user") {
          const qs = Array.isArray(args.questions)
            ? (args.questions as Array<{ eyebrow?: string }>)
            : null;
          if (qs && qs.length) {
            suffix =
              qs.length === 1
                ? (qs[0]?.eyebrow ?? "")
                : `${qs.length} questions`;
          } else {
            suffix = String(args.eyebrow ?? "");
          }
        } else if (tc.function.name === "finalize") {
          suffix = "done";
        }
        items.push({
          key: tc.id,
          tool: tc.function.name,
          label,
          detail,
          suffix,
          status: resolved.has(tc.id) ? "done" : "running",
          bucket,
          reasoning: t.reasoning ?? undefined,
        });
      });
    });

    if (sessionDone) {
      for (const it of items) {
        if (it.status === "running") it.status = "done";
      }
    } else {
      // Only the latest "running" step per bucket shows as working; earlier ones
      // within the same bucket are demoted to done because the backend has
      // moved on for that lane.
      const lastRunningByBucket: Record<string, number> = {};
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].status !== "running") continue;
        const key = items[i].bucket ?? "_";
        if (lastRunningByBucket[key] === undefined) {
          lastRunningByBucket[key] = i;
        } else {
          items[i].status = "done";
        }
      }
    }

    return { steps: items, assistantStatusLine: lastStatus };
  }, [agentTurns, threadNames, agentSession?.status]);

  const doneCount = steps.filter((s) => s.status === "done").length;

  // Group steps by bucket for the lane view.
  const stepsByBucket = useMemo(() => {
    const buckets: Record<string, ProgressStep[]> = {};
    for (const s of steps) {
      const b = s.bucket ?? "single";
      if (!buckets[b]) buckets[b] = [];
      buckets[b].push(s);
    }
    return buckets;
  }, [steps]);

  const bucketKeys = Object.keys(stepsByBucket);
  const hasMultipleBuckets = bucketKeys.length > 1;

  // Track when turns last arrived; after 8s of silence, say it is still working.
  useEffect(() => {
    const count = agentTurns?.length ?? 0;
    if (count !== lastTurnCountRef.current) {
      lastTurnCountRef.current = count;
      lastTurnTimeRef.current = Date.now();
      setShowThinking(false);
    }
  }, [agentTurns?.length]);

  useEffect(() => {
    const s = agentSession?.status ?? "planning";
    if (s !== "planning" || (agentTurns?.length ?? 0) === 0) {
      setShowThinking(false);
      return;
    }
    const id = setInterval(() => {
      if (Date.now() - lastTurnTimeRef.current > 8_000) setShowThinking(true);
    }, 2_000);
    return () => clearInterval(id);
  }, [agentSession?.status, agentTurns?.length]);

  // Pending questions: prefer the batched array when available.
  const pendingQuestions: AgentQuestion[] = useMemo(() => {
    const arr = agentSession?.pending_questions;
    if (Array.isArray(arr) && arr.length) return arr;
    if (agentSession?.pending_question) return [agentSession.pending_question];
    return [];
  }, [agentSession?.pending_questions, agentSession?.pending_question]);

  // Local batch answers keyed by question id.
  const [batchAnswers, setBatchAnswers] = useState<Record<string, AgentAnswer>>(
    {},
  );
  // Clear when the pending set changes (new round of questions).
  useEffect(() => {
    setBatchAnswers({});
  }, [pendingQuestions.map((q) => q.id).join("|")]);

  if (!agentSession) return null;

  const status = agentSession.status;

  const statusLabel = solveAgentCancelInFlight
    ? "Cancelling"
    : status === "planning"
      ? "Working out a plan"
      : status === "asking"
        ? "Has a question"
        : status === "ready" && localActions.length === 0
          ? "Nothing to do"
          : status === "ready"
            ? "Ready to review"
            : status === "executing"
              ? "Running what you approved"
              : status === "done"
                ? "Finished"
                : status === "cancelled"
                  ? "Cancelled"
                  : status === "error"
                    ? "Stopped on an error"
                    : "";

  const toggleAction = (id: string, selected: boolean) => {
    setLocalActions((prev) =>
      prev.map((a) => (a.id === id ? { ...a, selected } : a)),
    );
  };
  const editAction = (id: string, patch: Partial<AgentAction["payload"]>) => {
    setLocalActions((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, payload: { ...a.payload, ...patch } } : a,
      ),
    );
  };

  const onExecute = async () => {
    const approved = localActions.filter((a) => a.selected);
    if (!approved.length) {
      addToast("info", "Tick at least one action to run.");
      return;
    }
    setExecuting(true);
    try {
      await executeSolveAgent(approved);
    } finally {
      setExecuting(false);
    }
  };

  const onClearSession = () => resetSolveAgent();

  const canCancel =
    status === "planning" ||
    status === "asking" ||
    status === "ready" ||
    status === "executing";
  const showCancelControl = canCancel || solveAgentCancelInFlight;

  const visibleSteps = steps.filter(
    (s) => showAdvanced || s.tool !== "ask_user",
  );

  const answeredCount = Object.keys(batchAnswers).length;
  const totalQuestions = pendingQuestions.length;
  const submitBatch = async () => {
    if (!totalQuestions) return;
    if (totalQuestions === 1) {
      const qid = pendingQuestions[0].id;
      const a = batchAnswers[qid];
      if (!a) return;
      await answerSolveAgent({ ...a, question_id: qid });
      return;
    }
    const answers = pendingQuestions.map((q) => {
      const a = batchAnswers[q.id];
      if (a) return { ...a, question_id: q.id };
      return { question_id: q.id, skip: true } as AgentAnswer;
    });
    await answerSolveAgentBatch({ answers });
  };

  const anyReasoning = steps.some((s) => s.reasoning);

  // Pick a final rationale from the last assistant turn (if it has reasoning).
  const finalReasoning = (() => {
    for (let i = agentTurns.length - 1; i >= 0; i--) {
      const t = agentTurns[i];
      if (t.role === "assistant" && t.reasoning) return t.reasoning;
    }
    return null;
  })();

  const included = localActions.filter((a) => a.selected).length;
  const reviewing = status === "ready" || status === "executing" || status === "done";
  const lane = (list: ProgressStep[]) => list.map((step) => <StepRow key={step.key} step={step} showReasoning={showReasoning} />);

  // Inside the conversation column: rows keep their inset, so the block is
  // pulled out by it and headings put it back, lining text up with the chat.
  const pad = "px-3.5";
  return (
    <section className="-mx-3.5 rounded-[9px]" aria-label="Cleanup plan">
      <div className={`flex h-7 items-center gap-2 ${pad}`}>
        <b className="font-medium text-ink">Cleanup plan</b>
        <span className={`flex min-w-0 items-center gap-1.5 text-[12.5px] ${status === "asking" && !solveAgentCancelInFlight ? "font-semibold text-wax-ink" : status === "error" ? "text-danger" : "text-ink3"}`}>
          <span className="truncate">{statusLabel}</span>
          {status === "planning" && !solveAgentCancelInFlight && (
            <span className="solve-dot-wave inline-flex" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          )}
        </span>
        <span className="flex-1" />
        {showCancelControl && (
          <button type="button" className="link" onClick={() => void cancelSolveAgent()} disabled={solveAgentCancelInFlight}>
            {solveAgentCancelInFlight ? "Cancelling" : "Cancel plan"}
          </button>
        )}
        {(status === "done" || status === "cancelled" || status === "error") && (
          <button className="link" onClick={onClearSession}>
            Clear
          </button>
        )}
      </div>

      {steps.length === 0 && status === "planning" && <p className={`${pad} pt-1 text-ink3`}>Reading the inbox</p>}

      {steps.length > 0 && (
        <div className="pt-2">
          <div className={`flex items-baseline gap-3 ${pad} pb-1`}>
            <h3 className="label">
              Steps <span className="font-normal">{doneCount} of {steps.length}</span>
            </h3>
            <span className="flex-1" />
            {anyReasoning && (
              <button className="link" aria-expanded={showReasoning} onClick={() => setShowReasoning((v) => !v)}>
                {showReasoning ? "Hide reasoning" : "Show reasoning"}
              </button>
            )}
            {steps.length > 4 && (
              <button className="link" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
                {showAdvanced ? "Show the latest only" : "Show every step"}
              </button>
            )}
          </div>

          {hasMultipleBuckets ? (
            bucketKeys.map((bk) => {
              const list = stepsByBucket[bk] ?? [];
              const shown = showAdvanced ? list : list.filter((s) => s.tool !== "ask_user").slice(-4);
              return (
                <div key={bk} className="pb-2">
                  <p className={`${pad} pb-0.5 pt-1.5 text-xs text-ink3`}>
                    <b className="font-semibold text-ink2">{BUCKET_LABEL[bk as AgentBucket] ?? BUCKET_LABEL.single}</b> {list.filter((s) => s.status === "done").length} of {list.length}
                  </p>
                  <ol>{lane(shown)}</ol>
                </div>
              );
            })
          ) : (
            <ol>{lane(showAdvanced ? visibleSteps : visibleSteps.slice(-6))}</ol>
          )}

          {assistantStatusLine && !reviewing && <p className={`${pad} pt-2 leading-normal text-ink2`}>{assistantStatusLine}</p>}

          {showThinking && (
            <p className={`flex items-center gap-1.5 ${pad} pt-2 text-xs text-ink3`} role="status">
              Working on the next step
              <span className="solve-dot-wave inline-flex" aria-hidden>
                <span />
                <span />
                <span />
              </span>
            </p>
          )}
        </div>
      )}

      {status === "asking" && pendingQuestions.length > 0 && (
        <div className={`${pad} pt-4`}>
          {pendingQuestions.length === 1 ? (
            <QuestionCard
              question={pendingQuestions[0]}
              initialAnswer={batchAnswers[pendingQuestions[0].id]}
              onChange={(a) =>
                setBatchAnswers((prev) => {
                  const next = { ...prev };
                  if (a) next[pendingQuestions[0].id] = a;
                  else delete next[pendingQuestions[0].id];
                  return next;
                })
              }
              onAnswer={async (a) => {
                await answerSolveAgent({ ...a, question_id: pendingQuestions[0].id });
              }}
            />
          ) : (
            <>
              <h3 className="label">{pendingQuestions.length} questions</h3>
              {pendingQuestions.map((q) => (
                <QuestionCard
                  key={q.id}
                  question={q}
                  compact
                  initialAnswer={batchAnswers[q.id]}
                  hideContinue
                  onChange={(a) =>
                    setBatchAnswers((prev) => {
                      const next = { ...prev };
                      if (a) next[q.id] = a;
                      else delete next[q.id];
                      return next;
                    })
                  }
                />
              ))}
              <div className="flex items-center gap-2 pt-3">
                <span className="text-xs text-ink3">
                  {answeredCount} of {totalQuestions} answered{answeredCount < totalQuestions ? ", the rest skipped" : ""}
                </span>
                <span className="flex-1" />
                <button className="btn btn-pri" onClick={() => void submitBatch()} disabled={answeredCount === 0}>
                  Continue
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {status === "error" && (
        <p className={`${pad} pt-3 leading-normal text-danger`} role="alert">
          The plan stopped: {normalizeAgentSessionError(agentSession.error) ?? "the reason was not reported"}. Nothing was carried out.
        </p>
      )}

      {localActions.length > 0 && !reviewing && (
        <div className="pt-4">
          <h3 className={`label ${pad} pb-1`}>
            Proposed so far <span className="font-normal">{localActions.length}</span>
          </h3>
          <ul>
            {localActions.map((a) => (
              <li key={a.id} className="row">
                <span className="w-[26px] flex-none" />
                <span className="truncate">{actionLine(a)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reviewing && (
        <div className="pt-4">
          {/* What the plan does is the list; the model's account of it can say more than is there. */}
          {agentSession.summary && !localActions.length && <p className={`${pad} leading-[1.6] text-ink`}>{agentSession.summary}</p>}
          {finalReasoning && status === "ready" && (
            <details className={`${pad} pt-2`}>
              <summary className="link inline cursor-default">Why this plan</summary>
              <p className="mt-1.5 max-w-[68ch] whitespace-pre-wrap text-[12.5px] leading-normal text-ink2">{finalReasoning}</p>
            </details>
          )}
          {localActions.length === 0 ? (
            <p className={`${pad} pt-2 text-ink3`}>Nothing to propose.</p>
          ) : (
            KINDS.map(([type, name]) => {
              const group = localActions.filter((a) => a.type === type);
              if (!group.length) return null;
              const on = group.filter((a) => a.selected).length;
              return (
                <div key={type} className="pt-3">
                  <h4 className={`label ${pad} pb-0.5`}>
                    {name} <span className="font-normal">{status === "ready" ? `${on} of ${group.length}` : group.length}</span>
                  </h4>
                  {group.map((a) => (
                    <AgentActionCard
                      key={a.id}
                      action={a}
                      onToggle={(s) => toggleAction(a.id, s)}
                      onEdit={(patch) => editAction(a.id, patch)}
                      result={agentSession.results?.[a.id]}
                      locked={status === "executing" || status === "done"}
                    />
                  ))}
                </div>
              );
            })
          )}
          {status === "ready" && localActions.length > 0 && (
            <div className={`flex items-center gap-2 ${pad} pt-3`}>
              <span className="text-xs text-ink3">
                {included} of {localActions.length} included
              </span>
              <span className="flex-1" />
              <button className="btn" onClick={() => setLocalActions((prev) => prev.map((a) => ({ ...a, selected: true })))}>
                Include all
              </button>
              <button className="btn btn-pri" onClick={onExecute} disabled={executing || included === 0}>
                {executing ? "Running" : `Run ${included}`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// One step of the planning: a check once finished, moving dots while it runs.
function StepRow({ step, showReasoning }: { step: ProgressStep; showReasoning?: boolean }) {
  const running = step.status === "running";
  const extra = step.detail || step.suffix;
  return (
    <li className="mx-2 grid min-h-item grid-cols-[26px_minmax(0,1fr)] items-center pl-1.5 pr-3">
      <span className="grid place-items-center">
        <Glyph state={step.status === "done" ? "done" : "filed"} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={`truncate ${running ? "text-ink" : "text-ink2"}`}>
          {step.label}
          {extra && <span className="text-ink3">, {extra}</span>}
        </span>
        {running && (
          <span className="solve-dot-wave inline-flex flex-none text-ink3" aria-label="Working">
            <span />
            <span />
            <span />
          </span>
        )}
      </span>
      {showReasoning && step.reasoning && <p className="col-start-2 whitespace-pre-wrap pb-1.5 text-[12.5px] leading-snug text-ink3">{step.reasoning}</p>}
    </li>
  );
}
