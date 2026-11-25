import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { Countdown, Empty, Glyph, Menu, SkeletonRows, ViewBar, VirtualList, useSizes, clock, dayLabel, shortWhen, type MailState } from "../ui";

// History: everything Tabellar, the agent and Ask did, newest first, with
// undo. Proposals are not here; they wait on the page they belong to
// (Replies, Todos, Meetings). Every line opens to what happened, why, and how
// to take it back.

type LogRow = {
  id: string;
  kind: "label" | "archive" | "draft" | "todo" | "meeting" | "send" | "unsubscribe" | "snooze" | "read" | "brief" | "notify" | "vip";
  status: "proposed" | "running" | "done" | "undone" | "dismissed" | "blocked" | "failed";
  source: "engine" | "automation" | "agent" | "assistant" | "user";
  summary: string;
  detail: Record<string, unknown>;
  hash: string | null;
  reason: string | null;
  error: string | null;
  created_at: string;
  emails: { id: string; subject: string | null; sender: string | null } | null;
};

type Head = { head: true; key: string; name: string };
type Item = Head | LogRow;
type Kind = "all" | LogRow["kind"];

const CHUNK = 1000;
const LINE = 20; // line height of detail text, so a block's height is known before it is drawn
const UNDOABLE = new Set(["label", "archive", "draft", "todo", "meeting", "snooze", "read", "brief", "vip"]);
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "label", label: "Labels" },
  { id: "draft", label: "Drafted replies" },
  { id: "send", label: "Replies sent" },
  { id: "todo", label: "Todos" },
  { id: "meeting", label: "Meetings" },
  { id: "archive", label: "Archived" },
  { id: "unsubscribe", label: "Unsubscribes" },
];
const SOURCE: Record<string, string> = { engine: "Tabellar, on its own", automation: "Your automation", agent: "A plan from Ask that you approved", assistant: "Ask, at your request", user: "You" };

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

// The thing an action is about, for the detail of a finished or refused row.
function about(r: LogRow): string {
  const d = r.detail;
  if (r.kind === "label") return `Label ${String(d.label ?? "")}`;
  if (r.kind === "todo") return String(d.text ?? r.summary);
  if (r.kind === "meeting") return `${String(d.title ?? "Meeting")}${typeof d.start_time === "string" ? `, ${dayTime(d.start_time)}` : ""}${typeof d.end_time === "string" ? ` to ${clock(d.end_time)}` : ""}${d.location ? `, ${String(d.location)}` : ""}`;
  if (r.kind === "draft" || r.kind === "send") return `To ${recipients(r)}${d.subject ? `, ${String(d.subject)}` : ""}`;
  if (r.kind === "archive") return Array.isArray(d.emailIds) && d.emailIds.length > 1 ? `${d.emailIds.length} emails, archived` : "This email, archived";
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
  if (r.kind === "label") return "Undo removes the label in the mailbox.";
  if (r.kind === "archive") return "Undo returns it to the inbox.";
  if (r.kind === "draft") return "Undo deletes the draft.";
  if (r.kind === "todo") return "Undo removes the todo.";
  if (r.kind === "meeting") return "Undo removes the proposed meeting. Once it is confirmed, change it in Meetings.";
  if (r.kind === "snooze") return "Undo returns it to the inbox.";
  if (r.kind === "read") return "Undo marks it unread.";
  if (r.kind === "brief") return "Undo puts the Brief back as it was.";
  if (r.kind === "vip") return "Undo makes them as they were before.";
  if (r.kind === "notify") return "A notification cannot be taken back.";
  return "An unsubscribe cannot be undone from here.";
}

function stateOf(r: LogRow): MailState {
  if (r.status === "blocked") return "held";
  if (r.status === "failed") return "failed";
  if (r.status === "running" || (r.kind === "send" && r.status === "done" && r.detail.sendAt && !r.detail.sentAt)) return "going";
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
function detailHeight(r: LogRow): number {
  const body = bodyOf(r);
  const n = detailOf(r).reduce((sum, [, text]) => sum + linesOf(text, 72), 0) + (body ? linesOf(body, 72) + 1 : 0);
  return Math.min(n, 16) * LINE + 20;
}


export default function HistoryView() {
  const { user, addToast, liveChanges, search, mail, setView } = useApp();
  const supabase = createClient();
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [kind, setKind] = useState<Kind>("all");
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const searching = !!search.trim();
  const loaded = useRef(0);
  const loading = useRef(false);

  const load = useCallback(
    async (more = false) => {
      if (loading.current) return;
      loading.current = true;
      try {
        // A search looks through the whole log, so it loads further back.
        const want = more ? loaded.current + CHUNK : Math.max(searching ? 5 * CHUNK : CHUNK, loaded.current);
        let q = supabase.from("action_log").select("*, emails(id, subject, sender)").eq("user_id", user.id).neq("status", "proposed");
        if (kind !== "all") q = q.eq("kind", kind);
        const { data } = await q.order("created_at", { ascending: false }).range(0, want);
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
    [user.id, searching, kind],
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

  // Newest first under day headers.
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const shown = (rows || []).filter((r) => !q || `${r.summary} ${r.emails?.subject ?? ""} ${r.emails?.sender ?? ""}`.toLowerCase().includes(q));
    const out: Item[] = [];
    let run: LogRow[] = [];
    let day = { head: "", key: "" };
    const flush = () => run.length && out.push({ head: true, key: `head:${day.key}`, name: day.head }, ...run);
    for (const r of shown) {
      const d = dayLabel(r.created_at);
      if (d.key !== day.key) {
        flush();
        run = [];
        day = d;
      }
      run.push(r);
    }
    flush();
    return out;
  }, [rows, search]);

  const list = useMemo(() => items.filter((i): i is LogRow => !("head" in i)), [items]);
  const cursor = list.find((r) => r.id === cursorId) || null;
  const cursorIndex = cursor ? items.indexOf(cursor) : -1;

  const { row, head: headHeight, scale } = useSizes();
  const heightOf = useCallback((i: Item) => ("head" in i ? headHeight : row + (open.has(i.id) ? (detailHeight(i) + 8) * scale : 0)), [open, row, headHeight, scale]);

  const move = (delta: number) => {
    if (!list.length) return;
    const at = cursor ? list.indexOf(cursor) : -1;
    setCursorId(list[Math.min(list.length - 1, Math.max(0, at + delta))].id);
  };

  const toggle = (r: LogRow) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });

  const undoRow = async (r: LogRow) => {
    setBusy((b) => new Set(b).add(r.id));
    try {
      await api("/actions/undo", { id: r.id });
      addToast("success", r.kind === "send" ? "Cancelled. The reply will not be sent." : "Undone");
    } catch (e) {
      addToast("error", `Could not undo that: ${(e as Error).message}`);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(r.id);
        return next;
      });
      await load();
      mail.reload();
    }
  };

  const canUndo = (r: LogRow) => r.status === "done" && (UNDOABLE.has(r.kind) || pendingSend(r));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[data-compose-modal]")) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (e.key === "Enter" && cursor) toggle(cursor);
      else if (k === "u" && cursor && canUndo(cursor) && !busy.has(cursor.id)) undoRow(cursor);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const head = (h: Head) => (
    <div key={h.key} className="day !static">
      <b>{h.name}</b>
    </div>
  );

  const renderItem = (item: Item) => {
    if ("head" in item) return head(item);
    const r = item;
    const isCursor = cursor === r;
    const email = emailLine(r);
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
                <button className="link" disabled={busy.has(r.id)} onClick={(e) => (e.stopPropagation(), undoRow(r))}>
                  Cancel
                </button>
              </>
            ) : busy.has(r.id) ? (
              <span className="text-ink3">Working</span>
            ) : canUndo(r) ? (
              <button className="link" onClick={(e) => (e.stopPropagation(), undoRow(r))}>
                Undo
              </button>
            ) : r.status === "done" && r.kind === "send" ? (
              <span className="text-ink3">{r.detail.sendAt && !r.detail.sentAt ? "Sending" : `Sent ${shortWhen(String(r.detail.sentAt ?? r.created_at))}`}</span>
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
          <div className="ml-10 mr-5 overflow-y-auto rounded-[9px] bg-side px-3.5 py-2.5 text-[13px] leading-5" style={{ height: detailHeight(r) * scale }}>
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

  return (
    <>
      <ViewBar
        title={
          <span className="flex flex-none items-center gap-1">
            <button className="iconbtn -ml-1.5" aria-label="Back to Settings" title="Settings" onClick={() => setView("settings")}>
              <Icon name="chevron_left" size={16} />
            </button>
            <h1 className="bar-title">History</h1>
          </span>
        }
        search="Search history"
        right={<Menu label="Kind" value={kind} onChange={(k) => (setRows(null), setKind(k))} options={KINDS} />}
      />
      <div className="flex min-h-0 flex-1 flex-col" role="listbox" aria-label="History">
        {rows === null ? (
          <div className="pt-9">
            <SkeletonRows count={20} />
          </div>
        ) : !list.length ? (
          search ? (
            <Empty icon="search" title="Nothing matches that search" />
          ) : kind !== "all" ? (
            <Empty icon="activity" title="Nothing of this kind yet">
              <button className="link" onClick={() => setKind("all")}>
                Show all
              </button>
            </Empty>
          ) : (
            <Empty icon="activity" title="Nothing yet" />
          )
        ) : (
          <VirtualList
            page
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
    </>
  );
}
