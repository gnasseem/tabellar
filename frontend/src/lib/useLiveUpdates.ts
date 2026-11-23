
import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/db";

// Live updates: one channel on /events for the tables the views show (the
// server fetches and reads new mail itself), and the briefing kept current
// every few minutes and when the window comes back to the front.

type TableName =
  | "emails"
  | "email_processed"
  | "todos"
  | "meetings"
  | "draft_emails"
  | "scheduled_emails"
  | "action_log"
  | "questions";


// How often the briefing is looked at.
const BRIEFING_INTERVAL = 5 * 60 * 1000;
// Minimum time between briefing updates (ms)
const BRIEFING_COOLDOWN_MS = 30 * 60 * 1000;

function isToday(isoOrMs: string | number | null | undefined): boolean {
  if (!isoOrMs) return false;
  const d = new Date(isoOrMs as string);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export type LiveChangeCounters = Record<TableName, number>;

type WorkingHours = { start?: string; end?: string; days?: number[] } | null;

function isWithinWorkingHours(wh: WorkingHours): boolean {
  if (!wh) return true;
  const now = new Date();
  const days = wh.days || [1, 2, 3, 4, 5];
  if (!days.includes(now.getDay())) return false;
  const [startH, startM] = (wh.start || "09:00").split(":").map(Number);
  const [endH, endM] = (wh.end || "17:00").split(":").map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= startH * 60 + startM && mins < endH * 60 + endM;
}

export function useLiveUpdates(
  userId: string,
  lastBriefingAt: string | null,
  workingHours: WorkingHours,
  callbacks?: {
    addToast: (type: "success" | "error" | "info", msg: string) => void;
    onBriefingUpdated?: () => void;
  },
  briefingScope?: string | null,
) {
  const supabase = createClient();
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const briefingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastVisibilityRefresh = useRef<number>(0);
  const briefingBusy = useRef(false);

  // Keep callbacks in a ref so refreshBriefing doesn't need them as a dependency.
  // This prevents the inline callbacks object in AppShell from invalidating
  // refreshBriefing on every render, which was clearing the interval before it fired.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const workingHoursRef = useRef(workingHours);
  workingHoursRef.current = workingHours;

  // Per-table change counters; views useEffect on these to re-fetch
  const [changeCounters, setChangeCounters] = useState<LiveChangeCounters>({
    emails: 0,
    email_processed: 0,
    todos: 0,
    meetings: 0,
    draft_emails: 0,
    scheduled_emails: 0,
    action_log: 0,
    questions: 0,
  });

  const bumpTable = useCallback((table: TableName) => {
    setChangeCounters((prev) => ({ ...prev, [table]: prev[table] + 1 }));
  }, []);

  // ── Live-update subscriptions ──
  useEffect(() => {
    const subscribe = () => {
      const channel = supabase.channel(`live-updates-${userId}`);

      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "emails", filter: `user_id=eq.${userId}` },
        () => bumpTable("emails"),
      );
      channel.on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "emails",
          filter: `user_id=eq.${userId}`,
        },
        () => bumpTable("emails"),
      );
      channel.on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "emails",
          filter: `user_id=eq.${userId}`,
        },
        () => bumpTable("emails"),
      );

      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "email_processed", filter: `user_id=eq.${userId}` },
        () => bumpTable("email_processed"),
      );
      channel.on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "email_processed",
          filter: `user_id=eq.${userId}`,
        },
        () => bumpTable("email_processed"),
      );
      // Rows the background engine writes while the window is open.
      for (const table of ["action_log", "draft_emails", "todos", "meetings", "questions"] as const) {
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `user_id=eq.${userId}` },
          () => bumpTable(table),
        );
      }
      channel.subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setTimeout(() => {
            if (channelRef.current) {
              supabase.removeChannel(channelRef.current);
            }
            channelRef.current = null;
            subscribe();
          }, 3000);
        }
      });

      channelRef.current = channel;
    };

    subscribe();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [userId, supabase, bumpTable]);

  // ── The briefing ──
  const refreshBriefing = useCallback(async () => {
    if (briefingBusy.current) return;

    briefingBusy.current = true;
    try {
      const apiUrl = "/api";
      let {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        session = refreshed.session;
      }
      if (!session?.access_token) return;

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      };

      // Auto-create first, refresh on new day, or update incrementally.
      const briefingCooldownKey = `tabellar_briefing_ts_${userId}`;
      const lastBriefingUpdate = parseInt(
        localStorage.getItem(briefingCooldownKey) || "0",
      );
      const cooldownElapsed =
        Date.now() - lastBriefingUpdate >= BRIEFING_COOLDOWN_MS;

      // Resolve the current cached briefing and its timestamp.
      // Skip empty localStorage briefings  -  they may be stale scope-mismatch artifacts.
      // Fall back to DB which always has the authoritative version.
      let previousBriefing: unknown = null;
      let briefingTimestamp: string | null = lastBriefingAt;

      const briefingHasContent = (b: unknown): boolean => {
        if (!b || typeof b !== "object") return false;
        const d = b as Record<string, unknown>;
        return (
          (Array.isArray(d.crucial) && d.crucial.length > 0) ||
          (Array.isArray(d.replyNeeded) && d.replyNeeded.length > 0) ||
          (Array.isArray(d.deadlines) && d.deadlines.length > 0) ||
          (Array.isArray(d.nonEssential) && d.nonEssential.length > 0)
        );
      };

      const localCached = localStorage.getItem(
        `tabellar_briefing_cache_${userId}`,
      );
      if (localCached) {
        try {
          const parsed = JSON.parse(localCached);
          if (parsed?.data && briefingHasContent(parsed.data)) {
            previousBriefing = parsed.data;
            if (parsed.ts)
              briefingTimestamp = new Date(parsed.ts).toISOString();
          }
        } catch {
          /* ignore */
        }
      }

      if (!previousBriefing) {
        try {
          const { data: row } = await supabase
            .from("profiles")
            .select("last_briefing, last_briefing_at")
            .eq("id", userId)
            .single();
          if (row?.last_briefing) {
            previousBriefing = row.last_briefing;
            briefingTimestamp = row.last_briefing_at ?? null;
          }
        } catch {
          /* ignore */
        }
      }

      const noBriefing = !previousBriefing;
      const briefingIsStale = previousBriefing && !isToday(briefingTimestamp);

      const runCloudFreshBriefing = async (): Promise<boolean> => {
        try {
          // Use user's configured scope; fall back to safe defaults only if not set.
          const scope = briefingScope ?? (briefingIsStale ? "today_new" : "all_recent");
          const freshRes = await fetch(`${apiUrl}/briefing?scope=${encodeURIComponent(scope)}`, {
            headers,
          });
          if (!freshRes.ok) return false;
          const freshJson = await freshRes.json();
          const freshData = freshJson.briefing ?? freshJson;
          if (freshData?.executiveSummary === undefined) return false;
          const ts = Date.now();
          localStorage.setItem(
            `tabellar_briefing_cache_${userId}`,
            JSON.stringify({ data: freshData, ts, scope }),
          );
          localStorage.setItem(briefingCooldownKey, String(ts));
          await supabase
            .from("profiles")
            .update({
              last_briefing: freshData,
              last_briefing_at: new Date(ts).toISOString(),
            })
            .eq("id", userId);
          callbacksRef.current?.onBriefingUpdated?.();
          return true;
        } catch (err) {
          console.error("[useLiveUpdates] cloud fresh briefing:", err);
          return false;
        }
      };

      // Generate a fresh full briefing  -  used for first-ever creation and new-day refresh.
      const generateFreshBriefing = async () => {
        await runCloudFreshBriefing();
      };

      if (noBriefing) {
        // First-ever briefing  -  generate immediately regardless of working hours or cooldown.
        await generateFreshBriefing();
      } else if (
        briefingIsStale &&
        isWithinWorkingHours(workingHoursRef.current)
      ) {
        // New day and within working hours  -  generate a fresh full briefing.
        await generateFreshBriefing();
      } else if (
        cooldownElapsed &&
        isWithinWorkingHours(workingHoursRef.current)
      ) {
        // Existing briefing from today  -  do a smart incremental update.
        const runCloudIncrementalUpdate = async (): Promise<boolean> => {
          try {
            if (!previousBriefing || !briefingTimestamp) return false;
            const updateRes = await fetch(`${apiUrl}/briefing/update`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                previous_briefing: previousBriefing,
                since: briefingTimestamp,
              }),
            });

            if (!updateRes.ok) return false;
            const { briefing, updated } = await updateRes.json();
            if (!briefing) return false;

            const ts = Date.now();
            localStorage.setItem(
              `tabellar_briefing_cache_${userId}`,
              JSON.stringify({ data: briefing, ts }),
            );
            localStorage.setItem(briefingCooldownKey, String(ts));
            if (updated) {
              await supabase
                .from("profiles")
                .update({
                  last_briefing: briefing,
                  last_briefing_at: new Date(ts).toISOString(),
                })
                .eq("id", userId);
            }
            callbacksRef.current?.onBriefingUpdated?.();
            return true;
          } catch (err) {
            console.error("[useLiveUpdates] cloud briefing update:", err);
            return false;
          }
        };

        await runCloudIncrementalUpdate();
      }
    } catch (err) {
      console.error("[useLiveUpdates] briefing:", err);
    } finally {
      briefingBusy.current = false;
    }
  }, [userId, supabase, lastBriefingAt]);

  // Keep the timer pointed at the current closure without making the
  // timer effect depend on its identity.
  const refreshBriefingRef = useRef(refreshBriefing);
  useEffect(() => {
    refreshBriefingRef.current = refreshBriefing;
  }, [refreshBriefing]);

  // ── The briefing timer ──
  // Mount-only: depending on refreshBriefing would restart the interval and
  // fire an extra immediate run every time lastBriefingAt changed.
  useEffect(() => {
    refreshBriefingRef.current();
    briefingTimer.current = setInterval(
      () => refreshBriefingRef.current(),
      BRIEFING_INTERVAL,
    );
    return () => {
      if (briefingTimer.current) clearInterval(briefingTimer.current);
    };
  }, []);

  // ── When the window comes back to the front ──
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastVisibilityRefresh.current < 2 * 60_000) return;
      lastVisibilityRefresh.current = now;

      refreshBriefingRef.current();
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return { changeCounters };
}
