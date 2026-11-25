// The one place an action is authorised. Every change Tabellar makes on its
// own, and every approval of something it proposed, asks decide() first. The
// rules live in code, not in prompts, so nothing written inside an email can
// talk its way past them.
//
// Levels:
//   observe  syncs, sorts and notifies, but changes nothing and proposes nothing
//   suggest  labels happen on their own (and can be undone); everything else
//            waits for approval on its page
//   assist   labels, drafts, todos and meeting proposals happen on their own
//   autopilot  as Assist, and it may also send a reply on its own, but only
//            inside the thread and only to the person who wrote (checkAutoSend),
//            after a cancel window, within a daily cap
//
// Never, at any level: deleting or trashing mail (there is no such action, and
// gmail.ts has no function for it), archiving, forwarding or unsubscribing on
// its own, or sending to anyone other than the person who wrote.
//
// An automation the user wrote (automations.ts) is its own source. It may do
// what its sentence says at any level but Observe, archiving included, because
// the user wrote it; it may hand an email on by itself only at Autopilot and
// only to an address the user typed in that sentence (checkHandOn).

import { createHash } from "node:crypto";

export const LEVELS = ["observe", "suggest", "assist", "autopilot"] as const;
export type Level = (typeof LEVELS)[number];

// snooze, read, brief (first in the Brief, left out of it, or a digest there),
// notify and vip (a sender becomes most important) are an automation's.
export const KINDS = ["label", "archive", "draft", "todo", "meeting", "send", "unsubscribe", "snooze", "read", "brief", "notify", "vip"] as const;
export type Kind = (typeof KINDS)[number];

// "engine" and "automation" act on their own, "mcp" for an AI program the user
// connected; the others act because the user asked in the window.
export type Source = "engine" | "automation" | "mcp" | "agent" | "assistant" | "user";

// What the engine may do on its own at Assist. Archive and unsubscribe are
// never here, and send only at Autopilot.
const ENGINE_KINDS: ReadonlySet<string> = new Set(["label", "draft", "todo", "meeting"]);

// What an automation may do on its own. A sender it would make most important
// is always proposed. What changes nothing in the mailbox is never asked about.
const AUTOMATION_KINDS: ReadonlySet<string> = new Set(["label", "archive", "snooze", "read", "todo", "draft", "brief", "notify", "vip"]);
const CHANGES_NOTHING: ReadonlySet<string> = new Set(["brief", "notify"]);
export const CAP_PER_AUTOMATION = 50; // actions a day, for each automation

// What a program connected over MCP may do: nothing that leaves the mailbox.
const MCP_KINDS: ReadonlySet<string> = new Set(["label", "snooze", "draft", "todo", "meeting"]);
export const CAP_PER_PROGRAM = 50; // of each kind, a day

// Kinds the user's own window actions may carry out (agent plans, assistant
// requests, approvals of engine proposals).
const USER_KINDS: ReadonlySet<string> = new Set(KINDS);

// Caps on what the engine does or proposes: per cycle (one sync and analysis
// pass) and per calendar day.
export const CAP_PER_CYCLE = 60;
export const CAP_PER_DAY: Record<string, number> = { label: 500, draft: 25, todo: 60, meeting: 30, send: 20 };

// An automatic reply, as the engine wants to send it. `writer` is the address
// of the person whose email is being answered (Reply-To if set, else From),
// taken from the stored email, never from the model.
export type AutoSend = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  attachments?: number;
  threadId?: string | null;
  writer: string;
};

const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

// The only shape of send Autopilot may make: one recipient, the person who
// wrote, in the same thread, with nothing copied and nothing attached.
// Returns why it is refused, or null.
export function checkAutoSend(s: AutoSend | undefined): string | null {
  if (!s) return "No reply to check";
  const writer = s.writer.trim().toLowerCase();
  if (!ADDRESS.test(writer)) return "The sender's address is not usable";
  if (!s.threadId) return "Autopilot only replies inside an existing thread";
  if (s.to.length !== 1) return "Autopilot only replies to the one person who wrote";
  if (s.to[0].trim().toLowerCase() !== writer) return `Autopilot only replies to the person who wrote (${writer}), not ${s.to[0]}`;
  if (s.cc?.length || s.bcc?.length) return "Autopilot never copies anyone in";
  if (s.attachments) return "Autopilot never sends attachments";
  return null;
}

// An email handed on by an automation: `typed` are the addresses its sentence
// holds word for word. Returns why it is refused, or null.
export type HandOn = { to: string[]; cc?: string[]; bcc?: string[]; typed: string[] };
export function checkHandOn(s: HandOn | undefined): string | null {
  if (!s) return "Nothing to check";
  if (s.to.length !== 1 || s.cc?.length || s.bcc?.length) return "An automation forwards to one address, with nobody copied";
  const to = s.to[0].trim().toLowerCase();
  if (!ADDRESS.test(to)) return "The address is not usable";
  if (!s.typed.some((a) => a.trim().toLowerCase() === to)) return `${s.to[0]} is not in the automation's own words`;
  return null;
}

export type Decision = { verdict: "do" | "propose" | "refuse"; reason: string };

export type Request = {
  kind: string;
  source: Source;
  level: string;
  paused: boolean;
  suspicious?: boolean; // the email looks like it is trying to instruct the AI
  todayCount?: number; // engine actions of this kind so far today; for an automation, its own actions
  cycleCount?: number; // engine actions so far in this cycle
  send?: AutoSend; // for an engine send: the reply as it would go out
  sendCap?: number; // the user's own daily limit on automatic sends
  own?: boolean; // an automation that does not ask first
  handOn?: HandOn; // for an automation's send
  sentToday?: number; // automatic sends so far today, the engine's included
};

// Anything unrecognised, including levels from a later version, is Observe.
export function normalizeLevel(level: unknown): Level {
  return (LEVELS as readonly unknown[]).includes(level) ? (level as Level) : "observe";
}

export function decide(r: Request): Decision {
  if (!(KINDS as readonly string[]).includes(r.kind)) return { verdict: "refuse", reason: `Unknown action "${r.kind}"` };
  if (r.paused) return { verdict: "refuse", reason: "Tabellar is paused" };

  if (r.source === "automation") return decideAutomation(r);
  if (r.source === "mcp") return decideMcp(r);
  if (r.source !== "engine") {
    return USER_KINDS.has(r.kind) ? { verdict: "do", reason: "Requested in the window" } : { verdict: "refuse", reason: "Not allowed" };
  }

  const level = normalizeLevel(r.level);
  const autoSend = r.kind === "send" && level === "autopilot";
  if (!ENGINE_KINDS.has(r.kind) && !autoSend) return { verdict: "refuse", reason: `Tabellar never does "${r.kind}" on its own` };
  if (r.suspicious && r.kind !== "label") {
    return { verdict: "refuse", reason: "The email looks like it is giving instructions to an AI, so it is only labelled" };
  }
  if (level === "observe") return { verdict: "refuse", reason: "Observe changes nothing" };
  if (autoSend) {
    const why = checkAutoSend(r.send);
    if (why) return { verdict: "refuse", reason: why };
  }
  if ((r.cycleCount ?? 0) >= CAP_PER_CYCLE) return { verdict: "refuse", reason: `Limit of ${CAP_PER_CYCLE} actions per sync reached` };
  let cap = CAP_PER_DAY[r.kind] ?? 0;
  if (autoSend && r.sendCap !== undefined) cap = Math.min(cap, Math.max(0, r.sendCap));
  if ((r.todayCount ?? 0) >= cap) return { verdict: "refuse", reason: `Daily limit of ${cap} for ${r.kind} reached` };
  if (level === "suggest" && r.kind !== "label") return { verdict: "propose", reason: "Waiting for your approval" };
  return { verdict: "do", reason: level === "autopilot" ? "Autopilot" : level === "assist" ? "Assist" : "Suggest" };
}

function decideAutomation(r: Request): Decision {
  const level = normalizeLevel(r.level);
  const refuse = (reason: string): Decision => ({ verdict: "refuse", reason });
  if (!AUTOMATION_KINDS.has(r.kind) && r.kind !== "send") return refuse(`An automation never does "${r.kind}"`);
  if (r.suspicious && r.kind !== "label") return refuse("The email looks like it is giving instructions to an AI, so it is only labelled");
  if (level === "observe") return refuse("Observe changes nothing");
  if (r.kind === "send") {
    if (level !== "autopilot" || !r.own) return refuse("An automation sends only at Autopilot");
    const why = checkHandOn(r.handOn);
    if (why) return refuse(why);
    const cap = Math.min(CAP_PER_DAY.send, Math.max(0, r.sendCap ?? 0));
    if ((r.sentToday ?? 0) >= cap) return refuse(`Daily limit of ${cap} for send reached`);
  }
  if ((r.todayCount ?? 0) >= CAP_PER_AUTOMATION) return refuse(`Daily limit of ${CAP_PER_AUTOMATION} for this automation reached`);
  if (r.kind === "vip" || (!r.own && !CHANGES_NOTHING.has(r.kind))) return { verdict: "propose", reason: "Your automation asks first" };
  return { verdict: "do", reason: "Your automation" };
}

function decideMcp(r: Request): Decision {
  const level = normalizeLevel(r.level);
  const refuse = (reason: string): Decision => ({ verdict: "refuse", reason });
  if (!MCP_KINDS.has(r.kind)) return refuse(`A connected program never does "${r.kind}"`);
  if (r.suspicious && r.kind !== "label") return refuse("The email looks like it is giving instructions to an AI, so it is only labelled");
  if (level === "observe") return refuse("Observe changes nothing");
  if ((r.todayCount ?? 0) >= CAP_PER_PROGRAM) return refuse(`Daily limit of ${CAP_PER_PROGRAM} for ${r.kind} reached`);
  if (level === "suggest" && r.kind !== "label") return { verdict: "propose", reason: "Waiting for your approval" };
  return { verdict: "do", reason: "A program you connected" };
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

// A gap the model left for the user to fill in ("[Venue name]"). Such a
// reply is never sent on its own.
export const GAP = /\[[a-z][a-z0-9 ,.:/&'’-]{1,60}\](?!\()/i;
