// The models chosen in setup, behind one function. A request names its slot:
// fast (reading each email) or careful (everything that writes or plans).
//
// The prompts and tool definitions were written against the OpenAI chat
// completions format, so that is what callers build. For any OpenAI-compatible
// cloud endpoint the request goes out as it is. For Anthropic, and for local
// models through Ollama's own chat API, the request is translated and the
// reply translated back, so callers see the same response shape either way. The return value is a fetch Response so
// the callers' existing retry handling (429, 5xx, body parsing) keeps working.

import { totalmem } from "node:os";
import { slotModel, modelKey, type ModelConfig, type Slot } from "./config.ts";

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
  // How hard the model should think. Anthropic uses it as given; Ollama
  // turns thinking on only for "high".
  effort?: "low" | "medium" | "high";
  // Ask OpenRouter for the model's reasoning text alongside the answer.
  reasoning?: boolean;
  // Which of the two models answers; careful when left out.
  slot?: Slot;
};

function ready(m: ModelConfig | undefined): boolean {
  if (!m?.model || !m.baseUrl) return false;
  return m.format === "ollama" || !!modelKey(m);
}

// Without a slot: both slots can run.
export function modelConfigured(slot?: Slot): boolean {
  return slot ? ready(slotModel(slot)) : ready(slotModel("careful")) && ready(slotModel("fast"));
}

export function isLocalModel(slot: Slot = "careful"): boolean {
  return slotModel(slot)?.format === "ollama";
}

// Local models can take minutes on a long prompt, the first call also loads
// the model into memory.
export function modelTimeoutMs(slot: Slot = "careful"): number {
  return isLocalModel(slot) ? 300_000 : 120_000;
}

// Fail at once, with a message the interface can show, instead of retrying.
export function requireModel(slot: Slot = "careful"): void {
  if (!modelConfigured(slot)) throw new Error("No AI model is set up. Choose one in Settings, under AI.");
}

export async function chatCompletion(req: ChatRequest, signal?: AbortSignal): Promise<Response> {
  const m = slotModel(req.slot ?? "careful");
  if (!m) throw new Error("No AI model is set up. Choose one in Settings, under AI.");
  if (m.format === "ollama") return ollama(m.baseUrl, m.model, req, signal);
  const key = modelKey(m);
  if (!key) throw new Error("No API key is saved for the model. Add one in Settings, under AI.");
  return m.format === "anthropic" ? anthropic(m.baseUrl, m.model, key, req, signal) : openai(m.baseUrl, m.model, key, req, signal);
}

// ── OpenAI-compatible (OpenAI, OpenRouter, Groq, Cerebras, ...) ─────────────

async function openai(baseUrl: string, model: string, key: string, req: ChatRequest, signal?: AbortSignal): Promise<Response> {
  const openRouter = baseUrl.includes("openrouter.ai");
  const body: Record<string, unknown> = {
    model,
    messages: req.messages.map(({ _anthropic, ...m }) => m),
    temperature: req.temperature,
    // Reasoning models spend part of this on thinking, so leave room for the answer.
    max_tokens: Math.max(req.max_tokens ?? 0, 4096),
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
  const send = () =>
    fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...(openRouter ? { "X-Title": "Tabellar" } : {}),
      },
      body: JSON.stringify(body),
    });
  // Some models (OpenAI's reasoning models among them) reject temperature or
  // want max_completion_tokens instead of max_tokens. Adjust and retry once each.
  for (let attempt = 0; ; attempt++) {
    const res = await send();
    if (res.status !== 400 || attempt >= 2) return res;
    const text = await res.text();
    if (/temperature/i.test(text) && "temperature" in body) delete body.temperature;
    else if (/max_tokens/i.test(text) && "max_tokens" in body) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    } else return new Response(text, { status: res.status, headers: res.headers });
  }
}

// ── Ollama (local models) ───────────────────────────────────────────────────
// Ollama's own chat API rather than its OpenAI-compatible one, because only
// the native API lets a request set the context window. Its default is far
// too small for an email plus the prompts and tool definitions.

function contextLength(): number {
  const gb = totalmem() / 2 ** 30;
  return gb >= 48 ? 32768 : gb >= 16 ? 16384 : 8192;
}

async function ollama(baseUrl: string, model: string, req: ChatRequest, signal?: AbortSignal): Promise<Response> {
  const toolNames = new Map<string, string>();
  const messages = req.messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) toolNames.set(tc.id, tc.function.name);
      return {
        role: "assistant",
        content: asText(m.content),
        tool_calls: m.tool_calls.map((tc) => ({ function: { name: tc.function.name, arguments: parseArgs(tc.function.arguments) } })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: asText(m.content), tool_name: m.name ?? toolNames.get(m.tool_call_id ?? "") ?? "" };
    }
    return { role: m.role, content: asText(m.content) };
  });
  // Thinking models (qwen3, deepseek-r1) think by default, which made sorting
  // one email take about 30 seconds instead of 1 with the same answer. Only
  // a caller asking for high effort gets thinking.
  const body: Record<string, unknown> = {
    model,
    messages,
    tools: req.tools?.length ? req.tools : undefined,
    stream: false,
    think: req.effort === "high",
    options: { num_ctx: contextLength(), temperature: req.temperature, num_predict: Math.max(req.max_tokens ?? 0, 4096) },
  };
  const post = () =>
    fetch(`${baseUrl.replace(/\/+$/, "")}/api/chat`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let res: Response;
  try {
    res = await post();
    // A model without a thinking mode may reject the field; ask again without it.
    if (res.status === 400) {
      const text = await res.text();
      if (!/think/i.test(text)) return new Response(text, { status: 400 });
      delete body.think;
      res = await post();
    }
  } catch {
    if (signal?.aborted) throw new Error("Local model request was cancelled");
    return new Response(JSON.stringify({ error: `Could not reach Ollama at ${baseUrl}. Is the Ollama app running?` }), { status: 503 });
  }
  if (!res.ok) return new Response(await res.text(), { status: res.status });
  const data = (await res.json()) as {
    message?: { content?: string; thinking?: string; tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[] };
    done_reason?: string;
  };
  const msg = data.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((tc, i) => ({
    id: tc.id ?? `call_${Date.now().toString(36)}_${i}`,
    type: "function",
    function: {
      name: tc.function.name,
      arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}),
    },
  }));
  const message = {
    role: "assistant",
    content: msg.content ?? "",
    tool_calls: toolCalls.length ? toolCalls : undefined,
    reasoning: msg.thinking || undefined,
  };
  const finish = toolCalls.length ? "tool_calls" : data.done_reason === "length" ? "length" : "stop";
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
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
