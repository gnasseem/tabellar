// The cloud model chosen in setup, behind one function.
//
// The prompts and tool definitions were written against the OpenAI chat
// completions format, so that is what callers build. For any OpenAI-compatible
// endpoint the request goes out as it is. For Anthropic the request is
// translated to the Messages API and the reply translated back, so callers see
// the same response shape either way. The return value is a fetch Response so
// the callers' existing retry handling (429, 5xx, body parsing) keeps working.

import { loadConfig, keychainGet } from "./config.ts";

type ChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
  // The Anthropic content blocks this assistant turn came back with. Replayed
  // verbatim so thinking blocks reach the API unchanged, as it requires.
  _anthropic?: unknown[];
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: { type: string; function: { name: string; description?: string; parameters?: unknown } }[];
  temperature?: number;
  max_tokens?: number;
  // How hard the model should think. Only the Anthropic format uses it.
  effort?: "low" | "medium" | "high";
  // Ask OpenRouter for the model's reasoning text alongside the answer.
  reasoning?: boolean;
};

export function modelConfigured(): boolean {
  const m = loadConfig().model;
  return !!(m?.model && m.baseUrl && keychainGet("model-api-key"));
}

// Fail at once, with a message the interface can show, instead of retrying.
export function requireModel(): void {
  if (!modelConfigured()) throw new Error("No model is set up. Run `tabellar setup` in the terminal.");
}

export async function chatCompletion(req: ChatRequest, signal?: AbortSignal): Promise<Response> {
  const m = loadConfig().model;
  const key = keychainGet("model-api-key");
  if (!m || !key) throw new Error("No model is set up. Run `tabellar setup`.");
  return m.format === "anthropic" ? anthropic(m.baseUrl, m.model, key, req, signal) : openai(m.baseUrl, m.model, key, req, signal);
}

// ── OpenAI-compatible (OpenAI, OpenRouter, Groq, Cerebras, ...) ─────────────

function openai(baseUrl: string, model: string, key: string, req: ChatRequest, signal?: AbortSignal): Promise<Response> {
  const openRouter = baseUrl.includes("openrouter.ai");
  const body: Record<string, unknown> = {
    model,
    messages: req.messages.map(({ _anthropic, ...m }) => m),
    temperature: req.temperature,
    max_tokens: req.max_tokens,
  };
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  if (openRouter) {
    // Only route to providers that neither log nor train on the data.
    body.provider = { data_collection: "deny", allow_fallbacks: true };
    if (req.reasoning) body.reasoning = { effort: "medium" };
  }
  return fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...(openRouter ? { "X-Title": "Tabellar" } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ── Anthropic Messages API ──────────────────────────────────────────────────

// Models that accept server-side refusal fallbacks (beta). On a safety decline
// the API re-runs the request on a fallback model inside the same call.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"]);

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  return content == null ? "" : String(content);
}

function parseArgs(raw: string): unknown {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

type Block = Record<string, unknown>;

function toMessagesApi(req: ChatRequest): { system: string; messages: { role: string; content: Block[] }[] } {
  const system: string[] = [];
  const messages: { role: string; content: Block[] }[] = [];
  // Consecutive turns of one role are merged, which the API would do anyway;
  // this keeps tool results from several tool messages in one user turn.
  const push = (role: string, blocks: Block[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of req.messages) {
    if (m.role === "system") {
      // Leading system messages form the system prompt. Later ones are added
      // as text in the conversation so the earlier prefix never changes.
      if (messages.length === 0) system.push(asText(m.content));
      else push("user", [{ type: "text", text: asText(m.content) }]);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: asText(m.content) || "(no output)" }]);
    } else if (m.role === "assistant") {
      if (Array.isArray(m._anthropic) && m._anthropic.length) {
        push("assistant", m._anthropic as Block[]);
        continue;
      }
      const blocks: Block[] = [];
      const text = asText(m.content);
      if (text.trim()) blocks.push({ type: "text", text });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      }
      if (blocks.length) push("assistant", blocks);
    } else {
      push("user", [{ type: "text", text: asText(m.content) || "(empty)" }]);
    }
  }
  return { system: system.join("\n\n"), messages };
}

async function anthropic(baseUrl: string, model: string, key: string, req: ChatRequest, signal?: AbortSignal): Promise<Response> {
  const { system, messages } = toMessagesApi(req);
  // Thinking is always on for current models and its tokens count against
  // max_tokens, so the small limits written for other models would leave no
  // room for the answer. Output length is set by the prompts instead.
  const body: Record<string, unknown> = {
    model,
    max_tokens: Math.max(req.max_tokens ?? 0, 16000),
    messages,
    output_config: { effort: req.effort ?? "medium" },
  };
  if (system) body.system = system;
  // The agent workspace shows the model's reasoning; ask for a readable summary.
  if (req.reasoning) body.thinking = { type: "adaptive", display: "summarized" };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
    body.tool_choice = { type: "auto" };
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2026-10-21",
  };
  if (FALLBACK_MODELS.has(model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/messages`, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // 529 means overloaded; callers retry on 503.
    return new Response(await res.text(), { status: res.status === 529 ? 503 : res.status, headers: res.headers });
  }
  const data = (await res.json()) as { content: Block[]; stop_reason: string };
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text as string).join("");
  const toolCalls = data.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id as string, type: "function", function: { name: b.name as string, arguments: JSON.stringify(b.input ?? {}) } }));
  const reasoning = data.content
    .filter((b) => b.type === "thinking" && typeof b.thinking === "string" && b.thinking)
    .map((b) => b.thinking as string)
    .join("\n");
  const finish = { tool_use: "tool_calls", max_tokens: "length", refusal: "content_filter" }[data.stop_reason] ?? "stop";
  const message = {
    role: "assistant",
    content: text,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    reasoning: reasoning || undefined,
    _anthropic: data.content,
  };
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
