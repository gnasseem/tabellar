
import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import EmailDetail from "../EmailDetail";
import SolveAgentButton from "../solve/SolveAgentButton";
import { useSetupState } from "../ModelSetup";

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

type FilterType = "crucial" | "replyNeeded" | "deadlines" | "nonEssential" | null;

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

type BriefingAccent = "crucial" | "reply" | "deadline" | "noise";

const ACCENT_BORDER: Record<BriefingAccent, string> = {
  crucial: "border-l-rose-500/75",
  reply: "border-l-sky-500/75",
  deadline: "border-l-violet-500/75",
  noise: "border-l-slate-400/40",
};

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
  return s.replace(/—/g, " - ");
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
    // AI sometimes uses the wrong year; try bumping by 1 year if far in the past
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

    // Rescue: if AI put everything in nonEssential, reclassify by sender/urgency
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

function EmailCard({
  email,
  onClick,
  onDismiss,
  hideUrgency,
  accent = "crucial",
  isResolved,
}: {
  email: BriefingEmail;
  onClick?: () => void;
  onDismiss?: () => void;
  hideUrgency?: boolean;
  accent?: BriefingAccent;
  isResolved?: boolean;
}) {
  const hasNoReply = email.tags?.includes("NO_REPLY");
  const borderAccent = ACCENT_BORDER[hideUrgency ? "noise" : accent];
  const urgencyLabel =
    email.urgency === "critical" ? "Critical" : email.urgency === "high" ? "High" : "Med";

  const senderLabel = (email.senderName && email.senderName !== "null")
    ? email.senderName
    : ((email.sender && email.sender !== "null") ? email.sender : "");

  const rowBase =
    `rounded-lg border border-[var(--border)] bg-[var(--surface)] border-l-2 ${borderAccent} transition-colors duration-200 ` +
    (onClick ? "cursor-pointer hover:bg-[var(--surface-2)]/80 " : "");

  if (hideUrgency) {
    return (
      <div
        className={`${rowBase} flex items-center gap-2 px-2.5 py-1.5`}
        onClick={onClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[12px] font-medium text-[var(--foreground)] truncate block leading-snug font-['DM_Sans',ui-sans-serif,sans-serif]">
              {email.subject}
            </span>
            {isResolved && (
              <span className="shrink-0 text-[9px] px-1 py-0.5 rounded font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                resolved
              </span>
            )}
          </div>
          {senderLabel && (
            <span className="text-[10px] text-[var(--muted)] truncate block leading-snug">{senderLabel}</span>
          )}
        </div>
        {onDismiss && (
          <button
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            className="shrink-0 p-1 rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.06] text-[var(--muted)] hover:text-red-400 transition-colors cursor-pointer"
            title="Dismiss"
            aria-label="Dismiss"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>close</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`${rowBase} px-3 py-2.5`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 min-w-0">
          {!hasNoReply && (
            <span className="text-[9px] font-semibold uppercase tracking-wide text-[var(--muted)] tabular-nums">
              {urgencyLabel}
            </span>
          )}
          {email.waitingForReply && !hasNoReply && (
            <span className="text-[9px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400/90">
              Reply
            </span>
          )}
          {hasNoReply && (
            <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400/90">
              No reply yet
            </span>
          )}
          {email.deadline && (
            <span className="text-[9px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400/90">
              Due {formatDeadlineDate(email.deadline)}
            </span>
          )}
          {email.tags?.filter((t) => !["REPLY_NEEDED", "DEADLINE", "NO_REPLY"].includes(t)).map((tag) => (
            <span key={tag} className="text-[9px] text-[var(--muted)]">
              {tag}
            </span>
          ))}
          {isResolved && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              resolved
            </span>
          )}
        </div>
        {onDismiss && (
          <button
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            className="shrink-0 p-1 rounded-md hover:bg-black/[0.06] dark:hover:bg-white/[0.06] text-[var(--muted)] hover:text-red-400 transition-colors cursor-pointer"
            title="Dismiss"
            aria-label="Dismiss"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>close</span>
          </button>
        )}
      </div>
      <p className="text-[13px] font-semibold text-[var(--foreground)] mt-1 leading-snug line-clamp-2 font-['DM_Sans',ui-sans-serif,sans-serif]">
        {email.subject}
      </p>
      <p className="text-[11px] text-[var(--muted)] mt-0.5 line-clamp-1">
        {senderLabel}
        {email.senderName && email.senderName !== "null" && email.sender && email.sender !== "null" && email.senderName !== email.sender && (
          <span className="opacity-60"> · {email.sender}</span>
        )}
      </p>
      {email.signal?.trim() && (
        <p className="text-[11px] text-sky-700/90 dark:text-sky-400/80 mt-1 line-clamp-1 italic">
          {email.signal.replace(/—/g, " - ")}
        </p>
      )}
      <p className="text-[12px] text-slate-700 dark:text-slate-200 mt-1 leading-snug line-clamp-2 font-['DM_Sans',ui-sans-serif,sans-serif]">
        {(email.summary || "").replace(/—/g, " - ")}
      </p>
    </div>
  );
}

function GroupedEmailCard({
  group,
  onClickEmail,
  onDismiss,
  accent = "crucial",
  resolvedIds,
}: {
  group: BriefingEmail[];
  onClickEmail?: (email: BriefingEmail) => void;
  onDismiss?: (email: BriefingEmail) => void;
  accent?: BriefingAccent;
  resolvedIds?: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...group].sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3));
  const primary = sorted[0];
  const rest = sorted.slice(1);

  return (
    <div className="space-y-1.5">
      <EmailCard
        email={primary}
        accent={accent}
        isResolved={primary.email_id ? resolvedIds?.has(primary.email_id) : false}
        onClick={primary.email_id && onClickEmail ? () => onClickEmail(primary) : undefined}
        onDismiss={primary.email_id && onDismiss ? () => onDismiss(primary) : undefined}
      />
      {rest.length > 0 && (
        <div className="ml-2 pl-2 border-l border-[var(--border)]">
          {!expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-[10px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors flex items-center gap-0.5 py-0.5 cursor-pointer"
            >
              <span className="material-symbols-outlined" style={{ fontSize: "12px" }}>expand_more</span>
              {rest.length} more on thread
            </button>
          )}
          {expanded && (
            <div className="space-y-1.5 mt-1">
              {rest.map((email, i) => (
                <EmailCard
                  key={email.email_id ?? i}
                  email={email}
                  accent={accent}
                  isResolved={email.email_id ? resolvedIds?.has(email.email_id) : false}
                  onClick={email.email_id && onClickEmail ? () => onClickEmail(email) : undefined}
                  onDismiss={email.email_id && onDismiss ? () => onDismiss(email) : undefined}
                />
              ))}
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="text-[10px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors flex items-center gap-0.5 py-0.5 cursor-pointer"
              >
                <span className="material-symbols-outlined" style={{ fontSize: "12px" }}>expand_less</span>
                Collapse
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ icon, label, color }: { icon: string; label: string; color: string }) {
  return (
    <div className="flex items-center gap-2 mb-3 mt-1">
      <span className={`material-symbols-outlined ${color}`} style={{ fontSize: "16px" }}>{icon}</span>
      <h2 className="text-xs font-bold tracking-widest text-[var(--muted)] uppercase">{label}</h2>
    </div>
  );
}

type BriefingScope = "today_new" | "past_2_days" | "past_week" | "all_recent";

const BRIEFING_SCOPE_OPTIONS: { id: BriefingScope; label: string; desc: string }[] = [
  { id: "today_new", label: "Today", desc: "New emails from today" },
  { id: "past_2_days", label: "2 days", desc: "Last 2 days catch-up" },
  { id: "past_week", label: "Week", desc: "Past 7 days" },
  { id: "all_recent", label: "Full inbox", desc: "40 most recent emails" },
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
  } = useApp();
  const supabase = createClient();
  const [briefing, setBriefing] = useState<BriefingResult | null>(null);
  const [briefingAt, setBriefingAt] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<any | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [activeFilter, setActiveFilter] = useState<FilterType>(null);
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
  const [scopeDropdownOpen, setScopeDropdownOpen] = useState(false);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [resolvedSortToEnd, setResolvedSortToEnd] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(`tabellar_resolved_sort_end_${user.id}`);
      return raw === null ? true : raw === "true";
    } catch { return true; }
  });

  const saveScope = useCallback(async (scope: BriefingScope) => {
    setScopeDropdownOpen(false);
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

  const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });

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

  const displayStats = normalized ? {
    total: normalized.stats.total,
    crucial: displayCrucial.length,
    replyNeeded: displayReplyNeeded.length,
    deadlines: displayDeadlines.length,
    nonEssential: normalized.stats.nonEssential,
  } : null;

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

  // Which email list to show based on active filter
  const filteredEmails: BriefingEmail[] = (() => {
    if (activeFilter === "crucial") return displayCrucial;
    if (activeFilter === "replyNeeded") return displayReplyNeeded;
    if (activeFilter === "deadlines") return displayDeadlines;
    if (activeFilter === "nonEssential") return displayNonEssential;
    return [];
  })();

  const FILTER_CONFIG = {
    crucial: {
      label: "Crucial",
      icon: "priority_high",
      color: "text-rose-500 dark:text-rose-400",
      border: "border-rose-500/30",
      activeBg: "bg-rose-500/10",
      count: displayStats?.crucial ?? 0,
    },
    replyNeeded: {
      label: "Reply Needed",
      icon: "reply",
      color: "text-sky-500 dark:text-sky-400",
      border: "border-sky-500/30",
      activeBg: "bg-sky-500/10",
      count: displayStats?.replyNeeded ?? 0,
    },
    deadlines: {
      label: "Deadlines",
      icon: "event_upcoming",
      color: "text-violet-500 dark:text-violet-400",
      border: "border-violet-500/30",
      activeBg: "bg-violet-500/10",
      count: displayStats?.deadlines ?? 0,
    },
    nonEssential: {
      label: "Non-essential",
      icon: "filter_alt",
      color: "text-slate-500 dark:text-slate-400",
      border: "border-slate-500/20",
      activeBg: "bg-slate-500/10",
      count: displayStats?.nonEssential ?? 0,
    },
  };

  return (
    <div className="h-full flex overflow-hidden">
      {/* Left panel: Today's timeline */}
      <div className="w-72 lg:w-80 border-r border-[var(--border)] flex flex-col flex-shrink-0 overflow-auto">
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <span className="material-symbols-outlined text-[var(--accent)]" style={{ fontSize: "18px" }}>today</span>
            Today&apos;s Schedule
          </h2>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            {new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          </p>
        </div>
        <div className="flex-1 p-4">
          {todayScheduleItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-[var(--muted)] text-center">
              <span className="material-symbols-outlined mb-2" style={{ fontSize: "40px" }}>event_available</span>
              <p className="text-sm">No meetings today</p>
              <p className="text-xs mt-1 opacity-70">Your calendar is clear</p>
            </div>
          ) : (
            <div className="space-y-3">
              {todayScheduleItems.map((m: any) => {
                const isGcal = m.source === "google_calendar";
                const confirmed = m.status === "confirmed";
                const borderColor = confirmed ? "border-l-emerald-500" : "border-l-blue-500";
                const bgColor = confirmed ? "bg-emerald-50 dark:bg-emerald-900/20" : "bg-blue-50 dark:bg-blue-900/20";
                return (
                  <div key={m.id} className="flex gap-3">
                    <div className="text-right shrink-0 w-14">
                      {m.start && !m.allDay && (
                        <p className="text-xs font-medium text-slate-700 dark:text-slate-300">{formatTime(m.start)}</p>
                      )}
                      {m.end && !m.allDay && (
                        <p className="text-[10px] text-[var(--muted)]">{formatTime(m.end)}</p>
                      )}
                      {m.allDay && (
                        <p className="text-[10px] text-[var(--muted)] font-medium">All day</p>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`p-2 rounded-lg border-l-2 ${borderColor} ${bgColor}`}>
                        <div className="flex items-start gap-1.5">
                          {isGcal && (
                            <span className="material-symbols-outlined text-[var(--muted)] shrink-0 mt-px" style={{ fontSize: "13px" }}>event</span>
                          )}
                          <p className="text-sm font-medium text-slate-900 dark:text-white truncate leading-snug">{m.title}</p>
                        </div>
                        {m.attendees?.length > 0 && (
                          <p className="text-[11px] text-[var(--muted)] truncate mt-0.5">
                            {m.attendees.slice(0, 2).join(", ")}{m.attendees.length > 2 ? ` +${m.attendees.length - 2}` : ""}
                          </p>
                        )}
                        {m.location && (
                          <p className="text-[10px] text-[var(--muted)] truncate mt-0.5 flex items-center gap-0.5">
                            <span className="material-symbols-outlined" style={{ fontSize: "11px" }}>location_on</span>
                            {m.location}
                          </p>
                        )}
                        {m.meetingLink && (
                          <a
                            href={m.meetingLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-sky-600 dark:text-sky-400 hover:underline flex items-center gap-0.5 mt-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: "11px" }}>videocam</span>
                            Join meeting
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right panel: Executive briefing or email detail */}
      <div className="flex-1 overflow-auto">
        {selectedEmail ? (
          <EmailDetail
            key={selectedEmail.id}
            email={selectedEmail}
            onBack={() => setSelectedEmail(null)}
            onArchive={() => setSelectedEmail(null)}
            onReply={() => setSelectedEmail(null)}
            onMarkUnread={() => setSelectedEmail(null)}
            onSnooze={() => setSelectedEmail(null)}
            onRethink={(updated: any) => setSelectedEmail((prev: any) => prev ? { ...prev, email_processed: updated } : prev)}
            showBack
          />
        ) : (
          <div className="max-w-3xl mx-auto px-6 py-5">
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <h1 className="text-[1.35rem] font-bold text-[var(--foreground)] flex items-center gap-2 font-['Syne',system-ui,sans-serif] tracking-tight">
                  <span className="material-symbols-outlined text-[var(--accent)]" style={{ fontSize: "22px" }}>summarize</span>
                  Morning Briefing
                </h1>
                <p className="text-[11px] text-[var(--muted)] mt-0.5 font-['DM_Sans',ui-sans-serif,sans-serif]">
                  {briefingAt
                    ? `Generated ${new Date(briefingAt).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })} at ${new Date(briefingAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}`
                    : new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void requestBriefingRegeneration()}
                  disabled={briefingRegenerating}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50"
                  title={briefingRegenerating ? "Regenerating briefing..." : "Regenerate briefing"}
                  aria-label="Regenerate briefing"
                >
                  <span
                    className={`material-symbols-outlined ${briefingRegenerating ? "animate-spin" : ""}`}
                    style={{ fontSize: "16px" }}
                  >
                    {briefingRegenerating ? "progress_activity" : "refresh"}
                  </span>
                </button>
                {/* Subtle scope selector */}
                <div className="relative">
                  <button
                    onClick={() => setScopeDropdownOpen((v) => !v)}
                    className="flex items-center gap-1 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--foreground)]"
                    title="Briefing scope"
                  >
                    {BRIEFING_SCOPE_OPTIONS.find((o) => o.id === activeScope)?.label ?? "Today"}
                    <span className="material-symbols-outlined" style={{ fontSize: "13px" }}>expand_more</span>
                  </button>
                  {scopeDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setScopeDropdownOpen(false)} />
                      <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg overflow-hidden">
                        {BRIEFING_SCOPE_OPTIONS.map((opt) => (
                          <button
                            key={opt.id}
                            onClick={() => void saveScope(opt.id)}
                            className={`w-full text-left px-3 py-2 flex flex-col transition-colors hover:bg-[var(--surface-2)] ${activeScope === opt.id ? "text-[var(--accent)]" : "text-[var(--foreground)]"}`}
                          >
                            <span className="text-[12px] font-medium">{opt.label}</span>
                            <span className="text-[10px] text-[var(--muted)]">{opt.desc}</span>
                          </button>
                        ))}
                        <div className="border-t border-[var(--border)] px-3 py-2">
                          <button
                            type="button"
                            onClick={() => {
                              const next = !resolvedSortToEnd;
                              setResolvedSortToEnd(next);
                              try { localStorage.setItem(`tabellar_resolved_sort_end_${user.id}`, String(next)); } catch { /* ignore */ }
                            }}
                            className="w-full flex items-center justify-between gap-2 text-left"
                          >
                            <span className="text-[11px] text-[var(--foreground)]">Resolved emails sort to end</span>
                            <span className={`relative inline-flex h-4 w-7 shrink-0 rounded-full border-2 border-transparent transition-colors ${resolvedSortToEnd ? "bg-emerald-500" : "bg-[var(--border)]"}`}>
                              <span className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-white shadow-sm transform transition-transform ${resolvedSortToEnd ? "translate-x-3" : "translate-x-0"}`} />
                            </span>
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
                <SolveAgentButton disabled={!hasContent || briefingRegenerating} />
              </div>
            </div>

            {loading ? (
              <div className="space-y-4">
                <div className="h-16 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
                <div className="flex gap-3">
                  {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-14 flex-1 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
                </div>
                {[1, 2, 3].map((i) => <div key={i} className="h-24 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
              </div>
            ) : !hasContent ? (
              <div className="text-center py-16 text-[var(--muted)]">
                {briefingRegenerating ? (
                  <>
                    <span className="material-symbols-outlined mb-3 animate-spin text-[var(--accent)]" style={{ fontSize: "48px" }}>progress_activity</span>
                    <p className="text-sm font-medium text-[var(--foreground)]">Generating your briefing...</p>
                    <p className="text-xs mt-1 opacity-70">This takes a moment. You can keep using the app.</p>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined mb-3" style={{ fontSize: "48px" }}>mark_email_read</span>
                    <p className="text-sm font-medium">No briefing available</p>
                    <p className="text-xs mt-1 opacity-70 mb-4">Generate a briefing from your current inbox.</p>
                    <button
                      onClick={() => void requestBriefingRegeneration()}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>auto_awesome</span>
                      Generate Briefing
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-5">
                {/* Compact inline meta chips  -  muted, calm, dashboard aesthetic */}
                {displayStats && (
                  <div className="flex flex-wrap items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)]/60 px-2 py-1.5">
                    <button
                      onClick={() => setActiveFilter(null)}
                      title="Show all"
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                        activeFilter === null
                          ? "bg-[var(--foreground)] text-[var(--background)]"
                          : "text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
                      }`}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: "13px" }}>inbox</span>
                      <span>All</span>
                      <span className="tabular-nums opacity-70">{displayStats.total}</span>
                    </button>
                    <span className="h-4 w-px bg-[var(--border)]" aria-hidden />
                    {([
                      { key: "crucial", label: "Crucial", dot: "bg-rose-400", icon: "priority_high", count: displayStats.crucial },
                      { key: "replyNeeded", label: "Reply", dot: "bg-sky-400", icon: "reply", count: displayStats.replyNeeded },
                      { key: "deadlines", label: "Deadlines", dot: "bg-violet-400", icon: "event_upcoming", count: displayStats.deadlines },
                      { key: "nonEssential", label: "Noise", dot: "bg-slate-400", icon: "filter_alt", count: displayStats.nonEssential },
                    ] as const).map((chip) => {
                      const isActive = activeFilter === chip.key;
                      return (
                        <button
                          key={chip.key}
                          onClick={() => setActiveFilter(isActive ? null : chip.key)}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                            isActive
                              ? "bg-[var(--foreground)] text-[var(--background)]"
                              : "text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)]"
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} aria-hidden />
                          <span>{chip.label}</span>
                          <span className="tabular-nums opacity-70">{chip.count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* Executive summary */}
                {briefing && executiveSummaryIsUsable(briefing.executiveSummary) && (
                  <div className="px-4 py-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface)]/90">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <span className="text-[10px] font-semibold tracking-[0.12em] text-[var(--muted)] uppercase font-['Syne',system-ui,sans-serif]">Executive summary</span>
                    </div>
                    <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-slate-800 dark:text-slate-100 font-['DM_Sans',ui-sans-serif,sans-serif]">
                      {briefingExecutiveSummaryDisplay(briefing.executiveSummary)}
                    </p>
                  </div>
                )}
                {summaryFailedButHasCards && (
                  <div
                    className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] dark:bg-amber-500/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between"
                    role="status"
                  >
                    <p className="text-[13px] text-[var(--foreground)] leading-snug font-['DM_Sans',ui-sans-serif,sans-serif]">
                      Overview text did not generate for this inbox load, but the sections below are filled from your mail. Regenerate to try the overview again.
                    </p>
                    <button
                      type="button"
                      onClick={() => void requestBriefingRegeneration()}
                      disabled={briefingRegenerating}
                      className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] font-medium hover:border-[var(--accent)]/50 disabled:opacity-50 cursor-pointer transition-colors"
                    >
                      <span className={`material-symbols-outlined ${briefingRegenerating ? "animate-spin" : ""}`} style={{ fontSize: "15px" }}>
                        {briefingRegenerating ? "progress_activity" : "refresh"}
                      </span>
                      {briefingRegenerating ? "Working…" : "Regenerate"}
                    </button>
                  </div>
                )}

                {/* Email list: filtered or grouped */}
                {activeFilter ? (
                  <div>
                    {/* replyNeeded filter: show as two subsections */}
                    {activeFilter === "replyNeeded" ? (
                      <div className="space-y-6">
                        {displayReplyNeededIncoming.length > 0 && (
                          <div>
                            <SectionHeader icon="reply" label="Reply Needed" color="text-sky-500 dark:text-sky-400" />
                            <div className="space-y-2.5">
                              {groupByTopic(displayReplyNeededIncoming).map((group, i) => (
                                <GroupedEmailCard
                                  key={group[0].email_id ?? i}
                                  group={group}
                                  accent="reply"
                                  resolvedIds={resolvedIds}
                                  onClickEmail={(e) => e.email_id && openEmailById(e.email_id)}
                                  onDismiss={(e) => e.email_id && dismissCard(e.email_id)}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                        {displayNoReplyYet.length > 0 && (
                          <div>
                            <SectionHeader icon="mark_email_unread" label="No Reply Yet" color="text-amber-500 dark:text-amber-400" />
                            <div className="space-y-2.5">
                              {displayNoReplyYet.map((email, i) => (
                                <EmailCard
                                  key={email.email_id ?? i}
                                  email={email}
                                  accent="reply"
                                  isResolved={email.email_id ? resolvedIds.has(email.email_id) : false}
                                  onClick={email.email_id ? () => openEmailById(email.email_id!) : undefined}
                                  onDismiss={email.email_id ? () => dismissCard(email.email_id!) : undefined}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                        {displayReplyNeededIncoming.length === 0 && displayNoReplyYet.length === 0 && (
                          <p className="text-sm text-center py-8 text-[var(--muted)]">No emails in this category.</p>
                        )}
                      </div>
                    ) : (
                      <>
                        <SectionHeader
                          icon={FILTER_CONFIG[activeFilter].icon}
                          label={FILTER_CONFIG[activeFilter].label}
                          color={FILTER_CONFIG[activeFilter].color}
                        />
                        {filteredEmails.length === 0 ? (
                          <div className="text-center py-8 text-[var(--muted)]">
                            {activeFilter === "nonEssential" && (displayStats?.nonEssential ?? 0) > 0 ? (
                              <>
                                <span className="material-symbols-outlined mb-2" style={{ fontSize: "32px" }}>filter_alt</span>
                                <p className="text-sm font-medium">{displayStats!.nonEssential} emails filtered</p>
                                <p className="text-xs mt-1 opacity-70">Regenerate your briefing to see individual non-essential emails.</p>
                                <button
                                  onClick={() => void requestBriefingRegeneration()}
                                  disabled={briefingRegenerating}
                                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[var(--border)] text-xs hover:border-[var(--accent)] transition-colors disabled:opacity-50"
                                >
                                  <span className={`material-symbols-outlined ${briefingRegenerating ? "animate-spin" : ""}`} style={{ fontSize: "13px" }}>{briefingRegenerating ? "progress_activity" : "refresh"}</span>
                                  {briefingRegenerating ? "Generating..." : "Regenerate"}
                                </button>
                              </>
                            ) : (
                              <p className="text-sm">No emails in this category.</p>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            {filteredEmails.map((email, i) => (
                              <EmailCard
                                key={email.email_id ?? i}
                                email={email}
                                hideUrgency={activeFilter === "nonEssential"}
                                accent={
                                  activeFilter === "deadlines"
                                    ? "deadline"
                                    : activeFilter === "nonEssential"
                                      ? "noise"
                                      : "crucial"
                                }
                                isResolved={email.email_id ? resolvedIds.has(email.email_id) : false}
                                onClick={email.email_id ? () => openEmailById(email.email_id!) : undefined}
                                onDismiss={email.email_id ? () => dismissCard(email.email_id!) : undefined}
                              />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  // No filter: show all groups (reply-first, then crucial)
                  <div className="space-y-6">
                    {/* Reply Needed: incoming emails that need a response */}
                    {displayReplyNeededIncoming.length > 0 && (
                      <div>
                        <SectionHeader icon="reply" label="Reply Needed" color="text-sky-500 dark:text-sky-400" />
                        <div className="space-y-2.5">
                          {groupByTopic(displayReplyNeededIncoming).map((group, i) => (
                            <GroupedEmailCard
                              key={group[0].email_id ?? i}
                              group={group}
                              accent="reply"
                              resolvedIds={resolvedIds}
                              onClickEmail={(e) => e.email_id && openEmailById(e.email_id)}
                              onDismiss={(e) => e.email_id && dismissCard(e.email_id)}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* No Reply Yet: sent emails awaiting response */}
                    {displayNoReplyYet.length > 0 && (
                      <div>
                        <SectionHeader icon="mark_email_unread" label="No Reply Yet" color="text-amber-500 dark:text-amber-400" />
                        <div className="space-y-2.5">
                          {displayNoReplyYet.map((email, i) => (
                            <EmailCard
                              key={email.email_id ?? i}
                              email={email}
                              accent="reply"
                              isResolved={email.email_id ? resolvedIds.has(email.email_id) : false}
                              onClick={email.email_id ? () => openEmailById(email.email_id!) : undefined}
                              onDismiss={email.email_id ? () => dismissCard(email.email_id!) : undefined}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Crucial: critical/high shown first, medium collapsed under "Also important" */}
                    {displayCrucial.length > 0 && (
                      <div>
                        <SectionHeader icon="priority_high" label="Crucial" color="text-rose-500 dark:text-rose-400" />
                        {crucialsHigh.length > 0 && (
                          <div className="space-y-2.5">
                            {groupByTopic(crucialsHigh).map((group, i) => (
                              <GroupedEmailCard
                                key={group[0].email_id ?? i}
                                group={group}
                                accent="crucial"
                                resolvedIds={resolvedIds}
                                onClickEmail={(e) => e.email_id && openEmailById(e.email_id)}
                                onDismiss={(e) => e.email_id && dismissCard(e.email_id)}
                              />
                            ))}
                          </div>
                        )}
                        {crucialsImportant.length > 0 && (
                          <div className={crucialsHigh.length > 0 ? "mt-3" : ""}>
                            <button
                              type="button"
                              onClick={() => setImportantExpanded((v) => !v)}
                              className="flex items-center gap-1.5 mb-2 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors group cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-slate-400 group-hover:text-[var(--foreground)] transition-colors" style={{ fontSize: "13px" }}>
                                {importantExpanded ? "expand_less" : "expand_more"}
                              </span>
                              Also important ({crucialsImportant.length})
                            </button>
                            {importantExpanded && (
                              <div className="space-y-2.5">
                                {groupByTopic(crucialsImportant).map((group, i) => (
                                  <GroupedEmailCard
                                    key={group[0].email_id ?? i}
                                    group={group}
                                    accent="crucial"
                                    resolvedIds={resolvedIds}
                                    onClickEmail={(e) => e.email_id && openEmailById(e.email_id)}
                                    onDismiss={(e) => e.email_id && dismissCard(e.email_id)}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {displayDeadlines.length > 0 && (
                      <div>
                        <SectionHeader icon="event_upcoming" label="Deadlines" color="text-violet-500 dark:text-violet-400" />
                        <div className="space-y-2.5">
                          {groupByTopic(displayDeadlines).map((group, i) => (
                            <GroupedEmailCard
                              key={group[0].email_id ?? i}
                              group={group}
                              accent="deadline"
                              resolvedIds={resolvedIds}
                              onClickEmail={(e) => e.email_id && openEmailById(e.email_id)}
                              onDismiss={(e) => e.email_id && dismissCard(e.email_id)}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {(displayStats?.nonEssential ?? 0) > 0 && displayNonEssential.length === 0 && activeFilter !== "nonEssential" && (
                      <button
                        onClick={() => setActiveFilter("nonEssential")}
                        className="w-full text-[11px] text-[var(--muted)] text-center py-2 hover:text-[var(--foreground)] transition-colors"
                      >
                        <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: "12px" }}>filter_alt</span>
                        {displayStats!.nonEssential} non-essential emails filtered out -- click to view
                      </button>
                    )}

                    {displayNonEssential.length > 0 && (
                      <div>
                        <button
                          onClick={() => setNonEssentialExpanded((v) => !v)}
                          className="flex items-center gap-2 mb-3 mt-1 w-full group"
                        >
                          <span className="material-symbols-outlined text-slate-400" style={{ fontSize: "16px" }}>filter_alt</span>
                          <h2 className="text-xs font-bold tracking-widest text-[var(--muted)] uppercase flex-1 text-left">Non-essential</h2>
                          <span className="material-symbols-outlined text-slate-400 group-hover:text-[var(--foreground)] transition-colors" style={{ fontSize: "16px" }}>
                            {nonEssentialExpanded ? "expand_less" : "expand_more"}
                          </span>
                        </button>
                        {nonEssentialExpanded && (
                          <div className="space-y-1">
                            {displayNonEssential.map((email, i) => (
                              <EmailCard
                                key={email.email_id ?? i}
                                email={email}
                                hideUrgency
                                isResolved={email.email_id ? resolvedIds.has(email.email_id) : false}
                                onClick={email.email_id ? () => openEmailById(email.email_id!) : undefined}
                                onDismiss={email.email_id ? () => dismissCard(email.email_id!) : undefined}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Which model wrote it */}
                {writer && (
                  <p className="text-[11px] text-[var(--muted)] flex items-center gap-1 pb-2">
                    <span className="material-symbols-outlined" style={{ fontSize: "12px" }}>
                      {writer.format === "ollama" ? "laptop_mac" : "cloud"}
                    </span>
                    Written by {writer.model}
                    {writer.format === "ollama" ? " on this Mac" : " in the cloud"}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
