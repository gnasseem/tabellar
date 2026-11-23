
import { useState, useEffect, useRef, useCallback } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "./AppShell";

type ContactInsights = {
  name: string;
  email: string;
  domain: string | null;
  interaction_count: number;
  avg_response_time_hours: number | null;
  relationship_notes: string | null;
  last_interaction_at: string | null;
  last_subject: string | null;
  relationship_health: "active" | "recent" | "fading" | "dormant" | "new";
};

type RecentEmail = {
  id: string;
  subject: string | null;
  received_at: string;
  snippet: string | null;
};

type RecentTodo = {
  id: string;
  text: string;
  is_completed: boolean;
  created_at: string;
};

type RecentMeeting = {
  id: string;
  title: string;
  start_time: string;
  status: string;
};

function healthLabel(health: ContactInsights["relationship_health"]): { label: string; color: string; icon: string } {
  switch (health) {
    case "active":  return { label: "Active",   color: "text-ok bg-ok-soft",   icon: "favorite" };
    case "recent":  return { label: "Recent",   color: "text-ink2 bg-field",     icon: "bolt" };
    case "fading":  return { label: "Fading",   color: "text-warn bg-warn-soft", icon: "trending_down" };
    case "dormant": return { label: "Dormant",  color: "text-ink2 bg-field",    icon: "bedtime" };
    default:        return { label: "New",      color: "text-ink2 bg-field", icon: "star" };
  }
}

function timeAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? "s" : ""} ago`;
  if (days < 365) return `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? "s" : ""} ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function Initials({ name, email }: { name: string; email: string }) {
  const str = name || email;
  const parts = str.split(/[\s.@]/);
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : str.slice(0, 2).toUpperCase();
  // Deterministic color based on email
  const colors = [
    "bg-wax", "bg-wax", "bg-ok", "bg-danger",
    "bg-warn", "bg-wax", "bg-wax", "bg-ok",
  ];
  const idx = email.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length;
  return (
    <div className={`w-12 h-12 rounded-2xl ${colors[idx]} flex items-center justify-center text-white font-bold text-lg shrink-0 shadow-sm`}>
      {initials}
    </div>
  );
}

type PersonPanelProps = {
  senderEmail: string;
  senderName: string;
  onCompose: () => void;
  onFindAllEmails: () => void;
};

export default function PersonPanel({ senderEmail, senderName, onCompose, onFindAllEmails }: PersonPanelProps) {
  const { user } = useApp() as any;
  const supabase = createClient();

  const [insights, setInsights] = useState<ContactInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [notesDirty, setNotesDirty] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);
  const [recentEmails, setRecentEmails] = useState<RecentEmail[]>([]);
  const [recentTodos, setRecentTodos] = useState<RecentTodo[]>([]);
  const [recentMeetings, setRecentMeetings] = useState<RecentMeeting[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevEmailRef = useRef<string>("");

  const loadInsights = useCallback(async (email: string) => {
    setLoading(true);
    setNotesDirty(false);
    setNotesSaved(false);
    setRecentEmails([]);
    setRecentTodos([]);
    setRecentMeetings([]);

    try {
      const domain = email.includes("@") ? email.split("@")[1] : null;

      // Parallel fetches from the local database
      const [memRes, emailsRes, meetingsRes] = await Promise.all([
        supabase
          .from("email_memory")
          .select("interaction_count, avg_response_time, relationship_notes, last_interaction_at, last_subject")
          .eq("user_id", user.id)
          .eq("sender_email", email)
          .maybeSingle(),
        supabase
          .from("emails")
          .select("id, subject, received_at, snippet")
          .eq("user_id", user.id)
          .eq("sender_email", email)
          .order("received_at", { ascending: false })
          .limit(5),
        supabase
          .from("meetings")
          .select("id, title, start_time, status")
          .eq("user_id", user.id)
          .contains("attendees", [email])
          .order("start_time", { ascending: false })
          .limit(3),
      ]);

      const mem = memRes.data;

      // Set recent emails immediately
      const fetchedEmails = (emailsRes.data as RecentEmail[]) ?? [];
      setRecentEmails(fetchedEmails);

      // Set meetings
      setRecentMeetings((meetingsRes.data as RecentMeeting[]) ?? []);

      // Fetch todos linked to these emails
      if (fetchedEmails.length > 0) {
        const emailIds = fetchedEmails.map((e) => e.id);
        supabase
          .from("todos")
          .select("id, text, is_completed, created_at")
          .eq("user_id", user.id)
          .in("email_id", emailIds)
          .order("created_at", { ascending: false })
          .limit(5)
          .then(({ data }) => setRecentTodos((data as RecentTodo[]) ?? []));
      }

      // Relationship health based on last interaction
      let health: ContactInsights["relationship_health"] = "new";
      if (mem?.last_interaction_at) {
        const days = Math.floor((Date.now() - new Date(mem.last_interaction_at).getTime()) / 86_400_000);
        if (days < 7) health = "active";
        else if (days < 30) health = "recent";
        else if (days < 90) health = "fading";
        else health = "dormant";
      } else if (mem?.interaction_count && mem.interaction_count > 0) {
        health = "recent";
      }

      const displayName = senderName || email.split("@")[0];

      const result: ContactInsights = {
        name: displayName,
        email,
        domain,
        interaction_count: mem?.interaction_count ?? 0,
        avg_response_time_hours: mem?.avg_response_time ?? null,
        relationship_notes: mem?.relationship_notes ?? null,
        last_interaction_at: mem?.last_interaction_at ?? null,
        last_subject: mem?.last_subject ?? null,
        relationship_health: health,
      };

      setInsights(result);
      setNotes(result.relationship_notes ?? "");
    } catch {
      setInsights(null);
    }
    setLoading(false);
  }, [user.id, senderName]);

  useEffect(() => {
    if (!senderEmail || senderEmail === prevEmailRef.current) return;
    prevEmailRef.current = senderEmail;
    loadInsights(senderEmail);
  }, [senderEmail, loadInsights]);

  // Debounced note save (800ms)
  const handleNotesChange = (val: string) => {
    setNotes(val);
    setNotesDirty(true);
    setNotesSaved(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      await supabase
        .from("email_memory")
        .upsert({ user_id: user.id, sender_email: senderEmail, relationship_notes: val }, { onConflict: "user_id,sender_email" });
      setNotesDirty(false);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    }, 800);
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6">
        <Icon name="progress_activity" size={22} className="animate-spin text-ink3" />
      </div>
    );
  }

  if (!insights) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="person_off" size={28} fill className="text-ink3" />
        <p className="text-xs text-ink3">No contact data available</p>
      </div>
    );
  }

  const health = healthLabel(insights.relationship_health);

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-0">

      {/* ── Contact header ── */}
      <div className="px-4 pt-5 pb-4 border-b border-line">
        <div className="flex items-start gap-3">
          <Initials name={insights.name} email={insights.email} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-ink truncate leading-tight">{insights.name}</p>
            <p className="text-[11px] text-ink3 truncate mt-0.5">{insights.email}</p>
            {insights.domain && (
              <p className="text-[10px] text-ink3 opacity-60 truncate">{insights.domain}</p>
            )}
          </div>
        </div>

        {/* Relationship health badge */}
        <div className="mt-3 flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${health.color}`}>
            <Icon name={health.icon} size={10} fill />
            {health.label}
          </span>
          {insights.last_interaction_at && (
            <span className="text-[10px] text-ink3">{timeAgo(insights.last_interaction_at)}</span>
          )}
        </div>
      </div>

      {/* ── Stats ── */}
      {insights.interaction_count > 0 && (
        <div className="px-4 py-3 border-b border-line">
          <p className="text-[9px] font-bold uppercase tracking-widest text-ink3 mb-2">Relationship</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-field px-3 py-2">
              <p className="text-lg font-bold text-ink leading-tight">{insights.interaction_count}</p>
              <p className="text-[10px] text-ink3">emails</p>
            </div>
            {insights.avg_response_time_hours !== null && (
              <div className="rounded-xl bg-field px-3 py-2">
                <p className="text-lg font-bold text-ink leading-tight">
                  {insights.avg_response_time_hours < 1
                    ? `${Math.round(insights.avg_response_time_hours * 60)}m`
                    : insights.avg_response_time_hours < 24
                    ? `${Math.round(insights.avg_response_time_hours)}h`
                    : `${Math.round(insights.avg_response_time_hours / 24)}d`}
                </p>
                <p className="text-[10px] text-ink3">avg reply</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Recent emails ── */}
      {recentEmails.length > 0 && (
        <div className="px-4 py-3 border-b border-line">
          <p className="text-[9px] font-bold uppercase tracking-widest text-ink3 mb-2">Recent emails</p>
          <div className="flex flex-col gap-1.5">
            {recentEmails.map((e) => (
              <div key={e.id} className="rounded-lg bg-field px-2.5 py-1.5">
                <p className="text-[11px] font-medium text-ink truncate leading-tight">
                  {e.subject || "(no subject)"}
                </p>
                <p className="text-[10px] text-ink3 mt-0.5">
                  {new Date(e.received_at).toLocaleDateString([], { month: "short", day: "numeric" })}
                  {e.snippet ? ` - ${e.snippet.slice(0, 50)}${e.snippet.length > 50 ? "…" : ""}` : ""}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Todos from this contact ── */}
      {recentTodos.length > 0 && (
        <div className="px-4 py-3 border-b border-line">
          <p className="text-[9px] font-bold uppercase tracking-widest text-ink3 mb-2">Related todos</p>
          <div className="flex flex-col gap-1">
            {recentTodos.map((t) => (
              <div key={t.id} className="flex items-start gap-1.5">
                <Icon name={t.is_completed ? "check_circle" : "radio_button_unchecked"} size={12} fill={t.is_completed} className="shrink-0 mt-0.5" style={{ color: t.is_completed ? "var(--wax)" : "var(--ink3)" }} />
                <p className={`text-[11px] leading-tight ${t.is_completed ? "line-through text-ink3" : "text-ink"}`}>
                  {t.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Meetings with this contact ── */}
      {recentMeetings.length > 0 && (
        <div className="px-4 py-3 border-b border-line">
          <p className="text-[9px] font-bold uppercase tracking-widest text-ink3 mb-2">Meetings</p>
          <div className="flex flex-col gap-1.5">
            {recentMeetings.map((m) => {
              const isPast = new Date(m.start_time) < new Date();
              return (
                <div key={m.id} className="flex items-start gap-1.5">
                  <Icon name="event" size={12} fill className="shrink-0 mt-0.5 text-wax" style={{ opacity: isPast ? 0.5 : 1 }} />
                  <div className="min-w-0">
                    <p className={`text-[11px] font-medium leading-tight truncate ${isPast ? "text-ink3" : "text-ink"}`}>
                      {m.title}
                    </p>
                    <p className="text-[10px] text-ink3">
                      {new Date(m.start_time).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Notes ── */}
      <div className="px-4 py-3 border-b border-line">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-ink3">Notes</p>
          {notesDirty && (
            <span className="text-[9px] text-ink3 italic">saving...</span>
          )}
          {notesSaved && !notesDirty && (
            <span className="text-[9px] text-ok flex items-center gap-0.5">
              <Icon name="check" size={10} />
              saved
            </span>
          )}
        </div>
        <textarea
          value={notes}
          onChange={(e) => handleNotesChange(e.target.value)}
          placeholder="Add private notes about this contact..."
          rows={3}
          className="w-full text-xs text-ink bg-field rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-wax placeholder:text-ink3 leading-relaxed transition-shadow"
        />
      </div>

      {/* ── Actions ── */}
      <div className="px-4 py-3 flex flex-col gap-2 mt-auto">
        <button
          onClick={onCompose}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-wax text-on-wax text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer"
        >
          <Icon name="edit" size={15} />
          Compose to {insights.name.split(" ")[0]}
        </button>
        <button
          onClick={onFindAllEmails}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border border-line text-xs font-medium text-ink hover:bg-field transition-colors cursor-pointer"
        >
          <Icon name="search" size={15} />
          Find all emails
        </button>
      </div>
    </div>
  );
}
