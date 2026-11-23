
import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/db";

// Live updates: one channel on /events for the tables the views show (the
// server fetches and reads new mail itself).

type TableName =
  | "emails"
  | "email_processed"
  | "todos"
  | "meetings"
  | "draft_emails"
  | "scheduled_emails"
  | "action_log"
  | "questions"
  | "follow_up_reminders";


export type LiveChangeCounters = Record<TableName, number>;

export function useLiveUpdates(userId: string) {
  const supabase = createClient();
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

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
    follow_up_reminders: 0,
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
      for (const table of ["action_log", "draft_emails", "todos", "meetings", "questions", "follow_up_reminders"] as const) {
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

  return { changeCounters };
}
