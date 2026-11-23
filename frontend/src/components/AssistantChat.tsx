import { useState, useRef, useEffect, useCallback } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "./AppShell";

// Ask: questions about the inbox, and small things done on request (a todo,
// a draft, a meeting). The user's messages sit on a quiet field, Tabellar's
// answers are plain text, and what it did is one line under its answer.

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
  error?: boolean;
};

const MAX_MESSAGES = 16;

// Questions shown before the first message, each sent as written.
const STARTERS = ["What needs a reply from me today?", "Which emails have a deadline this week?", "Who have I not answered in a while?"];

function noDash(s: string): string {
  return s.replace(/\s*\u2014\s*/g, ", ");
}

// Models answer in Markdown even when asked not to. Bullets become a dot,
// headings and **bold** become bold, and `code` and *italics* lose their marks.
function Answer({ text }: { text: string }) {
  const lines = noDash(text).split("\n");
  return (
    <>
      {lines.map((raw, i) => {
        const bullet = raw.match(/^(\s*)[*-]\s+(.*)$/);
        const heading = raw.match(/^#{1,6}\s+(.*)$/);
        const body = bullet ? bullet[2] : heading ? `**${heading[1]}**` : raw;
        const parts = body.split(/\*\*(.+?)\*\*/g).map((p, j) => (j % 2 ? <b key={j} className="font-medium">{p}</b> : p.replace(/\*([^*\s][^*]*)\*/g, "$1").replace(/`([^`]+)`/g, "$1")));
        const indent = bullet ? Math.min(Math.floor(bullet[1].length / 2), 3) : 0;
        return (
          <span key={i} className="block" style={bullet ? { paddingLeft: `${1 + indent}em`, textIndent: "-0.9em" } : undefined}>
            {bullet && "\u2022 "}
            {parts}
            {!raw.trim() && "\u00a0"}
          </span>
        );
      })}
    </>
  );
}

export default function AssistantChat({ className, visible }: { className?: string; visible?: boolean }) {
  const { setView, notifySent, addToast } = useApp();
  const supabase = createClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const prevVisible = useRef(visible);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const stopGenerating = () => {
    stoppedRef.current = true;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLoading(false);
  };

  // Each time the panel opens it starts a new conversation.
  useEffect(() => {
    if (visible && !prevVisible.current) {
      setMessages([]);
      setInput("");
    }
    if (visible) textareaRef.current?.focus();
    prevVisible.current = visible;
  }, [visible]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, loading]);

  const resetConversation = useCallback(() => setMessages([]), []);

  const fitInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const toggleMic = useCallback(() => {
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
    const SpeechRecognition = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      addToast("error", "Voice input does not work in this browser. Type the question instead.");
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
      requestAnimationFrame(fitInput);
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
        const updated = [...prev, { role: "assistant" as const, content: result.reply, actions: result.actions }];
        if (updated.length >= MAX_MESSAGES) {
          return [...updated, { role: "assistant" as const, content: "This conversation is getting long, so answers may lose track of earlier messages. Start a new one below." }];
        }
        return updated;
      });
    };

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const history = messages.filter((m) => !m.error).slice(-10).map((m) => ({ role: m.role, content: m.content }));

      // 180s timeout to handle multi-step tasks. The controller is also kept
      // on a ref so Stop can abort it.
      const chatController = new AbortController();
      abortControllerRef.current = chatController;
      const chatTimeoutId = setTimeout(() => chatController.abort(), 180_000);

      let res: Response;
      try {
        res = await fetch("/api/chat", {
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
          throw new Error("No answer after three minutes. The model may be busy or stopped; check Settings, under Models, and ask again.");
        }
        throw fetchErr;
      }
      clearTimeout(chatTimeoutId);

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `The request failed (${res.status}). Check that the model in Settings, under Models, is running.`);
      }

      const data = await res.json();
      if (!data.reply?.trim()) throw new Error("The model returned an empty answer. Ask again, or try another model in Settings, under Models.");
      displayResult({ reply: data.reply, actions: data.actions });
    } catch (err) {
      if (stoppedRef.current) {
        stoppedRef.current = false;
        return;
      }
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      setMessages((prev) => [...prev, { role: "assistant", content: msg, error: true }]);
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
    }
  };

  const lastUser = [...messages].reverse().find((m) => m.role === "user");

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 && !loading ? (
          <div>
            <p className="leading-normal text-ink2">Ask about your mail, or tell Tabellar to add a todo, save a draft or set up a meeting.</p>
            <p className="label mb-1 mt-5">For example</p>
            <div className="-mx-2 flex flex-col">
              {STARTERS.map((q) => (
                <button key={q} className="btn btn-plain justify-start" onClick={() => sendMessage(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((msg, i) =>
              msg.role === "user" ? (
                <p key={i} className="max-w-[85%] self-end whitespace-pre-wrap rounded-[10px] bg-field px-3 py-2 leading-normal text-ink">
                  {msg.content}
                </p>
              ) : (
                <div key={i} className="flex flex-col gap-2">
                  {msg.error ? (
                    <p className="leading-normal text-danger" role="alert">
                      {msg.content}{" "}
                      {lastUser && i === messages.length - 1 && (
                        <button className="link" onClick={() => (setMessages((prev) => prev.slice(0, -2)), sendMessage(lastUser.content))}>
                          Ask again
                        </button>
                      )}
                    </p>
                  ) : (
                    <div className="whitespace-pre-wrap text-sm leading-[1.6] tracking-[-0.006em] text-ink"><Answer text={msg.content} /></div>
                  )}
                  {msg.actions?.map((action, j) => <ActionLine key={j} action={action} setView={setView} onSelectOption={(text) => sendMessage(text)} />)}
                </div>
              ),
            )}
            {loading && (
              <p className="flex items-center gap-1.5 text-xs text-ink3" role="status">
                Working on it
                <span className="solve-dot-wave inline-flex" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
              </p>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex-none border-t border-line px-3.5 pb-3 pt-2.5">
        {messages.length > 0 && !loading && (
          <button className="link mb-2 block" onClick={resetConversation}>
            New conversation
          </button>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              fitInput();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage(undefined);
              }
            }}
            placeholder="Ask about your mail"
            aria-label="Ask Tabellar"
            rows={1}
            className="input max-h-40 min-h-[28px] flex-1 resize-none overflow-y-auto !py-[5px]"
            disabled={loading}
          />
          <button className={`iconbtn ${recording ? "!text-danger" : ""}`} onClick={toggleMic} disabled={loading} aria-label={recording ? "Stop recording" : "Speak the question"} title={recording ? "Stop recording" : "Speak the question"}>
            <Icon name={recording ? "stop" : "mic"} size={16} />
          </button>
          {loading ? (
            <button className="btn" onClick={stopGenerating}>
              Stop
            </button>
          ) : (
            <button className="btn btn-pri" onClick={() => sendMessage(undefined)} disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// What Tabellar did while answering, as one quiet line with a way to see it.
function ActionLine({ action, setView, onSelectOption }: { action: Action; setView: (v: string) => void; onSelectOption: (text: string) => void }) {
  const d = action.data;

  // A choice Tabellar wants made before it acts: each option is an answer.
  if (action.type === "suggest_options") {
    const { options, recommended, context } = d as { options: { label: string; description: string }[]; recommended: number; context?: string };
    return (
      <div className="flex flex-col gap-2">
        {context && <p className="text-xs text-ink3">{context}</p>}
        {options.map((opt, idx) => (
          <div key={idx}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <button className="btn !h-auto min-h-7 max-w-full !whitespace-normal py-1 text-left" onClick={() => onSelectOption(`Execute: ${opt.label} - ${opt.description}`)}>
                {opt.label}
              </button>
              {idx === recommended && <span className="text-xs text-ink3">Suggested</span>}
            </div>
            {opt.description && <p className="mt-1 text-[12.5px] leading-snug text-ink3">{opt.description}</p>}
          </div>
        ))}
      </div>
    );
  }

  const when = (iso: unknown) => (typeof iso === "string" ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

  let text = "";
  let view = "";
  let viewName = "";
  let failed = false;
  if (action.type === "create_todo") [text, view, viewName] = [`Added a todo: ${String(d.text ?? "")}`, "todos", "Todos"];
  else if (action.type === "save_draft") [text, view, viewName] = [`Saved a draft to ${String(d.to ?? "")}`, "replies", "Replies"];
  else if (action.type === "send_email") [text, view, viewName] = [`Sent an email to ${String(d.to ?? "")}${d.subject ? `, ${String(d.subject)}` : ""}`, "sent", "Sent"];
  else if (action.type === "send_email_failed") [text, failed] = [`The email was not sent${d.error ? `: ${String(d.error)}` : "."}`, true];
  else if (action.type === "create_meeting") [text, view, viewName] = [`Proposed a meeting: ${String(d.title ?? "")}${d.start_time ? `, ${when(d.start_time)}` : ""}`, "meetings", "Meetings"];
  else if (action.type === "create_meeting_failed") [text, failed] = ["The meeting could not be created.", true];
  else if (action.type === "paused") [text, failed] = [`Nothing was done because Tabellar is paused${d.message ? `: ${String(d.message)}` : "."}`, true];
  else if (action.type === "update_todo") [text, view, viewName] = [d.is_completed === true ? "Marked a todo done" : "Changed a todo", "todos", "Todos"];
  else if (action.type === "delete_todo") text = "Deleted a todo";
  else if (action.type === "update_meeting") [text, view, viewName] = ["Changed a meeting", "meetings", "Meetings"];
  else if (action.type === "delete_meeting") text = "Deleted a meeting";
  else if (action.type === "delete_draft") text = "Deleted a draft";
  else if (action.type === "archive_email") [text, view, viewName] = ["Archived an email", "inbox", "Inbox"];
  else if (action.type === "add_knowledge") text = `Remembered: ${String(d.entity ?? "")}${d.entity_type ? ` (${String(d.entity_type)})` : ""}`;
  else if (action.type === "create_tag") [text, view, viewName] = [`Created the label ${String(d.display_name ?? "")}`, "categories", "Labels"];
  else if (action.type === "set_follow_up") [text, view, viewName] = [`Set a follow-up: ${String(d.subject ?? "")}${d.remind_at ? `, reminds ${when(d.remind_at)}` : ""}`, "followups", "Follow-ups"];
  else return null;

  return (
    <p className={`text-xs leading-normal ${failed ? "text-danger" : "text-ink3"}`}>
      {text}
      {view && (
        <>
          {" "}
          <button className="link" onClick={() => setView(view)}>
            Open {viewName}
          </button>
        </>
      )}
    </p>
  );
}
