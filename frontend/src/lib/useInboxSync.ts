// The window's first fetch, with its progress overlay. After that the server
// watches Gmail itself and new mail reaches the window over /events.
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/db";
import { useApp } from "@/components/AppShell";

export function useInboxSync(reload: () => Promise<void> | void) {
  const { user, profile, invalidateViewCache } = useApp();
  const supabase = createClient();
  const [syncError, setSyncError] = useState<string | null>(null);
  const [initialPhase, setInitialPhase] = useState(-1);
  const [noAccountsConnected, setNoAccountsConnected] = useState(false);
  // Whether this user has ever synced emails (a database count, not React state).
  const [isFirstEver, setIsFirstEver] = useState<boolean | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    supabase
      .from("gmail_accounts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_active", true)
      .then(({ count }: { count: number | null }) => setNoAccountsConnected((count ?? 0) === 0));
    supabase
      .from("emails")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .then(({ count }: { count: number | null }) => setIsFirstEver((count ?? 0) === 0));
  }, [user.id]);

  const syncInbox = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSyncError(null);
    setInitialPhase(1);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return setSyncError("Session expired. Reload the window.");
      const res = await fetch("/api/fetch-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ initial: true }),
      });
      if (!res.ok) {
        const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Error ${res.status}`;
        if (msg === "No Gmail account connected") setNoAccountsConnected(true);
        else setSyncError(msg);
        return;
      }
      // The newest mail is in. The server reads the rest in the background
      // (sorting, the briefing, 90 days of senders) and the inbox fills in as
      // it lands.
      invalidateViewCache("inbox", "inbox:smart");
      try {
        sessionStorage.removeItem(`inbox:${user.id}:smart`);
        sessionStorage.removeItem(`inbox:${user.id}:newest`);
      } catch {}
      await reload();
    } catch {
      setSyncError("Network error. Check your connection.");
    } finally {
      setInitialPhase(-1);
      busy.current = false;
    }
  }, [user.id, reload]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("initial")) {
      url.searchParams.delete("initial");
      window.history.replaceState({}, "", url.toString());
    }
    if (isFirstEver && profile) syncInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFirstEver]);

  return { syncInbox, syncError, initialPhase, noAccountsConnected, isFirstEver };
}
