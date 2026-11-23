import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { setEmailFlag } from "@/lib/outcomes";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import EmailDetail from "../EmailDetail";
import SolveAgentButton from "../solve/SolveAgentButton";
import { useSetupState } from "../ModelSetup";
import { Empty, Glyph, KeyHints, Menu, Seg, SkeletonRows, ViewBar, clock, dayLabel } from "../ui";

// The briefing: a short written summary of the mail in a chosen range, then
// what it found in four groups (reply needed, deadlines, crucial, and what
// needs nothing), with today's calendar beside it.

/* eslint-disable @typescript-eslint/no-explicit-any */

interface BriefingEmail {
  subject: string;
  senderName: string;
  sender: string;
  summary: string;
  urgency: "critical" | "high" | "medium";
  deadline?: string | null;
  waitingForReply: boolean;
  tags: string[];
  email_id?: string;
  /** One line: what the sender wants (Auto-Resolve / cloud briefing). */
  signal?: string;
  evidence?: string;
  relationshipHint?: "first-party" | "known-contact" | "stranger" | "auto" | string;
  suggestedAction?: "reply" | "todo" | "meeting" | "archive" | "ignore" | string;
  resolved_at?: string | null;
}

interface DeadlineItem {
  task: string;
  date: string;
  source: string;
}

interface BriefingResult {
  executiveSummary: string;
  // New shape (v2)
  crucial?: BriefingEmail[];
  replyNeeded?: BriefingEmail[];
  deadlines?: BriefingEmail[] | DeadlineItem[];
  nonEssential?: BriefingEmail[];
  // Old shape (v1) kept for backward compat with cached briefings
  topPriority?: BriefingEmail[];
  waitingForReply?: BriefingEmail[];
  stats: {
    total: number;
    // v2 fields
    crucial?: number;
    replyNeeded?: number;
    nonEssential?: number;
    // v1 fields
    critical?: number;
    deadlines?: number;
    waitingOnYou?: number;
    filtered?: number;
  };
  summary?: string;
  actionItems?: string[];
}

type Filter = "all" | "replyNeeded" | "deadlines" | "crucial" | "nonEssential";

interface NormalizedBriefing {
  executiveSummary: string;
  crucial: BriefingEmail[];
  replyNeeded: BriefingEmail[];
  deadlines: BriefingEmail[];
  nonEssential: BriefingEmail[];
  stats: {
    total: number;
    crucial: number;
    replyNeeded: number;
    deadlines: number;
    nonEssential: number;
  };
}


function executiveSummaryIsUsable(s: string | undefined | null): boolean {
  if (!s?.trim()) return false;
  return !s.toLowerCase().includes("unable to generate briefing");
}

/** Strip HTML from cloud summaries so text is readable and not theme-colored by inline styles. */
function briefingExecutiveSummaryDisplay(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n").trim();
  if (!s) return s;
  if (/<[a-z][\s\S]*>/i.test(s)) {
    s = s
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    s = s
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
    s = s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  }
  return noDash(s);
}

function formatDeadlineDate(iso: string) {
  try {
    const parts = iso.split("T")[0].split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch { return iso; }
}

function daysUntil(iso: string): number {
  try {
    const parts = iso.split("T")[0].split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    // The model sometimes uses the wrong year; try bumping by 1 year if far in the past
    if (diff <= -300) {
      const corrected = new Date(parts[0] + 1, parts[1] - 1, parts[2]);
      return Math.round((corrected.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    }
    return diff;
  } catch { return 999; }
}

/** Convert either new or old briefing shape into a unified NormalizedBriefing */
function normalizeBriefing(b: BriefingResult, followUps: FollowUp[]): NormalizedBriefing {
  // New shape: has crucial array
  if (Array.isArray((b as any).crucial)) {
    let crucial: BriefingEmail[] = (b as any).crucial ?? [];
    let replyNeededAI: BriefingEmail[] = (b as any).replyNeeded ?? [];
    let deadlines: BriefingEmail[] = Array.isArray((b as any).deadlines)
      ? ((b as any).deadlines as any[]).filter((d: any) => d.subject !== undefined)
      : [];
    let nonEssential: BriefingEmail[] = (b as any).nonEssential ?? [];

    // Rescue: if the model put everything in nonEssential, reclassify by sender/urgency
    if (crucial.length === 0 && replyNeededAI.length === 0 && deadlines.length === 0 && nonEssential.length > 0) {
      const rescued: BriefingEmail[] = [];
      const kept: BriefingEmail[] = [];
      for (const e of nonEssential) {
        const isAutoSender = /no.?reply|noreply|mailer-daemon|donotreply|@.*\.(marketing|promo|newsletter|bulk)/i.test(e.sender ?? "");
        if (!isAutoSender) {
          rescued.push(e);
        } else {
          kept.push(e);
        }
      }
      if (rescued.length > 0) {
        crucial = [...crucial, ...rescued];
        nonEssential = kept;
      }
    } else {
      // Move critical/high urgency items out of nonEssential even in partial results
      const misclassified = nonEssential.filter((e) => e.urgency === "critical" || e.urgency === "high");
      if (misclassified.length > 0) {
        crucial = [...crucial, ...misclassified];
        nonEssential = nonEssential.filter((e) => e.urgency !== "critical" && e.urgency !== "high");
      }
    }

    // Promote crucial emails that actually need a reply → replyNeeded
    const promoteToReply = crucial.filter((e) => e.waitingForReply);
    if (promoteToReply.length > 0) {
      replyNeededAI = [...replyNeededAI, ...promoteToReply];
      crucial = crucial.filter((e) => !e.waitingForReply);
    }

    // Promote crucial emails with a deadline → deadlines
    const promoteToDeadline = crucial.filter((e) => e.deadline);
    if (promoteToDeadline.length > 0) {
      deadlines = [...deadlines, ...promoteToDeadline];
      crucial = crucial.filter((e) => !e.deadline);
    }

    // Merge follow-ups into replyNeeded as synthetic BriefingEmail cards
    const followUpCards: BriefingEmail[] = followUps.map((f) => ({
      subject: f.subject,
      senderName: f.sender,
      sender: f.sender_email ?? f.sender,
      summary: `Sent ${Math.floor((Date.now() - new Date(f.received_at).getTime()) / 86400000)} days ago with no reply received.`,
      urgency: "medium" as const,
      deadline: null,
      waitingForReply: true,
      tags: ["NO_REPLY"],
      email_id: f.id,
    }));
    const replyNeeded = [...replyNeededAI, ...followUpCards];

    // Stats are always derived from array lengths so counts are internally consistent.
    return {
      executiveSummary: b.executiveSummary,
      crucial,
      replyNeeded,
      deadlines,
      nonEssential,
      stats: {
        total: crucial.length + replyNeeded.length + deadlines.length + nonEssential.length,
        crucial: crucial.length,
        replyNeeded: replyNeeded.length,
        deadlines: deadlines.length,
        nonEssential: nonEssential.length,
      },
    };
  }

  // Old shape (v1): has topPriority
  const topPriority: BriefingEmail[] = (b as any).topPriority ?? [];
  const oldWaiting: BriefingEmail[] = (b as any).waitingForReply ?? [];
  const oldDeadlineItems: DeadlineItem[] = Array.isArray((b as any).deadlines)
    ? ((b as any).deadlines as any[]).filter((d: any) => d.task !== undefined)
    : [];

  const replyNeededFromTop = topPriority.filter((e) => e.waitingForReply);
  const deadlinesFromTop = topPriority.filter((e) => !e.waitingForReply && e.deadline);
  const crucial = topPriority.filter((e) => !e.waitingForReply && !e.deadline);

  const topIds = new Set(topPriority.map((e) => e.email_id).filter(Boolean));
  const extraWaiting = oldWaiting.filter((e) => !e.email_id || !topIds.has(e.email_id));

  // Convert DeadlineItem rows that aren't already represented in deadlinesFromTop
  const deadlineEmailsFromItems: BriefingEmail[] = oldDeadlineItems
    .filter((d) => !deadlinesFromTop.find((e) => e.deadline === d.date))
    .map((d) => ({
      subject: d.task,
      senderName: d.source,
      sender: d.source,
      summary: `Due ${d.date}`,
      urgency: "medium" as const,
      deadline: d.date,
      waitingForReply: false,
      tags: ["DEADLINE"],
    }));

  const followUpCards: BriefingEmail[] = followUps.map((f) => ({
    subject: f.subject,
    senderName: f.sender,
    sender: f.sender_email ?? f.sender,
    summary: `Sent ${Math.floor((Date.now() - new Date(f.received_at).getTime()) / 86400000)} days ago with no reply received.`,
    urgency: "medium" as const,
    deadline: null,
    waitingForReply: true,
    tags: ["NO_REPLY"],
    email_id: f.id,
  }));

  const replyNeeded = [...replyNeededFromTop, ...extraWaiting, ...followUpCards];
  const deadlines = [...deadlinesFromTop, ...deadlineEmailsFromItems];

  return {
    executiveSummary: b.executiveSummary,
    crucial,
    replyNeeded,
    deadlines,
    nonEssential: [],
    stats: {
      total: crucial.length + replyNeeded.length + deadlines.length,
      crucial: crucial.length,
      replyNeeded: replyNeeded.length,
      deadlines: deadlines.length,
      nonEssential: 0,
    },
  };
}

interface FollowUp {
  id: string;
  subject: string;
  sender: string;
  sender_email?: string;
  received_at: string;
  thread_id?: string;
}

const URGENCY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2 };

// ── Topic grouping helpers ─────────────────────────────────────────────────

function normalizeSubject(s: string): string {
  return s.replace(/^(re|fwd?|fw)(\[\d+\])?:\s*/gi, "").trim().toLowerCase();
}

function fuzzyMatchBriefing(a: string, b: string): boolean {
  const stop = new Set(["the", "a", "an", "to", "and", "or", "of", "in", "on", "for", "is", "it", "this", "that"]);
  const words = (s: string) =>
    new Set(s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !stop.has(w)) ?? []);
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return false;
  const overlap = Array.from(wa).filter((w) => wb.has(w)).length;
  return overlap / Math.min(wa.size, wb.size) >= 0.75;
}

function groupByTopic(cards: BriefingEmail[]): BriefingEmail[][] {
  const groups: BriefingEmail[][] = [];
  for (const card of cards) {
    const normSub = normalizeSubject(card.subject ?? "");
    const existing = groups.find((g) => {
      const gs = normalizeSubject(g[0].subject ?? "");
      return gs === normSub || (normSub.length > 4 && gs.length > 4 && fuzzyMatchBriefing(gs, normSub));
    });
    if (existing) existing.push(card);
    else groups.push([card]);
  }
  return groups;
}

function noDash(s: string): string {
  return s.replace(/\u2014/g, ", ");
}

function senderOf(e: BriefingEmail): string {
  const raw = e.senderName && e.senderName !== "null" ? e.senderName : e.sender && e.sender !== "null" ? e.sender : "";
  return raw.replace(/<.*>/, "").replace(/"/g, "").trim();
}

// The quiet words at the right of an item: when it is due, how urgent it is.
function metaOf(e: BriefingEmail): { text: string; soon: boolean } {
  const parts: string[] = [];
  if (e.deadline) parts.push(`Due ${formatDeadlineDate(e.deadline)}`);
  else if (e.tags?.includes("NO_REPLY")) parts.push("No reply yet");
  else if (e.urgency === "critical") parts.push("Critical");
  else if (e.urgency === "high") parts.push("High");
  for (const tag of e.tags ?? []) {
    if (!["REPLY_NEEDED", "DEADLINE", "NO_REPLY"].includes(tag)) parts.push(tag.replace(/_/g, " ").toLowerCase());
  }
  return { text: parts.join(", "), soon: !!e.deadline && daysUntil(e.deadline) <= 1 };
}

// One finding: who and what on the first line, the signal on the second, and
// the suggested next step on the right.
function ItemRow({
  email,
  need,
  resolved,
  onOpen,
  onReply,
  onDismiss,
}: {
  email: BriefingEmail;
  need?: boolean;
  resolved?: boolean;
  onOpen?: () => void;
  onReply?: () => void;
  onDismiss?: () => void;
}) {
  const meta = metaOf(email);
  const line = noDash(email.signal?.trim() || email.summary || "");
  return (
    <div
      className="row2 group grid grid-cols-[26px_minmax(0,1fr)_auto] items-baseline gap-y-[3px]"
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (e) => e.key === "Enter" && e.target === e.currentTarget && onOpen() : undefined}
    >
      <span className="row-span-2 grid justify-center self-start pt-px">
        <Glyph state={resolved ? "done" : need ? "need" : "filed"} />
      </span>
      <div className="flex min-w-0 items-baseline gap-2">
        <b className={`max-w-[45%] flex-none truncate ${resolved ? "font-normal text-ink3" : "font-semibold text-ink"}`}>{senderOf(email) || "Unknown sender"}</b>
        <span className={`truncate ${resolved ? "text-ink3" : "text-ink2"}`}>{email.subject || "(no subject)"}</span>
      </div>
      <span className={`whitespace-nowrap pl-3 text-right text-xs ${meta.soon && !resolved ? "font-medium text-warn" : "text-ink3"}`}>{resolved ? "Resolved" : meta.text}</span>
      <p className="truncate text-ink3" title={noDash(email.summary || "")}>
        {line}
      </p>
      <span className="flex items-center justify-end gap-3 whitespace-nowrap pl-3">
        {onDismiss && (
          <button className="link invisible group-focus-within:visible group-hover:visible" onClick={(e) => (e.stopPropagation(), onDismiss())}>
            Dismiss
          </button>
        )}
        {onReply && !resolved ? (
          <button className="link" onClick={(e) => (e.stopPropagation(), onReply())}>
            Reply
          </button>
        ) : onOpen ? (
          <button className="link" onClick={(e) => (e.stopPropagation(), onOpen())}>
            Open
          </button>
        ) : null}
      </span>
    </div>
  );
}

// Emails on one topic: the most urgent stands for the rest until expanded.
function Thread({ group, row }: { group: BriefingEmail[]; row: (e: BriefingEmail) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...group].sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3));
  return (
    <>
      {row(sorted[0])}
      {expanded && sorted.slice(1).map(row)}
      {sorted.length > 1 && (
        <button type="button" className="link mb-1 ml-10 mt-1.5 block" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show only the first" : `${sorted.length - 1} more on this thread`}
        </button>
      )}
    </>
  );
}

function Section({ title, count, need, children }: { title: string; count: number; need?: boolean; children: ReactNode }) {
  return (
    <section className="pt-5">
      <h2 className="label flex items-baseline gap-1.5 px-5 pb-1">
        {title}
        <span className={need ? "count-need" : "font-normal"}>{count.toLocaleString()}</span>
      </h2>
      {children}
    </section>
  );
}

// Today's calendar: meetings Tabellar tracks and Google Calendar events.
function Schedule({ items }: { items: any[] }) {
  return (
    <>
      <h2 className="label flex items-baseline gap-1.5">
        Today
        <span className="font-normal">{new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</span>
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-ink3">Nothing on your calendar today.</p>
      ) : (
        <ul className="mt-1">
          {items.map((m) => (
            <li key={m.id} className="grid grid-cols-[46px_minmax(0,1fr)] gap-x-2 border-b border-line-soft py-2 last:border-0">
              <time className="pt-px text-xs text-ink3">{m.allDay ? "All day" : m.start ? clock(m.start) : ""}</time>
              <div className="min-w-0">
                <p className="truncate text-ink">{m.title}</p>
                <p className="truncate text-xs text-ink3">
                  {[m.end && !m.allDay ? `to ${clock(m.end)}` : "", m.status !== "confirmed" ? "proposed" : "", m.location || "", m.attendees?.length ? `${m.attendees.slice(0, 2).join(", ")}${m.attendees.length > 2 ? ` and ${m.attendees.length - 2} more` : ""}` : ""]
                    .filter(Boolean)
                    .join(", ")}
                </p>
                {m.meetingLink && (
                  <a href={m.meetingLink} target="_blank" rel="noopener noreferrer" className="link">
                    Join the call
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// The briefing's shape while it loads: a paragraph, then a group of items.
function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="pt-6">
      <div className="max-w-[68ch] space-y-2.5 px-5">
        <span className="skel block h-3 w-full" />
        <span className="skel block h-3 w-[94%]" />
        <span className="skel block h-3 w-[62%]" />
      </div>
      <div className="px-5 pb-1 pt-8">
        <span className="skel block h-2.5 w-24" />
      </div>
      <SkeletonRows count={3} tall />
      <div className="px-5 pb-1 pt-6">
        <span className="skel block h-2.5 w-20" />
      </div>
      <SkeletonRows count={3} tall />
    </div>
  );
}

type BriefingScope = "today_new" | "past_2_days" | "past_week" | "all_recent";

const BRIEFING_SCOPE_OPTIONS: { id: BriefingScope; label: string }[] = [
  { id: "today_new", label: "Today" },
  { id: "past_2_days", label: "Last 2 days" },
  { id: "past_week", label: "Last 7 days" },
  { id: "all_recent", label: "Latest 40 emails" },
];

export default function BriefingView() {
  const { state: setup } = useSetupState();
  const writer = setup?.model;
  const {
    user,
    profile,
    updateProfile,
    getViewCache,
    setViewCache,
    invalidateViewCache,
    briefingVersion,
    briefingRegenerating,
    requestBriefingRegeneration,
    openCompose,
    addToast,
    setView,
  } = useApp();
  const supabase = createClient();
  const [briefing, setBriefing] = useState<BriefingResult | null>(null);
  const [briefingAt, setBriefingAt] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<any | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [nonEssentialExpanded, setNonEssentialExpanded] = useState(false);
  const [importantExpanded, setImportantExpanded] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(`tabellar_dismissed_briefing_${user.id}`);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
  const generateBriefingOnDemandRef = useRef<(() => void) | null>(null);
  const validScopes = BRIEFING_SCOPE_OPTIONS.map((o) => o.id);
  const rawScope = profile?.briefing_scope ?? "today_new";
  const activeScope: BriefingScope = validScopes.includes(rawScope as BriefingScope) ? (rawScope as BriefingScope) : "today_new";
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());

  // A regeneration that ends without a new briefing has failed.
  const [failed, setFailed] = useState(false);
  const wasRegenerating = useRef(false);
  const versionAtStart = useRef(briefingVersion);
  useEffect(() => {
    if (briefingRegenerating && !wasRegenerating.current) {
      versionAtStart.current = briefingVersion;
      setFailed(false);
    }
    if (!briefingRegenerating && wasRegenerating.current) setFailed(briefingVersion === versionAtStart.current);
    wasRegenerating.current = briefingRegenerating;
  }, [briefingRegenerating, briefingVersion]);

  const saveScope = useCallback(async (scope: BriefingScope) => {
    updateProfile({ briefing_scope: scope });
    await supabase.from("profiles").update({ briefing_scope: scope }).eq("id", user.id);
    // Clear stale cache so the user sees "generating..." instead of the old briefing
    invalidateViewCache("briefing");
    try { localStorage.removeItem(`tabellar_briefing_cache_${user.id}`); } catch { /* ignore */ }
    setBriefing(null);
    setBriefingAt(null);
    // Pass scope explicitly so the API call uses the correct scope even if locked
    void requestBriefingRegeneration(scope);
  }, [supabase, user.id, updateProfile, invalidateViewCache, requestBriefingRegeneration]);

  const isFromToday = (ts: number | null | undefined): boolean => {
    if (!ts) return false;
    const d = new Date(ts);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  };

  const briefingIsEmpty = (data: any) => {
    const total = (data?.crucial?.length ?? 0) + (data?.replyNeeded?.length ?? 0) +
      (data?.deadlines?.length ?? 0) + (data?.nonEssential?.length ?? 0);
    return total === 0;
  };

  const loadCachedBriefing = useCallback(async () => {
    const currentScope = profile?.briefing_scope ?? "today_new";
    // If profile has no last_briefing_at the DB was cleared; local cache is unverified.
    const dbHasBriefing = Boolean(profile?.last_briefing_at);

    const memCached = getViewCache("briefing");
    if (memCached) {
      const memScope = (memCached as any).scope ?? null;
      const scopeMismatch = memScope && memScope !== currentScope;
      if (!scopeMismatch && !briefingIsEmpty(memCached.data)) {
        setBriefing(memCached.data);
        setBriefingAt(memCached.at);
        setLoading(false);
        const cachedTs = memCached.at ? new Date(memCached.at).getTime() : null;
        if (!isFromToday(cachedTs) || !dbHasBriefing) generateBriefingOnDemandRef.current?.();
        return;
      }
      // Scope changed or empty - fall through to get fresh data
    }

    try {
      const cached = localStorage.getItem(`tabellar_briefing_cache_${user.id}`);
      if (cached) {
        const { data, ts, scope: cachedScope } = JSON.parse(cached);
        const scopeMismatch = cachedScope && cachedScope !== currentScope;
        if (data?.executiveSummary !== undefined && !scopeMismatch && !briefingIsEmpty(data)) {
          const at = ts ? new Date(ts).toISOString() : null;
          setBriefing(data);
          if (at) setBriefingAt(at);
          setViewCache("briefing", { data, at, scope: cachedScope } as any);
          setLoading(false);
          // If DB has no briefing, treat local copy as unverified and regenerate
          if (!isFromToday(ts) || !dbHasBriefing) generateBriefingOnDemandRef.current?.();
          return;
        }
      }
    } catch { /* ignore */ }

    try {
      const { data: row } = await supabase
        .from("profiles")
        .select("last_briefing, last_briefing_at")
        .eq("id", user.id)
        .single();
      if (row?.last_briefing) {
        setBriefing(row.last_briefing as unknown as BriefingResult);
        setBriefingAt(row.last_briefing_at ?? null);
        setViewCache("briefing", { data: row.last_briefing, at: row.last_briefing_at ?? null, scope: currentScope } as any);
        const dbTs = row.last_briefing_at ? new Date(row.last_briefing_at).getTime() : null;
        localStorage.setItem(
          `tabellar_briefing_cache_${user.id}`,
          JSON.stringify({ data: row.last_briefing, ts: dbTs ?? Date.now(), scope: currentScope }),
        );
        if (!isFromToday(dbTs)) generateBriefingOnDemandRef.current?.();
      }
    } catch { /* ignore */ }

    setLoading(false);
  }, [user.id, profile?.briefing_scope, profile?.last_briefing_at, supabase, getViewCache, setViewCache]);

  const loadMeetings = useCallback(async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const { data } = await supabase
      .from("meetings")
      .select("*")
      .eq("user_id", user.id)
      .gte("start_time", startOfDay.toISOString())
      .lte("start_time", endOfDay.toISOString())
      .order("start_time", { ascending: true });
    setMeetings((data || []) as any[]);

    // Fetch Google Calendar events for today
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (accessToken) {
        const apiUrl = "/api";
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const today = new Date().toISOString().split("T")[0];
        const res = await fetch(`${apiUrl}/calendar/events?date=${today}&timezone=${encodeURIComponent(timezone)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          const body = await res.json();
          setCalendarEvents((body.events ?? []) as any[]);
        }
      }
    } catch { /* non-critical */ }
  }, [user.id, supabase]);

  generateBriefingOnDemandRef.current = requestBriefingRegeneration;

  useEffect(() => {
    let mounted = true;
    loadCachedBriefing();
    loadMeetings();

    // Load follow-up reminders: sent emails 3-14 days ago with no reply in thread
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    supabase
      .from("emails")
      .select("id, subject, sender, sender_email, received_at, thread_id")
      .eq("user_id", user.id)
      .contains("label_ids", ["SENT"])
      .lt("received_at", threeDaysAgo)
      .gt("received_at", twoWeeksAgo)
      .order("received_at", { ascending: false })
      .limit(50)
      .then(async ({ data: sentEmails }) => {
        if (!sentEmails?.length || !mounted) return;
        const threadIds = [...new Set(sentEmails.map((e: any) => e.thread_id).filter(Boolean))];
        const { data: replies } = await supabase
          .from("emails")
          .select("thread_id, received_at")
          .eq("user_id", user.id)
          .in("thread_id", threadIds)
          .not("label_ids", "cs", '["SENT"]');
        const repliedThreads = new Set((replies ?? []).map((r: any) => r.thread_id));
        const noReply = sentEmails.filter((e: any) => e.thread_id && !repliedThreads.has(e.thread_id));
        if (mounted) setFollowUps(noReply.slice(0, 5) as FollowUp[]);
      });
    return () => { mounted = false; };
  }, [loadCachedBriefing, loadMeetings, user.id]);

  const prevBriefingVersion = useRef(briefingVersion);
  useEffect(() => {
    if (briefingVersion !== prevBriefingVersion.current) {
      prevBriefingVersion.current = briefingVersion;
      invalidateViewCache("briefing");
      loadCachedBriefing();
    }
  }, [briefingVersion, invalidateViewCache, loadCachedBriefing]);

  useEffect(() => {
    if (!briefing) return;
    const norm = normalizeBriefing(briefing, followUps);
    const ids = [
      ...norm.crucial,
      ...norm.replyNeeded,
      ...norm.deadlines,
      ...norm.nonEssential,
    ].map((e) => e.email_id).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    supabase
      .from("emails")
      .select("id, resolved_at")
      .in("id", ids)
      .not("resolved_at", "is", null)
      .then(({ data }) => {
        if (data) setResolvedIds(new Set(data.map((r: any) => r.id)));
      });
  }, [briefing, followUps, supabase]);

  const dismissCard = useCallback((id: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev).add(id);
      localStorage.setItem(`tabellar_dismissed_briefing_${user.id}`, JSON.stringify([...next]));
      return next;
    });
  }, [user.id]);

  const openEmailById = useCallback(async (emailId: string) => {
    const { data } = await supabase
      .from("emails")
      .select("*, email_processed(*)")
      .eq("id", emailId)
      .single();
    if (data) setSelectedEmail(data);
  }, [supabase]);

  // Merge DB meetings and Google Calendar events into a unified sorted list
  const todayScheduleItems = (() => {
    const dbItems = meetings.map((m: any) => ({
      id: `db_${m.id}`,
      title: m.title,
      start: m.start_time,
      end: m.end_time,
      attendees: m.attendees ?? [],
      status: m.status ?? "confirmed",
      source: "tabellar" as const,
      meetingLink: null,
    }));
    // Deduplicate: skip GCal events that Tabellar already tracks via calendar_event_id,
    // or whose title+minute match a DB meeting (fallback for meetings without a GCal ID).
    const dbCalIds = new Set(meetings.map((m: any) => m.calendar_event_id).filter(Boolean));
    const dbKeys = new Set(
      dbItems.map((m) => {
        const t = m.start ? new Date(m.start).getTime() : 0;
        return `${m.title?.toLowerCase()}_${t}`;
      }),
    );
    const calItems = calendarEvents
      .filter((ev: any) => {
        if (dbCalIds.has(ev.id)) return false;
        const t = ev.start ? new Date(ev.start).getTime() : 0;
        const key = `${(ev.title ?? "").toLowerCase()}_${t}`;
        return !dbKeys.has(key);
      })
      .map((ev: any) => ({ ...ev, id: `cal_${ev.id}`, source: "google_calendar" as const }));
    return [...dbItems, ...calItems].sort((a, b) => {
      const ta = a.start ? new Date(a.start).getTime() : 0;
      const tb = b.start ? new Date(b.start).getTime() : 0;
      return ta - tb;
    });
  })();

  const normalized = briefing ? normalizeBriefing(briefing, followUps) : null;

  // Apply dismissals
  const filterDismissed = (cards: BriefingEmail[]) =>
    cards.filter((e) => !e.email_id || !dismissedIds.has(e.email_id));

  const displayCrucial = normalized
    ? [...filterDismissed(normalized.crucial)].sort(
        (a, b) => (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3),
      )
    : [];
  const displayReplyNeeded = normalized ? filterDismissed(normalized.replyNeeded) : [];
  const displayDeadlines = normalized ? filterDismissed(normalized.deadlines).filter((e) => {
    if (!e.deadline) return true;
    const days = daysUntil(e.deadline);
    return days !== 999 && days <= 365;
  }) : [];
  const displayNonEssential = normalized ? filterDismissed(normalized.nonEssential) : [];

  // Split crucial by urgency tier
  const crucialsHigh = displayCrucial.filter((e) => e.urgency === "critical" || e.urgency === "high");
  const crucialsImportant = displayCrucial.filter((e) => e.urgency === "medium");

  // Split reply needed: incoming (needs reply) vs outbound follow-ups (no reply yet)
  const displayReplyNeededIncoming = displayReplyNeeded.filter((e) => !e.tags?.includes("NO_REPLY"));
  const displayNoReplyYet = displayReplyNeeded.filter((e) => e.tags?.includes("NO_REPLY"));

  const hasContent = Boolean(
    briefing &&
      (executiveSummaryIsUsable(briefing.executiveSummary) ||
        (normalized?.crucial?.length ?? 0) > 0 ||
        (normalized?.replyNeeded?.length ?? 0) > 0 ||
        (normalized?.deadlines?.length ?? 0) > 0 ||
        (normalized?.nonEssential?.length ?? 0) > 0),
  );
  const summaryFailedButHasCards = Boolean(
    briefing &&
      !executiveSummaryIsUsable(briefing.executiveSummary) &&
      ((normalized?.crucial?.length ?? 0) > 0 ||
        (normalized?.replyNeeded?.length ?? 0) > 0 ||
        (normalized?.deadlines?.length ?? 0) > 0 ||
        (normalized?.nonEssential?.length ?? 0) > 0),
  );

  // Resolved items sink to the end of their group.
  const resolvedLast = (cards: BriefingEmail[]) => [...cards].sort((a, b) => Number(!!a.email_id && resolvedIds.has(a.email_id)) - Number(!!b.email_id && resolvedIds.has(b.email_id)));

  const replyTo = async (emailId: string) => {
    const { data } = await supabase.from("emails").select("*, email_processed(*)").eq("id", emailId).single();
    if (data) openCompose(data);
    else addToast("error", "That email is no longer in Tabellar. Refresh the briefing.");
  };

  const row = (email: BriefingEmail, need = false) => {
    const id = email.email_id;
    const followUp = email.tags?.includes("NO_REPLY");
    return (
      <ItemRow
        key={id ?? `${email.subject}:${email.sender}`}
        email={email}
        need={need && !followUp}
        resolved={id ? resolvedIds.has(id) : false}
        onOpen={id ? () => openEmailById(id) : undefined}
        onReply={id && !followUp && (need || email.suggestedAction === "reply") ? () => replyTo(id) : undefined}
        onDismiss={id ? () => dismissCard(id) : undefined}
      />
    );
  };
  const threads = (cards: BriefingEmail[], need = false) => groupByTopic(resolvedLast(cards)).map((group, i) => <Thread key={group[0].email_id ?? i} group={group} row={(e) => row(e, need)} />);

  if (selectedEmail)
    return (
      <EmailDetail
        key={selectedEmail.id}
        email={selectedEmail}
        onBack={() => setSelectedEmail(null)}
        onArchive={() => {
          const id = selectedEmail.id;
          setSelectedEmail(null);
          setEmailFlag(id, "archive")
            .then((undo) => addToast("success", "Archived", { action: { label: "Undo", onClick: () => void undo() } }))
            .catch((e: Error) => addToast("error", `Could not archive: ${e.message}`));
        }}
        onReply={() => setSelectedEmail(null)}
        onMarkUnread={() => {
          const id = selectedEmail.id;
          setSelectedEmail(null);
          setEmailFlag(id, "unread").catch(() => {});
        }}
        onSnooze={() => setSelectedEmail(null)}
        onRethink={(updated: any) => setSelectedEmail((prev: any) => (prev ? { ...prev, email_processed: updated } : prev))}
        showBack
      />
    );

  const noModel = setup !== null && !setup.model;
  const written = (() => {
    if (!briefingAt) return new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    const d = dayLabel(briefingAt);
    return `Written ${d.name === "Today" || d.name === "Yesterday" ? d.name.toLowerCase() : `on ${d.name} ${d.date}`} at ${clock(briefingAt)}`;
  })();
  const nonEssentialTotal = normalized?.stats.nonEssential ?? 0;
  const quietSenders = [...new Set(displayNonEssential.map(senderOf).filter(Boolean))];
  const show = (f: Filter) => filter === "all" || filter === f;
  const shownCount =
    (show("replyNeeded") ? displayReplyNeeded.length : 0) + (show("deadlines") ? displayDeadlines.length : 0) + (show("crucial") ? displayCrucial.length : 0) + (show("nonEssential") ? nonEssentialTotal : 0);

  return (
    <>
      <ViewBar
        title="Briefing"
        search={false}
        right={
          <>
            <Menu label="Covers" value={activeScope} onChange={(scope) => void saveScope(scope)} options={BRIEFING_SCOPE_OPTIONS} />
            <button
              className="iconbtn"
              title={briefingRegenerating ? "Writing a new briefing" : "Write a new briefing"}
              aria-label="Write a new briefing"
              disabled={briefingRegenerating || noModel}
              onClick={() => void requestBriefingRegeneration()}
            >
              <Icon name="refresh" size={16} />
            </button>
            <SolveAgentButton disabled={!hasContent || briefingRegenerating} />
          </>
        }
      >
        <span className="hidden whitespace-nowrap text-xs text-ink3 xl:block">{written}</span>
        {hasContent && (
          <div className="hidden lg:block">
            <Seg
              value={filter}
              onChange={setFilter}
              options={[
                { id: "all", label: "All" },
                { id: "replyNeeded", label: "Reply needed", count: displayReplyNeededIncoming.length, need: displayReplyNeededIncoming.length > 0 },
                { id: "deadlines", label: "Deadlines", count: displayDeadlines.length },
                { id: "crucial", label: "Crucial", count: displayCrucial.length },
                { id: "nonEssential", label: "Non-essential", count: nonEssentialTotal },
              ]}
            />
          </div>
        )}
      </ViewBar>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="max-w-[780px] pb-10">
            {noModel ? (
              <p className="px-5 pt-4 leading-normal text-danger" role="alert">
                No model is set up, so Tabellar cannot write a briefing. Choose one in Settings, under AI.{" "}
                <button className="link" onClick={() => setView("settings")}>
                  Open Settings
                </button>
              </p>
            ) : failed && !briefingRegenerating ? (
              <p className="px-5 pt-4 leading-normal text-danger" role="alert">
                The briefing could not be written. Check that the model in Settings, under AI, is running, then try again.{" "}
                <button className="link" onClick={() => void requestBriefingRegeneration()}>
                  Try again
                </button>{" "}
                <button className="link" onClick={() => setView("settings")}>
                  Open Settings
                </button>
              </p>
            ) : briefingRegenerating ? (
              <p className="px-5 pt-4 text-xs text-ink3" role="status">
                {hasContent ? "Writing a new briefing. This one stays until it is ready." : "Writing your briefing. It can take a minute, and you can keep using Tabellar meanwhile."}
              </p>
            ) : null}

            {loading || (!hasContent && briefingRegenerating) ? (
              <Skeleton />
            ) : !hasContent ? (
              <div className="empty">
                <Icon name="description" size={22} className="text-ink3" />
                <h3>No briefing yet</h3>
                <p>A briefing sums up the mail in the range you choose: what needs a reply, what has a deadline, what matters, and what you can skip.</p>
                <button className="btn btn-pri mt-4" disabled={noModel} onClick={() => void requestBriefingRegeneration()}>
                  Write a briefing
                </button>
              </div>
            ) : (
              <>
                {briefing && executiveSummaryIsUsable(briefing.executiveSummary) ? (
                  <p className="max-w-[calc(68ch+40px)] whitespace-pre-wrap px-5 pt-5 text-sm leading-[1.6] tracking-[-0.006em] text-ink">{briefingExecutiveSummaryDisplay(briefing.executiveSummary)}</p>
                ) : summaryFailedButHasCards ? (
                  <p className="px-5 pt-5 leading-normal text-ink2" role="status">
                    The overview could not be written this time. The groups below are complete.{" "}
                    <button className="link" disabled={briefingRegenerating} onClick={() => void requestBriefingRegeneration()}>
                      Try the overview again
                    </button>
                  </p>
                ) : null}

                {show("replyNeeded") && displayReplyNeededIncoming.length > 0 && (
                  <Section title="Reply needed" count={displayReplyNeededIncoming.length} need>
                    {threads(displayReplyNeededIncoming, true)}
                  </Section>
                )}

                {show("deadlines") && displayDeadlines.length > 0 && (
                  <Section title="Deadlines" count={displayDeadlines.length}>
                    {threads(displayDeadlines)}
                  </Section>
                )}

                {show("crucial") && displayCrucial.length > 0 && (
                  <Section title="Crucial" count={displayCrucial.length}>
                    {threads(crucialsHigh)}
                    {(importantExpanded || filter === "crucial") && threads(crucialsImportant)}
                    {crucialsImportant.length > 0 && filter !== "crucial" && (
                      <button type="button" className="link mb-1 ml-10 mt-1.5 block" aria-expanded={importantExpanded} onClick={() => setImportantExpanded((v) => !v)}>
                        {importantExpanded ? "Show only the most urgent" : `${crucialsImportant.length} also important`}
                      </button>
                    )}
                  </Section>
                )}

                {filter === "all" && displayNoReplyYet.length > 0 && (
                  <Section title="Waiting on others" count={displayNoReplyYet.length}>
                    {resolvedLast(displayNoReplyYet).map((e) => row(e))}
                  </Section>
                )}

                {show("nonEssential") && nonEssentialTotal > 0 && (
                  <Section title="Non-essential" count={nonEssentialTotal}>
                    {displayNonEssential.length === 0 ? (
                      <p className="px-5 py-1.5 text-ink3">You dismissed all of these.</p>
                    ) : (
                      <>
                        {filter !== "nonEssential" && (
                          <button type="button" className="row w-[calc(100%-16px)] text-left" aria-expanded={nonEssentialExpanded} onClick={() => setNonEssentialExpanded((v) => !v)}>
                            <span className="grid w-[26px] flex-none place-items-center">
                              <Icon name={nonEssentialExpanded ? "expand_less" : "expand_more"} size={14} className="text-ink3" />
                            </span>
                            <span className="truncate text-ink3">
                              {nonEssentialExpanded
                                ? "Hide these"
                                : `Nothing needed from you: ${quietSenders.slice(0, 3).join(", ")}${quietSenders.length > 3 ? ` and ${quietSenders.length - 3} more` : ""}`}
                            </span>
                          </button>
                        )}
                        {(nonEssentialExpanded || filter === "nonEssential") &&
                          resolvedLast(displayNonEssential).map((e, i) => (
                            <div
                              key={e.email_id ?? i}
                              className="row group !grid grid-cols-[26px_minmax(0,172px)_minmax(0,1fr)_auto]"
                              role={e.email_id ? "button" : undefined}
                              tabIndex={e.email_id ? 0 : undefined}
                              onClick={e.email_id ? () => openEmailById(e.email_id!) : undefined}
                              onKeyDown={e.email_id ? (ev) => ev.key === "Enter" && ev.target === ev.currentTarget && openEmailById(e.email_id!) : undefined}
                            >
                              <span className="grid place-items-center">
                                <Glyph state={e.email_id && resolvedIds.has(e.email_id) ? "done" : "filed"} />
                              </span>
                              <span className="truncate pr-3">{senderOf(e) || "Unknown sender"}</span>
                              <span className="truncate text-ink3">{e.subject || "(no subject)"}</span>
                              {e.email_id && (
                                <button className="link invisible pl-3 group-focus-within:visible group-hover:visible" onClick={(ev) => (ev.stopPropagation(), dismissCard(e.email_id!))}>
                                  Dismiss
                                </button>
                              )}
                            </div>
                          ))}
                      </>
                    )}
                  </Section>
                )}

                {filter !== "all" && shownCount === 0 && (
                  <Empty icon="description" title="Nothing in this group">
                    This briefing found nothing here.{" "}
                    <button className="link" onClick={() => setFilter("all")}>
                      Show the whole briefing
                    </button>
                  </Empty>
                )}
              </>
            )}

            <div className="px-5 pt-8 lg:hidden">
              <Schedule items={todayScheduleItems} />
            </div>
          </div>
        </div>
        <aside className="hidden w-[288px] flex-none overflow-y-auto border-l border-line px-5 pb-6 pt-5 lg:block" aria-label="Today's calendar">
          <Schedule items={todayScheduleItems} />
        </aside>
      </div>
      <KeyHints left={writer ? `Written by ${writer.model}${writer.format === "ollama" ? " on this Mac" : " in the cloud"}` : ""} keys={[]} />
    </>
  );
}
