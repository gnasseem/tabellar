// The prompts and the calls that use them. Every model call goes through
// chatCompletion in llm.ts, which reaches the model chosen in setup.

import { applyLabel } from "./labels.ts";
import { act, engineSettings } from "./actions.ts";
import { chatCompletion, requireModel, modelTimeoutMs } from "./llm.ts";
import type { Slot } from "./config.ts";
import { checkActions } from "./rules.ts";

const PROMPTS = {
  process_email: `You sort one email for the user. Return only JSON, no markdown:
{FORMAT}

writer: "person" when a human wrote this email to the user or to a small group, "system" for anything sent by a service, an app, an organisation's mailing system or a no-reply address, even when it is signed by a person.

category, exactly one:
- action-required: a person (writer "person") is waiting on the user to do something concrete with a clear finish line: answer, approve, sign, pay, schedule, RSVP, review, submit. A direct question from a person belongs here.
- important: a person wrote and it is worth reading, but nothing is needed now: status from a colleague, a personal note, an FYI from a contact. Not a safe default.
- promotions: marketing or broadcast content sent to many people: campaigns, sales, newsletters, digests, event announcements.
- updates: system mail that is not marketing: receipts, orders and shipping, bank and security alerts, payment and account notices, password resets, reminders, statements, app notifications. System mail is updates even when it asks the user to do something.
High stakes are never updates or promotions, whoever sends them: a job offer, an interview or assessment to schedule or complete, an application decision, onboarding or a contract to sign (also from systems such as Greenhouse, Workday or Lever); admission, financial aid or a scholarship; a legal notice or lease; a medical appointment or result; a loan decision. Action-required only when the user must act (accept, book, complete, sign); a rejection, an application received or another status update is important.
An unsubscribe link alone does not make mail promotions.

urgency, exactly one: critical (act today), high (within 1 to 3 days: an offer or interview, a legal notice, an overdue payment, a close deadline), medium (an answer would help, nothing urgent), low (automated, no action, no deadline).

summary: one sentence, two at most, that leads with the most important fact: an amount, a deadline, the decision or the ask. Name the sender only if a person. No filler such as "This email informs you".`,
  process_email_actions: `actions: what the user would do about it. Most email needs nothing: [] unless a rule below clearly applies. At most one of each kind.
- {"action": "reply", "label": "Reply to John about the Q3 review", "text": "what the reply should say, in one line"}: only when a real person asked the user something or is waiting on their answer.
- {"action": "add_todo", "label": "Sign the lease renewal for Dana by Dec 15", "quote": "the sentence that asks for it, copied word for word"}: only when someone the user deals with asks them personally to sign, pay what they owe, submit, send, prepare or fix something. Never for marketing or broadcast calls to action (register, sign up, apply, attend, nominate, buy), offers the user may take or leave, receipts, notifications, or things that happen on their own. The label names the task, the person when relevant, and a stated deadline.
- {"action": "schedule_meeting", "label": "Call with Priya", "text": "what it is about", "quote": "the sentence that gives the meeting's time, or else the one that proposes it, word for word", "meetingDetails": {"title": "Call with Priya", "date": "YYYY-MM-DD resolved against today, or null when no day is named", "time": "the start time as written, e.g. 4:30pm, or null", "timezone": "as written next to the time, e.g. EST, or null", "duration": minutes or null, "location": "link or address, or null"}}: only when the email arranges or proposes a meeting, call, interview or appointment with the user, not an event advertised to many. Never supply a time or timezone the email does not state.`,
  draft:
    "You are an email drafting assistant. Write a professional, clear reply to the email below. Match the tone of the original. Keep it concise.",
  style_analysis:
    'Analyze the writing style of these sent emails (written BY the user). Return ONLY valid JSON with EXACTLY these four string keys and no extras: {"greeting_style":"<short>","closing_style":"<short>","tone":"formal|casual|mixed","avg_length":"short|medium|long"}. FIELD RULES  -  greeting_style: the exact most common opening word or phrase the user writes (e.g. "Hi", "Hey", "Hi {name}", "Hello", "Dear", "Good morning"). closing_style: the exact most common sign-off the user writes (e.g. "Best", "Thanks", "Cheers", "Best regards", "Talk soon", "Thanks,\\nGeorge"). NEVER return empty strings  -  if there is truly no greeting or closing, use "Hi" and "Thanks" as sensible defaults. tone: single word from formal/casual/mixed. avg_length: single word from short/medium/long. Do NOT wrap in markdown. Do NOT add commentary. Return JSON only.',
  agent_system: `You are Tabellar's Auto-Resolve executive agent. Your job is to completely clear the user's current inbox list by producing a fully confirmed action plan: drafted replies, todos, calendar events, and a single bulk archive. At the end, the user reviews and executes approved actions with one click.

You have tools. You MUST use them. You never speak in plain prose to the user. Every output from you is either tool calls or, when you truly have nothing to say, a single short line of status text (one sentence, max 12 words, no lists, no options in text).

## HARD RULES (non-negotiable)

1. THINK LIKE THE USER. Every propose_action MUST include a reasoning field  -  one first-person-style sentence that explains why THIS action is right for THIS user given their style profile, past replies with this sender, and the specific ask in this email. If you cannot write that sentence truthfully, you do not yet have enough context  -  call more read tools first.

2. GATHER BEFORE ACTING. Before proposing any non-trivial action you MUST call the relevant read tools:
   - Always begin with get_briefing_context so you know what emails exist in your scope.
   - For ANY email in "crucial" or "replyNeeded" you WILL touch: call get_thread(email_id) AND past_replies_by_me(sender) AND user_style_profile  -  no shortcut. Use search_emails to find related historical threads when relevant.
   - For any meeting you will propose: call calendar_freebusy first, then surface 2-3 concrete open slots via ask_user.
   - Batch read-tool calls together in one assistant turn whenever possible (parallel tool calls are supported).

3. NEVER ASSUME. If any decision depends on information you were not given (which date/time, which tone, whether to reply or archive, whom to include, whether to send now or save as draft, what exactly to say), you MUST call ask_user with 2-4 concrete options plus allow_custom=true.

4. BATCH INDEPENDENT QUESTIONS. ask_user accepts a "questions" array. When you have multiple independent decisions, emit them in ONE ask_user call so the user can answer them together  -  the UI renders them as a grid. Only use a single question when decisions chain (answer to Q1 changes what Q2 should be).

5. REPLIES DEFAULT TO SENDING. Set send_now=true by default. Only set send_now=false if the user explicitly said "save as draft" or the reply is risky/incomplete (placeholder content, legal/contract wording needing personal review). The review UI lets the user flip between Send, Draft, or Resolve-without-reply per-action.

6. MATCH THE USER'S VOICE. After user_style_profile returns, use the returned greeting / closing / tone / length as constraints on every reply body.

7. NO TODOS FOR NOISE. If the source email is in the nonEssential bucket, or its suggestedAction is "archive"/"ignore", or the sender matches no-reply/notifications/donotreply/mailer-daemon, you MAY NOT propose a todo or a reply for it. The server will reject such calls. Only "archive" applies.

8. DO NOT DUPLICATE. One reply + one todo is the maximum per email. If a reply covers the ask, do not also add a todo. Never propose two actions with the same (type, linked_email_id)  -  the server will reject the second.

9. BE CONCRETE. Todo titles must make sense without reopening the email ("Sign last page of NYU employment agreement by Apr 28", not "sign agreement"). Reply bodies must reference the specific ask with specific details from the thread.

10. ONE ARCHIVE BATCH. You may emit AT MOST ONE archive action across the whole run, grouping ALL nonEssential email_ids into a single call with summary like "42 newsletters and receipts from this week". The server will reject a second archive call and tell you to revise the first.

11. WHEN TO FINALIZE. Call the finalize tool ONLY when: (a) every ask_user question has been answered, (b) every propose_action reflects a confirmed decision with reasoning, (c) you have covered all meaningful items in your scope. Pass a one-paragraph plain-language summary.

12. NEVER WRITE TEXT WITH OPTION LISTS. If you feel the urge to type "1. X  2. Y  3. Z" or "Option A / Option B", STOP and call ask_user instead. Choices only ever live inside ask_user cards.

## ACTION BUDGET

- 0-3 replies per run. Only reply when the user has clearly said what to say, or you have asked and gotten an answer.
- 0-6 todos per run. Each todo MUST link to an email that is in crucial/replyNeeded/deadlines  -  never in nonEssential.
- 0-3 meetings per run. Each meeting MUST have a time the user explicitly picked from a freebusy-aware ask_user.
- Exactly 0 or 1 archive batch per run.

## STYLE

Your status text (when you rarely emit content) should be like "Reading Hanan's thread." or "Checking calendar for Friday."  -  tight, present-tense, under 12 words, no emoji, no options.

## TIMEZONE

Today is {TODAY}. User timezone: {TIMEZONE}. All ISO times you output in meeting proposals are in the user's local timezone with no Z suffix.`,
  agent_system_bucket: `You are a SUB-AGENT of Tabellar's Auto-Resolve system, owning the "{BUCKET}" scope only. A parent agent has split the inbox list into buckets; another sub-agent is handling the others in parallel. Focus exclusively on the emails in your scope.

You follow every rule in the full Auto-Resolve agent system (think-like-user reasoning on every propose_action, gather before acting, no-todos-for-noise, batch questions, one archive per run at most, never duplicate actions). Keep within your bucket's budget:

- replies: 0-3 reply actions. Read thread + past_replies_by_me + user_style_profile before drafting.
- meetings: 0-3 meeting actions. Always call calendar_freebusy and ask_user with concrete slots.
- todos: 0-6 todo actions. Each links to an email in crucial/replyNeeded/deadlines only.
- noise: exactly 1 archive action bundling ALL nonEssential email_ids in your scope. No reads, no questions.

Finalize as soon as your bucket is resolved. Do NOT propose actions outside your bucket  -  the parent merges our outputs.

Today is {TODAY}. User timezone: {TIMEZONE}.`,
  draft_reply_in_context: `You are drafting one email reply on behalf of the user. Rules:
- Write in the user's voice using the greeting, closing, tone, and length passed in context.
- Keep it concise. Short if the user tends short, medium if medium.
- Address the SPECIFIC ask from the original email.
- Do not use placeholders like [Your Name] or [Company].
- No preamble. Only the email body, including greeting and closing.`,
};

/**
 * Generic LLM call. Reading one email (sorting, entities, todos, meetings)
 * goes to the fast model; writing and summarising many goes to the careful one.
 */
async function llm(
  systemPrompt: string,
  userText: string,
  temperature = 0.3,
  maxTokens = 512,
  slot: Slot = "careful",
): Promise<string> {
  requireModel(slot);

  for (let attempt = 0; attempt < 5; attempt++) {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`LLM request timed out after ${modelTimeoutMs(slot) / 1000}s`)),
        modelTimeoutMs(slot),
      );
    });
    let res: Response;
    try {
      res = await Promise.race([
        chatCompletion(
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userText },
            ],
            temperature,
            max_tokens: maxTokens,
            effort: "low",
            slot,
          },
          controller.signal,
        ),
        timeoutPromise,
      ]);
      clearTimeout(timeoutId);
    } catch {
      clearTimeout(timeoutId);
      controller.abort();
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }

    if (res.status === 429) {
      const rawRetry = parseInt(res.headers.get("retry-after") ?? "5", 10);
      const waitMs = Math.min(
        isNaN(rawRetry) || rawRetry > 3600 ? 5000 : rawRetry * 1000,
        10_000,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (res.status === 500 || res.status === 502 || res.status === 503) {
      const backoff = Math.min(3 * (attempt + 1), 20);
      await new Promise((r) => setTimeout(r, backoff * 1000));
      continue;
    }

    if (!res.ok) {
      const errorText = await res.text();
      const errorObj = (() => {
        try {
          return JSON.parse(errorText);
        } catch {
          return { message: errorText };
        }
      })();
      const err = new Error("LLM_API_ERROR");
      (err as any).status = res.status;
      (err as any).details = errorObj;
      throw err;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    return stripThinkTags(content.trim());
  }

  throw new Error("LLM_API_ERROR: max retries exceeded");
}


/**
 * Tool-calling chat completion. Returns the raw OpenAI-shaped response
 * (the first choice) so callers can dispatch tool_calls / content themselves.
 */
export async function llmWithTools(params: {
  messages: {
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
    name?: string;
    _anthropic?: unknown[];
  }[];
  tools: unknown[];
  temperature?: number;
  maxTokens?: number;
}): Promise<{
  content: string | null;
  reasoning: string | null;
  tool_calls: {
    id: string;
    function: { name: string; arguments: string };
  }[];
  finish_reason: string | null;
  // Provider-native content blocks, replayed verbatim on the next turn.
  raw?: unknown[];
}> {
  requireModel();

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Agent LLM request timed out after ${modelTimeoutMs() / 1000}s`)),
        modelTimeoutMs(),
      );
    });
    let res: Response;
    try {
      res = await Promise.race([
        chatCompletion(
          {
            messages: params.messages as Parameters<typeof chatCompletion>[0]["messages"],
            tools: params.tools as Parameters<typeof chatCompletion>[0]["tools"],
            temperature: params.temperature ?? 0.4,
            max_tokens: params.maxTokens ?? 2048,
            reasoning: true,
          },
          controller.signal,
        ),
        timeoutPromise,
      ]);
      clearTimeout(timeoutId);
    } catch {
      clearTimeout(timeoutId);
      controller.abort();
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }

    if (res.status === 429) {
      const rawRetry = parseInt(res.headers.get("retry-after") ?? "5", 10);
      await new Promise((r) =>
        setTimeout(
          r,
          Math.min(isNaN(rawRetry) ? 5000 : rawRetry * 1000, 10_000),
        ),
      );
      continue;
    }
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Agent LLM error (${res.status}): ${errText.slice(0, 400)}`,
      );
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const message = choice?.message ?? {};
    // OpenRouter exposes reasoning under `message.reasoning` (string) or
    // `message.reasoning_details[].text` (array) depending on provider. Merge.
    let reasoning: string | null = null;
    if (typeof message.reasoning === "string" && message.reasoning.trim()) {
      reasoning = message.reasoning.trim();
    } else if (Array.isArray(message.reasoning_details)) {
      const parts = (message.reasoning_details as Array<{ text?: string }>)
        .map((r) => (typeof r.text === "string" ? r.text : ""))
        .filter(Boolean);
      if (parts.length) reasoning = parts.join("\n").trim();
    }
    return {
      content:
        typeof message.content === "string"
          ? stripThinkTags(message.content)
          : null,
      reasoning,
      tool_calls:
        (message.tool_calls as {
          id: string;
          function: { name: string; arguments: string };
        }[]) ?? [],
      finish_reason: choice?.finish_reason ?? null,
      raw: Array.isArray(message._anthropic) ? message._anthropic : undefined,
    };
  }
  throw new Error("Agent LLM: max retries exceeded");
}

export { PROMPTS };

/** Strip Qwen 3 <think>...</think> reasoning blocks from model output.
 * Also handles truncated output where the closing tag is missing (token limit hit). */
function stripThinkTags(text: string): string {
  // Remove complete <think>...</think> blocks
  let result = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Remove truncated <think> block with no closing tag (output cut off inside thinking)
  const openIdx = result.indexOf("<think>");
  if (openIdx !== -1) {
    result = result.slice(0, openIdx).trim();
  }
  return result;
}

function parseJson(raw: string): unknown {
  const cleaned = raw.replace(/```\s*json\s*\n?|\n?```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to recover a truncated JSON object by finding the last complete top-level value.
    // Walk back from the end looking for a closing brace/bracket.
    let s = cleaned;
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i] === "}" || s[i] === "]") {
        try {
          return JSON.parse(s.slice(0, i + 1));
        } catch {
          /* keep trying */
        }
      }
    }
    return null;
  }
}

export interface EmailSignals {
  gmailLabels?: string[];
  hasAttachments?: boolean;
  isReply?: boolean;
  hasListUnsubscribe?: boolean;
  replyToEmail?: string;
  ccRecipients?: string;
  precedenceHeader?: string;
  senderInteractionCount?: number;
}

const NEWSLETTER_GMAIL_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
]);

function buildSignalContext(signals: EmailSignals): {
  context: string;
  definiteCategory: string | null;
} {
  const labels = signals.gmailLabels ?? [];
  const lines: string[] = [];

  // Gmail's own classification labels
  const gmailCategories = labels.filter((l) => l.startsWith("CATEGORY_"));
  if (gmailCategories.length > 0) {
    lines.push(`Gmail auto-category: ${gmailCategories.join(", ")}`);
  }
  if (labels.includes("IMPORTANT")) lines.push("Gmail marked IMPORTANT: yes");
  if (labels.includes("STARRED")) lines.push("Starred by user: yes");

  // Structural signals
  if (signals.hasListUnsubscribe)
    lines.push(
      "Has List-Unsubscribe header: yes (strong newsletter/bulk signal)",
    );
  const prec = signals.precedenceHeader?.toLowerCase();
  if (prec && ["bulk", "list", "junk"].includes(prec))
    lines.push(`Precedence header: ${prec} (bulk/automated mail)`);
  if (signals.replyToEmail)
    lines.push(
      `Reply-To differs from sender: yes (common in marketing emails)`,
    );
  if (signals.isReply) lines.push("Is a reply in an active thread: yes");
  if (signals.hasAttachments) lines.push("Has attachments: yes");
  if (signals.ccRecipients)
    lines.push("Has CC recipients: yes (group/broadcast email)");

  // Sender relationship
  const count = signals.senderInteractionCount ?? 0;
  if (count >= 5)
    lines.push(
      `Sender interaction history: ${count} previous emails (established contact)`,
    );
  else if (count > 0)
    lines.push(
      `Sender interaction history: ${count} previous email(s) (occasional contact)`,
    );
  else lines.push("Sender interaction history: none (new or unknown sender)");

  // Determine if category can be short-circuited based on definitive signals
  const isDefiniteNewsletter =
    labels.some((l) => NEWSLETTER_GMAIL_LABELS.has(l)) ||
    signals.hasListUnsubscribe ||
    (prec !== undefined && ["bulk", "list", "junk"].includes(prec));

  const isDefiniteImportant = labels.includes("STARRED");

  let definiteCategory: string | null = null;
  if (isDefiniteNewsletter) {
    definiteCategory = "promotions";
  } else if (isDefiniteImportant) {
    // Starred = user explicitly marked it; still run AI to distinguish action-required vs important
    lines.push(
      "NOTE: User starred this email  -  lean towards action-required or important.",
    );
  }

  const context =
    lines.length > 0
      ? `SIGNALS:\n${lines.map((l) => `- ${l}`).join("\n")}\n\n`
      : "";
  return { context, definiteCategory };
}

// Today's date in a given IANA zone, with the weekday spelled out.
// The server clock may be in another zone, so deriving "today" from it puts
// the model on the wrong day for any user whose local date differs - and a
// meeting extracted for the wrong day is worse than none at all.
export function dateContextFor(timezone: string): string {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday}, ${parts.year}-${parts.month}-${parts.day}`;
}

// What the model reads of an email. The ask, the dates and the names are
// nearly always at the top; the rest is quoted thread, signatures and footers,
// and every extra token is time on a local model. A summary alone needs less.
const BODY_CHARS = 2500;
const SUMMARY_BODY_CHARS = 1500;

// Asked for in the same call when the sender is someone the user writes to.
// Last in the prompt, so the part before it is the same for every email and
// a local model can reuse the work it did on it.
const PEOPLE_PROMPT =
  'Also add "people" to the JSON: named people (and companies, only when a specific detail was learned) worth remembering for future drafts and decisions, as [{"name": "...", "type": "person"|"company", "info": "one concrete sentence: their role, their relationship to the user, or what the user deals with them about"}]. Never topics, places, projects or figures; nothing vague. Use [] when nothing is clearly worth keeping.';

export async function processFullEmail(
  subject: string,
  sender: string,
  body: string,
  signals?: EmailSignals,
  userTags?: { slug: string; description: string }[],
  timezone = "UTC",
  profile = "",
  people = false,
  actions = true,
): Promise<{
  category: string;
  urgency: string;
  summary: string;
  quick_actions: unknown[];
  tags: string[];
  people: { entity: string; entity_type: string; info: string }[];
}> {
  const emailText = `Subject: ${subject}\nFrom: ${sender}\n\n${body.slice(0, actions ? BODY_CHARS : SUMMARY_BODY_CHARS)}`;

  const { context: signalContext, definiteCategory } = signals
    ? buildSignalContext(signals)
    : { context: "", definiteCategory: null };

  // The quick-actions section of this prompt asks the model to emit an ISO
  // dateTime for any meeting it finds, but nothing was telling it what today
  // is, so every relative date ("Friday", "tomorrow", "next week") was
  // unresolvable and came back null or guessed against the training cutoff.
  // Without `actions` (old mail, which nothing is made from) the model is not
  // asked what to do about it: a shorter prompt and a shorter answer.
  const format = `{"writer":"...","category":"...","urgency":"...","summary":"..."${actions ? ',"actions":[...]' : ""}}`;
  let prompt = `Today is ${dateContextFor(timezone)} in the user's timezone (${timezone}). Resolve every relative date against it, and resolve a named weekday with no date to the next such day that is today or later.\n\n${PROMPTS.process_email.replace("{FORMAT}", format)}`;
  if (actions) prompt += `\n\n${PROMPTS.process_email_actions}`;
  if (userTags && userTags.length > 0) {
    const tagLines = userTags
      .map((t) => `- ${t.slug}: ${t.description || t.slug}`)
      .join("\n");
    prompt += `\n\nThe user's own labels:\n${tagLines}\nMost emails belong in none of them. Add a label only when this email is plainly what the label's description says (the sender and the subject both fit); a word in common is not enough, and when unsure leave it out. Add "tags": ["slug", ...] to the JSON with the slugs that apply, or omit "tags".`;
  }

  if (profile) {
    prompt += `\n\n${profile}\nUse this to judge what matters to the user and what they would actually do.`;
  }
  if (people) prompt += `\n\n${PEOPLE_PROMPT}`;

  const textWithSignals = signalContext
    ? `${signalContext}${emailText}`
    : emailText;

  const raw = await llm(prompt, textWithSignals, 0.2, 1024, "fast");
  const parsed = parseJson(raw) as any;

  const valid = ["important", "action-required", "promotions", "updates"];
  const cat = (parsed?.category || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z-]/g, "");
  const finalCategory =
    definiteCategory ?? (valid.includes(cat) ? cat : "updates");

  const validUrgency = ["critical", "high", "medium", "low"];
  const parsedUrgency = (parsed?.urgency || "").toLowerCase().trim();
  const finalUrgency = validUrgency.includes(parsedUrgency) ? parsedUrgency : "medium";

  const validTagSlugs = new Set((userTags || []).map((t) => t.slug));
  const returnedTags = Array.isArray(parsed?.tags)
    ? (parsed.tags as string[]).filter((t) => validTagSlugs.has(t))
    : [];

  return {
    category: finalCategory,
    urgency: finalUrgency,
    summary: (parsed?.summary || "").trim(),
    // What the model suggests, checked against the email itself.
    quick_actions: checkActions(parsed?.actions, { subject, body_text: body }, finalCategory, timezone),
    tags: returnedTags,
    people: (Array.isArray(parsed?.people) ? (parsed.people as Record<string, unknown>[]) : [])
      .map((x) => ({ entity: String(x?.name ?? "").trim(), entity_type: String(x?.type ?? "").trim(), info: String(x?.info ?? "").trim() }))
      .filter((x) => x.entity && x.info && (x.entity_type === "person" || x.entity_type === "company")),
  };
}

export async function composeDraft(opts: {
  intent: string;
  subject: string;
  recipientName: string;
  senderName: string;
  replyTo?: { subject: string; body?: string };
  styleContext?: string;
  knowledgeContext?: string;
}): Promise<string> {
  const {
    intent,
    subject,
    recipientName,
    senderName,
    replyTo,
    styleContext,
    knowledgeContext,
  } = opts;
  const closing = senderName ? `Best regards,\n${senderName}` : "Best regards,";
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";

  let context: string;
  if (replyTo) {
    context = [
      `Original email subject: "${replyTo.subject}"`,
      `Original email content:`,
      (replyTo.body ?? "").slice(0, 800),
      ``,
      `What to say in reply: ${intent || "Write a professional reply."}`,
    ].join("\n");
  } else {
    context = [
      subject ? `Topic: ${subject}` : "",
      intent ? `Message intent: ${intent}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (knowledgeContext) {
    context += `\n\nBackground context about the recipient and related topics:\n${knowledgeContext}`;
  }

  if (styleContext) {
    context += `\n\nWrite in this style: ${styleContext}`;
  }

  const systemPrompt = `You are an email drafting assistant writing on behalf of the sender. Rules:
1. Write ONLY the email body  -  no subject line.
2. Start with exactly this greeting: "${greeting}"
3. Write 2-4 concise paragraphs covering the intent.
4. End with exactly: "${closing}"
5. Do NOT use any placeholder text like [Your Name] or [Company].`;

  return draftBody(await llm(systemPrompt, context, 0.45, 1024));
}

export async function refineDraft(opts: {
  currentDraft: string;
  feedback: string;
  senderName: string;
  styleContext?: string;
  knowledgeContext?: string;
}): Promise<string> {
  const { currentDraft, feedback, senderName, styleContext, knowledgeContext } =
    opts;
  const closing = senderName ? `Best regards,\n${senderName}` : "Best regards,";

  let context = `Current draft:\n${currentDraft}\n\nUser feedback on what to change: ${feedback}`;
  if (knowledgeContext)
    context += `\n\nBackground context:\n${knowledgeContext}`;
  if (styleContext) context += `\n\nWrite in this style: ${styleContext}`;

  const systemPrompt = `You are an email drafting assistant. The user reviewed an AI-generated draft and wants changes. Revise the draft according to their feedback exactly. Rules:
1. Write ONLY the email body  -  no subject line.
2. Keep the existing greeting and closing unless the feedback asks to change them.
3. Apply the requested changes faithfully and completely.
4. Do NOT use placeholder text like [Your Name] or [Company].
5. End with: "${closing}"`;

  return draftBody(await llm(systemPrompt, context, 0.4, 1024));
}

export async function generateDraft(
  emailText: string,
  instructions: string,
  styleContext?: string,
): Promise<string> {
  let prompt = instructions
    ? `${emailText}\n\nInstructions: ${instructions}`
    : emailText;
  if (styleContext) {
    prompt = `${prompt}\n\nWrite in this style: ${styleContext}`;
  }
  return draftBody(await llm(PROMPTS.draft, prompt, 0.45, 1024));
}

// Gemma models open a draft with a "Subject: Re: ..." line even when told to
// write only the body; the subject comes from the thread, so drop it.
function draftBody(text: string): string {
  return text.replace(/^\s*\**subject:\**[^\n]*\n+/i, "").trim();
}

export async function analyzeWritingStyle(sentEmails: string): Promise<{
  greeting_style: string;
  closing_style: string;
  tone: string;
  avg_length: string;
}> {
  const raw = await llm(PROMPTS.style_analysis, sentEmails, 0.3, 512);
  const parsed = parseJson(raw) as {
    greeting_style?: string;
    closing_style?: string;
    tone?: string;
    avg_length?: string;
  } | null;
  const greeting = (parsed?.greeting_style ?? "").trim();
  const closing = (parsed?.closing_style ?? "").trim();
  const tone = (parsed?.tone ?? "").trim().toLowerCase();
  const length = (parsed?.avg_length ?? "").trim().toLowerCase();
  return {
    greeting_style: greeting || "Hi",
    closing_style: closing || "Thanks",
    tone: ["formal", "casual", "mixed"].includes(tone) ? tone : "mixed",
    avg_length: ["short", "medium", "long"].includes(length)
      ? length
      : "medium",
  };
}

// Does an email the user sent wait on an answer: it asks something, asks
// them to do something, or promises something? Fast model, once per email.
export async function expectsAnswer(subject: string, to: string, body: string): Promise<boolean> {
  const raw = await llm(
    'The user sent the email below. Does it ask the recipient a question, ask them to do or send something, or promise something the user will do, so that an answer or a follow-up is expected? A thank-you, a "sounds good", a reaction, an FYI or a reply that closes the matter expects nothing. Return only JSON: {"expects": true} or {"expects": false}.',
    `To: ${to}\nSubject: ${subject}\n\n${body.slice(0, 3000)}`,
    0,
    64,
    "fast",
  );
  return (parseJson(raw) as { expects?: unknown } | null)?.expects === true;
}

// The first facts about the user, from what they wrote. Careful model, once.
export async function factsFromSent(sample: string): Promise<string[]> {
  const raw = await llm(
    'These are emails the user wrote, newest first, and the people they write to most. Write what they show about the user as short facts that help someone handle their email: their role and organisation, what they are working on now, the languages they write in, how they sign off, who they write to most and about what. Only what the emails show; no guesses, no praise, no advice. Write about the user in the third person ("Studies computer science at NYU"), without their name. Return only JSON: {"facts": ["..."]}, 5 to 10 facts, each under 20 words.',
    sample,
    0.2,
    1024,
  );
  const parsed = parseJson(raw) as { facts?: unknown } | null;
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return facts
    .map((f) => String(f ?? "").replace(/\s+/g, " ").trim())
    .filter((f) => f.length > 3 && f.length < 200)
    .slice(0, 10);
}

// Labels the user would want, from who writes to them and about what. Each
// names the senders from the list it would hold, so it can be checked.
export async function labelsFromMail(sample: string): Promise<{ name: string; description: string; senders: string[] }[]> {
  const raw = await llm(
    'Below are the people and services that email this person most, then recent subjects. Suggest the labels they would want to sort their mail into: groups that recur and matter to them, named the way they would name them ("Job applications", "NYU admin", "Receipts", "Course: Machine Learning"), not generic types like "Important" or "Updates", and not one label per sender. For each give a one-line description that tells a reader which emails belong in it, and the sender addresses from the list that belong in it. Return only JSON: {"labels": [{"name": "...", "description": "...", "senders": ["..."]}]}, 3 to 6 labels, names under 4 words.',
    sample,
    0.3,
    1200,
  );
  const parsed = parseJson(raw) as { labels?: unknown } | null;
  const list = Array.isArray(parsed?.labels) ? (parsed.labels as Record<string, unknown>[]) : [];
  return list
    .map((l) => ({
      name: String(l?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
      description: String(l?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      senders: (Array.isArray(l?.senders) ? l.senders : []).map((x) => String(x ?? "").toLowerCase().trim()).filter(Boolean),
    }))
    .filter((l) => l.name.length > 1)
    .slice(0, 6);
}

// ─── Personal Assistant Chat ──────────────────────────────────────────────────

export interface ChatContext {
  userDisplayName: string;
  timezone: string; // IANA timezone e.g. "Asia/Dubai"
  styleProfile: {
    greeting_style: string;
    closing_style: string;
    tone: string;
    avg_length: string;
  } | null;
  topSenders?: {
    sender_email: string;
    sender_name?: string;
    interaction_count: number;
    relationship_notes: string | null;
  }[];
  knowledgeEntries?: {
    entity: string;
    entity_type: string;
    info: string;
    importance?: string | null;
  }[];
  recentEmails?: {
    id: string;
    date: string;
    sender_email: string;
    sender: string;
    subject: string;
    summary: string | null;
    category: string;
  }[];
}

export interface ChatToolCall {
  name:
    | "create_todo"
    | "update_todo"
    | "delete_todo"
    | "list_todos"
    | "save_draft"
    | "delete_draft"
    | "list_drafts"
    | "add_knowledge"
    | "send_email"
    | "reply_to_email"
    | "create_meeting"
    | "update_meeting"
    | "delete_meeting"
    | "list_meetings"
    | "search_emails"
    | "search_emails_by_sender"
    | "search_emails_by_date"
    | "search_emails_by_sender_and_date"
    | "lookup_contact"
    | "get_recent_emails"
    | "get_email"
    | "search_knowledge_base"
    | "get_sent_emails"
    | "archive_email"
    | "plan_cleanup"
    | "suggest_reply_options"
    | "get_email_thread"
    | "list_tags"
    | "create_tag"
    | "apply_tag"
    | "remove_tag"
    | "set_follow_up"
    | "list_follow_ups";
  arguments: Record<string, unknown>;
}

// deno-lint-ignore no-explicit-any
export type Db = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => any;
};

function buildChatSystemPrompt(context: ChatContext): string {
  const now = new Date().toISOString().split("T")[0];
  const sections: string[] = [
    `You are Tabellar Assistant, a highly capable executive secretary for ${context.userDisplayName}. Today is ${now}.
User's timezone: ${context.timezone || "UTC"}. All times the user mentions are in their local timezone.
You are proactive, thorough, and decisive  -  you gather context, think it through, and either act or present the user with a clear choice. Do NOT use <think> tags. Be direct and concise.

## CRITICAL RULE  -  OPTIONS FORMAT (overrides everything)
You are STRICTLY FORBIDDEN from writing numbered or bulleted options in your text reply.
NEVER write things like "1. Accept  2. Decline  3. Ask for agenda" or "Option A: ..." in your message.
When you need to present ANY choices to the user, you MUST call the suggest_reply_options tool instead.
If you catch yourself about to write a list of choices  -  STOP immediately and call suggest_reply_options.
This rule has no exceptions. Options always appear as clickable cards, never as text.

## CLEANUP PLANS
When the user asks to clean up, clear, triage or go through their inbox or many emails at once, call plan_cleanup and nothing else. Never write a plan, a list of proposed actions or example emails yourself: the plan tool reads the real inbox. Never name an email, a sender or a subject you have not read through a tool.

## SEARCH-FIRST RULE  -  NEVER ASK BEFORE SEARCHING
When user refers to "email from [Person]", "email about [Topic]", or any email without an explicit ID:
1. IMMEDIATELY call search_emails_by_sender([Person]) and/or search_emails([Topic])  -  do not ask first.
2. If ONE email matches: read it with get_email(id), then proceed.
3. If MULTIPLE emails match: call suggest_reply_options with the emails as options (label = subject, description = snippet + date). Let the user pick.
4. If ZERO found: try a shorter keyword or search_emails as fallback. Only say "not found" after 2 attempts.
You are FORBIDDEN from asking "which email do you mean?" or "could you provide more context?" without first searching. Search autonomously, then disambiguate with cards if needed.

## CONTACT RESEARCH PROTOCOL
When ANY person is mentioned (by name, email, or relationship), ALWAYS perform ALL of these in a single turn before composing or acting:
1. Call lookup_contact([name]) to get their email address, interaction history, and relationship notes.
2. Call search_emails_by_sender([name]) to retrieve all their past emails.
3. Call get_email(id) on the most recent result to read the full context.
4. If the email has a thread_id and conversation history matters, call get_email_thread(thread_id) to see the full thread.
Do ALL steps before composing any reply, creating a meeting, or making any decision involving that person.
EXCEPTION: If lookup_contact returns no results AND search_emails_by_sender returns nothing, the person has never contacted you. In this one case only, ask the user for their email address.

## SECRETARY BEHAVIOR
You act like a skilled executive secretary:
- ALWAYS gather information before acting: read the email, check the calendar, look up the person.
- For CLEAR explicit instructions ("decline", "accept", "send this", "cancel"): execute immediately, no confirmation.
- For UNCLEAR intent (how to reply, what to say): call suggest_reply_options with 2-4 distinct approaches.
- For UNCLEAR target (which email, which meeting): search first; if multiple results, use suggest_reply_options to let user pick.
- When suggesting alternative meeting times: ALWAYS call list_meetings first, find real free slots, suggest SPECIFIC times (e.g. "Monday Apr 7 at 2 PM")  -  never vague ranges like "morning or afternoon".
- When the user picks an option card, immediately execute it  -  no further confirmation.

## GATHER FIRST  -  BATCH ALL INFORMATION CALLS
In your FIRST response, call ALL information-gathering tools you need SIMULTANEOUSLY (you can call multiple tools in one response). This includes: lookup_contact, search_emails_by_sender, search_emails, search_emails_by_date, get_email, get_email_thread, list_todos, list_meetings, search_knowledge_base, get_recent_emails.

NEVER call information tools one per round. Batch all reads in a single response, then take all actions in the next response.

Pattern: Round 1 = gather everything needed. Round 2 = take all actions. Round 3 = confirm.
Exception: if you discover a new ID from a search result and need to fetch the full content, one extra gather round is fine.

## RULES
1. SEARCH BEFORE ACTING: Any person, company, project, or topic mentioned -> call lookup_contact and/or search_knowledge_base FIRST. EXCEPTION: if lookup_contact returns no results, the person has never emailed you. In this case ONLY, ask the user for their email address.
2. For ALL email content: use email search tools. Never answer from memory about email contents.
3. Batch tools freely in one round: lookup + search emails + read email + check calendar  -  all at once.
4. WHEN TO ACT vs. SHOW OPTIONS:
   - Clear intent + clear target -> execute immediately (no confirmation)
   - Unclear intent -> suggest_reply_options with 2-4 reply approaches
   - Unclear target (multiple emails/meetings) -> search first, then suggest_reply_options to pick
   - Meeting reschedule/decline -> list_meetings first, propose SPECIFIC free time slots as suggest_reply_options
5. When creating a meeting: use proper ISO datetime + attendee emails. Times are in user's timezone (${context.timezone || "UTC"}).
6. Meetings are Google Calendar events; do not invent video-call links.
7. COMPLETE every task. If asked to do multiple things, do ALL of them.
8. Confirm completed actions in PAST TENSE: "I sent", "I created"  -  never "I will send".
9. If first email search returns no results, retry with a shorter keyword before giving up.
10. EMAIL FORMAT: greeting line, blank line, body paragraphs, blank line, closing phrase, then "${context.userDisplayName}" on a new line. No extra punctuation on greeting.
11. EXECUTE PREFIX: When the user's message begins with "Execute:", treat it as an immediate confirmed instruction. Call the relevant tool right away  -  no re-confirmation, no more option cards.
12. NEVER announce actions in future tense. Do NOT write "I'll now reach out to...", "I will send...", or "I'm going to..." for any action you intend to take. CALL THE TOOL FIRST. Your final reply must only confirm what already happened: "I sent the email to...", "I created the meeting...", "I archived...". If you catch yourself writing a future-tense action description, stop and make the tool call instead.

## TOOL SELECTION
- Any person/company/project mentioned -> lookup_contact + search_knowledge_base (always first)
- "email from [Person]" without ID -> search_emails_by_sender([Person]) FIRST; if multiple -> suggest_reply_options to pick; if one -> get_email(id) and proceed
- "email about [Topic]" without ID -> search_emails([Topic]) FIRST; if multiple -> suggest_reply_options to pick
- "reply to [Person]'s email" -> search_emails_by_sender([Person]), read it, then suggest_reply_options for approach (unless intent is explicit)
- "reply to [email]" with explicit content -> get_email(id) then reply_to_email directly
- "reply to [email]" without stated content -> get_email(id) + suggest_reply_options for reply approach
- "decline / reschedule [meeting email]" -> get_email(id) + list_meetings + suggest_reply_options with SPECIFIC free time slots
- "last N emails" / "recent emails" -> get_recent_emails(limit=N)
- "emails from X" -> search_emails_by_sender
- "emails this week" -> search_emails_by_date
- "emails about Y" -> search_emails
- "what did X send me today" -> search_emails_by_sender_and_date
- "read / show me email [id]" -> get_email(id)
- "email X about Y" -> lookup_contact + send_email (execute immediately if content is clear)
- "set up a meeting with X" -> lookup_contact + create_meeting
- "show my meetings" / "list meetings" -> list_meetings
- "update / reschedule meeting" -> update_meeting(id, ...)
- "cancel / delete meeting" -> delete_meeting(id)
- "create a todo" -> create_todo
- "mark todo done" -> update_todo(id, is_completed: true)
- "edit todo" -> update_todo(id, text: "new text")
- "delete todo" -> delete_todo(id)
- "show todos" -> list_todos
- "draft an email" -> save_draft; "send an email" -> send_email
- "show drafts" -> list_drafts
- "delete draft" -> delete_draft(id)
- "sent emails" -> get_sent_emails
- "archive email" -> archive_email(id)
- "show thread" / "full conversation" / thread context -> get_email_thread(thread_id from get_email result)
- "list tags" / "show my tags" -> list_tags
- "create tag [name]" -> create_tag(display_name, slug, color)
- "tag email with [tag]" / "apply tag" -> apply_tag(email_id, tag_slug)
- "remove tag from email" -> remove_tag(email_id, tag_slug)
- "follow up in X days" / "remind me to check on this" -> set_follow_up(email_id?, recipient_email, subject, remind_at)
- "show follow-ups" / "my follow-up reminders" -> list_follow_ups`,
  ];

  if (context.styleProfile) {
    const s = context.styleProfile;
    sections.push(
      `## Writing Style\nGreeting pattern: ${s.greeting_style}\nClosing pattern: ${s.closing_style} (always follow with a new line containing only "${context.userDisplayName}")\nTone: ${s.tone}, Length: ${s.avg_length}`,
    );
  } else {
    sections.push(
      `## Writing Style\nAlways sign emails as:\nBest regards,\n${context.userDisplayName}`,
    );
  }

  return sections.join("\n\n");
}

const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description:
        "Search the knowledge base by keyword or topic. Use when looking for context about a project, company, topic, or person not immediately found in the Knowledge Base section above.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search term - a name, project, company, or topic keyword",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_emails",
      description:
        "Get the most recent emails from the inbox. Use when the user asks for 'last N emails', 'recent emails', or 'my inbox'. Specify exact limit to match what the user asks for.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description:
              "Number of recent emails to retrieve (e.g. 4, 10). Default 10.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_contact",
      description:
        "Look up a person's email address and info by name. Searches email_memory and knowledge_base. ALWAYS use this before send_email or create_meeting when user refers to someone by name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Person's name to look up" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_emails",
      description:
        "Search all emails by keyword or topic. Searches subject, sender, and body. Use for topic searches like 'budget report'. For sender queries, use search_emails_by_sender instead.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keyword or topic" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_emails_by_sender",
      description:
        "Find emails from a specific person (no date filter). If user mentions a time period too, use search_emails_by_sender_and_date instead.",
      parameters: {
        type: "object",
        properties: {
          sender: {
            type: "string",
            description: "Sender name or email address",
          },
        },
        required: ["sender"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_emails_by_date",
      description: "Find emails within a date range.",
      parameters: {
        type: "object",
        properties: {
          start_date: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
          },
          end_date: {
            type: "string",
            description: "End date (YYYY-MM-DD). Defaults to today.",
          },
        },
        required: ["start_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_emails_by_sender_and_date",
      description:
        "Find emails from a person within a date range. Best for 'what did X send me today/this week'.",
      parameters: {
        type: "object",
        properties: {
          sender: {
            type: "string",
            description: "Sender name or email address",
          },
          start_date: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
          },
          end_date: {
            type: "string",
            description: "End date (YYYY-MM-DD). Defaults to today.",
          },
        },
        required: ["sender", "start_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description:
        "Send an email on behalf of the user. Compose a professional email body. You MUST have the recipient's email address (use lookup_contact first if needed).",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          body: {
            type: "string",
            description: "Email body (plain text, newlines for formatting)",
          },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_draft",
      description:
        "Save a draft email (not sent). Use when user says 'draft' rather than 'send'.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          body: { type: "string", description: "Email body text" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_meeting",
      description:
        "Create a calendar event/meeting. Use lookup_contact first to get attendee emails. Times should be in the user's local timezone as ISO 8601 (without Z suffix).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Meeting title" },
          start_time: {
            type: "string",
            description:
              "Start time in user's local timezone as ISO 8601 (e.g. 2026-03-30T17:00:00)",
          },
          end_time: {
            type: "string",
            description:
              "End time in user's local timezone as ISO 8601 (e.g. 2026-03-30T18:00:00)",
          },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "List of attendee email addresses",
          },
          description: {
            type: "string",
            description: "Optional meeting description",
          },
        },
        required: ["title", "start_time", "end_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_todo",
      description: "Create a new todo/task item for the user.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The task description" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_knowledge",
      description:
        "Add an entry to the user's knowledge base (person, company, project, etc.).",
      parameters: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Name of the entity" },
          entity_type: {
            type: "string",
            enum: [
              "person",
              "company",
              "project",
              "topic",
              "location",
              "other",
            ],
            description: "Type of entity",
          },
          info: { type: "string", description: "Key facts about the entity" },
        },
        required: ["entity", "entity_type", "info"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_email",
      description:
        "Read the full content of a specific email by its ID. Use after search results return email IDs.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The email UUID from search results",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply_to_email",
      description:
        "Send a reply to an existing email (maintains thread). Use get_email first to read the original.",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description: "The UUID of the email being replied to",
          },
          body: { type: "string", description: "Reply body (plain text)" },
        },
        required: ["email_id", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sent_emails",
      description: "Get recently sent emails.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of sent emails to retrieve. Default 10.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todos",
      description: "List the user's todo items.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["pending", "completed", "all"],
            description: "Filter by status. Default: pending.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_todo",
      description:
        "Update a todo item - mark it complete/incomplete or change its text. Requires the todo ID from list_todos.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Todo ID" },
          text: {
            type: "string",
            description: "New text for the todo (optional)",
          },
          is_completed: {
            type: "boolean",
            description: "Mark as complete (true) or incomplete (false)",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_todo",
      description: "Delete a todo item permanently.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Todo ID" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_meetings",
      description:
        "List the user's meetings. Use to show upcoming or recent meetings with full details.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["upcoming", "past", "all"],
            description: "Filter meetings. Default: upcoming.",
          },
          limit: {
            type: "number",
            description: "Max meetings to return. Default 10.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_meeting",
      description:
        "Edit an existing meeting. Requires meeting ID from list_meetings.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Meeting ID" },
          title: { type: "string", description: "New title" },
          start_time: {
            type: "string",
            description: "New start time (ISO 8601 in user's local timezone)",
          },
          end_time: {
            type: "string",
            description: "New end time (ISO 8601 in user's local timezone)",
          },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Updated attendee email list",
          },
          description: { type: "string", description: "Updated description" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_meeting",
      description:
        "Delete/cancel a meeting. Requires meeting ID from list_meetings.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Meeting ID" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_drafts",
      description: "List the user's saved email drafts.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of drafts to return. Default 10.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_draft",
      description: "Delete a draft email. Requires draft ID from list_drafts.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Draft ID" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_follow_up",
      description:
        "Set a follow-up reminder to check back on an email or contact. Use when the user says 'follow up in X days', 'remind me to check on this', or 'set a follow-up'. The remind_at date is when the assistant will remind the user.",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description: "ID of the email to follow up on (optional if using recipient_email + subject directly).",
          },
          recipient_email: {
            type: "string",
            description: "Email address of the person to follow up with.",
          },
          subject: {
            type: "string",
            description: "Subject or topic of the follow-up.",
          },
          remind_at: {
            type: "string",
            description: "ISO 8601 date-time for when to send the reminder (e.g. '2026-05-10T09:00:00').",
          },
        },
        required: ["recipient_email", "subject", "remind_at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_follow_ups",
      description: "List pending follow-up reminders.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "archive_email",
      description: "Archive an email (removes it from the inbox view).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Email ID to archive" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_cleanup",
      description:
        "Start a cleanup plan for the inbox: Tabellar reads the last week of inbox mail and proposes replies, todos, meetings and one archive of what needs nothing, asks the user anything it cannot decide, and runs only what the user approves. Use it when the user asks to clean up, clear, triage, go through or deal with their inbox or several emails at once. Takes no arguments; the plan appears under your answer.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_reply_options",
      description:
        "Use this tool ANY time the user needs to choose between options  -  this is the ONLY allowed way to present choices. Use cases: (1) reply approach is unclear  -  present 2-4 reply stances; (2) multiple emails match the user's description  -  present them so user can pick which one to act on; (3) alternative meeting times  -  present specific free time slots; (4) any other ambiguity. NEVER present options in your text reply. Labels should be short (e.g. subject line or action). Descriptions should be one sentence. Do NOT call send_email, reply_to_email, or save_draft until the user picks.",
      parameters: {
        type: "object",
        properties: {
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description:
                    "Short label, e.g. 'Accept', 'Decline', 'Ask for more time'",
                },
                description: {
                  type: "string",
                  description: "One sentence: what this reply would say",
                },
              },
              required: ["label", "description"],
            },
            description: "2-4 reply options",
          },
          recommended: {
            type: "number",
            description: "0-based index of the recommended option",
          },
          context: {
            type: "string",
            description: "One sentence explaining what the email is about",
          },
        },
        required: ["options", "recommended"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_email_thread",
      description:
        "Fetch all emails in a conversation thread by thread_id. Use after get_email returns a thread_id to see the full back-and-forth history. Returns emails ordered oldest-first.",
      parameters: {
        type: "object",
        properties: {
          thread_id: {
            type: "string",
            description: "The thread_id from a get_email result",
          },
        },
        required: ["thread_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tags",
      description:
        "List all custom tags/categories the user has created. Use before apply_tag or remove_tag to get valid tag slugs.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_tag",
      description: "Create a new custom tag/category for labeling emails.",
      parameters: {
        type: "object",
        properties: {
          display_name: {
            type: "string",
            description: "Human-readable tag name, e.g. 'Work Projects'",
          },
          slug: {
            type: "string",
            description:
              "URL-safe lowercase identifier with hyphens, e.g. 'work-projects'",
          },
          color: {
            type: "string",
            description: "Hex color code, e.g. '#3b82f6'. Default '#6b7280'.",
          },
        },
        required: ["display_name", "slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_tag",
      description:
        "Apply a tag/label to an email. Use list_tags first to get valid slugs.",
      parameters: {
        type: "object",
        properties: {
          email_id: { type: "string", description: "The email UUID" },
          tag_slug: {
            type: "string",
            description: "The tag slug to apply (from list_tags)",
          },
        },
        required: ["email_id", "tag_slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_tag",
      description: "Remove a tag/label from an email.",
      parameters: {
        type: "object",
        properties: {
          email_id: { type: "string", description: "The email UUID" },
          tag_slug: { type: "string", description: "The tag slug to remove" },
        },
        required: ["email_id", "tag_slug"],
      },
    },
  },
];

// Who an email is from, as the assistant's tools describe it. Sent mail has
// no sender; without this the model takes the user's own mail for incoming.
export function who(e: any): string {
  return (e.label_ids ?? []).includes("SENT") ? `Sent by the user to: ${e.recipients ?? ""}` : `From: ${e.sender || e.sender_email}`;
}

export async function chatWithAssistant(
  context: ChatContext,
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  db?: Db,
  userId?: string,
): Promise<{ reply: string; tool_calls: ChatToolCall[] }> {
  requireModel();
  const systemPrompt = buildChatSystemPrompt(context);
  const allToolCalls: ChatToolCall[] = [];

  let messages: {
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[] = [
    { role: "system", content: systemPrompt },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: message },
  ];

  const callAPI = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Chat request timed out after ${modelTimeoutMs() / 1000}s`)),
          modelTimeoutMs(),
        );
      });
      let res: Response;
      try {
        res = await Promise.race([
          chatCompletion(
            {
              messages: messages as Parameters<typeof chatCompletion>[0]["messages"],
              tools: CHAT_TOOLS as Parameters<typeof chatCompletion>[0]["tools"],
              temperature: 0.5,
              max_tokens: 2048,
            },
            controller.signal,
          ),
          timeoutPromise,
        ]);
        clearTimeout(timeoutId);
      } catch {
        clearTimeout(timeoutId);
        controller.abort();
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }

      if (res.status === 429) {
        const rawRetry = parseInt(res.headers.get("retry-after") ?? "5", 10);
        const waitMs = Math.min(
          isNaN(rawRetry) || rawRetry > 3600 ? 5000 : rawRetry * 1000,
          10_000,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (res.status === 500 || res.status === 503) {
        const backoff = Math.min(5 * (attempt + 1), 20);
        await new Promise((r) => setTimeout(r, backoff * 1000));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(
          `Chat API error (${res.status}): ${errText.slice(0, 300)}`,
        );
      }

      return await res.json();
    }
    throw new Error("Chat API: max retries exceeded");
  };

  // Tool-calling loop  -  up to 8 rounds for complex multi-step tasks.
  for (let round = 0; round < 8; round++) {
    const data = await callAPI();
    const choice = data.choices?.[0];
    const assistantMsg = choice?.message;

    if (
      choice?.finish_reason !== "tool_calls" ||
      !assistantMsg?.tool_calls?.length
    ) {
      const reply = stripThinkTags(assistantMsg?.content ?? "");
      if (!reply.trim()) {
        // Empty content from a non-tool-call response  -  treat as transient, retry via callAPI
        messages.push({ role: "user", content: "Please respond." });
        continue;
      }
      return { reply, tool_calls: allToolCalls };
    }

    // Model wants to call tools  -  add assistant message and process each tool
    messages.push(assistantMsg);

    for (const tc of assistantMsg.tool_calls as {
      id: string;
      function: { name: string; arguments: string };
    }[]) {
      const args = (() => {
        try {
          return JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          return {};
        }
      })() as Record<string, unknown>;

      const toolCall: ChatToolCall = {
        name: tc.function?.name as ChatToolCall["name"],
        arguments: args,
      };
      allToolCalls.push(toolCall);

      let toolResult: string;
      if (tc.function?.name === "get_recent_emails" && db && userId) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50);
        const { data: results } = await db
          .from("emails")
          .select(
            "id, subject, sender, sender_email, recipients, label_ids, received_at, snippet, email_processed(summary, category)",
          )
          .eq("user_id", userId)
          .order("received_at", { ascending: false })
          .limit(limit);
        const emails = results ?? [];
        toolResult =
          emails.length > 0
            ? `Here are the ${emails.length} most recent emails:\n` +
              emails
                .map((e: any) => {
                  const p = Array.isArray(e.email_processed)
                    ? e.email_processed[0]
                    : e.email_processed;
                  return `[${e.id}] ${e.received_at?.split("T")[0]} ${who(e)} | ${e.subject} | ${p?.summary ?? e.snippet ?? "(no summary)"} | ${p?.category ?? "unknown"}`;
                })
                .join("\n")
            : "No emails found.";
      } else if (
        tc.function?.name === "search_knowledge_base" &&
        db &&
        userId
      ) {
        const query = ((args.query as string) ?? "").trim();
        const { data: kbResults } = await db
          .from("knowledge_base")
          .select("entity, entity_type, info, importance")
          .eq("user_id", userId)
          .or(`entity.ilike.%${query}%,info.ilike.%${query}%`)
          .order("importance", { ascending: false })
          .limit(15);
        const entries = kbResults ?? [];
        toolResult =
          entries.length > 0
            ? "Knowledge base results:\n" +
              entries
                .map((k: any) => `- ${k.entity} (${k.entity_type}): ${k.info}`)
                .join("\n")
            : `No knowledge base entries found for "${query}".`;
      } else if (tc.function?.name === "lookup_contact" && db && userId) {
        const name = ((args.name as string) ?? "").trim();
        // Search email_memory for sender info
        const { data: memoryResults } = await db
          .from("email_memory")
          .select(
            "sender_email, sender_name, interaction_count, relationship_notes, last_subject",
          )
          .eq("user_id", userId)
          .or(`sender_email.ilike.%${name}%,sender_name.ilike.%${name}%`)
          .order("interaction_count", { ascending: false })
          .limit(5);
        // Also search knowledge_base
        const { data: kbResults } = await db
          .from("knowledge_base")
          .select("entity, entity_type, info")
          .eq("user_id", userId)
          .ilike("entity", `%${name}%`)
          .limit(5);
        const contacts = memoryResults ?? [];
        const knowledge = kbResults ?? [];
        const parts: string[] = [];
        if (contacts.length > 0) {
          parts.push(
            "Contacts found:\n" +
              contacts
                .map(
                  (c: any) =>
                    `- ${c.sender_name || "Unknown"} <${c.sender_email}> (${c.interaction_count} emails)${c.relationship_notes ? ` - ${c.relationship_notes}` : ""}${c.last_subject ? ` | Last email: ${c.last_subject}` : ""}`,
                )
                .join("\n"),
          );
        }
        if (knowledge.length > 0) {
          parts.push(
            "Knowledge base:\n" +
              knowledge
                .map((k: any) => `- ${k.entity} (${k.entity_type}): ${k.info}`)
                .join("\n"),
          );
        }
        toolResult =
          parts.length > 0
            ? parts.join("\n\n")
            : `No contact or knowledge found for "${name}". Check the Contacts section in context, or ask the user for the email address.`;
      } else if (tc.function?.name === "search_emails" && db && userId) {
        const query = ((args.query as string) ?? "").trim();
        const { data: results } = await db
          .from("emails")
          .select(
            "id, subject, sender, sender_email, recipients, label_ids, received_at, snippet, email_processed(summary, category)",
          )
          .eq("user_id", userId)
          .or(
            `subject.ilike.%${query}%,sender.ilike.%${query}%,sender_email.ilike.%${query}%,body_text.ilike.%${query}%`,
          )
          .order("received_at", { ascending: false })
          .limit(20);
        const emails = results ?? [];
        toolResult =
          emails.length > 0
            ? "Found emails:\n" +
              emails
                .map((e: any) => {
                  const p = Array.isArray(e.email_processed)
                    ? e.email_processed[0]
                    : e.email_processed;
                  return `[${e.id}] ${e.received_at?.split("T")[0]} ${who(e)} | ${e.subject} | ${p?.summary ?? e.snippet ?? ""}`;
                })
                .join("\n")
            : `No emails found matching "${query}". The user's inbox may not be fully synced - let them know to click the reload button to sync newer emails, or try a shorter/different search term.`;
      } else if (
        tc.function?.name === "search_emails" &&
        (!db || !userId)
      ) {
        const query = ((args.query as string) ?? "").toLowerCase();
        const matches = (context.recentEmails ?? [])
          .filter(
            (e) =>
              e.subject.toLowerCase().includes(query) ||
              (e.sender?.toLowerCase() ?? "").includes(query) ||
              e.sender_email.toLowerCase().includes(query) ||
              (e.summary?.toLowerCase() ?? "").includes(query),
          )
          .slice(0, 10);
        toolResult =
          matches.length > 0
            ? "Found emails:\n" +
              matches
                .map(
                  (e) =>
                    `[${e.id}] ${e.date.split("T")[0]} From: ${e.sender || e.sender_email} | ${e.subject} | ${e.summary ?? ""}`,
                )
                .join("\n")
            : "No emails found matching that query.";
      } else if (
        tc.function?.name === "search_emails_by_sender" &&
        db &&
        userId
      ) {
        const sender = ((args.sender as string) ?? "").trim();
        const { data: results } = await db
          .from("emails")
          .select(
            "id, subject, sender, sender_email, recipients, label_ids, received_at, snippet, email_processed(summary)",
          )
          .eq("user_id", userId)
          .or(`sender_email.ilike.%${sender}%,sender.ilike.%${sender}%`)
          .order("received_at", { ascending: false })
          .limit(20);
        const emails = results ?? [];
        toolResult =
          emails.length > 0
            ? `Found ${emails.length} emails from "${sender}":\n` +
              emails
                .map((e: any) => {
                  const p = Array.isArray(e.email_processed)
                    ? e.email_processed[0]
                    : e.email_processed;
                  return `[${e.id}] ${e.received_at?.split("T")[0]} ${who(e)} | ${e.subject} | ${p?.summary ?? e.snippet ?? ""}`;
                })
                .join("\n")
            : `No emails found from "${sender}". The inbox may not be fully synced - suggest the user click the reload button to fetch newer emails.`;
      } else if (
        tc.function?.name === "search_emails_by_date" &&
        db &&
        userId
      ) {
        const startDate = (args.start_date as string) ?? "";
        const endDate =
          (args.end_date as string) ?? new Date().toISOString().split("T")[0];
        const { data: results } = await db
          .from("emails")
          .select(
            "id, subject, sender, sender_email, recipients, label_ids, received_at, snippet, email_processed(summary)",
          )
          .eq("user_id", userId)
          .gte("received_at", `${startDate}T00:00:00`)
          .lte("received_at", `${endDate}T23:59:59`)
          .order("received_at", { ascending: false })
          .limit(20);
        const emails = results ?? [];
        toolResult =
          emails.length > 0
            ? `Found ${emails.length} emails between ${startDate} and ${endDate}:\n` +
              emails
                .map((e: any) => {
                  const p = Array.isArray(e.email_processed)
                    ? e.email_processed[0]
                    : e.email_processed;
                  return `[${e.id}] ${e.received_at?.split("T")[0]} ${who(e)} | ${e.subject} | ${p?.summary ?? e.snippet ?? ""}`;
                })
                .join("\n")
            : `No emails found between ${startDate} and ${endDate}.`;
      } else if (
        tc.function?.name === "search_emails_by_sender_and_date" &&
        db &&
        userId
      ) {
        const sender = ((args.sender as string) ?? "").trim();
        const startDate = (args.start_date as string) ?? "";
        const endDate =
          (args.end_date as string) ?? new Date().toISOString().split("T")[0];
        const { data: results } = await db
          .from("emails")
          .select(
            "id, subject, sender, sender_email, recipients, label_ids, received_at, snippet, email_processed(summary)",
          )
          .eq("user_id", userId)
          .or(`sender_email.ilike.%${sender}%,sender.ilike.%${sender}%`)
          .gte("received_at", `${startDate}T00:00:00`)
          .lte("received_at", `${endDate}T23:59:59`)
          .order("received_at", { ascending: false })
          .limit(20);
        const emails = results ?? [];
        toolResult =
          emails.length > 0
            ? `Found ${emails.length} emails from "${sender}" between ${startDate} and ${endDate}:\n` +
              emails
                .map((e: any) => {
                  const p = Array.isArray(e.email_processed)
                    ? e.email_processed[0]
                    : e.email_processed;
                  return `[${e.id}] ${e.received_at?.split("T")[0]} ${who(e)} | ${e.subject} | ${p?.summary ?? e.snippet ?? ""}`;
                })
                .join("\n")
            : `No emails found from "${sender}" between ${startDate} and ${endDate}.`;
      } else if (tc.function?.name === "get_email" && db && userId) {
        const id = (args.id as string) ?? "";
        const { data: email } = await db
          .from("emails")
          .select(
            "id, subject, sender, sender_email, recipients, received_at, body_text, snippet, thread_id, gmail_id, label_ids, email_processed(summary, category)",
          )
          .eq("user_id", userId)
          .eq("id", id)
          .maybeSingle();
        if (!email) {
          toolResult = `Email with ID "${id}" not found.`;
        } else {
          const p = Array.isArray((email as any).email_processed)
            ? (email as any).email_processed[0]
            : (email as any).email_processed;
          const body =
            (email as any).body_text ?? (email as any).snippet ?? "(no body)";
          toolResult = `Email ID: ${(email as any).id}\nDate: ${(email as any).received_at?.split("T")[0]}\n${who(email)}\nTo: ${(email as any).recipients ?? ""}\nSubject: ${(email as any).subject}\nCategory: ${p?.category ?? "unknown"}\nSummary: ${p?.summary ?? ""}\n\nBody:\n${body.slice(0, 3000)}`;
        }
      } else if (
        tc.function?.name === "get_sent_emails" &&
        db &&
        userId
      ) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50);
        const { data: results } = await db
          .from("emails")
          .select(
            "id, subject, sender, sender_email, recipients, received_at, snippet",
          )
          .eq("user_id", userId)
          .contains("label_ids", ["SENT"])
          .order("received_at", { ascending: false })
          .limit(limit);
        const emails = results ?? [];
        toolResult =
          emails.length > 0
            ? `${emails.length} sent emails:\n` +
              emails
                .map(
                  (e: any) =>
                    `[${e.id}] ${e.received_at?.split("T")[0]} To: ${e.recipients ?? ""} | ${e.subject}`,
                )
                .join("\n")
            : "No sent emails found.";
      } else if (tc.function?.name === "list_todos" && db && userId) {
        const filter = (args.filter as string) ?? "pending";
        let query = db
          .from("todos")
          .select("id, text, is_completed, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50);
        if (filter === "pending") query = query.eq("is_completed", false);
        else if (filter === "completed") query = query.eq("is_completed", true);
        const { data: todos } = await query;
        const items = todos ?? [];
        toolResult =
          items.length > 0
            ? `${items.length} todos (${filter}):\n` +
              items
                .map(
                  (t: any) =>
                    `[${t.id}] [${t.is_completed ? "done" : "pending"}] ${t.text}`,
                )
                .join("\n")
            : `No ${filter} todos found.`;
      } else if (tc.function?.name === "update_todo" && db && userId) {
        const id = (args.id as string) ?? "";
        const updates: Record<string, unknown> = {};
        if (args.text !== undefined) updates.text = args.text;
        if (args.is_completed !== undefined)
          updates.is_completed = args.is_completed;
        if (Object.keys(updates).length === 0) {
          toolResult = "No updates provided.";
        } else {
          const { error } = await db
            .from("todos")
            .update(updates)
            .eq("id", id)
            .eq("user_id", userId);
          toolResult = error
            ? `Failed to update todo: ${error.message}`
            : `Todo updated successfully.`;
        }
      } else if (tc.function?.name === "delete_todo" && db && userId) {
        const id = (args.id as string) ?? "";
        const { error } = await db
          .from("todos")
          .delete()
          .eq("id", id)
          .eq("user_id", userId);
        toolResult = error
          ? `Failed to delete todo: ${error.message}`
          : "Todo deleted.";
      } else if (tc.function?.name === "list_meetings" && db && userId) {
        const filter = (args.filter as string) ?? "upcoming";
        const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50);
        const now = new Date().toISOString();
        let query = db
          .from("meetings")
          .select(
            "id, title, description, start_time, end_time, attendees, location, status",
          )
          .eq("user_id", userId)
          .limit(limit);
        if (filter === "upcoming")
          query = query
            .gte("start_time", now)
            .order("start_time", { ascending: true });
        else if (filter === "past")
          query = query
            .lt("start_time", now)
            .order("start_time", { ascending: false });
        else query = query.order("start_time", { ascending: true });
        const { data: meetings } = await query;
        const items = meetings ?? [];
        toolResult =
          items.length > 0
            ? `${items.length} meetings (${filter}):\n` +
              items
                .map(
                  (m: any) =>
                    `[${m.id}] ${m.start_time?.split("T")[0]} ${m.start_time?.split("T")[1]?.slice(0, 5) ?? ""} - ${m.title}${m.attendees?.length ? ` | Attendees: ${m.attendees.join(", ")}` : ""}${m.location ? ` | Location: ${m.location}` : ""}${m.status !== "confirmed" ? ` | Status: ${m.status}` : ""}`,
                )
                .join("\n")
            : `No ${filter} meetings found.`;
      } else if (tc.function?.name === "update_meeting" && db && userId) {
        const id = (args.id as string) ?? "";
        const updates: Record<string, unknown> = {};
        if (args.title !== undefined) updates.title = args.title;
        if (args.start_time !== undefined) updates.start_time = args.start_time;
        if (args.end_time !== undefined) updates.end_time = args.end_time;
        if (args.attendees !== undefined) updates.attendees = args.attendees;
        if (args.description !== undefined)
          updates.description = args.description;
        if (Object.keys(updates).length === 0) {
          toolResult = "No updates provided.";
        } else {
          const { error } = await db
            .from("meetings")
            .update(updates)
            .eq("id", id)
            .eq("user_id", userId);
          toolResult = error
            ? `Failed to update meeting: ${error.message}`
            : "Meeting updated successfully.";
        }
      } else if (tc.function?.name === "delete_meeting" && db && userId) {
        const id = (args.id as string) ?? "";
        const { error } = await db
          .from("meetings")
          .delete()
          .eq("id", id)
          .eq("user_id", userId);
        toolResult = error
          ? `Failed to delete meeting: ${error.message}`
          : "Meeting deleted.";
      } else if (tc.function?.name === "list_drafts" && db && userId) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50);
        const { data: drafts } = await db
          .from("draft_emails")
          .select("id, subject, to_addresses, body_html, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(limit);
        const items = drafts ?? [];
        toolResult =
          items.length > 0
            ? `${items.length} drafts:\n` +
              items
                .map(
                  (d: any) =>
                    `[${d.id}] ${d.created_at?.split("T")[0]} To: ${Array.isArray(d.to_addresses) ? d.to_addresses.join(", ") : d.to_addresses} | ${d.subject}`,
                )
                .join("\n")
            : "No drafts found.";
      } else if (tc.function?.name === "delete_draft" && db && userId) {
        const id = (args.id as string) ?? "";
        const { error } = await db
          .from("draft_emails")
          .delete()
          .eq("id", id)
          .eq("user_id", userId);
        toolResult = error
          ? `Failed to delete draft: ${error.message}`
          : "Draft deleted.";
      } else if (
        tc.function?.name === "list_follow_ups" &&
        db &&
        userId
      ) {
        const { data: followUps } = await db
          .from("follow_up_reminders")
          .select("id, recipient_email, subject, remind_at, status")
          .eq("user_id", userId)
          .in("status", ["waiting", "pending"])
          .order("remind_at", { ascending: true })
          .limit(20);
        const items = followUps ?? [];
        toolResult =
          items.length > 0
            ? `${items.length} follow-up reminders:\n` +
              items
                .map(
                  (f: any) =>
                    `[${f.id}] "${f.subject}" → ${f.recipient_email} | Remind: ${f.remind_at?.split("T")[0]} | Status: ${f.status}`,
                )
                .join("\n")
            : "No pending follow-up reminders.";
      } else if (tc.function?.name === "archive_email" && db && userId) {
        const id = (args.id as string) ?? "";
        const { data: owned } = await db.from("emails").select("id").eq("id", id).eq("user_id", userId).maybeSingle();
        if (!owned) {
          toolResult = "Failed to archive email: not found.";
        } else {
          const outcome = await act(userId, { kind: "archive", emailId: id, summary: "Archive (asked in chat)", detail: {} }, { ...(await engineSettings(userId)), source: "assistant" });
          toolResult = outcome === "done" ? "Email archived." : outcome === "refused" ? "Not archived: Tabellar is paused." : "Failed to archive the email in the mailbox.";
        }
      } else if (
        tc.function?.name === "get_email_thread" &&
        db &&
        userId
      ) {
        const threadId = (args.thread_id as string) ?? "";
        const { data: threadEmails } = await db
          .from("emails")
          .select(
            "id, subject, sender, sender_email, recipients, label_ids, received_at, body_text, snippet",
          )
          .eq("user_id", userId)
          .eq("thread_id", threadId)
          .order("received_at", { ascending: true })
          .limit(20);
        const emails = threadEmails ?? [];
        toolResult =
          emails.length > 0
            ? `Thread (${emails.length} emails):\n` +
              emails
                .map(
                  (e: any) =>
                    `[${e.id}] ${e.received_at?.split("T")[0]} ${who(e)} | ${e.subject}\n${((e.body_text ?? e.snippet ?? "") as string).slice(0, 500)}`,
                )
                .join("\n---\n")
            : `No emails found for thread_id "${threadId}".`;
      } else if (tc.function?.name === "list_tags" && db && userId) {
        const { data: tags } = await db
          .from("categories")
          .select("id, slug, display_name, color")
          .eq("user_id", userId)
          .order("display_name", { ascending: true });
        const items = tags ?? [];
        toolResult =
          items.length > 0
            ? `${items.length} tags:\n` +
              items
                .map(
                  (t: any) =>
                    `[${t.id}] ${t.display_name} (slug: ${t.slug}, color: ${t.color})`,
                )
                .join("\n")
            : "No tags found. Use create_tag to create one.";
      } else if ((tc.function?.name === "apply_tag" || tc.function?.name === "remove_tag") && db && userId) {
        // As if the user did it in the reader: in Gmail too, and kept as an example.
        const on = tc.function.name === "apply_tag";
        try {
          await applyLabel(userId, String(args.email_id ?? ""), String(args.tag_slug ?? ""), on);
          toolResult = on ? "Label applied to the email." : "Label removed from the email.";
        } catch (e) {
          toolResult = `Failed: ${(e as Error).message}`;
        }
      } else {
        // These tools are executed by the caller (index.ts) after this function returns.
        // Tell the model they succeeded so it confirms in past tense.
        toolResult = `Done. "${tc.function?.name}" executed successfully.`;
      }

      messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
    }
  }

  // Fallback: get final response after tool rounds
  const finalData = await callAPI();
  const finalReply = stripThinkTags(
    finalData.choices?.[0]?.message?.content ?? "",
  );
  return {
    reply: finalReply || "I've completed the requested actions.",
    tool_calls: allToolCalls,
  };
}
