import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { ReaderById } from "../EmailDetail";
import { Empty, SkeletonRows, Tick, ViewBar, VirtualList } from "../ui";
import { NotThis } from "../Profile";

// Todos: a plain checklist, grouped by when each is due. A todo Tabellar
// found but has not added (it waits for approval) is an ordinary row with a
// dashed box, Add and the "Not this" menu. The email a todo came from is
// named on hover and opens from the row.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Todo = { id: string; text: string; is_completed: boolean; source: string; created_at: string; email_id: string | null; due: string | null };
type Proposal = { id: string; hash: string; text: string; due: string | null; email_id: string | null; created_at: string };
type Source = { sender: string; subject: string };
type Row = { key: string; text: string; due: string | null; emailId: string | null; created: string; todo?: Todo; proposal?: Proposal };
type Head = { head: true; key: Group; name: string };
type Group = "today" | "week" | "later" | "done";

const GROUPS: [Group, string][] = [
  ["today", "Today"],
  ["week", "This week"],
  ["later", "Later"],
  ["done", "Done"],
];

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nameOf = (s: string) => (s || "").replace(/<.*>/, "").replace(/"/g, "").trim();

// When a todo is due, in words: Overdue, Today, Tomorrow, the weekday within
// the week, else the date.
function dueLabel(due: string, today: string): string {
  if (due < today) return "Overdue";
  const d = new Date(`${due}T12:00`);
  const days = Math.round((d.getTime() - new Date(`${today}T12:00`).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

// Dated todos go by their day; undated ones are today's on the day they were
// added and this week's after that.
function groupOf(r: Row, today: string, weekEnd: string): Group {
  if (r.todo?.is_completed) return "done";
  if (r.due) return r.due <= today ? "today" : r.due <= weekEnd ? "week" : "later";
  return dayKey(new Date(r.created)) === today ? "today" : "week";
}

export default function TodosView() {
  const { user, addToast, search, liveChanges, mail } = useApp();
  const supabase = createClient();
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [sources, setSources] = useState<Map<string, Source>>(new Map());
  const [loadError, setLoadError] = useState("");
  const [newTodo, setNewTodo] = useState("");
  const [showDone, setShowDone] = useState(() => {
    try {
      return localStorage.getItem("tabellar_todos_done") === "open";
    } catch {
      return false;
    }
  });
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [t, p] = await Promise.all([
      supabase.from("todos").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(1000),
      supabase.from("action_log").select("id, hash, detail, email_id, created_at").eq("user_id", user.id).eq("kind", "todo").eq("status", "proposed").order("created_at", { ascending: false }),
    ]);
    if (t.error) return setLoadError(t.error.message || "the database did not answer");
    setLoadError("");
    const list = (t.data || []) as Todo[];
    // A proposal for a todo that is already on the list is not shown twice.
    const have = new Set(list.map((x) => `${x.email_id}:${x.text.toLowerCase()}`));
    const waiting = ((p.data || []) as any[])
      .map((r) => ({ id: r.id, hash: r.hash || "", text: String(r.detail?.text || ""), due: r.detail?.due ?? null, email_id: r.email_id, created_at: r.created_at }))
      .filter((r) => r.text && !have.has(`${r.email_id}:${r.text.toLowerCase()}`));
    setTodos(list);
    setProposals(waiting);
    // Who and what each todo came from.
    const ids = [...new Set([...list, ...waiting].map((x) => x.email_id).filter(Boolean))] as string[];
    if (!ids.length) return;
    const e = await supabase.from("emails").select("id, sender, sender_email, subject").in("id", ids);
    setSources(new Map(((e.data || []) as any[]).map((x) => [x.id, { sender: nameOf(x.sender) || x.sender_email || "", subject: x.subject || "(no subject)" }])));
  }, [user.id]);

  useEffect(() => {
    load();
  }, [load, liveChanges.todos, liveChanges.action_log]);

  const q = search.trim().toLowerCase();
  const now = new Date();
  const today = dayKey(now);
  const weekEnd = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6));

  const items = useMemo(() => {
    const rows: Row[] = [
      ...proposals.map((p) => ({ key: `p:${p.id}`, text: p.text, due: p.due, emailId: p.email_id, created: p.created_at, proposal: p })),
      ...(todos || []).map((t) => ({ key: t.id, text: t.text, due: t.due, emailId: t.email_id, created: t.created_at, todo: t })),
    ].filter((r) => {
      const s = r.emailId ? sources.get(r.emailId) : undefined;
      return !q || `${r.text} ${s?.sender || ""} ${s?.subject || ""}`.toLowerCase().includes(q);
    });
    const out: (Head | Row)[] = [];
    for (const [g, name] of GROUPS) {
      const list = rows.filter((r) => groupOf(r, today, weekEnd) === g);
      if (!list.length) continue;
      // Dated first by day, then the newest; done ones newest first.
      list.sort((a, b) => (g === "done" ? 0 : (a.due ?? "9999").localeCompare(b.due ?? "9999")) || b.created.localeCompare(a.created));
      out.push({ head: true, key: g, name });
      if (g !== "done" || showDone || q) out.push(...list);
    }
    return out;
  }, [todos, proposals, sources, q, today, weekEnd, showDone]);

  const rows = useMemo(() => items.filter((i): i is Row => !("head" in i)), [items]);
  const cursor = rows.find((r) => r.key === cursorKey) || rows[0] || null;
  const cursorIndex = cursor ? items.indexOf(cursor) : -1;

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorKey(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].key);
  };
  // The row to land on when the one at `key` leaves the list.
  const stepPast = (key: string) => {
    const at = rows.findIndex((r) => r.key === key);
    setCursorKey((rows[at + 1] || rows[at - 1])?.key ?? null);
  };

  const toggleDone = () => {
    setShowDone(!showDone);
    try {
      localStorage.setItem("tabellar_todos_done", showDone ? "closed" : "open");
    } catch {
      // Remembering is a convenience.
    }
  };

  const addTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = newTodo.trim();
    if (!text) return;
    const { data, error } = await supabase.from("todos").insert({ user_id: user.id, text, source: "manual" }).select().single();
    if (error || !data) return addToast("error", `The todo was not added: ${error?.message || "the database did not answer"}. Try again.`);
    setTodos((prev) => [data as Todo, ...(prev || [])]);
    setNewTodo("");
  };

  const setDone = async (t: Todo, done: boolean) => {
    const mark = (value: boolean) => setTodos((prev) => (prev || []).map((x) => (x.id === t.id ? { ...x, is_completed: value } : x)));
    mark(done);
    const { error } = await supabase.from("todos").update({ is_completed: done }).eq("id", t.id);
    if (error) {
      mark(!done);
      return addToast("error", `That was not saved: ${error.message}. Try again.`);
    }
    if (done) addToast("info", "Done", { action: { label: "Undo", onClick: () => void setDone({ ...t, is_completed: true }, false) } });
  };

  const add = async (p: Proposal) => {
    stepPast(`p:${p.id}`);
    setProposals((prev) => prev.filter((x) => x.id !== p.id));
    await mail.approve(p.id, p.hash).catch(() => load());
  };

  const remove = async (t: Todo) => {
    stepPast(t.id);
    setTodos((prev) => (prev || []).filter((x) => x.id !== t.id));
    const { error } = await supabase.from("todos").delete().eq("id", t.id);
    if (error) {
      addToast("error", `The todo was not deleted: ${error.message}. Try again.`);
      return void load();
    }
    const undo = async () => {
      const { data } = await supabase.from("todos").insert({ ...t, user_id: user.id }).select().single();
      if (data) setTodos((prev) => [...(prev || []).filter((x) => x.id !== t.id), data as Todo]);
    };
    addToast("info", "Todo deleted", { action: { label: "Undo", onClick: undo } });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (reading || document.querySelector("[data-compose-modal]")) return;
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "n") inputRef.current?.focus();
      else if (e.key === " " && cursor && !(e.target as HTMLElement).closest?.("button, a")) {
        if (cursor.todo) setDone(cursor.todo, !cursor.todo.is_completed);
        else add(cursor.proposal!);
      } else if (e.key === "Backspace" && cursor?.todo) remove(cursor.todo);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const heightOf = useCallback((i: Head | Row) => ("head" in i ? 34 : 32), []);

  if (reading) return <ReaderById emailId={reading} onClose={() => setReading(null)} />;

  const render = (item: Head | Row) => {
    if ("head" in item) {
      if (item.key !== "done")
        return (
          <div key={item.key} className="day !static">
            <b>{item.name}</b>
          </div>
        );
      return (
        <div key={item.key} className="day !static">
          <button className="flex items-center gap-1 text-ink3 hover:text-ink" aria-expanded={showDone || !!q} onClick={toggleDone}>
            <b className="font-[650] text-ink">{item.name}</b>
            <Icon name={showDone || q ? "expand_more" : "chevron_right"} size={13} />
          </button>
        </div>
      );
    }
    const t = item.todo;
    const src = item.emailId ? sources.get(item.emailId) : undefined;
    const from = src ? `From ${src.sender ? `${src.sender}: ` : ""}${src.subject}` : undefined;
    const done = !!t?.is_completed;
    const fromMail = !!item.emailId && t?.source !== "manual";
    const reveal = "opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-aria-selected:opacity-100 has-[[aria-expanded=true]]:opacity-100";
    return (
      <div key={item.key} role="option" aria-selected={cursor?.key === item.key} className="row group gap-2.5" title={from} onClick={() => setCursorKey(item.key)}>
        <span className="grid w-[26px] flex-none place-items-center">
          {t ? <Tick checked={done} onChange={(v) => setDone(t, v)} label={done ? `Mark as open: ${t.text}` : `Mark as done: ${t.text}`} /> : <span className="tick border-dashed" aria-label="Waiting to be added" />}
        </span>
        <span className={`min-w-0 flex-1 truncate ${done ? "text-ink3 line-through" : t ? "text-ink" : "text-ink2"}`}>{item.text}</span>
        <span className={`flex flex-none items-center ${reveal}`}>
          {item.emailId && (
            <button className="iconbtn h-6 w-6" title={from} aria-label={from} onClick={(e) => (e.stopPropagation(), setReading(item.emailId))}>
              <Icon name="mail" size={14} />
            </button>
          )}
          {t?.source === "manual" && (
            <button className="iconbtn h-6 w-6" title="Delete" aria-label={`Delete: ${t.text}`} onClick={(e) => (e.stopPropagation(), remove(t))}>
              <Icon name="delete" size={14} />
            </button>
          )}
          {fromMail && !done && <NotThis thing="todo" id={t?.id} proposal={item.proposal?.id} who={src?.sender} onDone={load} />}
        </span>
        {item.proposal && (
          <button className="link flex-none !text-wax-ink" onClick={(e) => (e.stopPropagation(), add(item.proposal!))}>
            Add
          </button>
        )}
        {item.due && !done && <span className={`w-[72px] flex-none text-right text-xs ${item.due < today ? "font-medium text-ink2" : "text-ink3"}`}>{dueLabel(item.due, today)}</span>}
      </div>
    );
  };

  return (
    <>
      <ViewBar title="Todos" search="Search todos" />
      <form className="mx-2 flex flex-none items-center pb-1 pl-1.5 pr-3 pt-2.5" onSubmit={addTodo}>
        <span className="grid w-[26px] flex-none place-items-center text-ink3">
          <Icon name="add" size={15} />
        </span>
        <input ref={inputRef} className="input" value={newTodo} onChange={(e) => setNewTodo(e.target.value)} placeholder="Add a todo" aria-label="Add a todo" />
      </form>
      {loadError && (
        <p className="px-5 pt-3 text-danger" role="alert">
          Your todos could not be loaded: {loadError}.{" "}
          <button className="link !text-danger" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {todos === null ? (
        loadError ? null : (
          <div className="pt-9">
            <SkeletonRows count={14} />
          </div>
        )
      ) : !rows.length && !items.length ? (
        q ? <Empty icon="search" title="Nothing matches that search" /> : <Empty icon="checklist" title="No todos" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" role="listbox" aria-label="Todos">
          <VirtualList items={items} heightOf={heightOf} render={render} cursor={cursorIndex} />
        </div>
      )}
    </>
  );
}
