import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import AgentWorkspace from "../solve/AgentWorkspace";
import { Empty, SkeletonRows, ViewBar, dayLabel } from "../ui";

// Ask: questions about the mail, and things done on request (a todo, a
// draft, a meeting, a cleanup plan for the whole inbox). Past conversations
// sit on the left; the open one reads down the middle at reading width. A
// conversation is saved after every message, so an answer that arrives while
// the user is on another page is there when they come back.

type Action = { type: string; data: Record<string, unknown> };
type Message = { role: "user" | "assistant"; content: string; actions?: Action[]; error?: boolean };
type Conversation = { id: string; title: string; updated_at: string };

// Long conversations lose the start: only the last ten messages go to the model.
const HISTORY = 10;
const LONG = 16;
const STARTERS = ["What needs a reply from me today?", "Clean up my inbox", "Who have I not answered in a while?"];

// Answers on their way, by conversation, so a conversation reopened before
// its answer arrived says it is still working.
const pending = new Set<string>();
const listeners = new Set<() => void>();
const settle = (id: string) => {
  pending.delete(id);
  listeners.forEach((f) => f());
};

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


export default function AskView() {
  const { user, setView, notifySent, addToast, agentSession, adoptSolveAgent } = useApp();
  const supabase = createClient();
  const [list, setList] = useState<Conversation[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("tabellar_ask_open");
    } catch {
      return null;
    }
  });
  const [messages, setMessages] = useState<Message[] | null>(openId ? null : []);
  const [input, setInput] = useState("");
  const [recording, setRecording] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [, bump] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const shownRef = useRef<string | null>(openId);
  shownRef.current = openId;
  const working = !!openId && pending.has(openId);

  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);

  const loadList = useCallback(async () => {
    const { data } = await supabase.from("conversations").select("id, title, updated_at").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(300);
    setList((data || []) as Conversation[]);
  }, [user.id]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // The open conversation, read again when its answer lands.
  useEffect(() => {
    try {
      if (openId) localStorage.setItem("tabellar_ask_open", openId);
      else localStorage.removeItem("tabellar_ask_open");
    } catch {
      /* the next visit starts a new conversation */
    }
    if (!openId) return setMessages([]);
    let live = true;
    supabase
      .from("conversations")
      .select("messages")
      .eq("id", openId)
      .maybeSingle()
      .then(({ data }) => {
        if (!live) return;
        if (!data) return setOpenId(null);
        setMessages(((data as { messages: Message[] }).messages || []) as Message[]);
      });
    return () => {
      live = false;
    };
  }, [openId, working]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, working]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [openId]);

  const save = async (id: string | null, msgs: Message[], title: string): Promise<string | null> => {
    const at = new Date().toISOString();
    if (id) {
      const { error } = await supabase.from("conversations").update({ messages: msgs, updated_at: at }).eq("id", id);
      return error ? null : id;
    }
    const { data, error } = await supabase.from("conversations").insert({ user_id: user.id, title, messages: msgs, updated_at: at }).select("id").single();
    return error || !data ? null : (data as { id: string }).id;
  };

  const fitInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const send = async (text?: string) => {
    const question = (text ?? input).trim();
    if (!question || working || messages === null) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const before = messages;
    const asked: Message[] = [...before, { role: "user", content: question }];
    setMessages(asked);
    const id = await save(openId, asked, question.replace(/\s+/g, " ").slice(0, 80));
    if (!id) {
      setMessages(before);
      setInput(question);
      return addToast("error", "The question was not saved. Try again.");
    }
    if (!openId) setOpenId(id);
    pending.add(id);
    listeners.forEach((f) => f());
    loadList();

    let reply: Message | null = null;
    let saved = false;
    const controller = new AbortController();
    abortRef.current = controller;
    // Long answers (several tools in a row) can take minutes on a local model.
    const timer = setTimeout(() => controller.abort("timeout"), 180_000);
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token}` },
        body: JSON.stringify({
          message: question,
          history: before.filter((m) => !m.error).slice(-HISTORY).map((m) => ({ role: m.role, content: m.content })),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          conversation_id: id,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The request failed (${res.status}). Check the model in Settings, under Models.`);
      if (!String(body.reply ?? "").trim()) throw new Error("The model gave an empty answer. Ask again, or try another model in Settings, under Models.");
      // The server kept the answer in the conversation; the window follows
      // the plan it started, if it did.
      const actions = (Array.isArray(body.actions) ? body.actions : []) as Action[];
      for (const a of actions) {
        if (a.type === "send_email") notifySent({ to: String(a.data.to ?? ""), subject: String(a.data.subject ?? ""), body_html: "" });
        if (a.type === "plan_cleanup" && typeof a.data.session_id === "string") await adoptSolveAgent(a.data.session_id);
      }
      saved = true;
      reply = { role: "assistant", content: String(body.reply), actions };
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason !== "timeout") reply = null;
      else
        reply = {
          role: "assistant",
          error: true,
          content: controller.signal.aborted ? "No answer after three minutes. The model may be busy or stopped; check Settings, under Models, and ask again." : (err as Error).message || "Something went wrong.",
        };
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
    }
    const after = reply ? [...asked, reply] : asked;
    if (!saved) await save(id, after, "");
    settle(id);
    if (shownRef.current === id) setMessages(after);
    loadList();
  };

  const stop = () => abortRef.current?.abort("stopped");

  const startNew = () => {
    stop();
    setOpenId(null);
    setListOpen(false);
    setInput("");
  };

  const remove = async (c: Conversation) => {
    const { error } = await supabase.from("conversations").delete().eq("id", c.id);
    if (error) return addToast("error", "That conversation was not deleted. Try again.");
    if (openId === c.id) setOpenId(null);
    loadList();
  };

  const toggleMic = () => {
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
    const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Recognition) return addToast("error", "Voice input does not work in this browser. Type the question instead.");
    if (recording && recognitionRef.current) return recognitionRef.current.stop();
    const r = new Recognition();
    r.lang = navigator.language || "en-US";
    r.interimResults = false;
    r.maxAlternatives = 1;
    recognitionRef.current = r;
    r.onstart = () => setRecording(true);
    r.onend = r.onerror = () => {
      setRecording(false);
      recognitionRef.current = null;
    };
    r.onresult = (e: SpeechRecognitionResultEvent) => {
      const said = e.results[0][0].transcript;
      setInput((prev) => (prev ? `${prev} ${said}` : said));
      requestAnimationFrame(fitInput);
    };
    r.start();
  };

  const lastUser = [...(messages || [])].reverse().find((m) => m.role === "user");
  const title = (openId && list?.find((c) => c.id === openId)?.title) || "Ask";

  const conversations = (
    <nav className={`flex-none flex-col overflow-y-auto border-line px-2 py-2 md:flex md:w-[232px] md:border-r ${listOpen ? "flex w-full" : "hidden"}`} aria-label="Conversations">
      <button className={`flex h-item w-full flex-none items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 ${!openId ? "bg-sel font-medium text-ink" : "text-ink2 hover:bg-hover"}`} onClick={startNew}>
        <Icon name="add" size={16} className="text-ink3" />
        New conversation
      </button>
      {list === null ? (
        <div className="pt-2">
          <SkeletonRows count={6} />
        </div>
      ) : (
        list.map((c, i) => {
          const day = dayLabel(c.updated_at);
          const head = i === 0 || dayLabel(list[i - 1].updated_at).key !== day.key;
          return (
            <div key={c.id}>
              {head && <p className="label px-2 pb-1 pt-3">{day.head}</p>}
              <div className={`group flex h-item items-center rounded-md transition-colors duration-150 ${openId === c.id ? "bg-sel" : "hover:bg-hover"}`}>
                <button
                  aria-current={openId === c.id ? "page" : undefined}
                  className={`h-full min-w-0 flex-1 truncate px-2 text-left ${openId === c.id ? "font-medium text-ink" : "text-ink2"}`}
                  title={c.title}
                  onClick={() => (setOpenId(c.id), setListOpen(false))}
                >
                  {c.title}
                </button>
                <button className="iconbtn hidden h-6 w-6 flex-none group-hover:grid focus-visible:grid" aria-label={`Delete ${c.title}`} title="Delete" onClick={() => remove(c)}>
                  <Icon name="delete" size={14} />
                </button>
              </div>
            </div>
          );
        })
      )}
    </nav>
  );

  return (
    <>
      <ViewBar
        title={<h1 className="bar-title min-w-0 flex-none truncate md:max-w-[50%]">{title}</h1>}
        search={false}
        right={
          <span className="flex items-center gap-0.5 md:hidden">
            <button className="iconbtn" aria-label="Conversations" title="Conversations" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
              <Icon name="history" size={16} />
            </button>
            <button className="iconbtn" aria-label="New conversation" title="New conversation" onClick={startNew}>
              <Icon name="add" size={16} />
            </button>
          </span>
        }
      />
      <div className="flex min-h-0 flex-1">
        {conversations}
        <div className={`min-h-0 min-w-0 flex-1 flex-col md:flex ${listOpen ? "hidden" : "flex"}`}>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[720px] px-5 pb-6 pt-5">
              {messages === null ? (
                <SkeletonRows count={4} />
              ) : messages.length === 0 && !working ? (
                <Empty icon="chat_bubble" title="Ask about your mail">
                  <span className="-mx-2 mt-1 flex flex-col items-center">
                    {STARTERS.map((q) => (
                      <button key={q} className="btn btn-plain" onClick={() => send(q)}>
                        {q}
                      </button>
                    ))}
                  </span>
                </Empty>
              ) : (
                <div className="flex flex-col gap-5">
                  {messages.map((m, i) =>
                    m.role === "user" ? (
                      <p key={i} className="max-w-[85%] self-end whitespace-pre-wrap rounded-[10px] bg-field px-3 py-2 leading-normal text-ink">
                        {m.content}
                      </p>
                    ) : (
                      <div key={i} className="flex flex-col gap-2">
                        {m.error ? (
                          <p className="leading-normal text-danger" role="alert">
                            {m.content}{" "}
                            {lastUser && i === messages.length - 1 && !working && (
                              <button
                                className="link !text-danger"
                                onClick={() => {
                                  setMessages(messages.slice(0, -2));
                                  setTimeout(() => send(lastUser.content));
                                }}
                              >
                                Ask again
                              </button>
                            )}
                          </p>
                        ) : (
                          <div className="whitespace-pre-wrap text-sm leading-[1.6] tracking-[-0.006em] text-ink">
                            <Answer text={m.content} />
                          </div>
                        )}
                        {m.actions?.map((a, j) =>
                          a.type === "plan_cleanup" ? (
                            <Plan key={j} sessionId={(a.data.session_id as string | null) ?? null} current={agentSession?.id ?? null} />
                          ) : (
                            <ActionLine key={j} action={a} setView={setView} onSelectOption={i === messages.length - 1 && !working ? (t) => send(t) : undefined} />
                          ),
                        )}
                      </div>
                    ),
                  )}
                  {working && (
                    <p className="flex items-center gap-1.5 text-xs text-ink3" role="status">
                      Working on it
                      <span className="solve-dot-wave inline-flex" aria-hidden>
                        <span />
                        <span />
                        <span />
                      </span>
                    </p>
                  )}
                  {messages.length >= LONG && !working && (
                    <p className="text-xs text-ink3">
                      Answers only see the last {HISTORY} messages.{" "}
                      <button className="link" onClick={startNew}>
                        New conversation
                      </button>
                    </p>
                  )}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>
          <div className="flex-none border-t border-line">
            <div className="mx-auto flex w-full max-w-[720px] items-end gap-1.5 px-5 pb-3 pt-2.5">
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
                    send();
                  }
                }}
                placeholder="Ask about your mail"
                aria-label="Ask Tabellar"
                rows={1}
                className="input max-h-40 min-h-[28px] flex-1 resize-none overflow-y-auto !py-[5px]"
                disabled={working}
              />
              <button className={`iconbtn ${recording ? "!text-danger" : ""}`} onClick={toggleMic} disabled={working} aria-label={recording ? "Stop recording" : "Speak the question"} title={recording ? "Stop recording" : "Speak the question"}>
                <Icon name={recording ? "stop" : "mic"} size={16} />
              </button>
              {working && abortRef.current ? (
                <button className="btn" onClick={stop}>
                  Stop
                </button>
              ) : (
                <button className="btn btn-pri" onClick={() => send()} disabled={!input.trim() || working}>
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const PLAN_STATE: Record<string, string> = { done: "ran", cancelled: "was cancelled", error: "stopped on an error", ready: "is waiting for review", asking: "has a question", planning: "is being worked out", executing: "is running" };

// A cleanup plan started from this conversation: the live one in full (one
// still going is followed again after a reload), an earlier one as a line
// saying how it ended.
function Plan({ sessionId, current }: { sessionId: string | null; current: string | null }) {
  const { adoptSolveAgent } = useApp();
  const [status, setStatus] = useState<string | null>(null);
  const live = !!sessionId && sessionId === current;
  useEffect(() => {
    if (!sessionId || live) return;
    createClient()
      .from("agent_sessions")
      .select("status")
      .eq("id", sessionId)
      .maybeSingle()
      .then(({ data }) => {
        const s = ((data as { status?: string } | null)?.status as string) ?? "gone";
        if (["planning", "asking", "ready", "executing"].includes(s)) adoptSolveAgent(sessionId);
        else setStatus(s);
      });
  }, [sessionId, live]);
  if (!sessionId) return <p className="text-xs leading-normal text-danger">The cleanup plan could not start. Ask again in a moment.</p>;
  if (live) return <AgentWorkspace />;
  return <p className="text-xs leading-normal text-ink3">{status === null ? "" : status === "gone" ? "A cleanup plan, since cleared" : `A cleanup plan that ${PLAN_STATE[status] ?? status}`}</p>;
}

// What Tabellar did while answering, as one quiet line with a way to see it.
function ActionLine({ action, setView, onSelectOption }: { action: Action; setView: (v: string) => void; onSelectOption?: (text: string) => void }) {
  const d = action.data;

  // A choice Tabellar wants made before it acts: each option is an answer.
  if (action.type === "suggest_options") {
    const { options, recommended, context } = d as { options: { label: string; description: string }[]; recommended: number; context?: string };
    if (!onSelectOption) return null;
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
  else if (action.type === "update_todo") [text, view, viewName] = [d.is_completed === true ? "Marked a todo done" : "Changed a todo", "todos", "Todos"];
  else if (action.type === "delete_todo") text = "Deleted a todo";
  else if (action.type === "update_meeting") [text, view, viewName] = ["Changed a meeting", "meetings", "Meetings"];
  else if (action.type === "delete_meeting") text = "Deleted a meeting";
  else if (action.type === "delete_draft") text = "Deleted a draft";
  else if (action.type === "archive_email") [text, view, viewName] = ["Archived an email", "inbox", "Inbox"];
  else if (action.type === "add_knowledge") text = `Remembered: ${String(d.entity ?? "")}${d.entity_type ? ` (${String(d.entity_type)})` : ""}`;
  else if (action.type === "create_tag") [text, view, viewName] = [`Created the label ${String(d.display_name ?? "")}`, "labels", "Labels"];
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
