// v3
import { useState, useEffect, useCallback, useRef } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";

export default function ScheduledView() {
  const { user, liveChanges, openCompose } = useApp();
  const supabase = createClient();
  const [scheduled, setScheduled] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadScheduled = useCallback(async () => {
    try {
      const { data, error: fetchErr } = await supabase
        .from("scheduled_emails")
        .select("*")
        .eq("user_id", user.id)
        .order("send_at", { ascending: true })
        .limit(200);
      if (fetchErr) throw fetchErr;
      setScheduled(data || []);
      setError(null);
    } catch {
      setError("Failed to load scheduled emails. Try reloading.");
    } finally {
      setLoading(false);
    }
  }, [user.id, supabase]);

  useEffect(() => { loadScheduled(); }, [loadScheduled]);

  // Live updates: re-fetch when scheduled_emails table changes
  const prevScheduledChange = useRef(liveChanges.scheduled_emails);
  useEffect(() => {
    if (liveChanges.scheduled_emails !== prevScheduledChange.current) {
      prevScheduledChange.current = liveChanges.scheduled_emails;
      loadScheduled();
    }
  }, [liveChanges.scheduled_emails, loadScheduled]);

  const cancelScheduled = async (id: string) => {
    await supabase
      .from("scheduled_emails")
      .update({ status: "cancelled" })
      .eq("id", id);
    setScheduled((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: "cancelled" } : s)),
    );
  };

  const statusColors: Record<string, string> = {
    pending: "bg-field text-ink2",
    sent: "bg-ok-soft text-ok",
    failed: "bg-danger-soft text-danger",
    cancelled: "bg-field text-ink2",
  };

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-ink mb-4">
        Scheduled Emails
      </h1>
      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-danger-soft border border-danger-line text-danger text-sm flex items-center gap-2">
          <Icon name="error" size={16} />
          {error}
        </div>
      )}
      {loading ? (
        <p className="text-sm text-ink3">Loading…</p>
      ) : scheduled.length === 0 ? (
        <div className="text-center py-12 text-ink3">
          <Icon name="schedule_send" size={48} className="mb-2" />
          <p className="text-sm">No scheduled emails.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {scheduled.map((s) => (
            <div
              key={s.id}
              onClick={() => {
                if (s.status === "pending") {
                  openCompose(undefined, { _scheduledId: s.id, ...s });
                }
              }}
              className={`p-4 rounded-xl border border-line flex items-center gap-3 ${s.status === "pending" ? "cursor-pointer hover:bg-hover" : ""}`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink truncate">
                  {s.subject}
                </p>
                <p className="text-xs text-ink3">
                  To: {s.to_addresses?.join(", ")} · Sends:{" "}
                  {new Date(s.send_at).toLocaleString()}
                </p>
              </div>
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[s.status]}`}
              >
                {s.status}
              </span>
              {s.status === "pending" && (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); openCompose(undefined, { _scheduledId: s.id, ...s }); }}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-field text-ink2 hover:bg-field text-xs font-medium"
                  >
                    <Icon name="edit" size={14} />
                    Edit
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); cancelScheduled(s.id); }}
                    className="p-1.5 rounded-lg hover:bg-danger-soft text-danger"
                    title="Cancel"
                  >
                    <Icon name="close" size={18} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
