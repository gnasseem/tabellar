import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setEmailFlag } from "@/lib/outcomes";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import EmailDetail from "../EmailDetail";
import { Empty, KeyHints, Menu, Seg, SkeletonRows, Tick, ViewBar, dayLabel, shortWhen } from "../ui";
import { NotThis, usePrefStops } from "../Profile";

// Todos: what the user has to do, typed in by hand or pulled out of their mail
// by Tabellar. One line each, ticked off in place. What Tabellar found in
// recent mail but has not added yet sits in a group at the top of the list.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Todo = { id: string; text: string; is_completed: boolean; source: string; created_at: string; email_id?: string | null };
type Suggestion = { key: string; emailId: string; task: string; subject: string; sender: string; receivedAt: string; category: string };
type Head = { head: true; key: string; name: string; note: string; count: number };
type Row = { key: string; todo?: Todo; suggestion?: Suggestion };

const CATEGORY_PRIORITY: Record<string, number> = { "action-required": 4, important: 3, updates: 2, promotions: 1 };
const SUGGESTED_SHOWN = 5;

function nameOf(s: string): string {
  return (s || "").replace(/<.*>/, "").replace(/"/g, "").trim();
}

export default function TodosView() {
  const { user, addToast, search, getViewCache, setViewCache, liveChanges } = useApp();
  const supabase = createClient();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [sources, setSources] = useState<Map<string, { sender: string; subject: string }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [newTodo, setNewTodo] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [handled, setHandled] = useState<Set<string>>(new Set()); // suggestions added or dismissed
  const [showSuggested, setShowSuggested] = useState(() => localStorage.getItem("tabellar_todos_suggested") !== "off");
  const [allSuggested, setAllSuggested] = useState(false);
  const [filter, setFilterRaw] = useState<"open" | "done">("open");
  const [group, setGroup] = useState<"day" | "sender">("day");
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  // Todos ticked or unticked since the filter was chosen stay in the list, so a
  // slip can be put right where it happened.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [selectedEmail, setSelectedEmail] = useState<any | null>(null);
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const stopped = usePrefStops("todo");

  const loadTodos = useCallback(async () => {
    const cached = getViewCache("todos");
    if (cached) {
      setTodos(cached);
      setLoading(false);
    }
    const { data, error } = await supabase.from("todos").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(500);
    setLoading(false);
    if (error) return setLoadError(error.message || "the database did not answer");
    setLoadError("");
    const result = (data || []) as Todo[];
    setTodos(result);
    setViewCache("todos", result);
    // Who and what each todo came from.
    const ids = [...new Set(result.map((t) => t.email_id).filter(Boolean))] as string[];
    if (!ids.length) return;
    const e = await supabase.from("emails").select("id, sender, sender_email, subject").in("id", ids);
    setSources(new Map(((e.data || []) as any[]).map((x) => [x.id, { sender: nameOf(x.sender) || x.sender_email || "", subject: x.subject || "(no subject)" }])));
  }, [user.id]);

  // Todos that the analysis of the last three days of mail came up with.
  const loadSuggestions = useCallback(async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("email_processed")
      .select("email_id, category, quick_actions, emails!inner(subject, sender, sender_email, received_at)")
      .eq("user_id", user.id)
      .filter("emails.received_at", "gte", threeDaysAgo)
      .limit(100);
    if (!data) return;
    // Mail Tabellar is still asking about, or that the user's preferences rule out, suggests nothing.
    const { data: asking } = await supabase.from("questions").select("email_id").eq("user_id", user.id).in("status", ["open", "waiting"]);
    const held = new Set(((asking || []) as any[]).map((q) => q.email_id));
    const out: Suggestion[] = [];
    for (const row of data as any[]) {
      if (!row.emails || held.has(row.email_id)) continue;
      for (const qa of Array.isArray(row.quick_actions) ? row.quick_actions : []) {
        const task = qa.action === "add_todo" && qa.label ? String(qa.label).replace(/^Todo:\s*/i, "").trim() : "";
        if (!task || stopped(row.emails.sender_email, `${row.emails.subject ?? ""} ${task}`)) continue;
        out.push({ key: `s:${row.email_id}:${task}`, emailId: row.email_id, task, subject: row.emails.subject || "(no subject)", sender: nameOf(row.emails.sender), receivedAt: row.emails.received_at, category: row.category || "updates" });
      }
    }
    // What matters most first, then the newest mail.
    out.sort((a, b) => (CATEGORY_PRIORITY[b.category] ?? 0) - (CATEGORY_PRIORITY[a.category] ?? 0) || b.receivedAt.localeCompare(a.receivedAt));
    setSuggestions(out);
  }, [user.id, stopped]);

  useEffect(() => {
    loadTodos();
  }, [loadTodos, liveChanges.todos]);
  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions, liveChanges.email_processed]);

  const q = search.trim().toLowerCase();
  const sourceOf = (t: Todo) => (t.email_id ? sources.get(t.email_id) : undefined);

  // Suggestions that are not already todos and have not been dismissed.
  const suggested = useMemo(() => {
    const have = new Set(todos.map((t) => t.text.toLowerCase()));
    return suggestions.filter((s) => !have.has(s.task.toLowerCase()) && !handled.has(s.key) && (!q || `${s.task} ${s.sender} ${s.subject}`.toLowerCase().includes(q)));
  }, [suggestions, todos, handled, q]);

  const shown = useMemo(
    () =>
      todos.filter((t) => {
        if (t.is_completed !== (filter === "done") && !touched.has(t.id)) return false;
        const s = t.email_id ? sources.get(t.email_id) : undefined;
        return !q || `${t.text} ${s?.sender || ""} ${s?.subject || ""}`.toLowerCase().includes(q);
      }),
    [todos, filter, touched, sources, q],
  );

  const items = useMemo(() => {
    const out: (Head | Row)[] = [];
    if (filter === "open" && suggested.length) {
      out.push({ head: true, key: "suggested", name: "Suggested by Tabellar", note: "From mail in the last 3 days", count: suggested.length });
      if (showSuggested) for (const s of allSuggested ? suggested : suggested.slice(0, SUGGESTED_SHOWN)) out.push({ key: s.key, suggestion: s });
    }
    const groups = new Map<string, { name: string; note: string; list: Todo[] }>();
    for (const t of shown) {
      let key: string;
      let name: string;
      let note = "";
      if (group === "sender") {
        const s = t.email_id ? sources.get(t.email_id) : undefined;
        name = s?.sender || (t.email_id || t.source !== "manual" ? "From your mail" : "Added by you");
        key = `p:${name}`;
      } else {
        const d = dayLabel(t.created_at);
        key = `d:${d.key}`;
        name = d.name;
        note = d.date;
      }
      const g = groups.get(key) || { name, note, list: [] };
      g.list.push(t);
      groups.set(key, g);
    }
    for (const [key, g] of groups) out.push({ head: true, key, name: g.name, note: g.note, count: g.list.length }, ...g.list.map((t) => ({ key: t.id, todo: t })));
    return out;
  }, [shown, suggested, showSuggested, allSuggested, filter, group, sources]);

  const rows = useMemo(() => items.filter((i): i is Row => !("head" in i)), [items]);
  const cursor = rows.find((r) => r.key === cursorKey) || rows[0] || null;
  const openCount = todos.filter((t) => !t.is_completed).length;
  const doneCount = todos.length - openCount;

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor?.key]);

  const setFilter = (f: "open" | "done") => {
    setFilterRaw(f);
    setTouched(new Set());
    anchor.current = null;
  };

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorKey(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].key);
    // Let go of a tick clicked earlier, so Space acts on the row the cursor is on.
    if (listRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  };

  const addTodo = async (text: string, source = "manual", emailId?: string) => {
    if (!text.trim()) return false;
    const { data, error } = await supabase
      .from("todos")
      .insert({ user_id: user.id, text: text.trim(), source, ...(emailId ? { email_id: emailId } : {}) })
      .select()
      .single();
    if (error || !data) {
      addToast("error", `The todo was not added: ${error?.message || "the database did not answer"}. Try again.`);
      return false;
    }
    setTodos((prev) => [data as Todo, ...prev.filter((t) => t.id !== data.id)]);
    setCursorKey(data.id);
    if (source === "manual") setNewTodo("");
    return true;
  };

  const addSuggestion = async (s: Suggestion) => {
    if (!(await addTodo(s.task, "email", s.emailId))) return;
    setSources((prev) => new Map(prev).set(s.emailId, { sender: s.sender, subject: s.subject }));
    setHandled((prev) => new Set(prev).add(s.key));
  };

  const dismissSuggestion = (s: Suggestion) => setHandled((prev) => new Set(prev).add(s.key));

  const setDone = async (list: Todo[], done: boolean) => {
    const ids = list.filter((t) => t.is_completed !== done).map((t) => t.id);
    if (!ids.length) return;
    const mark = (value: boolean) => setTodos((prev) => prev.map((t) => (ids.includes(t.id) ? { ...t, is_completed: value } : t)));
    mark(done);
    setTouched((prev) => new Set([...prev, ...ids]));
    const { error } = await supabase.from("todos").update({ is_completed: done }).in("id", ids);
    if (error) {
      mark(!done);
      addToast("error", `That was not saved: ${error.message}. Try again.`);
    }
  };

  // The tick completes one todo; with Shift, every todo from the last tick to
  // this one.
  const tick = (t: Todo, done: boolean, range: boolean) => {
    const list = rows.flatMap((r) => (r.todo ? [r.todo] : []));
    const a = list.findIndex((x) => x.id === anchor.current);
    const b = list.findIndex((x) => x.id === t.id);
    anchor.current = t.id;
    setCursorKey(t.id);
    if (!range || a < 0 || a === b) return void setDone([t], done);
    const span = list.slice(Math.min(a, b), Math.max(a, b) + 1).filter((x) => x.is_completed !== done);
    setDone(span, done);
    if (span.length > 1) addToast("info", `${span.length} todos marked ${done ? "done" : "open"}`, { action: { label: "Undo", onClick: () => setDone(span.map((x) => ({ ...x, is_completed: done })), !done) } });
  };

  const removeTodo = async (t: Todo) => {
    const at = rows.findIndex((r) => r.key === t.id);
    setCursorKey((rows[at + 1] || rows[at - 1])?.key ?? null);
    setTodos((prev) => prev.filter((x) => x.id !== t.id));
    const { error } = await supabase.from("todos").delete().eq("id", t.id);
    if (error) {
      addToast("error", `The todo was not deleted: ${error.message}. Try again.`);
      return void loadTodos();
    }
    const undo = async () => {
      const { data } = await supabase
        .from("todos")
        .insert({ id: t.id, user_id: user.id, text: t.text, is_completed: t.is_completed, source: t.source, created_at: t.created_at, email_id: t.email_id ?? null })
        .select()
        .single();
      if (data) setTodos((prev) => [...prev.filter((x) => x.id !== t.id), data as Todo].sort((x, y) => y.created_at.localeCompare(x.created_at)));
    };
    addToast("info", "Todo deleted", { action: { label: "Undo", onClick: undo } });
  };

  const openEmailById = useCallback(async (emailId: string) => {
    const { data } = await supabase.from("emails").select("*, email_processed(*)").eq("id", emailId).single();
    if (data) setSelectedEmail(data);
    else addToast("error", "That email is no longer in Tabellar.");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selectedEmail || document.querySelector("[data-compose-modal]")) return;
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "n" && filter === "open") inputRef.current?.focus();
      else if (e.key === " " || e.key === "Enter") {
        // A focused button or link takes its own Space and Enter.
        if (!cursor || (e.target as HTMLElement).closest?.("button, a")) return;
        if (cursor.todo) tick(cursor.todo, !cursor.todo.is_completed, e.shiftKey);
        else addSuggestion(cursor.suggestion!);
      } else if (e.key === "Backspace" && cursor) {
        if (cursor.todo) removeTodo(cursor.todo);
        else dismissSuggestion(cursor.suggestion!);
      } else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (selectedEmail)
    return (
      <EmailDetail
        key={selectedEmail.id}
        email={selectedEmail}
        onBack={() => setSelectedEmail(null)}
        onArchive={() => {
          const id = selectedEmail.id;
          setSelectedEmail(null);
          setEmailFlag(id, "archive")
            .then((undo) => addToast("success", "Archived", { action: { label: "Undo", onClick: () => void undo() } }))
            .catch((e: Error) => addToast("error", `Could not archive: ${e.message}`));
        }}
        onReply={() => setSelectedEmail(null)}
        onMarkUnread={() => {
          const id = selectedEmail.id;
          setSelectedEmail(null);
          setEmailFlag(id, "unread").catch(() => {});
        }}
        onSnooze={() => setSelectedEmail(null)}
        onRethink={(updated: any) => setSelectedEmail((prev: any) => (prev ? { ...prev, email_processed: updated } : prev))}
        showBack
      />
    );

  const source = (emailId: string, sender: string, subject: string) => (
    <span className="min-w-0 flex-1 truncate pl-2.5 text-ink3">
      <button className="inline hover:text-ink hover:underline" title="Open the email this came from" onClick={(e) => (e.stopPropagation(), openEmailById(emailId))}>
        {sender ? `${sender}, ${subject}` : subject}
      </button>
    </span>
  );

  return (
    <>
      <ViewBar
        title="Todos"
        search="Search todos"
        right={
          <Menu
            label="Group"
            value={group}
            onChange={setGroup}
            options={[
              { id: "day", label: "Day added" },
              { id: "sender", label: "Sender" },
            ]}
          />
        }
      >
        <Seg
          value={filter}
          onChange={setFilter}
          options={[
            { id: "open", label: "Open", count: openCount },
            { id: "done", label: "Done" },
          ]}
        />
      </ViewBar>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-3" role="listbox" aria-label="Todos">
        {filter === "open" && (
          <form
            className="mx-2 flex items-center pl-1.5 pr-3 pt-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              addTodo(newTodo);
            }}
          >
            <span className="grid w-[26px] flex-none place-items-center text-ink3">
              <Icon name="add" size={15} />
            </span>
            <input ref={inputRef} className="input" value={newTodo} onChange={(e) => setNewTodo(e.target.value)} placeholder="Add a todo, then press Return" aria-label="Add a todo" />
          </form>
        )}
        {loadError && (
          <p className="px-5 pt-3 text-danger" role="alert">
            Your todos could not be loaded: {loadError}.{" "}
            <button className="link" onClick={loadTodos}>
              Try again
            </button>
          </p>
        )}
        {loading ? (
          <div className="pt-9">
            <SkeletonRows count={16} />
          </div>
        ) : loadError && !todos.length ? null : !items.length ? (
          q ? (
            <Empty icon="search" title="No todos match that search">
              Try a word from the todo, or the name of the person whose email it came from.
            </Empty>
          ) : filter === "done" ? (
            <Empty icon="task_alt" title="Nothing is done yet">
              Todos you tick off are kept here, so you can look back or untick one.
            </Empty>
          ) : (
            <Empty icon="checklist" title="No open todos">
              When an email asks something of you, Tabellar adds it here with the email it came from. To add your own, type it in the field above.
            </Empty>
          )
        ) : (
          items.map((item) => {
            if ("head" in item)
              return (
                <div key={item.key} className="day">
                  <b>{item.name}</b>
                  <span className="truncate">{item.note}</span>
                  <span className="flex-1" />
                  {item.key === "suggested" && (
                    <button
                      className="link"
                      onClick={() => {
                        localStorage.setItem("tabellar_todos_suggested", showSuggested ? "off" : "on");
                        setShowSuggested(!showSuggested);
                      }}
                    >
                      {showSuggested ? "Hide" : "Show"}
                    </button>
                  )}
                  <span>{item.count}</span>
                </div>
              );
            const isCursor = cursor?.key === item.key;
            if (item.suggestion) {
              const s = item.suggestion;
              const last = !allSuggested && suggested.length > SUGGESTED_SHOWN && s === suggested[SUGGESTED_SHOWN - 1];
              return (
                <div key={item.key}>
                  <div role="option" aria-selected={isCursor} className="row scroll-mt-[34px]" onClick={() => setCursorKey(item.key)}>
                    <span className="grid w-[26px] flex-none place-items-center text-ink4">
                      <Icon name="add" size={14} />
                    </span>
                    <span className="min-w-0 shrink truncate text-ink">{s.task}</span>
                    {source(s.emailId, s.sender, s.subject)}
                    <button className="link ml-3 flex-none" onClick={(e) => (e.stopPropagation(), addSuggestion(s))}>
                      Add
                    </button>
                    <button className="link ml-3 flex-none" onClick={(e) => (e.stopPropagation(), dismissSuggestion(s))}>
                      Dismiss
                    </button>
                  </div>
                  {last && (
                    <button className="link mx-2 mb-1 mt-1 block pl-8" onClick={() => setAllSuggested(true)}>
                      Show {suggested.length - SUGGESTED_SHOWN} more
                    </button>
                  )}
                </div>
              );
            }
            const t = item.todo!;
            const src = sourceOf(t);
            return (
              <div key={item.key} role="option" aria-selected={isCursor} className="row group scroll-mt-[34px]" onClick={() => setCursorKey(item.key)}>
                <span className="grid w-[26px] flex-none place-items-center">
                  <Tick checked={t.is_completed} onChange={(v, e) => tick(t, v, e.shiftKey)} label={t.is_completed ? `Mark as open: ${t.text}` : `Mark as done: ${t.text}`} />
                </span>
                <span className={`min-w-0 shrink truncate ${t.is_completed ? "text-ink3 line-through" : "text-ink"}`}>{t.text}</span>
                {src && t.email_id ? source(t.email_id, src.sender, src.subject) : <span className="min-w-0 flex-1 truncate pl-2.5 text-ink3">{t.source !== "manual" && "From your mail"}</span>}
                <button className="iconbtn hidden h-6 w-6 group-hover:grid" title="Delete (Backspace)" aria-label={`Delete: ${t.text}`} onClick={(e) => (e.stopPropagation(), removeTodo(t))}>
                  <Icon name="delete" size={14} />
                </button>
                {t.email_id && t.source !== "manual" && !t.is_completed && (
                  <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-aria-selected:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                    <NotThis thing="todo" id={t.id} who={src?.sender} onDone={loadTodos} />
                  </span>
                )}
                <time className="flex-none pl-2.5 text-xs text-ink3">{shortWhen(t.created_at)}</time>
              </div>
            );
          })
        )}
      </div>
      <KeyHints
        left={loading ? "" : `${openCount.toLocaleString()} open, ${doneCount.toLocaleString()} done${suggested.length ? `, ${suggested.length} suggested` : ""}`}
        keys={[
          ["J K", "Move"],
          ["Space", filter === "open" ? "Done" : "Reopen"],
          ["N", "New"],
          ["⌫", "Delete"],
        ]}
      />
    </>
  );
}
