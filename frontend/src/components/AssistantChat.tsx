
import { useState, useRef, useEffect, useCallback } from "react";
import { createClient } from "@/lib/db";
import { useApp } from "./AppShell";

type Action = { type: string; data: Record<string, unknown> };

// Web Speech API types (not in all TS lib versions)
interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((e: SpeechRecognitionResultEvent) => void) | null;
}
interface SpeechRecognitionResultEvent {
  results: { [index: number]: { [index: number]: { transcript: string } } };
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

type Message = {
  role: "user" | "assistant";
  content: string;
  actions?: Action[];
};

const MAX_MESSAGES = 16;
const GREETING = "Hi! I'm your email assistant. I can search emails, send messages, create meetings, manage todos, and answer questions about your inbox. What can I help with?";

// ── Component ───────────────────────────────────────────────────────

export default function AssistantChat({ className, visible }: { className?: string; visible?: boolean }) {
  const { addToast, setView, notifySent } = useApp();
  const supabase = createClient();
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: GREETING },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);

  const stopGenerating = () => {
    stoppedRef.current = true;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLoading(false);
  };
  const prevVisible = useRef(visible);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  useEffect(() => {
    if (visible && !prevVisible.current) {
      setMessages([{ role: "assistant", content: GREETING }]);
      setInput("");
    }
    prevVisible.current = visible;
  }, [visible]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const resetConversation = useCallback(() => {
    setMessages([{ role: "assistant", content: "Starting fresh. What can I help with?" }]);
  }, []);

  const toggleMic = useCallback(() => {
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
    const SpeechRecognition = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      addToast("error", "Voice input is not supported in this browser.");
      return;
    }

    if (recording && recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;

    recognition.onstart = () => setRecording(true);
    recognition.onend = () => {
      setRecording(false);
      recognitionRef.current = null;
    };
    recognition.onerror = () => {
      setRecording(false);
      recognitionRef.current = null;
    };
    recognition.onresult = (e: SpeechRecognitionResultEvent) => {
      const transcript = e.results[0][0].transcript;
      setInput((prev) => (prev ? prev + " " + transcript : transcript));
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + "px";
      }
    };

    recognition.start();
  }, [recording, addToast]);

  const sendMessage = async (directText?: string) => {
    const userMessage = directText ?? input.trim();
    if (!userMessage || loading) return;

    if (!directText) {
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    }
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setLoading(true);

    const displayResult = (result: { reply: string; actions?: Action[] }) => {
      if (Array.isArray(result.actions)) {
        for (const action of result.actions) {
          if (action.type === "send_email") {
            notifySent({ to: action.data.to as string, subject: action.data.subject as string, body_html: "" });
          }
        }
      }
      setMessages((prev) => {
        const updated = [
          ...prev,
          { role: "assistant" as const, content: result.reply, actions: result.actions },
        ];
        if (updated.length >= MAX_MESSAGES) {
          return [
            ...updated,
            { role: "assistant" as const, content: "This conversation is getting long. Start fresh anytime with the button below." },
          ];
        }
        return updated;
      });
    };

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const apiUrl = "/api";
      const recentMessages = messages.slice(-10);
      const history = recentMessages.map((m) => ({ role: m.role, content: m.content }));

      // 180s timeout to handle multi-step tasks.
      // The controller is also stored on a ref so the Stop button can abort.
      const chatController = new AbortController();
      abortControllerRef.current = chatController;
      const chatTimeoutId = setTimeout(() => chatController.abort(), 180_000);

      let res: Response;
      try {
        res = await fetch(`${apiUrl}/chat`, {
          method: "POST",
          signal: chatController.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ message: userMessage, history, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        });
      } catch (fetchErr) {
        clearTimeout(chatTimeoutId);
        if ((fetchErr as Error)?.name === "AbortError") {
          if (stoppedRef.current) {
            stoppedRef.current = false;
            return;
          }
          throw new Error("Request timed out. The AI service is taking longer than usual; please try again.");
        }
        throw fetchErr;
      }
      clearTimeout(chatTimeoutId);

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Request failed (${res.status})`);
      }

      const data = await res.json();
      if (!data.reply?.trim()) throw new Error("Empty response from assistant");
      displayResult({ reply: data.reply, actions: data.actions });
    } catch (err) {
      if (stoppedRef.current) {
        stoppedRef.current = false;
        return;
      }
      const msg = err instanceof Error ? err.message : "Unknown error";
      addToast("error", `Assistant error: ${msg}`);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${msg}` },
      ]);
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
    }
  };

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((msg, i) => (
          <div
            key={`${msg.role}-${i}-${msg.content.slice(0, 16)}`}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div className={`flex flex-col gap-1.5 ${msg.role === "user" ? "items-end max-w-[80%]" : "items-start w-full"}`}>
              <div
                className={`text-[13px] leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "px-3.5 py-2 rounded-2xl rounded-br-sm bg-[var(--accent)] text-white"
                    : "text-[var(--foreground)] py-0.5"
                }`}
              >
                {msg.content.replace(/ - /g, " - ")}
              </div>
              {msg.actions?.map((action, j) => (
                <ActionChip
                  key={`action-${i}-${j}`}
                  action={action}
                  onViewDrafts={() => setView("drafts")}
                  onViewMeetings={() => setView("meetings")}
                  onViewSent={() => setView("sent")}
                  onViewTodos={() => setView("todos")}
                  onViewInbox={() => setView("inbox")}
                  onViewCategories={() => setView("categories")}
                  onViewFollowups={() => setView("followups")}
                  onSelectOption={(text) => sendMessage(text)}
                />
              ))}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-1.5 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* New conversation button */}
      {messages.length > 2 && (
        <div className="px-3 pb-1">
          <button
            onClick={resetConversation}
            className="w-full text-[11px] py-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors flex items-center justify-center gap-1 cursor-pointer"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "13px" }}>refresh</span>
            New conversation
          </button>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-[var(--border)] p-3 flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage(undefined);
            }
          }}
          placeholder="Ask anything or tell me what to do..."
          rows={1}
          className="flex-1 px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-[13px] placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 focus:border-[var(--accent)]/50 resize-none overflow-y-hidden leading-relaxed transition-all"
          style={{ minHeight: "38px", maxHeight: "160px" }}
          disabled={loading}
        />
        <button
          onClick={toggleMic}
          disabled={loading}
          aria-label={recording ? "Stop recording" : "Start voice input"}
          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 cursor-pointer transition-all ${
            recording
              ? "bg-red-500 text-white animate-pulse hover:opacity-90"
              : "bg-[var(--surface-2)] text-[var(--muted)] border border-[var(--border)] hover:text-[var(--accent)] hover:border-[var(--accent)]/50"
          } disabled:opacity-40`}
        >
          <span className="material-symbols-outlined" style={{ fontSize: "17px" }}>
            {recording ? "stop" : "mic"}
          </span>
        </button>
        {loading ? (
          <button
            onClick={stopGenerating}
            aria-label="Stop generating"
            className="w-9 h-9 rounded-xl bg-[var(--danger)] text-white hover:opacity-90 transition-all flex items-center justify-center shrink-0 cursor-pointer"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "17px" }}>stop</span>
          </button>
        ) : (
          <button
            onClick={() => sendMessage(undefined)}
            disabled={!input.trim()}
            aria-label="Send message"
            className="w-9 h-9 rounded-xl bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-all flex items-center justify-center shrink-0 cursor-pointer"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "17px" }}>send</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Action card color maps ──────────────────────────────────────── */
const CARD_ICON_STYLES = {
  green:  "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400",
  blue:   "bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400",
  red:    "bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400",
  purple: "bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400",
  slate:  "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400",
};

function ActionCard({ color, icon, title, subtitle, onClick }: {
  color: keyof typeof CARD_ICON_STYLES;
  icon: string;
  title: string;
  subtitle?: string;
  onClick?: () => void;
}) {
  const base = "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-left transition-all";
  const inner = (
    <>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${CARD_ICON_STYLES[color]}`}>
        <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>{icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-[var(--foreground)] leading-tight truncate">{title}</p>
        {subtitle && <p className="text-[11px] text-[var(--muted)] leading-tight mt-0.5 truncate">{subtitle}</p>}
      </div>
      {onClick && (
        <span className="material-symbols-outlined text-[var(--muted)] shrink-0 opacity-50 group-hover:opacity-100 transition-opacity" style={{ fontSize: "16px" }}>chevron_right</span>
      )}
    </>
  );
  if (onClick) {
    return (
      <button onClick={onClick} className={`${base} cursor-pointer hover:bg-[var(--accent)]/5 hover:border-[var(--accent)]/30 group`}>
        {inner}
      </button>
    );
  }
  return <div className={base}>{inner}</div>;
}

function ActionChip({
  action,
  onViewDrafts,
  onViewMeetings,
  onViewSent,
  onViewTodos,
  onViewInbox,
  onViewCategories,
  onViewFollowups,
  onSelectOption,
}: {
  action: Action;
  onViewDrafts: () => void;
  onViewMeetings: () => void;
  onViewSent: () => void;
  onViewTodos: () => void;
  onViewInbox: () => void;
  onViewCategories: () => void;
  onViewFollowups: () => void;
  onSelectOption: (text: string) => void;
}) {
  if (action.type === "suggest_options") {
    const { options, recommended, context } = action.data as {
      options: { label: string; description: string }[];
      recommended: number;
      context?: string;
    };
    return (
      <div className="w-full space-y-2 mt-0.5">
        {context && (
          <p className="text-[11px] text-[var(--muted)] px-0.5">{context}</p>
        )}
        {options.map((opt, idx) => (
          <button
            key={idx}
            onClick={() => onSelectOption(`Execute: ${opt.label} - ${opt.description}`)}
            className={`w-full text-left px-3 py-2.5 rounded-xl border-2 transition-all cursor-pointer group ${
              idx === recommended
                ? "border-[var(--accent)] bg-[var(--accent)]/8"
                : "border-[var(--border)] hover:border-[var(--accent)]/50 bg-[var(--surface-2)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                  idx === recommended
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--border)] text-[var(--muted)] group-hover:bg-[var(--accent)]/20 group-hover:text-[var(--accent)]"
                }`}
              >
                {idx + 1}
              </span>
              <span className={`text-[12px] font-semibold leading-tight ${
                idx === recommended ? "text-[var(--accent)]" : "text-[var(--foreground)]"
              }`}>
                {opt.label}
              </span>
              {idx === recommended && (
                <span className="ml-auto text-[10px] font-medium text-[var(--accent)] opacity-70 shrink-0">recommended</span>
              )}
            </div>
            <p className="text-[11px] text-[var(--muted)] mt-1 ml-7 leading-relaxed">{opt.description}</p>
          </button>
        ))}
      </div>
    );
  }
  if (action.type === "create_todo") {
    return <ActionCard color="green" icon="check_circle" title="Todo created" subtitle={action.data.text as string} onClick={onViewTodos} />;
  }
  if (action.type === "save_draft") {
    return <ActionCard color="blue" icon="draft" title="Draft saved" subtitle={`To: ${action.data.to as string}`} onClick={onViewDrafts} />;
  }
  if (action.type === "send_email") {
    return <ActionCard color="green" icon="send" title={`Email sent to ${action.data.to as string}`} subtitle={action.data.subject as string | undefined} onClick={onViewSent} />;
  }
  if (action.type === "send_email_failed") {
    return <ActionCard color="red" icon="error" title="Failed to send email" subtitle={action.data.error as string | undefined} />;
  }
  if (action.type === "create_meeting") {
    return <ActionCard color="purple" icon="event" title={`Meeting created: ${action.data.title as string}`} subtitle={action.data.start_time ? new Date(action.data.start_time as string).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : undefined} onClick={onViewMeetings} />;
  }
  if (action.type === "create_meeting_failed") {
    return <ActionCard color="red" icon="error" title="Failed to create meeting" />;
  }
  if (action.type === "update_todo") {
    const isCompleted = action.data.is_completed === true;
    return <ActionCard color="green" icon={isCompleted ? "check_circle" : "edit"} title={isCompleted ? "Todo marked complete" : "Todo updated"} onClick={onViewTodos} />;
  }
  if (action.type === "delete_todo") {
    return <ActionCard color="slate" icon="delete" title="Todo deleted" />;
  }
  if (action.type === "update_meeting") {
    return <ActionCard color="blue" icon="edit_calendar" title="Meeting updated" onClick={onViewMeetings} />;
  }
  if (action.type === "delete_meeting") {
    return <ActionCard color="slate" icon="event_busy" title="Meeting deleted" />;
  }
  if (action.type === "delete_draft") {
    return <ActionCard color="slate" icon="delete" title="Draft deleted" />;
  }
  if (action.type === "archive_email") {
    return <ActionCard color="slate" icon="archive" title="Email archived" onClick={onViewInbox} />;
  }
  if (action.type === "add_knowledge") {
    return <ActionCard color="purple" icon="psychology" title={`Saved: ${action.data.entity as string}`} subtitle={action.data.entity_type as string | undefined} />;
  }
  if (action.type === "create_tag") {
    return <ActionCard color="slate" icon="label" title={`Tag created: ${action.data.display_name as string}`} onClick={onViewCategories} />;
  }
  if (action.type === "set_follow_up") {
    const remindDate = action.data.remind_at
      ? new Date(action.data.remind_at as string).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : undefined;
    return <ActionCard color="blue" icon="schedule_send" title={`Follow-up set: ${action.data.subject as string}`} subtitle={remindDate ? `Remind: ${remindDate}` : undefined} onClick={onViewFollowups} />;
  }
  return null;
}
