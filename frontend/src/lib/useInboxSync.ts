// Bringing mail in from the window: the first fetch with its progress overlay,
// and the catch-up sync each time the window opens. The background engine does
// the same on its own every two minutes; this is the part the window drives.
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/db";
import { useApp } from "@/components/AppShell";

export function useInboxSync(reload: () => Promise<void> | void) {
  const { user, profile, addToast, setSyncing, invalidateViewCache, notifyBriefingUpdated } = useApp();
  const supabase = createClient();
  const [syncing, setSyncingLocal] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [initialPhase, setInitialPhase] = useState(-1);
  const [syncMode, setSyncMode] = useState<"initial" | "refresh">("initial");
  const [noAccountsConnected, setNoAccountsConnected] = useState(false);
  const autoSyncAttempted = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // Whether this user has ever synced emails (a database count, not React state).
  const [isFirstEver, setIsFirstEver] = useState<boolean | null>(null);

  useEffect(() => {
    supabase
      .from("gmail_accounts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_active", true)
      .then(({ count }: { count: number | null }) => setNoAccountsConnected((count ?? 0) === 0));
  }, [user.id]);

  useEffect(() => {
    supabase
      .from("emails")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .then(({ count }: { count: number | null }) => setIsFirstEver((count ?? 0) === 0));
  }, [user.id]);

  const syncInbox = useCallback(async () => {
    if (syncing) return;
    setSyncingLocal(true);
    setSyncing(true);
    setSyncError(null);
    const isFirstFetch = isFirstEver === true;
    setSyncMode(isFirstFetch ? "initial" : "refresh");

    try {
      const apiUrl = "/api";
      let {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        session = refreshed.session;
      }
      if (!session?.access_token) {
        setSyncError(
          "Session expired. Please reload the page and sign in again.",
        );
        return;
      }
      let headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      };

      const handleAuthRefresh = async (): Promise<boolean> => {
        const { data: refreshed } = await supabase.auth.refreshSession();
        if (!refreshed.session?.access_token) return false;
        session = refreshed.session;
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        };
        return true;
      };

      const handleFetchError = async (
        res: Response,
        isRetry = false,
      ): Promise<boolean> => {
        if (res.status === 401) {
          if (isRetry) {
            setSyncError(
              "Authentication failed. Please sign out and sign in again.",
            );
            return true;
          }
          const refreshed = await handleAuthRefresh();
          if (!refreshed) {
            setSyncError(
              "Session expired. Please reload the page and sign in again.",
            );
            return true;
          }
          return false;
        }
        const err = await res.json().catch(() => ({}));
        const msg = (err as { error?: string }).error ?? `Error ${res.status}`;
        if (msg === "No Gmail account connected") {
          setNoAccountsConnected(true);
        } else {
          setSyncError(msg);
        }
        return true;
      };

      // Phase 1: Fetch new emails from Gmail
      // Only show the blocking overlay for the very first sync
      if (isFirstFetch) {
        setInitialPhase(0);
        setInitialPhase(1);
      }
      const fetchBody = JSON.stringify({
        initial: isFirstFetch,
      });
      let fetchRes = await fetch(`${apiUrl}/fetch-emails`, {
        method: "POST",
        headers,
        body: fetchBody,
      });
      if (!fetchRes.ok) {
        const shouldRetry = !(await handleFetchError(fetchRes));
        if (shouldRetry) {
          fetchRes = await fetch(`${apiUrl}/fetch-emails`, {
            method: "POST",
            headers,
            body: fetchBody,
          });
        }
        if (!fetchRes.ok) {
          await handleFetchError(fetchRes, true);
          setInitialPhase(-1);
          return;
        }
      }
      const fetchData = await fetchRes.json();
      const newEmailCount: number = fetchData.fetched ?? 0;
      const backgroundPipeline: boolean =
        fetchData.background_pipeline === true;

      // Fast path: no new emails and not first fetch.
      if (newEmailCount === 0 && !isFirstFetch) {
        invalidateViewCache("inbox", "inbox:smart");
        try { sessionStorage.removeItem(`inbox:${user.id}:smart`); sessionStorage.removeItem(`inbox:${user.id}:newest`); } catch {}
        await reload();
        setInitialPhase(-1);
        return;
      }

      const shouldAnalyze = newEmailCount > 0 || isFirstFetch;

      // For initial fetch, learn writing style in parallel (fire and forget)
      if (isFirstFetch) {
        fetch(`${apiUrl}/learn-style`, { method: "POST", headers }).catch(
          () => {},
        );
      }

      // On the initial fetch the backend has already kicked off
      // analysis + briefing in the background via EdgeRuntime.waitUntil, so
      // we don't hit /analyze-inbox at all; we just wait for email_processed
      // rows to show up via Realtime (see the overlay's poll/subscribe below).
      const cloudBackgroundHandled = backgroundPipeline;
      const analyzePromise: Promise<unknown> = shouldAnalyze
        ? cloudBackgroundHandled
          ? Promise.resolve()
          : fetch(`${apiUrl}/analyze-inbox`, { method: "POST", headers })
              .then((r) => r.ok)
              .catch(() => false)
        : Promise.resolve();

      // Briefing is fire-and-forget from the frontend's perspective; it never
      // blocks the overlay. On the initial fetch the backend also writes
      // last_briefing itself, so we skip the HTTP call and rely on a profiles
      // realtime/polling pickup. For non-initial fetches we still fetch
      // so the BriefingView gets a fresh snapshot.
      void (async () => {
        try {
          await analyzePromise;
        } catch {
          /* ignore */
        }
        if (!mountedRef.current) return;

        if (cloudBackgroundHandled) {
          // Backend owns briefing generation. Poll profiles.last_briefing_at
          // briefly (backend usually lands it within ~10s) then notify.
          for (let i = 0; i < 60; i++) {
            const { data: p } = await supabase
              .from("profiles")
              .select("last_briefing, last_briefing_at")
              .eq("id", user.id)
              .single();
            if (p?.last_briefing && p.last_briefing_at) {
              try {
                const ts = new Date(p.last_briefing_at as string).getTime();
                localStorage.setItem(
                  `tabellar_briefing_cache_${user.id}`,
                  JSON.stringify({ data: p.last_briefing, ts }),
                );
              } catch {
                /* ignore */
              }
              notifyBriefingUpdated();
              return;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          return;
        }

        try {
          const briefingRes = await fetch(
            `${apiUrl}/briefing?scope=all_recent`,
            { headers },
          );
          if (!briefingRes.ok) return;
          const briefingJson = await briefingRes.json();
          const briefingData = briefingJson.briefing ?? briefingJson;
          if (briefingData?.executiveSummary !== undefined) {
            const ts = Date.now();
            try {
              localStorage.setItem(
                `tabellar_briefing_cache_${user.id}`,
                JSON.stringify({ data: briefingData, ts }),
              );
            } catch {
              /* ignore */
            }
            await supabase
              .from("profiles")
              .update({
                last_briefing: briefingData,
                last_briefing_at: new Date(ts).toISOString(),
              })
              .eq("id", user.id);
            notifyBriefingUpdated();
          }
        } catch {
          /* non-blocking */
        }
      })();

      if (isFirstFetch) {
        // Keep the overlay visible until every fetched inbox email has an
        // email_processed row. This ensures the user never lands on a
        // half-processed inbox. Safety timeout at 5 minutes as an absolute cap.
        setInitialPhase(2);
        const safetyTimer = setTimeout(() => {
          if (!mountedRef.current) return;
          setInitialPhase(-1);
          invalidateViewCache("inbox", "inbox:smart");
        try { sessionStorage.removeItem(`inbox:${user.id}:smart`); sessionStorage.removeItem(`inbox:${user.id}:newest`); } catch {}
          reload();
        }, 300_000);

        // Realtime shortcut: the backend micro-batches email_processed
        // upserts, so we subscribe and short-circuit the poll as soon as
        // processed count >= total (no need to wait the 500ms tick).
        let remoteDoneResolve: (() => void) | null = null;
        const remoteDonePromise = new Promise<void>((r) => {
          remoteDoneResolve = r;
        });
        const checkDone = async (): Promise<number> => {
          const [totalRes, processedRes] = await Promise.all([
            supabase
              .from("emails")
              .select("id", { count: "exact", head: true })
              .eq("user_id", user.id)
              .eq("is_archived", false)
              .not("label_ids", "cs", '{"SENT"}'),
            supabase
              .from("email_processed")
              .select("email_id", { count: "exact", head: true })
              .eq("user_id", user.id),
          ]);
          const total = totalRes.count ?? 0;
          const processedCount = processedRes.count ?? 0;
          return Math.max(0, total - processedCount);
        };

        const processedChannel = supabase
          .channel(`initial-processed-${user.id}`)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "email_processed",
              filter: `user_id=eq.${user.id}`,
            },
            () => {
              checkDone().then((n) => {
                if (n === 0) remoteDoneResolve?.();
              });
            },
          )
          .subscribe();

        await Promise.allSettled([analyzePromise]);

        // Fast poll (500ms) after backend work completes, racing the realtime
        // notifier so whichever fires first dismisses the overlay.
        const pollLoop = (async () => {
          for (let tick = 0; tick < 360; tick++) {
            if (!mountedRef.current) break;
            const remaining = await checkDone();
            if (remaining === 0) return;
            await new Promise((r) => setTimeout(r, 500));
          }
        })();

        await Promise.race([pollLoop, remoteDonePromise]);
        try {
          await supabase.removeChannel(processedChannel);
        } catch {
          /* noop */
        }

        clearTimeout(safetyTimer);
        if (!mountedRef.current) return;
        setInitialPhase(3);
        invalidateViewCache("inbox", "inbox:smart");
        try { sessionStorage.removeItem(`inbox:${user.id}:smart`); sessionStorage.removeItem(`inbox:${user.id}:newest`); } catch {}
        await reload();
        setInitialPhase(-1);
      } else {
        // Non-initial sync: run in background, no blocking overlay
        await Promise.allSettled([analyzePromise]);
        invalidateViewCache("inbox", "inbox:smart");
        try { sessionStorage.removeItem(`inbox:${user.id}:smart`); sessionStorage.removeItem(`inbox:${user.id}:newest`); } catch {}
        await reload();
      }
    } catch {
      setSyncError("Network error - check your connection.");
      setInitialPhase(-1);
    } finally {
      setSyncingLocal(false);
      setSyncing(false);
    }
  }, [
    isFirstEver,
    syncing,
    reload,
    addToast,
    setSyncing,
    notifyBriefingUpdated,
  ]);

  // Auto-sync on every login for all modes.
  // Sets up the Gmail watch so push notifications work, catches emails
  // missed since last session.
  useEffect(() => {
    if (isFirstEver === null) return; // wait for DB count check
    if (!profile) return; // wait for profile
    if (autoSyncAttempted.current) return;

    autoSyncAttempted.current = true;

    // Clean up URL param if present
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.has("initial")) {
        url.searchParams.delete("initial");
        window.history.replaceState({}, "", url.toString());
      }
    }

    syncInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFirstEver]);

  return { syncInbox, syncing, syncError, initialPhase, syncMode, noAccountsConnected, isFirstEver };
}
