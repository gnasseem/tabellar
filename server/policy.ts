// The one place an action is authorised. Every change Tabellar makes on its
// own, and every approval of something it proposed, asks decide() first. The
// rules live in code, not in prompts, so nothing written inside an email can
// talk its way past them.
//
// Levels:
//   observe  syncs, sorts and notifies, but changes nothing and proposes nothing
//   suggest  everything waits in Activity for approval
//   assist   labels, drafts, todos and meeting proposals happen on their own
//
// Never, at any level: deleting or trashing mail (there is no such action, and
// gmail.ts has no function for it), sending on its own, or archiving on its
// own. Drafts are saved for the user to send; they never leave the machine by
// themselves.

import { createHash } from "node:crypto";

export const LEVELS = ["observe", "suggest", "assist"] as const;
export type Level = (typeof LEVELS)[number];

export const KINDS = ["label", "archive", "draft", "todo", "meeting", "send"] as const;
export type Kind = (typeof KINDS)[number];

// "engine" acts on its own; the others act because the user asked in the window.
export type Source = "engine" | "agent" | "assistant" | "user";

// What the engine may do on its own at Assist. Archive and send are never here.
const ENGINE_KINDS: ReadonlySet<string> = new Set(["label", "draft", "todo", "meeting"]);

// Kinds the user's own window actions may carry out (agent plans, assistant
// requests, approvals of engine proposals).
const USER_KINDS: ReadonlySet<string> = new Set(KINDS);

// Caps on what the engine does or proposes: per cycle (one sync and analysis
// pass) and per calendar day.
export const CAP_PER_CYCLE = 60;
export const CAP_PER_DAY: Record<string, number> = { label: 500, draft: 25, todo: 60, meeting: 30 };

export type Decision = { verdict: "do" | "propose" | "refuse"; reason: string };

export type Request = {
  kind: string;
  source: Source;
  level: string;
  paused: boolean;
  suspicious?: boolean; // the email looks like it is trying to instruct the AI
  todayCount?: number; // engine actions of this kind so far today
  cycleCount?: number; // engine actions so far in this cycle
};

// Anything unrecognised, including levels from a later version, is Observe.
export function normalizeLevel(level: unknown): Level {
  return (LEVELS as readonly unknown[]).includes(level) ? (level as Level) : "observe";
}

export function decide(r: Request): Decision {
  if (!(KINDS as readonly string[]).includes(r.kind)) return { verdict: "refuse", reason: `Unknown action "${r.kind}"` };
  if (r.paused) return { verdict: "refuse", reason: "Tabellar is paused" };

  if (r.source !== "engine") {
    return USER_KINDS.has(r.kind) ? { verdict: "do", reason: "Requested in the window" } : { verdict: "refuse", reason: "Not allowed" };
  }

  if (!ENGINE_KINDS.has(r.kind)) return { verdict: "refuse", reason: `Tabellar never does "${r.kind}" on its own` };
  if (r.suspicious && r.kind !== "label") {
    return { verdict: "refuse", reason: "The email looks like it is giving instructions to an AI, so it is only labelled" };
  }
  const level = normalizeLevel(r.level);
  if (level === "observe") return { verdict: "refuse", reason: "Observe changes nothing" };
  if ((r.cycleCount ?? 0) >= CAP_PER_CYCLE) return { verdict: "refuse", reason: `Limit of ${CAP_PER_CYCLE} actions per sync reached` };
  const cap = CAP_PER_DAY[r.kind] ?? 0;
  if ((r.todayCount ?? 0) >= cap) return { verdict: "refuse", reason: `Daily limit of ${cap} for ${r.kind} reached` };
  if (level === "suggest") return { verdict: "propose", reason: "Waiting for your approval" };
  return { verdict: "do", reason: "Assist" };
}

// An approval is bound to the exact proposal the user saw: the hash covers the
// kind, the email and every field of the detail (the draft's text, the label,
// the todo's wording). If any of it changes after the user looked, the hash no
// longer matches and the approval is refused.
export function proposalHash(kind: string, emailId: string | null, detail: unknown): string {
  return createHash("sha256").update(stableJson({ kind, emailId, detail })).digest("hex");
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

// Text that addresses an AI rather than a person: the usual shape of a planted
// instruction. A match only narrows what the engine will do (label only); it
// never widens anything, so a false positive costs a missed draft at worst.
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|directions|messages)\b/i,
  /\b(you are|you're|act as|pretend to be|behave as)\s+(now\s+)?(an?\s+|the\s+)?(ai|a\.i\.|assistant|language model|llm|chatbot|email agent|agent)\b/i,
  /\b(system prompt|developer (message|mode)|jailbreak|prompt injection)\b/i,
  /\b(new|updated|additional|hidden|secret|important)\s+instructions?\s+(for|to)\s+(the\s+|any\s+)?(ai|assistant|agent|model|llm|bot)\b/i,
  /\b(dear|attention|note to( the)?|hey|hi)\s+(ai|a\.i\.|assistant|agent|llm|chatbot|bot|language model)\b/i,
  /\b(ai|assistant|agent|llm|bot|model)\s*[:,-]\s*(please\s+)?(forward|send|reply|delete|trash|transfer|share|export|email|archive|wire|pay)\b/i,
  /\bforward\s+(all|every|each|any)\b[^.\n]{0,40}\b(emails?|messages?|mail|inbox|threads?)\b/i,
  /\b(do not|don't|never)\s+(tell|inform|notify|alert|show|mention (this|it) to)\s+(the\s+)?(user|owner|recipient|human)\b/i,
  /<\s*\/?\s*(system|instructions?|assistant|im_start|im_end)\s*>/i,
  /\[\s*\/?\s*(system|inst|instructions?)\s*\]/i,
];

export function looksLikeInstructions(...parts: (string | null | undefined)[]): boolean {
  const raw = parts.filter(Boolean).join("\n").slice(0, 40000);
  const text = raw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  return INSTRUCTION_PATTERNS.some((re) => re.test(text) || re.test(raw));
}
