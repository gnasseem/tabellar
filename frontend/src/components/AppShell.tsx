
import {
  useState,
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
} from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import ComposeModal from "./ComposeModal";
import AssistantPanel from "./AssistantPanel";
import { ToastContainer, type ToastItem } from "./Toast";
import AgentWorkspace from "./solve/AgentWorkspace";
import ShortcutsHelp from "./ShortcutsHelp";
import { GO_TO_VIEWS, isTypingTarget } from "@/lib/shortcuts";
import type { User } from "@/lib/db";
import { createClient } from "@/lib/db";
import { useLiveUpdates, type LiveChangeCounters } from "@/lib/useLiveUpdates";
import {
  startAgent as apiStartAgent,
  stepAgent as apiStepAgent,
  answerAgent as apiAnswerAgent,
  answerAgentBatch as apiAnswerAgentBatch,
  executeAgent as apiExecuteAgent,
  cancelAgent as apiCancelAgent,
  fetchSession as apiFetchSession,
  fetchTurns as apiFetchTurns,
  subscribeAgent,
  normalizeAgentSessionError,
} from "@/lib/agentClient";
import type {
  AgentSessionState,
  AgentAnswer,
  AgentBatchAnswer,
  AgentAction,
  AgentTurnRow,
} from "@/lib/agentTypes";

type Profile = {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  theme: "light" | "dark";
  style_notes?: string | null;
  working_hours?: Record<string, unknown> | null;
  last_briefing?: Record<string, unknown> | null;
  last_briefing_at?: string | null;
  briefing_scope?: string | null;
  calendar_send_invites?: boolean | null;
};

// In-memory view data cache for instant view switching
type ViewCacheEntry = { data: any; timestamp: number };

export type AppContextType = {
  user: User;
  profile: Profile;
  updateProfile: (patch: Partial<Profile>) => void;
  view: string;
  setView: (v: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  theme: "light" | "dark";
  setTheme: (v: "light" | "dark") => void;
  openCompose: (replyTo?: any, draft?: any) => void;
  addToast: (
    type: ToastItem["type"],
    message: string,
    options?: { action?: ToastItem["action"]; duration?: number },
  ) => void;
  // Global search
  search: string;
  setSearch: (v: string) => void;
  // Global sync (used by InboxView for initial fetch overlay)
  syncing: boolean;
  setSyncing: (v: boolean) => void;
  // Inbox filter/sort (shared between TopBar and InboxView)
  inboxFilters: Set<string>;
  setInboxFilters: (v: Set<string>) => void;
  inboxSort: "newest" | "smart";
  setInboxSort: (v: "newest" | "smart") => void;
  inboxCustomCategories: string[];
  setInboxCustomCategories: (v: string[]) => void;
  inboxCustomTags: { slug: string; displayName: string; color: string }[];
  setInboxCustomTags: (
    v: { slug: string; displayName: string; color: string }[],
  ) => void;
  // Draft change notifications
  draftVersion: number;
  notifyDraftChange: () => void;
  // Sent email notifications
  pendingSentEmail: {
    id: string;
    to: string;
    subject: string;
    body_html: string;
    date: string;
  } | null;
  notifySent: (email: {
    to: string;
    subject: string;
    body_html: string;
  }) => void;
  // View data cache
  getViewCache: (key: string) => any | null;
  setViewCache: (key: string, data: any) => void;
  invalidateViewCache: (...keys: string[]) => void;
  // Live update change counters (per-table)
  liveChanges: LiveChangeCounters;
  // Processing banner (how many emails are being AI-processed)
  processingCount: number;
  // Briefing version  -  increments whenever a new briefing is saved
  briefingVersion: number;
  notifyBriefingUpdated: () => void;
  briefingRegenerating: boolean;
  requestBriefingRegeneration: (scope?: string) => void;
  // Assistant panel open state (used by ComposeModal to shift position)
  assistantOpen: boolean;
  // Solve-Everything agent session (survives navigation)
  agentSession: AgentSessionState | null;
  agentTurns: AgentTurnRow[];
  agentWorkspaceOpen: boolean;
  openAgentWorkspace: () => void;
  closeAgentWorkspace: () => void;
  startSolveAgent: () => Promise<void>;
  answerSolveAgent: (answer: AgentAnswer) => Promise<void>;
  answerSolveAgentBatch: (batch: AgentBatchAnswer) => Promise<void>;
  executeSolveAgent: (
    approved: AgentAction[],
  ) => Promise<
    Record<
      string,
      { status: "success" | "error"; info?: string; error?: string }
    >
  >;
  cancelSolveAgent: () => Promise<void>;
  /** True while a cancel request is in flight (direct DB update or API fallback). */
  solveAgentCancelInFlight: boolean;
  resetSolveAgent: () => void;
  // Pending meeting schedule (set when user clicks schedule_meeting quick action)
  pendingMeetingSchedule: {
    title?: string;
    dateTime?: string;
    duration?: number;
    location?: string;
    attendees?: string[];
    description?: string;
  } | null;
  setPendingMeetingSchedule: (v: AppContextType["pendingMeetingSchedule"]) => void;
};

export const AppContext = createContext<AppContextType | null>(null);
export const useApp = () => useContext(AppContext)!;

export default function AppShell({
  user,
  profile,
  children,
}: {
  user: User;
  profile: Profile;
  children: React.ReactNode;
}) {
  const [profileState, setProfileState] = useState<Profile>(profile);
  const updateProfile = useCallback((patch: Partial<Profile>) => {
    setProfileState((prev) => ({ ...prev, ...patch }));
  }, []);
  const [viewRaw, setViewRaw] = useState("inbox");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(
    profile?.theme || "light",
  );
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeReplyTo, setComposeReplyTo] = useState<any>(null);
  const [composeDraft, setComposeDraft] = useState<any>(null);
  const [composeMinimized, setComposeMinimized] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [search, setSearch] = useState("");
  const setView = useCallback((v: string) => {
    setViewRaw(v);
    setSearch("");
  }, []);
  const view = viewRaw;
  const [syncing, setSyncing] = useState(false);
  const [inboxFilters, setInboxFilters] = useState<Set<string>>(new Set());
  const [inboxSort, setInboxSort] = useState<"newest" | "smart">(() => {
    if (typeof window === "undefined") return "newest";
    const saved = localStorage.getItem("tabellar_inbox_sort");
    return saved === "smart" ? "smart" : "newest";
  });
  const [inboxCustomCategories, setInboxCustomCategories] = useState<string[]>(
    [],
  );
  const [inboxCustomTags, setInboxCustomTags] = useState<
    { slug: string; displayName: string; color: string }[]
  >([]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [draftVersion, setDraftVersion] = useState(0);
  const notifyDraftChange = useCallback(
    () => setDraftVersion((v) => v + 1),
    [],
  );
  const [briefingVersion, setBriefingVersion] = useState(0);
  const [briefingRegenerating, setBriefingRegenerating] = useState(false);
  const briefingGenLockRef = useRef(false);
  const pendingScopeRef = useRef<string | null>(null);
  const requestBriefingRegenerationRef = useRef<((scope?: string) => void) | null>(null);
  const viewRef = useRef(viewRaw);
  useEffect(() => {
    viewRef.current = viewRaw;
  }, [viewRaw]);
  const profileRef = useRef(profileState);
  useEffect(() => {
    profileRef.current = profileState;
  }, [profileState]);
  useEffect(() => {
    localStorage.setItem("tabellar_inbox_sort", inboxSort);
  }, [inboxSort]);

  const [pendingSentEmail, setPendingSentEmail] = useState<{
    id: string;
    to: string;
    subject: string;
    body_html: string;
    date: string;
  } | null>(null);
  const notifySent = useCallback(
    (email: { to: string; subject: string; body_html: string }) => {
      setPendingSentEmail({
        id: `pending-${Date.now()}`,
        date: new Date().toISOString(),
        ...email,
      });
    },
    [],
  );
  // Stable ref so useLiveUpdates can call addToast without a stale closure
  const addToastRef = useRef<
    | ((
        type: ToastItem["type"],
        msg: string,
        options?: { action?: ToastItem["action"]; duration?: number },
      ) => void)
    | null
  >(null);
  const onBriefingUpdatedRef = useRef<(() => void) | null>(null);

  // View data cache (in-memory, survives view switches but not page reloads)
  const viewCacheRef = useRef<Record<string, ViewCacheEntry>>({});
  const getViewCache = useCallback((key: string) => {
    const entry = viewCacheRef.current[key];
    if (!entry) return null;
    // Cache valid for 5 minutes
    if (Date.now() - entry.timestamp > 5 * 60 * 1000) {
      delete viewCacheRef.current[key];
      return null;
    }
    return entry.data;
  }, []);
  const setViewCache = useCallback((key: string, data: any) => {
    viewCacheRef.current[key] = { data, timestamp: Date.now() };
  }, []);
  const invalidateViewCache = useCallback((...keys: string[]) => {
    for (const key of keys) delete viewCacheRef.current[key];
  }, []);

  // Centralized live updates (realtime + background sync + visibility refresh)
  const { changeCounters: liveChanges, processingCount } = useLiveUpdates(
    user.id,
    profileState?.last_briefing_at ?? null,
    (profileState?.working_hours as {
      start?: string;
      end?: string;
      days?: number[];
    } | null) ?? null,
    {
      addToast: (type, msg) => addToastRef.current?.(type, msg),
      onBriefingUpdated: () => onBriefingUpdatedRef.current?.(),
    },
    profileState?.briefing_scope ?? null,
  );

  // Background prefetch of common view data after initial load
  const prefetchDone = useRef(false);
  useEffect(() => {
    if (prefetchDone.current) return;
    prefetchDone.current = true;
    const supabase = createClient();
    const timer = setTimeout(async () => {
      try {
        const [todosRes, meetingsRes] = await Promise.all([
          supabase
            .from("todos")
            .select("*")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(50),
          supabase
            .from("meetings")
            .select("*")
            .eq("user_id", user.id)
            .gte("start_time", new Date().toISOString())
            .order("start_time", { ascending: true })
            .limit(50),
        ]);
        if (todosRes.data)
          viewCacheRef.current["todos"] = {
            data: todosRes.data,
            timestamp: Date.now(),
          };
        if (meetingsRes.data)
          viewCacheRef.current["meetings_upcoming"] = {
            data: meetingsRes.data,
            timestamp: Date.now(),
          };
      } catch {
        // Non-blocking prefetch
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [user.id]);

  // Memoised: it goes into the context value and into the global shortcut
  // effect's dependencies, both of which would otherwise churn every render.
  const openCompose = useCallback((replyTo?: any, draft?: any) => {
    setComposeReplyTo(replyTo || null);
    setComposeDraft(draft || null);
    setComposeOpen(true);
    setComposeMinimized(false);
  }, []);

  const addToast = useCallback(
    (
      type: ToastItem["type"],
      message: string,
      options?: { action?: ToastItem["action"]; duration?: number },
    ) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((prev) => [
        ...prev,
        {
          id,
          type,
          message,
          action: options?.action,
          duration: options?.duration,
        },
      ]);
    },
    [],
  );
  const notifyBriefingUpdated = useCallback(
    () => setBriefingVersion((v) => v + 1),
    [],
  );

  const invalidateViewCacheRef = useRef(invalidateViewCache);
  invalidateViewCacheRef.current = invalidateViewCache;

  const requestBriefingRegeneration = useCallback(async (scope?: string) => {
    if (scope) pendingScopeRef.current = scope;
    if (briefingGenLockRef.current) return;
    briefingGenLockRef.current = true;
    setBriefingRegenerating(true);
    const supabase = createClient();
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const apiUrl = "/api";
      const scopeToUse = pendingScopeRef.current;
      pendingScopeRef.current = null;
      const briefingUrl = scopeToUse
        ? `${apiUrl}/briefing?scope=${encodeURIComponent(scopeToUse)}`
        : `${apiUrl}/briefing`;
      const res = await fetch(briefingUrl, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.executiveSummary && !data?.briefing) return;
      const briefingData = data.briefing ?? data;
      const ts = Date.now();
      const iso = new Date(ts).toISOString();
      try {
        localStorage.setItem(
          `tabellar_briefing_cache_${user.id}`,
          JSON.stringify({ data: briefingData, ts, scope: scopeToUse ?? profileRef.current?.briefing_scope ?? null }),
        );
      } catch {
        /* ignore */
      }
      await supabase
        .from("profiles")
        .update({
          last_briefing: briefingData,
          last_briefing_at: iso,
        })
        .eq("id", user.id);
      updateProfile({
        last_briefing: briefingData as Profile["last_briefing"],
        last_briefing_at: iso,
      });
      invalidateViewCacheRef.current("briefing");
      notifyBriefingUpdated();
      if (viewRef.current !== "briefing") {
        addToast("info", "Briefing finished updating.");
      }
    } catch (err) {
      console.error("[AppShell] briefing regeneration:", err);
    } finally {
      briefingGenLockRef.current = false;
      setBriefingRegenerating(false);
      // Re-run if a scope change arrived while we were locked
      if (pendingScopeRef.current) {
        void requestBriefingRegenerationRef.current?.();
      }
    }
  }, [
    user.id,
    addToast,
    notifyBriefingUpdated,
    updateProfile,
  ]);

  // Keep refs in sync so useLiveUpdates callbacks can call these without stale closures
  addToastRef.current = addToast;
  onBriefingUpdatedRef.current = notifyBriefingUpdated;
  requestBriefingRegenerationRef.current = requestBriefingRegeneration;

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Solve-Everything agent state ───────────────────────────────────────
  const AGENT_SESSION_KEY = `tabellar_agent_session_${user.id}`;
  const [agentSession, setAgentSession] = useState<AgentSessionState | null>(
    null,
  );
  const [agentTurns, setAgentTurns] = useState<AgentTurnRow[]>([]);
  const [agentWorkspaceOpen, setAgentWorkspaceOpen] = useState(false);
  const [solveAgentCancelInFlight, setSolveAgentCancelInFlight] =
    useState(false);
  const agentUnsubRef = useRef<(() => void) | null>(null);
  const lastStatusRef = useRef<string | null>(null);
  const agentWorkspaceOpenRef = useRef(false);
  useEffect(() => {
    agentWorkspaceOpenRef.current = agentWorkspaceOpen;
  }, [agentWorkspaceOpen]);

  const loadAgentTurns = useCallback(async (sessionId: string) => {
    const supabase = createClient();
    const rows = await apiFetchTurns(supabase, sessionId);
    setAgentTurns(rows);
  }, []);

  const attachAgentRealtime = useCallback(
    (sessionId: string) => {
      agentUnsubRef.current?.();
      const supabase = createClient();
      agentUnsubRef.current = subscribeAgent(supabase, sessionId, {
        onSession: (s) => {
          setAgentSession((prev) => (prev ? { ...prev, ...s } : s));
          // Surface a toast + notification on status transitions when the
          // workspace is closed so the user knows they need to act.
          const prev = lastStatusRef.current;
          if (s.status !== prev) {
            lastStatusRef.current = s.status;
            if (!agentWorkspaceOpenRef.current) {
              if (s.status === "asking") {
                addToast("info", "Solver needs your input");
              } else if (s.status === "ready") {
                addToast("info", "Plan ready for review");
              }
            }
          }
        },
        onTurn: (t) =>
          setAgentTurns((prev) => {
            if (prev.find((p) => p.id === t.id)) return prev;
            return [...prev, t].sort((a, b) => a.idx - b.idx);
          }),
      });
    },
    [addToast],
  );

  // Restore session from sessionStorage on mount.
  useEffect(() => {
    const stored = (() => {
      try {
        const raw = sessionStorage.getItem(AGENT_SESSION_KEY);
        return raw ? (JSON.parse(raw) as { id: string }) : null;
      } catch {
        return null;
      }
    })();
    if (!stored?.id) return;
    const sid = stored.id;
    const looksLikeUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid);
    if (!looksLikeUuid || sid === "__starting__") {
      try {
        sessionStorage.removeItem(AGENT_SESSION_KEY);
      } catch {}
      return;
    }
    const supabase = createClient();
    (async () => {
      const session = await apiFetchSession(supabase, stored.id);
      if (!session) {
        sessionStorage.removeItem(AGENT_SESSION_KEY);
        return;
      }
      setAgentSession(session);
      await loadAgentTurns(stored.id);
      if (
        ["planning", "asking", "executing", "ready"].includes(session.status)
      ) {
        attachAgentRealtime(stored.id);
      }
      // If the session was left in "planning" (e.g. the server stopped before
      // completing), kick the orchestrator so it resumes instead of staying stuck.
      if (session.status === "planning") {
        apiStepAgent(supabase, stored.id).catch(() => {});
      }
    })();
    return () => {
      agentUnsubRef.current?.();
      agentUnsubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [AGENT_SESSION_KEY]);

  // Persist session id whenever it changes.
  useEffect(() => {
    if (!agentSession) {
      try {
        sessionStorage.removeItem(AGENT_SESSION_KEY);
      } catch {}
      return;
    }
    if (agentSession.id === "__starting__") {
      return;
    }
    try {
      sessionStorage.setItem(
        AGENT_SESSION_KEY,
        JSON.stringify({ id: agentSession.id }),
      );
    } catch {}
  }, [agentSession?.id, agentSession, AGENT_SESSION_KEY]);

  const startSolveAgent = useCallback(async () => {
    // Optimistic: open the workspace instantly with a placeholder session so
    // the UI feels instant. The real session_id arrives from the backend shortly
    // and we swap the state in place.
    setAgentSession({
      id: "__starting__",
      status: "planning",
      draft_actions: [],
      pending_question: null,
      plan: null,
      results: {},
    });
    setAgentTurns([]);
    setAgentWorkspaceOpen(true);

    const supabase = createClient();
    try {
      const { session_id } = await apiStartAgent(supabase);
      const session = await apiFetchSession(supabase, session_id);
      if (session) setAgentSession(session);
      else
        setAgentSession((prev) => (prev ? { ...prev, id: session_id } : prev));
      attachAgentRealtime(session_id);
    } catch (err) {
      const msg =
        normalizeAgentSessionError(err) ?? "Could not start solve agent";
      setAgentSession((prev) =>
        prev ? { ...prev, status: "error", error: msg } : prev,
      );
      addToast("error", `Could not start solve agent: ${msg}`);
    }
  }, [addToast, attachAgentRealtime]);

  const answerSolveAgent = useCallback(
    async (answer: AgentAnswer) => {
      if (!agentSession) return;
      const supabase = createClient();
      try {
        setAgentSession((s) =>
          s
            ? {
                ...s,
                pending_question: null,
                pending_questions: [],
                status: "planning",
              }
            : s,
        );
        const result = await apiAnswerAgent(supabase, agentSession.id, answer);
        const full = await apiFetchSession(supabase, agentSession.id);
        if (full) setAgentSession(full);
        await loadAgentTurns(agentSession.id);
        void result;
      } catch (err) {
        addToast("error", `Answer failed: ${(err as Error).message}`);
      }
    },
    [agentSession, addToast, loadAgentTurns],
  );

  const answerSolveAgentBatch = useCallback(
    async (batch: AgentBatchAnswer) => {
      if (!agentSession) return;
      const supabase = createClient();
      try {
        setAgentSession((s) =>
          s
            ? {
                ...s,
                pending_question: null,
                pending_questions: [],
                status: "planning",
              }
            : s,
        );
        const result = await apiAnswerAgentBatch(
          supabase,
          agentSession.id,
          batch,
        );
        const full = await apiFetchSession(supabase, agentSession.id);
        if (full) setAgentSession(full);
        await loadAgentTurns(agentSession.id);
        void result;
      } catch (err) {
        addToast("error", `Answer batch failed: ${(err as Error).message}`);
      }
    },
    [agentSession, addToast, loadAgentTurns],
  );

  const executeSolveAgent = useCallback(
    async (approved: AgentAction[]) => {
      if (!agentSession) return {};
      const supabase = createClient();
      setAgentSession((s) => (s ? { ...s, status: "executing" } : s));
      try {
        const { results } = await apiExecuteAgent(
          supabase,
          agentSession.id,
          approved,
        );
        const full = await apiFetchSession(supabase, agentSession.id);
        if (full) setAgentSession(full);
        const ok = Object.values(results).filter(
          (r) => r.status === "success",
        ).length;
        const bad = Object.values(results).filter(
          (r) => r.status === "error",
        ).length;
        addToast(
          bad ? "error" : "success",
          `Solve finished: ${ok} succeeded${bad ? `, ${bad} failed` : ""}`,
        );
        return results;
      } catch (err) {
        addToast("error", `Execute failed: ${(err as Error).message}`);
        return {} as Record<
          string,
          { status: "success" | "error"; info?: string; error?: string }
        >;
      }
    },
    [agentSession, addToast],
  );

  const cancelSolveAgent = useCallback(async () => {
    if (!agentSession) return;
    // Placeholder session (optimistic open before the backend has created the
    // real session). Just nuke local state.
    if (agentSession.id === "__starting__") {
      agentUnsubRef.current?.();
      agentUnsubRef.current = null;
      setAgentSession(null);
      setAgentTurns([]);
      setAgentWorkspaceOpen(false);
      addToast("info", "Cancelled");
      return;
    }
    setSolveAgentCancelInFlight(true);
    agentUnsubRef.current?.();
    agentUnsubRef.current = null;
    const supabase = createClient();
    const sid = agentSession.id;
    try {
      const { data: updated, error } = await supabase
        .from("agent_sessions")
        .update({
          status: "cancelled",
          pending_question: null,
          pending_questions: [],
        })
        .eq("id", sid)
        .eq("user_id", user.id)
        .select(
          "id, status, draft_actions, pending_question, pending_questions, plan, results, summary, error, updated_at, briefing_at, parent_id, bucket",
        )
        .maybeSingle();

      if (error) throw error;

      if (updated) {
        setAgentSession({
          ...(updated as unknown as AgentSessionState),
          error: normalizeAgentSessionError(
            (updated as { error?: unknown }).error,
          ) as string | null | undefined,
        });
      } else {
        await apiCancelAgent(supabase, sid);
        const full = await apiFetchSession(supabase, sid);
        if (full) setAgentSession(full);
        else
          setAgentSession((prev) =>
            prev ? { ...prev, status: "cancelled" } : prev,
          );
      }

      addToast("info", "Plan cancelled");
    } catch {
      try {
        await apiCancelAgent(supabase, sid);
        const full = await apiFetchSession(supabase, sid);
        if (full) setAgentSession(full);
        else
          setAgentSession((prev) =>
            prev ? { ...prev, status: "cancelled" } : prev,
          );
        addToast("info", "Plan cancelled");
      } catch {
        addToast("error", "Could not cancel plan");
      }
    } finally {
      setSolveAgentCancelInFlight(false);
    }
  }, [agentSession, addToast, user.id]);

  const resetSolveAgent = useCallback(() => {
    agentUnsubRef.current?.();
    agentUnsubRef.current = null;
    setAgentSession(null);
    setAgentTurns([]);
    setAgentWorkspaceOpen(false);
    try {
      sessionStorage.removeItem(AGENT_SESSION_KEY);
    } catch {}
  }, [AGENT_SESSION_KEY]);

  const openAgentWorkspace = useCallback(() => setAgentWorkspaceOpen(true), []);
  const closeAgentWorkspace = useCallback(
    () => setAgentWorkspaceOpen(false),
    [],
  );

  // ── Global keyboard shortcuts ────────────────────────────────────────────
  // View-scoped shortcuts (j/k and the like) stay in their own views; this
  // layer owns navigation and the actions that make sense from anywhere.
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const goToPending = useRef(false);
  const goToTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Never steal a key from a text field, and never from a modifier combo,
      // which belongs to the browser or the OS.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        // Escape should still get you out of the search box.
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (document.querySelector("[data-compose-modal]")) return;

      if (e.key === "Escape") {
        setShowShortcutsHelp(false);
        goToPending.current = false;
        return;
      }

      // Second key of a "g" sequence
      if (goToPending.current) {
        goToPending.current = false;
        if (goToTimer.current) clearTimeout(goToTimer.current);
        const target = GO_TO_VIEWS[e.key.toLowerCase()];
        if (target) {
          e.preventDefault();
          setView(target);
        }
        return;
      }

      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        goToPending.current = true;
        // Abandon the sequence if the second key never comes, so a stray g
        // does not swallow the next real shortcut.
        if (goToTimer.current) clearTimeout(goToTimer.current);
        goToTimer.current = setTimeout(() => {
          goToPending.current = false;
        }, 1500);
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        setShowShortcutsHelp((v) => !v);
        return;
      }

      if (e.key === "/") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(
          "[data-search-input]",
        );
        input?.focus();
        input?.select();
        return;
      }

      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        openCompose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (goToTimer.current) clearTimeout(goToTimer.current);
    };
  }, [setView, openCompose]);

  // Polling fallback: re-sync session every 5s while active, in case a
  // Realtime UPDATE event was missed (requires REPLICA IDENTITY FULL which is
  // now set, but belt-and-suspenders keeps the UI from getting stuck).
  useEffect(() => {
    const sid = agentSession?.id;
    if (!sid || sid === "__starting__") return;
    if (!["planning", "asking", "executing"].includes(agentSession?.status ?? ""))
      return;
    const interval = setInterval(async () => {
      const supabase = createClient();
      const session = await apiFetchSession(supabase, sid);
      if (!session) return;
      setAgentSession((prev) => (prev ? { ...prev, ...session } : session));
      await loadAgentTurns(sid);
    }, 5000);
    return () => clearInterval(interval);
  }, [agentSession?.id, agentSession?.status, loadAgentTurns]);

  const [pendingMeetingSchedule, setPendingMeetingSchedule] = useState<AppContextType["pendingMeetingSchedule"]>(null);
  return (
    <AppContext.Provider
      value={{
        user,
        profile: profileState,
        updateProfile,
        view,
        setView,
        sidebarOpen,
        setSidebarOpen,
        theme,
        setTheme,
        openCompose,
        addToast,
        search,
        setSearch,
        syncing,
        setSyncing,
        inboxFilters,
        setInboxFilters,
        inboxSort,
        setInboxSort,
        inboxCustomCategories,
        setInboxCustomCategories,
        inboxCustomTags,
        setInboxCustomTags,
        draftVersion,
        notifyDraftChange,
        pendingSentEmail,
        notifySent,
        getViewCache,
        setViewCache,
        invalidateViewCache,
        liveChanges,
        processingCount,
        briefingVersion,
        notifyBriefingUpdated,
        briefingRegenerating,
        requestBriefingRegeneration,
        assistantOpen,
        agentSession,
        agentTurns,
        agentWorkspaceOpen,
        openAgentWorkspace,
        closeAgentWorkspace,
        startSolveAgent,
        answerSolveAgent,
        answerSolveAgentBatch,
        executeSolveAgent,
        cancelSolveAgent,
        solveAgentCancelInFlight,
        resetSolveAgent,
        pendingMeetingSchedule,
        setPendingMeetingSchedule,
      }}
    >
      <div className={`${theme} h-screen flex flex-col overflow-hidden`}>
        <TopBar />
        <div
          className="flex flex-1 overflow-hidden"
          style={{
            marginRight: assistantOpen ? "380px" : "0",
            transition: "margin-right 0.2s ease",
          }}
        >
          <Sidebar />
          <main className="flex-1 overflow-auto bg-[var(--background)]">
            {children}
          </main>
        </div>

        {composeOpen && !composeMinimized && (
          <ComposeModal
            replyTo={composeReplyTo}
            draft={composeDraft}
            onClose={() => {
              setComposeOpen(false);
              setComposeDraft(null);
            }}
            onMinimize={() => setComposeMinimized(true)}
          />
        )}

        {composeOpen && composeMinimized && (
          <button
            onClick={() => setComposeMinimized(false)}
            className="fixed bottom-0 z-50 flex items-center gap-2 px-4 py-2.5 rounded-t-xl bg-[var(--accent)] text-white text-sm font-medium shadow-lg hover:opacity-90 transition-opacity"
            style={{
              right: assistantOpen ? "388px" : "16px",
              transition: "right 0.2s ease",
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: "18px" }}
            >
              edit
            </span>
            {composeReplyTo ? "Reply" : "New Email"}
            <span
              onClick={(e) => {
                e.stopPropagation();
                setComposeOpen(false);
              }}
              className="material-symbols-outlined ml-2 hover:text-white/70 cursor-pointer"
              style={{ fontSize: "16px" }}
            >
              close
            </span>
          </button>
        )}

        {/* Floating assistant button */}
        {!assistantOpen && (
          <button
            onClick={() => setAssistantOpen(true)}
            className="fixed bottom-16 z-40 rounded-full bg-[var(--accent)] text-white shadow-lg hover:opacity-90 active:scale-95 transition-all flex items-center justify-center"
            title="Open Assistant"
            style={{
              width: "52px",
              height: "52px",
              right: "32px",
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: "24px" }}
            >
              assistant
            </span>
          </button>
        )}

        <AssistantPanel
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
        />

        <ToastContainer toasts={toasts} removeToast={removeToast} />
        <ShortcutsHelp
          open={showShortcutsHelp}
          onClose={() => setShowShortcutsHelp(false)}
        />
        <AgentWorkspace
          open={agentWorkspaceOpen}
          onClose={closeAgentWorkspace}
        />
      </div>
    </AppContext.Provider>
  );
}
