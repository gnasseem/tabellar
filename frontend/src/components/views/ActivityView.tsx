import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/db";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { Countdown, Empty, Glyph, KeyHints, Kbd, Menu, Seg, SkeletonRows, Tick, ViewBar, VirtualList, clock, dayLabel, shortWhen, type MailState } from "../ui";

// Everything Tabellar did or proposes, and what the agent and the assistant
// did for you. Proposals are approved exactly as shown (the server checks a
// hash of the content); finished actions can be undone. Every line says what
// happened, why, and how to take it back.

// The sidebar owns the level and pause controls; Settings imports these from here.
export { LEVELS, confirmLevel } from "../Sidebar";

type LogRow = {
  id: string;
  kind: "label" | "archive" | "draft" | "todo" | "meeting" | "send" | "unsubscribe";
  status: "proposed" | "running" | "done" | "undone" | "dismissed" | "blocked" | "failed";
  source: "engine" | "agent" | "assistant" | "user";
  summary: string;
  detail: Record<string, unknown>;
  hash: string | null;
  reason: string | null;
  error: string | null;
  created_at: string;
  emails: { id: string; subject: string | null; sender: string | null } | null;
};

type Head = { head: true; key: string; name: string; note: string; count: number; waiting?: boolean };
type Item = Head | LogRow;
type Filter = "waiting" | "done" | "notdone" | "all";
type Group = "day" | "kind";

const CHUNK = 1000;
const HEAD = 34;
const ROW = 32;
const PROPOSAL = 62;
const LINE = 20; // line height of detail text, so a block's height is known before it is drawn
const UNDOABLE = new Set(["label", "archive", "draft", "todo", "meeting"]);
const KIND_NAME: Record<string, string> = { label: "Labels", draft: "Drafted replies", send: "Replies sent", todo: "Todos", meeting: "Meetings", archive: "Archived", unsubscribe: "Unsubscribes" };
const SOURCE: Record<string, string> = { engine: "Tabellar, on its own", agent: "A cleanup plan you approved", assistant: "Ask, at your request", user: "You" };

export async function engineFetch(path: string, body?: unknown) {
  const { data } = await createClient().auth.getSession();
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// An Autopilot reply that has not gone out yet can still be cancelled.
function pendingSend(r: LogRow): boolean {
  return r.kind === "send" && r.status === "done" && !r.detail.sentAt && typeof r.detail.sendAt === "string" && new Date(r.detail.sendAt).getTime() > Date.now();
}

function plain(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}

function recipients(r: LogRow): string {
  return (r.detail.to as string[] | undefined)?.join(", ") || "the sender";
}

function emailLine(r: LogRow): string {
  return r.emails ? `${r.emails.sender?.split("<")[0]?.replace(/"/g, "").trim() || "Unknown"}: ${r.emails.subject || "(no subject)"}` : "";
}

function dayTime(iso: string): string {
  return `${new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${clock(iso)}`;
}

// The text a reply proposal or a logged reply carries.
function bodyOf(r: LogRow): string {
  return (r.kind === "draft" || r.kind === "send") && typeof r.detail.body === "string" ? plain(r.detail.body) : "";
}

// What approving a proposal does, in full, since approval is bound to it.
function willDo(r: LogRow): string {
  const d = r.detail;
  if (r.kind === "label") return `Adds the Gmail label ${String(d.label ?? "")} to this email.`;
  if (r.kind === "todo") return `Adds to Todos: ${String(d.text ?? "")}`;
  if (r.kind === "meeting") {
    const start = typeof d.start_time === "string" ? dayTime(d.start_time) : "";
    const end = typeof d.end_time === "string" ? ` to ${clock(d.end_time)}` : "";
    return `${start}${end}${d.location ? `, ${String(d.location)}` : ""}. Goes to Meetings for you to confirm, not onto your calendar yet.`;
  }
  if (r.kind === "draft") return `Saves this reply to ${recipients(r)} as a draft in Replies. Nothing is sent.`;
  if (r.kind === "send") return `Sends this reply to ${recipients(r)}, inside the thread, after a wait you can cancel in.`;
  if (r.kind === "archive") return Array.isArray(d.emailIds) ? `Archives ${d.emailIds.length} emails in Gmail. Nothing is deleted.` : "Archives this email in Gmail. Nothing is deleted.";
  return "Unsubscribes from this sender.";
}

// The thing an action is about, for the detail of a finished or refused row.
function about(r: LogRow): string {
  const d = r.detail;
  if (r.kind === "label") return `Gmail label ${String(d.label ?? "")}`;
  if (r.kind === "todo") return String(d.text ?? r.summary);
  if (r.kind === "meeting") return `${String(d.title ?? "Meeting")}${typeof d.start_time === "string" ? `, ${dayTime(d.start_time)}` : ""}${typeof d.end_time === "string" ? ` to ${clock(d.end_time)}` : ""}${d.location ? `, ${String(d.location)}` : ""}`;
  if (r.kind === "draft" || r.kind === "send") return `To ${recipients(r)}${d.subject ? `, ${String(d.subject)}` : ""}`;
  if (r.kind === "archive") return Array.isArray(d.emailIds) ? `${d.emailIds.length} emails, archived in Gmail` : "This email, archived in Gmail";
  return r.summary;
}

// How to take a row back, or why there is nothing to take back.
function undoNote(r: LogRow): string {
  if (r.status === "blocked") return "Nothing was changed.";
  if (r.status === "dismissed") return "You dismissed it. Nothing was changed.";
  if (r.status === "undone") return r.kind === "send" ? "You cancelled it. It was not sent." : "Already undone.";
  if (r.status !== "done") return "";
  if (pendingSend(r)) return "Cancel stops it from being sent.";
  if (r.kind === "send") return "A sent reply cannot be taken back.";
  if (r.kind === "label") return "Undo removes the label in Gmail.";
  if (r.kind === "archive") return "Undo returns it to the inbox.";
  if (r.kind === "draft") return "Undo deletes the draft.";
  if (r.kind === "todo") return "Undo removes the todo.";
  if (r.kind === "meeting") return "Undo removes the proposed meeting. Once it is confirmed, change it in Meetings.";
  return "An unsubscribe cannot be undone from here.";
}

function stateOf(r: LogRow): MailState {
  if (r.status === "proposed") return "need";
  if (r.status === "blocked") return "held";
  if (r.status === "failed") return "failed";
  if (r.status === "running" || (r.kind === "send" && r.status === "done" && !r.detail.sentAt)) return "going";
  if (r.status === "done") return "done";
  return "filed";
}

// The labelled lines shown when a finished or refused row is opened.
function detailOf(r: LogRow): [string, string, boolean?][] {
  const out: [string, string, boolean?][] = [["What", about(r)]];
  if (r.error) out.push(["Error", r.error, true]);
  if (r.reason) out.push(["Why", r.reason]);
  out.push(["By", `${SOURCE[r.source] ?? r.source}, ${dayTime(r.created_at)}`]);
  if (undoNote(r)) out.push(["Undo", undoNote(r)]);
  return out;
}

// Lines a text takes at about `perLine` characters a line. Blocks get exactly
// this height and scroll inside if the guess runs short.
function linesOf(text: string, perLine: number): number {
  return text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
}
function bodyHeight(body: string): number {
  return Math.min(linesOf(body, 84), 12) * LINE + 20;
}
function detailHeight(r: LogRow): number {
  const body = bodyOf(r);
  const n = detailOf(r).reduce((sum, [, text]) => sum + linesOf(text, 72), 0) + (body ? linesOf(body, 72) + 1 : 0);
  return Math.min(n, 16) * LINE + 20;
}


export default function ActivityView() {
  const { user, addToast, liveChanges, search, mail, setView } = useApp();
  const supabase = createClient();
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [group, setGroup] = useState<Group>(() => (localStorage.getItem("tabellar_activity_group") as Group) || "day");
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const searching = !!search.trim();
  const loaded = useRef(0);
  const loading = useRef(false);
  const anchor = useRef<string | null>(null);
  const lastUndo = useRef<(() => Promise<void>) | null>(null);

  const load = useCallback(
    async (more = false) => {
      if (loading.current) return;
      loading.current = true;
      try {
        // A search looks through the whole log, so it loads further back.
        const want = more ? loaded.current + CHUNK : Math.max(searching ? 5 * CHUNK : CHUNK, loaded.current);
        const { data } = await supabase.from("action_log").select("*, emails(id, subject, sender)").eq("user_id", user.id).order("created_at", { ascending: false }).range(0, want);
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        let list = ((data || []) as any[]).map((r) => ({ ...r, detail: r.detail || {}, emails: Array.isArray(r.emails) ? r.emails[0] ?? null : r.emails })) as LogRow[];
        const extra = list.length > want;
        if (extra) list = list.slice(0, want);
        loaded.current = list.length;
        setHasMore(extra);
        setRows(list);
      } finally {
        loading.current = false;
      }
    },
    [user.id, searching],
  );

  useEffect(() => {
    load();
  }, [load, liveChanges.action_log]);

  // A reply leaves its cancel window at its send time even if no event arrives.
  useEffect(() => {
    const next = (rows || []).filter(pendingSend).map((r) => new Date(String(r.detail.sendAt)).getTime()).sort((a, b) => a - b)[0];
    if (!next) return;
    const id = setTimeout(() => load(), next - Date.now() + 1500);
    return () => clearTimeout(id);
  }, [rows, load]);

  const engine = mail.engine;


  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows || []).filter((r) => !q || `${r.summary} ${r.emails?.subject ?? ""} ${r.emails?.sender ?? ""}`.toLowerCase().includes(q));
  }, [rows, search]);

  // Proposals first, oldest at the top so new ones land below the one being
  // read; then everything else, newest first, under day or kind headers.
  const items = useMemo(() => {
    const out: Item[] = [];
    const proposals = filter === "all" || filter === "waiting" ? shown.filter((r) => r.status === "proposed").reverse() : [];
    const rest = shown.filter((r) =>
      filter === "waiting" ? false : filter === "done" ? r.status === "done" || r.status === "running" : filter === "notdone" ? r.status === "blocked" || r.status === "failed" : r.status !== "proposed",
    );
    if (proposals.length) out.push({ head: true, key: "head:waiting", name: "Waiting for you", note: "Carried out exactly as shown once you approve", count: proposals.length, waiting: true }, ...proposals);
    if (group === "kind") {
      for (const kind of Object.keys(KIND_NAME)) {
        const list = rest.filter((r) => r.kind === kind);
        if (list.length) out.push({ head: true, key: `head:${kind}`, name: KIND_NAME[kind], note: "", count: list.length }, ...list);
      }
    } else {
      let run: LogRow[] = [];
      let day = { name: "", date: "", key: "" };
      const flush = () => run.length && out.push({ head: true, key: `head:${day.key}`, name: day.name, note: day.date, count: run.length }, ...run);
      for (const r of rest) {
        const d = dayLabel(r.created_at);
        if (d.key !== day.key) {
          flush();
          run = [];
          day = d;
        }
        run.push(r);
      }
      flush();
    }
    return out;
  }, [shown, filter, group]);

  const list = useMemo(() => items.filter((i): i is LogRow => !("head" in i)), [items]);
  const waiting = useMemo(() => list.filter((r) => r.status === "proposed"), [list]);
  const cursor = list.find((r) => r.id === cursorId) || list[0] || null;
  const cursorIndex = cursor ? items.indexOf(cursor) : -1;
  const selected = waiting.filter((r) => picked.has(r.id));
  const labelProposals = waiting.filter((r) => r.kind === "label");

  const heightOf = useCallback(
    (i: Item) => {
      if ("head" in i) return HEAD;
      if (i.status === "proposed") return PROPOSAL + (bodyOf(i) ? bodyHeight(bodyOf(i)) + 10 : 0);
      return ROW + (open.has(i.id) ? detailHeight(i) + 8 : 0);
    },
    [open],
  );

  const move = (delta: number) => {
    if (!list.length) return;
    const at = cursor ? list.indexOf(cursor) : -1;
    setCursorId(list[Math.min(list.length - 1, Math.max(0, at + delta))].id);
  };

  const pick = (r: LogRow, range = false) => {
    if (r.status !== "proposed") return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && anchor.current) {
        const a = waiting.findIndex((x) => x.id === anchor.current);
        const b = waiting.indexOf(r);
        if (a >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(waiting[i].id);
      } else if (next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });
    anchor.current = r.id;
  };

  const toggle = (r: LogRow) => {
    if (r.status === "proposed") return;
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });
  };

  // Runs one request per row, marks the rows busy meanwhile, and returns the
  // rows that went through and the first error.
  const each = async (targets: LogRow[], run: (r: LogRow) => Promise<unknown>) => {
    setBusy((b) => new Set([...b, ...targets.map((r) => r.id)]));
    const ok: LogRow[] = [];
    let error = "";
    for (const r of targets) {
      try {
        await run(r);
        ok.push(r);
      } catch (e) {
        error ||= (e as Error).message;
      }
    }
    setBusy((b) => {
      const next = new Set(b);
      targets.forEach((r) => next.delete(r.id));
      return next;
    });
    setPicked(new Set());
    await load();
    mail.reload();
    return { ok, error };
  };

  const undoRows = async (targets: LogRow[]) => {
    const { ok, error } = await each(targets, (r) => engineFetch("/actions/undo", { id: r.id }));
    if (error) addToast("error", `${targets.length - ok.length === 1 ? "Could not undo that" : `${targets.length - ok.length} could not be undone`}: ${error}`);
    else addToast("success", targets.length === 1 && targets[0].kind === "send" ? "Cancelled. The reply will not be sent." : targets.length === 1 ? "Undone" : `Undid ${ok.length}`);
  };

  const approve = async (targets: LogRow[]) => {
    targets = targets.filter((r) => r.status === "proposed" && !busy.has(r.id));
    if (!targets.length) return addToast("info", "Nothing here is waiting for approval");
    const { ok, error } = await each(targets, (r) => engineFetch("/actions/approve", { id: r.id, hash: r.hash }));
    if (error) addToast("error", `${targets.length - ok.length} of ${targets.length} could not be approved: ${error}`);
    if (!ok.length) return;
    const back = ok.filter((r) => UNDOABLE.has(r.kind)).map((r) => ({ ...r, status: "done" as const }));
    const run = async () => {
      lastUndo.current = null;
      await undoRows(back);
    };
    lastUndo.current = back.length ? run : null;
    addToast("success", ok.length === 1 ? "Approved" : `Approved ${ok.length}`, back.length ? { action: { label: "Undo", onClick: run } } : undefined);
  };

  const dismiss = async (targets: LogRow[]) => {
    targets = targets.filter((r) => r.status === "proposed" && !busy.has(r.id));
    if (!targets.length) return;
    const { ok, error } = await each(targets, (r) => engineFetch("/actions/dismiss", { id: r.id }));
    if (error) addToast("error", `${targets.length - ok.length} could not be dismissed: ${error}`);
    else addToast("info", ok.length === 1 ? "Dismissed. Nothing was changed." : `Dismissed ${ok.length}. Nothing was changed.`);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[data-compose-modal]")) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "x" && cursor) pick(cursor, e.shiftKey);
      else if (k === "a") approve(selected.length ? selected : cursor ? [cursor] : []);
      else if (e.key === "Enter" && cursor) toggle(cursor);
      else if (k === "z" && lastUndo.current) lastUndo.current();
      else if (e.key === "Escape" && picked.size) setPicked(new Set());
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const head = (h: Head) => (
    <div key={h.key} className="day !static">
      <b className={h.waiting ? "!text-wax-ink" : ""}>{h.name}</b>
      <span className="truncate">{h.note}</span>
      <span className="flex-1" />
      {h.waiting && labelProposals.length > 1 && !picked.size && (
        <button className="link whitespace-nowrap" onClick={() => approve(labelProposals)}>
          Approve all {labelProposals.length} labels
        </button>
      )}
      <span className="whitespace-nowrap">{h.count.toLocaleString()}</span>
    </div>
  );

  const renderItem = (item: Item) => {
    if ("head" in item) return head(item);
    const r = item;
    const isCursor = cursor === r;
    const email = emailLine(r);

    if (r.status === "proposed") {
      const body = bodyOf(r);
      const isPicked = picked.has(r.id);
      return (
        <div key={r.id} style={{ height: heightOf(r) }} className="group overflow-hidden">
          <div
            role="option"
            aria-selected={isCursor}
            className={`row2 grid h-[62px] grid-cols-[26px_minmax(0,1fr)_auto] content-center items-center gap-y-0.5 !py-0 after:hidden ${isPicked && !isCursor ? "bg-hover" : ""}`}
            onClick={(e) => (e.shiftKey ? pick(r, true) : setCursorId(r.id))}
          >
            <span className="row-span-2 grid place-items-center self-start pt-[3px]">
              <Tick checked={isPicked} onChange={(_, e) => pick(r, e.shiftKey)} label={`Select: ${r.summary}`} />
            </span>
            <div className="flex min-w-0 items-baseline gap-2">
              <b className="shrink truncate font-semibold text-ink">{r.summary}</b>
              {email && <span className="min-w-0 flex-1 truncate text-ink3">{email}</span>}
            </div>
            <time className="pl-3 text-right text-xs text-ink3">{shortWhen(r.created_at)}</time>
            <p className="truncate text-ink2" title={willDo(r)}>
              {willDo(r)}
            </p>
            <span className={`flex h-6 items-center justify-end gap-1.5 pl-3 ${isCursor ? "" : "invisible group-hover:visible"}`}>
              <button className="btn btn-sm" disabled={busy.has(r.id)} onClick={(e) => (e.stopPropagation(), dismiss([r]))}>
                Not this
              </button>
              <button className="btn btn-pri btn-sm" disabled={busy.has(r.id)} onClick={(e) => (e.stopPropagation(), approve([r]))}>
                Approve
              </button>
            </span>
          </div>
          {body && (
            <pre className="ml-10 mr-5 overflow-y-auto whitespace-pre-wrap rounded-[9px] bg-side px-3.5 py-2.5 font-sans text-[13px] leading-5 text-ink" style={{ height: bodyHeight(body) }}>
              {body}
            </pre>
          )}
        </div>
      );
    }

    const state = stateOf(r);
    const going = pendingSend(r);
    const quiet = r.status === "undone" || r.status === "dismissed";
    const isOpen = open.has(r.id);
    const why = r.error || (r.status === "blocked" ? r.reason : "") || (r.source !== "engine" ? SOURCE[r.source] : "");
    return (
      <div key={r.id} style={{ height: heightOf(r) }} className="overflow-hidden">
        <div
          role="option"
          aria-selected={isCursor}
          aria-expanded={isOpen}
          className="row !grid grid-cols-[26px_minmax(0,1fr)_auto_46px]"
          onClick={() => {
            setCursorId(r.id);
            toggle(r);
          }}
        >
          <span className="grid place-items-center">
            <Glyph state={state} />
          </span>
          <span className="flex min-w-0 items-center gap-2 pr-4">
            <b className={`shrink truncate font-normal ${quiet ? "text-ink3" : "text-ink"}`}>{r.summary}</b>
            {email && <span className="min-w-0 shrink-[2] truncate text-ink3">{email}</span>}
            {why && <span className={`hidden min-w-0 flex-1 truncate sm:block ${r.status === "failed" ? "text-danger" : "text-ink3"}`}>{why}</span>}
          </span>
          <span className="flex items-center gap-2.5 whitespace-nowrap text-[12.5px]">
            {going ? (
              <>
                <span className="font-medium text-wax-ink">
                  Sends in <Countdown until={String(r.detail.sendAt)} />
                </span>
                <button className="link" disabled={busy.has(r.id)} onClick={(e) => (e.stopPropagation(), undoRows([r]))}>
                  Cancel
                </button>
              </>
            ) : r.status === "done" && UNDOABLE.has(r.kind) ? (
              <button className="link" disabled={busy.has(r.id)} onClick={(e) => (e.stopPropagation(), undoRows([r]))}>
                Undo
              </button>
            ) : r.status === "done" && r.kind === "send" ? (
              <span className="text-ink3">{r.detail.sentAt ? `Sent ${shortWhen(String(r.detail.sentAt))}` : "Sending"}</span>
            ) : r.status === "blocked" ? (
              <span className="font-medium text-warn">Not allowed</span>
            ) : r.status === "failed" ? (
              <span className="font-medium text-danger">Failed</span>
            ) : r.status === "running" ? (
              <span className="text-ink3">Working</span>
            ) : quiet ? (
              <span className="text-ink3">{r.status === "dismissed" ? "Dismissed" : r.kind === "send" ? "Cancelled" : "Undone"}</span>
            ) : null}
          </span>
          <time className="text-right text-xs text-ink3">{shortWhen(r.created_at)}</time>
        </div>
        {isOpen && (
          <div className="ml-10 mr-5 overflow-y-auto rounded-[9px] bg-side px-3.5 py-2.5 text-[13px] leading-5" style={{ height: detailHeight(r) }}>
            <dl className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-3">
              {detailOf(r).map(([label, text, bad]) => (
                <div key={label} className="contents">
                  <dt className="text-ink3">{label}</dt>
                  <dd className={bad ? "text-danger" : "text-ink2"}>{text}</dd>
                </div>
              ))}
            </dl>
            {bodyOf(r) && <pre className="mt-5 whitespace-pre-wrap font-sans text-ink">{bodyOf(r)}</pre>}
          </div>
        )}
      </div>
    );
  };

  const firstHead = (first: number): Head | null => {
    for (let i = Math.min(first, items.length - 1); i >= 0; i--) if ("head" in items[i]) return items[i] as Head;
    return null;
  };

  const level = engine?.level ?? "observe";

  return (
    <>
      {selected.length ? (
        <header className="bar">
          <b className="bar-title mr-1.5">{selected.length} selected</b>
          <button className="btn btn-pri" onClick={() => approve(selected)}>
            Approve {selected.length} <Kbd>A</Kbd>
          </button>
          <button className="btn" onClick={() => dismiss(selected)}>
            Dismiss {selected.length}
          </button>
          <button className="btn btn-plain" onClick={() => setPicked(new Set())}>
            Clear <Kbd>esc</Kbd>
          </button>
        </header>
      ) : (
        <ViewBar
          title="Activity"
          search="Search activity"
          right={
            <Menu
              label="Group"
              value={group}
              onChange={(g) => (localStorage.setItem("tabellar_activity_group", g), setGroup(g))}
              options={[
                { id: "day", label: "Day" },
                { id: "kind", label: "Kind" },
              ]}
            />
          }
        >
          <Seg
            value={filter}
            onChange={setFilter}
            options={[
              { id: "waiting", label: "Waiting for you", count: mail.counts.proposals, need: true },
              { id: "done", label: "Done" },
              { id: "notdone", label: "Not done" },
              { id: "all", label: "All" },
            ]}
          />
        </ViewBar>
      )}
      {(engine?.paused || engine?.gmailError || engine?.lastError) && (
        <div className="flex h-9 flex-none items-center gap-2 border-b border-line-soft pl-5 pr-3.5 text-xs text-ink3">
          {engine.paused ? (
            <span className="flex-none">Paused. Nothing happens until you resume, at the bottom of the sidebar.</span>
          ) : (
            <span className="min-w-0 truncate text-danger" role="alert" title={engine.gmailError || engine.lastError || ""}>
              {engine.gmailError ? `Can't reach Gmail: ${engine.gmailError}` : `The last check failed: ${engine.lastError}`}
            </span>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col" role="listbox" aria-label="Activity">
        {rows === null ? (
          <div className="pt-9">
            <SkeletonRows count={20} />
          </div>
        ) : !list.length ? (
          search ? (
            <Empty icon="search" title="Nothing in Activity matches that search">
              Search looks at what was done and at the subject and sender of the email it belongs to.
            </Empty>
          ) : filter === "waiting" ? (
            <Empty icon="activity" title="Nothing is waiting for you">
              {level === "suggest"
                ? "At Suggest, Tabellar asks before it drafts, adds a todo or proposes a meeting. Each request appears here to approve."
                : "Proposals appear here at the Suggest level. Change the level at the bottom of the sidebar."}{" "}
              <button className="link" onClick={() => setFilter("all")}>
                Show all activity
              </button>
            </Empty>
          ) : filter !== "all" ? (
            <Empty icon="activity" title={filter === "done" ? "Nothing has been done yet" : "Nothing was refused or failed"}>
              {filter === "done" ? "Labels, drafts, todos, meetings and replies appear here once Tabellar makes them." : "Actions that were not allowed, and ones that went wrong, appear here with the reason."}{" "}
              <button className="link" onClick={() => setFilter("all")}>
                Show all activity
              </button>
            </Empty>
          ) : (
            <Empty icon="activity" title="No activity yet">
              {level === "observe" ? (
                <>
                  At Observe, Tabellar sorts and notifies and changes nothing, so there is little to log. Raise the level at the bottom of the sidebar, or see{" "}
                  <button className="link" onClick={() => setView("settings")}>
                    Settings
                  </button>
                  .
                </>
              ) : (
                "Everything Tabellar does or proposes is listed here, with the reason and a way to undo it. New mail is checked every two minutes."
              )}
            </Empty>
          )
        ) : (
          <VirtualList
            items={items}
            heightOf={heightOf}
            render={renderItem}
            cursor={cursorIndex}
            onEnd={hasMore ? () => load(true) : undefined}
            sticky={(first) => {
              const h = firstHead(first);
              return h ? head(h) : null;
            }}
          />
        )}
      </div>
      <KeyHints
        left={rows ? `${list.length.toLocaleString()} ${list.length === 1 ? "action" : "actions"}${hasMore ? ", more load as you scroll" : ""}` : ""}
        keys={[
          ["J K", "Move"],
          ["X", "Select"],
          ["A", "Approve"],
          ["↵", "Details"],
          ["Z", "Undo approval"],
        ]}
      />
    </>
  );
}
