import { useState, useEffect, useRef, useCallback } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "./AppShell";
import { Empty } from "./ui";

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

const HEALTH: Record<ContactInsights["relationship_health"], string> = {
  active: "In touch this week",
  recent: "In touch this month",
  fading: "Quiet for over a month",
  dormant: "Quiet for over three months",
  new: "New to you",
};

function timeAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? "s" : ""} ago`;
  if (days < 365) return `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? "s" : ""} ago`;
  return `${Math.floor(days / 365)} year${Math.floor(days / 365) > 1 ? "s" : ""} ago`;
}

function replyTime(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.round(hours / 24);
  return `${days} day${days > 1 ? "s" : ""}`;
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

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

  const pane = "flex h-full w-full flex-none flex-col overflow-y-auto border-l border-line md:w-[300px]";

  if (loading) {
    return (
      <aside className={pane} aria-busy="true" aria-label="About the sender">
        <div className="space-y-2 px-4 pt-4">
          <div className="skel h-3 w-32" />
          <div className="skel h-2.5 w-44" />
        </div>
        <div className="space-y-3 px-4 pt-7">
          <div className="skel h-2.5 w-20" />
          <div className="skel h-2.5 w-full" />
          <div className="skel h-2.5 w-4/5" />
          <div className="skel h-2.5 w-3/5" />
        </div>
      </aside>
    );
  }

  if (!insights) {
    return (
      <aside className={pane} aria-label="About the sender">
        <Empty icon="person_off" title="Nothing known about this sender">
          Tabellar could not read what it has on {senderEmail || "this address"}. Close this panel and open it again to retry.
        </Empty>
      </aside>
    );
  }

  const section = "border-t border-line-soft px-4 py-3";
  const line = "flex min-h-[26px] items-baseline gap-3";

  return (
    <aside className={pane} aria-label="About the sender">
      <div className="px-4 pb-3.5 pt-4">
        <p className="truncate text-[15px] font-[650] tracking-[-0.01em] text-ink">{insights.name}</p>
        <p className="truncate text-xs text-ink3">{insights.email}</p>
        <p className="mt-2 text-xs text-ink2">
          {HEALTH[insights.relationship_health]}
          {insights.last_interaction_at && <span className="text-ink3">, last mail {timeAgo(insights.last_interaction_at)}</span>}
        </p>
        <div className="mt-3 flex gap-2">
          <button className="btn" onClick={onCompose}>
            Write to {insights.name.split(" ")[0]}
          </button>
          <button className="btn" onClick={onFindAllEmails}>
            Find all emails
          </button>
        </div>
      </div>

      {insights.interaction_count > 0 && (
        <div className={section}>
          <h3 className="label mb-1">With you</h3>
          <div className={line}>
            <span className="flex-1 text-ink2">Emails exchanged</span>
            <span className="text-ink">{insights.interaction_count.toLocaleString()}</span>
          </div>
          {insights.avg_response_time_hours !== null && (
            <div className={line}>
              <span className="flex-1 text-ink2">Usual time to reply</span>
              <span className="text-ink">{replyTime(insights.avg_response_time_hours)}</span>
            </div>
          )}
        </div>
      )}

      {recentEmails.length > 0 && (
        <div className={section}>
          <h3 className="label mb-1">Recent emails</h3>
          {recentEmails.map((e) => (
            <div key={e.id} className={line} title={e.snippet || undefined}>
              <span className="min-w-0 flex-1 truncate text-ink2">{e.subject || "(no subject)"}</span>
              <time className="flex-none text-xs text-ink3">{shortDate(e.received_at)}</time>
            </div>
          ))}
        </div>
      )}

      {recentTodos.length > 0 && (
        <div className={section}>
          <h3 className="label mb-1">Todos from their mail</h3>
          {recentTodos.map((t) => (
            <div key={t.id} className="flex min-h-[26px] items-start gap-2 py-1">
              <Icon name={t.is_completed ? "check" : "radio_button_unchecked"} size={13} className="mt-0.5 text-ink3" />
              <span className={`min-w-0 flex-1 leading-snug ${t.is_completed ? "text-ink3 line-through" : "text-ink2"}`}>{t.text}</span>
            </div>
          ))}
        </div>
      )}

      {recentMeetings.length > 0 && (
        <div className={section}>
          <h3 className="label mb-1">Meetings</h3>
          {recentMeetings.map((m) => {
            const isPast = new Date(m.start_time) < new Date();
            return (
              <div key={m.id} className={line}>
                <span className={`min-w-0 flex-1 truncate ${isPast ? "text-ink3" : "text-ink2"}`}>{m.title}</span>
                <time className="flex-none text-xs text-ink3">
                  {new Date(m.start_time).toLocaleDateString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                </time>
              </div>
            );
          })}
        </div>
      )}

      <div className={section}>
        <div className="mb-1.5 flex items-baseline justify-between">
          <label htmlFor="person-notes" className="label">
            Notes
          </label>
          <span className="text-xs text-ink3" role="status">
            {notesDirty ? "Saving" : notesSaved ? "Saved" : ""}
          </span>
        </div>
        <textarea
          id="person-notes"
          value={notes}
          onChange={(e) => handleNotesChange(e.target.value)}
          placeholder="Private notes about this person. Tabellar uses them in the briefing and when you ask about them."
          rows={4}
          className="input resize-none"
        />
      </div>
    </aside>
  );
}
