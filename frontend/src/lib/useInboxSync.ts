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

      // First fetch: the newest mail is in. The server reads the rest in the
      // background (sorting, the briefing, 90 days of senders) and the inbox
      // fills in as it lands.
      if (isFirstFetch || newEmailCount === 0) {
        invalidateViewCache("inbox", "inbox:smart");
        try { sessionStorage.removeItem(`inbox:${user.id}:smart`); sessionStorage.removeItem(`inbox:${user.id}:newest`); } catch {}
        await reload();
        setInitialPhase(-1);
        return;
      }

      const analyzePromise = fetch(`${apiUrl}/analyze-inbox`, { method: "POST", headers })
        .then((r) => r.ok)
        .catch(() => false);

      // The briefing never blocks the window.
      void (async () => {
        await analyzePromise;
        if (!mountedRef.current) return;
        try {
          const briefingRes = await fetch(`${apiUrl}/briefing?scope=all_recent`, { headers });
          if (!briefingRes.ok) return;
          const briefingJson = await briefingRes.json();
          const briefingData = briefingJson.briefing ?? briefingJson;
          if (briefingData?.executiveSummary !== undefined) {
            const ts = Date.now();
            try {
              localStorage.setItem(`tabellar_briefing_cache_${user.id}`, JSON.stringify({ data: briefingData, ts }));
            } catch {
              /* ignore */
            }
            await supabase
              .from("profiles")
              .update({ last_briefing: briefingData, last_briefing_at: new Date(ts).toISOString() })
              .eq("id", user.id);
            notifyBriefingUpdated();
          }
        } catch {
          /* non-blocking */
        }
      })();

      await analyzePromise;
      invalidateViewCache("inbox", "inbox:smart");
      try { sessionStorage.removeItem(`inbox:${user.id}:smart`); sessionStorage.removeItem(`inbox:${user.id}:newest`); } catch {}
      await reload();
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
