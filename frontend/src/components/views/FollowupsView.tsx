
import { useState, useEffect, useCallback, useMemo } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";

type FollowUp = {
  id: string;
  email_id: string | null;
  thread_id: string;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  remind_at: string;
  status: "waiting" | "replied" | "dismissed" | "snoozed";
  snooze_until: string | null;
  created_at: string;
};

type SuggestedFollowUp = {
  email_id: string;
  thread_id: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  sent_at: string;
  days_waiting: number;
};

type Tab = "waiting" | "all" | "dismissed";

function daysAgo(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000);
}

function daysUntil(isoDate: string): number {
  return Math.ceil((new Date(isoDate).getTime() - Date.now()) / 86_400_000);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StatusBadge({ status, remindAt }: { status: FollowUp["status"]; remindAt: string }) {
  const isOverdue = status === "waiting" && new Date(remindAt) < new Date();
  if (status === "replied") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-ok-soft text-ok text-[10px] font-bold uppercase tracking-wide">
        <Icon name="check_circle" size={10} fill />
        Replied
      </span>
    );
  }
  if (status === "snoozed") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-field text-ink2 text-[10px] font-bold uppercase tracking-wide">
        <Icon name="bedtime" size={10} fill />
        Snoozed
      </span>
    );
  }
  if (status === "dismissed") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-field text-ink2 text-[10px] font-bold uppercase tracking-wide">
        Dismissed
      </span>
    );
  }
  if (isOverdue) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-danger-soft text-danger text-[10px] font-bold uppercase tracking-wide">
        <Icon name="warning" size={10} fill />
        Overdue
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warn-soft text-warn text-[10px] font-bold uppercase tracking-wide">
      <Icon name="hourglass_empty" size={10} fill />
      Waiting
    </span>
  );
}

function SnoozeMenu({ onSnooze }: { onSnooze: (days: number) => void }) {
  const [open, setOpen] = useState(false);
  const options = [
    { label: "1 day", days: 1 },
    { label: "3 days", days: 3 },
    { label: "1 week", days: 7 },
    { label: "2 weeks", days: 14 },
  ];
  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="flex items-center gap-1 px-2 py-1 rounded-lg border border-line text-[11px] font-medium text-ink3 hover:bg-field hover:text-ink transition-colors cursor-pointer"
        title="Snooze"
      >
        <Icon name="bedtime" size={13} />
        Snooze
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 bg-canvas border border-line rounded-xl shadow-xl overflow-hidden min-w-[120px]">
            {options.map((o) => (
              <button
                key={o.days}
                onClick={(e) => { e.stopPropagation(); onSnooze(o.days); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-xs font-medium text-ink hover:bg-field transition-colors cursor-pointer"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function FollowupsView() {
  const { user, addToast, openCompose, setView, setSearch } = useApp() as any;
  const supabase = createClient();

  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestedFollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("waiting");
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [addingThreadId, setAddingThreadId] = useState<string | null>(null);

  const loadFollowUps = useCallback(async () => {
    const { data } = await supabase
      .from("follow_up_reminders")
      .select("*")
      .eq("user_id", user.id)
      .order("remind_at", { ascending: true });
    setFollowUps((data as FollowUp[]) || []);
    setLoading(false);
  }, [user.id]);

  const loadSuggestions = useCallback(async () => {
    // Find sent emails from last 30 days with no reply in the thread
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data: sentEmails } = await supabase
      .from("emails")
      .select("id, thread_id, recipients, subject, received_at, sender_email, sender")
      .eq("user_id", user.id)
      .contains("label_ids", ["SENT"])
      .gte("received_at", thirtyDaysAgo)
      .order("received_at", { ascending: false })
      .limit(50);

    if (!sentEmails?.length) return;

    // Check which thread_ids already have reminders
    const { data: existingReminders } = await supabase
      .from("follow_up_reminders")
      .select("thread_id")
      .eq("user_id", user.id);
    const trackedThreads = new Set((existingReminders || []).map((r: any) => r.thread_id));

    // Find threads where no other email exists from a different sender (no reply received)
    const threadIds = [...new Set(sentEmails.map((e: any) => e.thread_id).filter(Boolean))];
    if (!threadIds.length) return;

    const { data: replies } = await supabase
      .from("emails")
      .select("thread_id, sender_email")
      .eq("user_id", user.id)
      .in("thread_id", threadIds)
      .not("label_ids", "cs", '{"SENT"}');

    const threadsWithReplies = new Set((replies || []).map((r: any) => r.thread_id));

    const suggestedMap = new Map<string, SuggestedFollowUp>();
    for (const email of sentEmails as any[]) {
      if (!email.thread_id) continue;
      if (trackedThreads.has(email.thread_id)) continue;
      if (threadsWithReplies.has(email.thread_id)) continue;
      if (suggestedMap.has(email.thread_id)) continue;

      const recipients = (email.recipients || "").split(",").map((s: string) => s.trim()).filter(Boolean);
      const firstRecipient = recipients[0] || email.recipients || "unknown";
      const nameMatch = firstRecipient.match(/^(.*?)\s*<[^>]+>/);
      const emailMatch = firstRecipient.match(/<([^>]+)>/);
      const recipientEmail = emailMatch ? emailMatch[1] : firstRecipient.replace(/<.*>/, "").trim();
      const recipientName = nameMatch ? nameMatch[1].trim() : recipientEmail.split("@")[0];

      suggestedMap.set(email.thread_id, {
        email_id: email.id,
        thread_id: email.thread_id,
        recipient_email: recipientEmail,
        recipient_name: recipientName,
        subject: email.subject || "(no subject)",
        sent_at: email.received_at,
        days_waiting: daysAgo(email.received_at),
      });
    }

    setSuggestions(Array.from(suggestedMap.values()).filter((s) => s.days_waiting >= 2));
  }, [user.id]);

  useEffect(() => {
    loadFollowUps();
    loadSuggestions();
  }, [loadFollowUps, loadSuggestions]);

  const addFromSuggestion = async (s: SuggestedFollowUp) => {
    setAddingThreadId(s.thread_id);
    const remindAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const { data, error } = await supabase
      .from("follow_up_reminders")
      .insert({
        user_id: user.id,
        email_id: s.email_id,
        thread_id: s.thread_id,
        recipient_email: s.recipient_email,
        recipient_name: s.recipient_name,
        subject: s.subject,
        remind_at: remindAt,
      })
      .select("*")
      .single();
    if (error) { addToast("error", "Failed to add follow-up"); setAddingThreadId(null); return; }
    setFollowUps((prev) => [...prev, data as FollowUp].sort((a, b) => a.remind_at.localeCompare(b.remind_at)));
    setDismissedSuggestions((prev) => new Set([...prev, s.thread_id]));
    addToast("success", "Follow-up added. We'll remind you in 2 days.");
    setAddingThreadId(null);
  };

  const updateStatus = async (id: string, status: FollowUp["status"], snoozeUntil?: string) => {
    await supabase.from("follow_up_reminders").update({ status, snooze_until: snoozeUntil ?? null }).eq("id", id);
    setFollowUps((prev) => prev.map((f) => f.id === id ? { ...f, status, snooze_until: snoozeUntil ?? null } : f));
  };

  const handleSnooze = async (id: string, days: number) => {
    const snoozeUntil = new Date(Date.now() + days * 86_400_000).toISOString();
    await updateStatus(id, "snoozed", snoozeUntil);
    addToast("success", `Snoozed for ${days} day${days > 1 ? "s" : ""}`);
  };

  const handleDismiss = async (id: string) => {
    await updateStatus(id, "dismissed");
  };

  const handleDelete = async (id: string) => {
    await supabase.from("follow_up_reminders").delete().eq("id", id);
    setFollowUps((prev) => prev.filter((f) => f.id !== id));
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "waiting", label: "Waiting" },
    { id: "all", label: "All" },
    { id: "dismissed", label: "Dismissed" },
  ];

  const filteredFollowUps = useMemo(() => {
    if (activeTab === "waiting") return followUps.filter((f) => f.status === "waiting" || f.status === "snoozed");
    if (activeTab === "dismissed") return followUps.filter((f) => f.status === "dismissed");
    return followUps;
  }, [followUps, activeTab]);

  const waitingCount = followUps.filter((f) => f.status === "waiting").length;
  const visibleSuggestions = suggestions.filter((s) => !dismissedSuggestions.has(s.thread_id));

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Icon name="progress_activity" size={24} className="animate-spin text-ink3" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-canvas">
      <div className="max-w-2xl mx-auto px-4 py-6">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-ink">Follow-ups</h1>
            <p className="text-sm text-ink3 mt-0.5">
              {waitingCount > 0 ? `${waitingCount} awaiting reply` : "All caught up"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-ink3">
            <Icon name="schedule_send" size={28} fill style={{ color: "var(--wax)", opacity: 0.7 }} />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 rounded-xl bg-field mb-5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === tab.id
                  ? "bg-canvas text-ink shadow-sm"
                  : "text-ink3 hover:text-ink"
              }`}
            >
              {tab.label}
              {tab.id === "waiting" && waitingCount > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-wax text-on-wax text-[9px] font-bold">
                  {waitingCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Suggestions banner (only on waiting tab) */}
        {activeTab === "waiting" && visibleSuggestions.length > 0 && (
          <div className="mb-5 rounded-xl border border-warn-line bg-warn-soft overflow-hidden">
            <div className="px-4 py-2.5 border-b border-warn-line flex items-center gap-2">
              <Icon name="lightbulb" size={15} fill className="text-warn" />
              <p className="text-xs font-semibold text-warn">Suggested follow-ups</p>
              <span className="text-xs text-warn ml-auto">No reply in {visibleSuggestions[0]?.days_waiting}+ days</span>
            </div>
            <div className="divide-y divide-warn-line">
              {visibleSuggestions.slice(0, 5).map((s) => (
                <div key={s.thread_id} className="flex items-start gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{s.subject}</p>
                    <p className="text-xs text-ink3 mt-0.5 truncate">{s.recipient_name || s.recipient_email} &bull; Sent {formatDate(s.sent_at)}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setDismissedSuggestions((prev) => new Set([...prev, s.thread_id]))}
                      className="text-ink3 hover:text-ink p-1 rounded cursor-pointer transition-colors"
                      title="Dismiss suggestion"
                    >
                      <Icon name="close" size={14} />
                    </button>
                    <button
                      onClick={() => addFromSuggestion(s)}
                      disabled={addingThreadId === s.thread_id}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-warn text-white text-[11px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-60 cursor-pointer"
                    >
                      {addingThreadId === s.thread_id ? (
                        <Icon name="progress_activity" size={12} className="animate-spin" />
                      ) : (
                        <Icon name="add" size={12} />
                      )}
                      Track
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Follow-up list */}
        {filteredFollowUps.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-field flex items-center justify-center">
              <Icon name="schedule_send" size={32} fill className="text-ink3" />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">
                {activeTab === "waiting" ? "No pending follow-ups" : activeTab === "dismissed" ? "Nothing dismissed" : "No follow-ups yet"}
              </p>
              <p className="text-xs text-ink3 mt-1 max-w-xs">
                {activeTab === "waiting"
                  ? "Track important sent emails to get reminded if no one replies."
                  : "Follow-ups you track will appear here."}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredFollowUps.map((f) => {
              const daysWaiting = daysAgo(f.created_at);
              const isOverdue = f.status === "waiting" && new Date(f.remind_at) < new Date();
              return (
                <div
                  key={f.id}
                  className={`group rounded-xl border transition-all ${
                    isOverdue
                      ? "border-danger-line bg-danger-soft"
                      : f.status === "replied"
                      ? "border-ok-line bg-ok-soft"
                      : "border-line bg-canvas hover:bg-field"
                  }`}
                >
                  <div className="px-4 py-3.5">
                    <div className="flex items-start gap-3">
                      {/* Avatar */}
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm font-bold mt-0.5 ${
                        isOverdue ? "bg-danger-soft text-danger" :
                        f.status === "replied" ? "bg-ok-soft text-ok" :
                        "bg-wax-soft text-wax"
                      }`}>
                        {(f.recipient_name || f.recipient_email).charAt(0).toUpperCase()}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-ink truncate">{f.subject}</p>
                          <StatusBadge status={f.status} remindAt={f.remind_at} />
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <Icon name="person" size={12} className="text-ink3" />
                          <p className="text-xs text-ink3 truncate">
                            {f.recipient_name || f.recipient_email}
                            {f.recipient_name && f.recipient_name !== f.recipient_email && (
                              <span className="opacity-60 ml-1">({f.recipient_email})</span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          <p className="text-[11px] text-ink3">
                            {daysWaiting === 0 ? "Added today" : daysWaiting === 1 ? "Waiting 1 day" : `Waiting ${daysWaiting} days`}
                          </p>
                          {f.status === "snoozed" && f.snooze_until && (
                            <p className="text-[11px] text-ink2">
                              Resumes {formatDate(f.snooze_until)}
                            </p>
                          )}
                          {(f.status === "waiting" || f.status === "snoozed") && (
                            <p className="text-[11px] text-ink3">
                              Remind: {formatDate(f.remind_at)}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    {(f.status === "waiting" || f.status === "snoozed") && (
                      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line">
                        <button
                          onClick={() => openCompose({ sender_email: f.recipient_email, subject: `Re: ${f.subject}`, thread_id: f.thread_id })}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-wax text-on-wax text-[11px] font-semibold hover:opacity-90 transition-opacity cursor-pointer"
                        >
                          <Icon name="reply" size={13} />
                          Follow up
                        </button>
                        <SnoozeMenu onSnooze={(days) => handleSnooze(f.id, days)} />
                        <button
                          onClick={() => updateStatus(f.id, "replied")}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg border border-line text-[11px] font-medium text-ok hover:bg-ok-soft transition-colors cursor-pointer"
                          title="Mark as replied"
                        >
                          <Icon name="check" size={13} />
                          Mark replied
                        </button>
                        <button
                          onClick={() => handleDismiss(f.id)}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg border border-line text-[11px] font-medium text-ink3 hover:bg-field transition-colors cursor-pointer ml-auto"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                    {(f.status === "dismissed" || f.status === "replied") && (
                      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line">
                        {f.status === "dismissed" && (
                          <button
                            onClick={() => updateStatus(f.id, "waiting")}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-line text-[11px] font-medium text-ink hover:bg-field transition-colors cursor-pointer"
                          >
                            <Icon name="undo" size={12} />
                            Restore
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(f.id)}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-danger hover:bg-danger-soft transition-colors cursor-pointer ml-auto"
                        >
                          <Icon name="delete" size={13} />
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
