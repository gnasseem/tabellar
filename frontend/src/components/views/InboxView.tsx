import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { parseSearch } from "@/lib/searchQuery";
import { isTypingTarget } from "@/lib/shortcuts";
import { rowStatus, type Outcome } from "@/lib/outcomes";
import { useInboxSync } from "@/lib/useInboxSync";
import { useApp } from "../AppShell";
import EmailDetail from "../EmailDetail";
import InitialFetchOverlay from "../InitialFetchOverlay";
import { Questions } from "../Profile";
import { Countdown, Empty, Glyph, KeyHints, Kbd, Menu, Seg, SkeletonRows, Tick, ViewBar, VirtualList, dayLabel, shortWhen, type MailState } from "../ui";

// The inbox: every email on one quiet line that ends in what Tabellar did
// with it. Only mail that needs the user is set in strong type and wax red.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Email = {
  id: string;
  gmail_id: string;
  thread_id?: string;
  subject: string;
  sender: string;
  sender_email: string;
  snippet: string;
  received_at: string;
  is_read: boolean;
  is_starred: boolean;
  is_archived: boolean;
  has_attachments: boolean;
  resolved_at?: string | null;
  email_processed: { category: string; summary: string; quick_actions: any[]; extra_labels: string[] | null } | null;
};

type Thread = { key: string; latest: Email; ids: string[]; count: number; outcomes: Outcome[]; state: MailState; text: string; sendAt?: string };
type Head = { head: true; key: string; name: string; note: string; count: number; need: number; going: number };
type Item = Head | Thread;
type Filter = "all" | "need" | "going" | "handled" | "filed";
type Group = "day" | "sender" | "outcome";

const CHUNK = 300;
// Narrow windows drop the subject column; the status stays.
const COLUMNS = "!grid grid-cols-[26px_minmax(0,1fr)_minmax(0,auto)_44px] md:grid-cols-[26px_164px_minmax(0,1fr)_172px_46px]";
const SELECT =
  "id, user_id, gmail_id, thread_id, gmail_account_id, subject, sender, sender_email, recipients, snippet, received_at, is_read, is_starred, is_archived, is_snoozed, snooze_until, label_ids, has_attachments, has_list_unsubscribe, is_reply, reply_to_email, cc_recipients, attachments, resolved_at, email_processed!inner(*)";
const CATEGORY: Record<string, string> = { important: "Important", "action-required": "Action required", promotions: "Promotions", updates: "Updates" };
const OUTCOME_GROUPS: [MailState, string, string][] = [
  ["need", "Needs you", "Waiting on a decision from you"],
  ["going", "Going out", "Replies Autopilot is about to send"],
  ["failed", "Could not finish", "Something went wrong"],
  ["held", "Held", "Only labelled, nothing else was done"],
  ["done", "Handled", "Tabellar took care of it"],
  ["filed", "Filed", "Sorted, nothing to do"],
];

function senderName(e: Email): string {
  return (e.sender || e.sender_email || "Unknown").replace(/<.*>/, "").replace(/"/g, "").trim() || e.sender_email;
}

export default function InboxView() {
  const { user, openCompose, addToast, search, getViewCache, setViewCache, invalidateViewCache, liveChanges, mail, setView } = useApp();
  const supabase = createClient();
  const [emails, setEmails] = useState<Email[]>(() => getViewCache("inbox")?.emails ?? []);
  const [loading, setLoading] = useState(() => !getViewCache("inbox"));
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [group, setGroup] = useState<Group>(() => (localStorage.getItem("tabellar_inbox_group") as Group) || "day");
  const [details, setDetails] = useState(() => localStorage.getItem("tabellar_inbox_details") !== "off");
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState<Email | null>(null);
  const loaded = useRef(0);
  const busy = useRef(false);
  const anchor = useRef<string | null>(null);
  const lastUndo = useRef<{ label: string; run: () => Promise<void> } | null>(null);

  const load = useCallback(
    async (more = false) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const want = more ? loaded.current + CHUNK : Math.max(CHUNK, loaded.current);
        let query = supabase
          .from("emails")
          .select(SELECT)
          .eq("user_id", user.id)
          .eq("is_archived", false)
          .not("label_ids", "cs", '{"SENT"}')
          .or("is_snoozed.eq.false,snooze_until.lt." + new Date().toISOString())
          .order("received_at", { ascending: false })
          .range(0, want);
        if (search) {
          const q = parseSearch(search);
          if (q.text) query = query.textSearch("search_vector", q.text, { type: "websearch", config: "english" });
          if (q.from) query = query.or(`sender.ilike.%${q.from}%,sender_email.ilike.%${q.from}%`);
          if (q.to) query = query.ilike("recipients", `%${q.to}%`);
          if (q.subject) query = query.ilike("subject", `%${q.subject}%`);
          if (q.category) query = query.eq("email_processed.category", q.category);
          if (q.after) query = query.gte("received_at", `${q.after}T00:00:00Z`);
          if (q.before) query = query.lt("received_at", `${q.before}T00:00:00Z`);
          if (q.isUnread) query = query.eq("is_read", false);
          if (q.isRead) query = query.eq("is_read", true);
          if (q.isStarred) query = query.eq("is_starred", true);
          if (q.isResolved) query = query.not("resolved_at", "is", null);
          if (q.isUnresolved) query = query.is("resolved_at", null);
          if (q.hasAttachment) query = query.eq("has_attachments", true);
        }
        const { data } = await query;
        let rows = ((data || []) as any[]).map((e) => ({ ...e, email_processed: Array.isArray(e.email_processed) ? e.email_processed[0] : e.email_processed })) as Email[];
        const extra = rows.length > want;
        if (extra) rows = rows.slice(0, want);
        loaded.current = rows.length;
        setHasMore(extra);
        setEmails(rows);
        if (!search) setViewCache("inbox", { emails: rows });
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [user.id, search],
  );

  const reload = useCallback(() => {
    invalidateViewCache("inbox");
    return load();
  }, [load]);

  // Mail that needs the user, is going out, or was held may be older than the
  // rows loaded so far. It is fetched by id, so "Needs you" finds all of it.
  const [attention, setAttention] = useState<Email[]>([]);
  useEffect(() => {
    const have = new Set(emails.map((e) => e.id));
    const ids = [...mail.byEmail].filter(([id, list]) => !have.has(id) && ["need", "going", "held", "failed"].includes(list[0]?.state)).map(([id]) => id);
    if (!ids.length || search) return setAttention([]);
    let live = true;
    (async () => {
      const found: Email[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await supabase.from("emails").select(SELECT).in("id", ids.slice(i, i + 200)).eq("is_archived", false).not("label_ids", "cs", '{"SENT"}');
        found.push(...((data || []) as any[]).map((e) => ({ ...e, email_processed: Array.isArray(e.email_processed) ? e.email_processed[0] : e.email_processed })));
      }
      if (live) setAttention(found);
    })();
    return () => {
      live = false;
    };
  }, [mail.byEmail, emails, search]);
  const { syncInbox, syncing, syncError, initialPhase, syncMode, noAccountsConnected } = useInboxSync(reload);

  useEffect(() => {
    loaded.current = 0;
    load();
  }, [load, liveChanges.emails, liveChanges.email_processed]);

  useEffect(() => {
    supabase
      .from("emails")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_archived", false)
      .not("label_ids", "cs", '{"SENT"}')
      .then(({ count }: { count: number | null }) => setTotal(count));
    supabase
      .from("categories")
      .select("slug, display_name")
      .eq("user_id", user.id)
      .then(({ data }: { data: { slug: string; display_name: string }[] | null }) => setLabels(Object.fromEntries((data || []).map((c) => [c.slug, c.display_name]))));
  }, [user.id, liveChanges.emails]);

  // One row per conversation: the newest message stands for the thread.
  const threads = useMemo(() => {
    const byKey = new Map<string, Thread>();
    const have = new Set(emails.map((e) => e.id));
    const all = [...emails, ...attention.filter((e) => !have.has(e.id))].sort((a, b) => b.received_at.localeCompare(a.received_at));
    for (const e of all) {
      const key = e.thread_id || e.id;
      const t = byKey.get(key);
      if (t) {
        t.ids.push(e.id);
        t.count++;
      } else byKey.set(key, { key, latest: e, ids: [e.id], count: 1, outcomes: [], state: "filed", text: "" });
    }
    const list = [...byKey.values()];
    for (const t of list) {
      t.outcomes = t.ids.flatMap((id) => mail.byEmail.get(id) || []);
      if (t.ids.length > 1) t.outcomes.sort((a, b) => rank(a.state) - rank(b.state) || b.at.localeCompare(a.at));
      const s = rowStatus(t.outcomes);
      const cat = t.latest.email_processed?.category || "";
      t.state = s.state;
      t.text = s.text || labels[cat] || CATEGORY[cat] || cat;
      t.sendAt = s.sendAt;
    }
    return list;
  }, [emails, attention, mail.byEmail, labels]);

  const counts = useMemo(() => ({ need: threads.filter((t) => t.state === "need").length, going: threads.filter((t) => t.state === "going").length }), [threads]);

  const items = useMemo(() => {
    // Older mail fetched only because it needs attention stays out of the
    // plain listing until scrolling reaches it.
    const oldest = hasMore && emails.length ? emails[emails.length - 1].received_at : "";
    const shown = threads.filter((t) =>
      (filter === "all" || filter === "filed") && t.latest.received_at < oldest ? false : filter === "all" ? true : filter === "need" ? t.state === "need" : filter === "going" ? t.state === "going" : filter === "filed" ? t.state === "filed" : t.state === "done" || t.state === "held" || t.state === "failed",
    );
    const out: Item[] = [];
    const add = (key: string, name: string, note: string, list: Thread[]) => {
      if (!list.length) return;
      out.push({ head: true, key: `head:${key}`, name, note, count: list.reduce((n, t) => n + t.count, 0), need: list.filter((t) => t.state === "need").length, going: list.filter((t) => t.state === "going").length });
      out.push(...list);
    };
    if (group === "outcome") {
      for (const [state, name, note] of OUTCOME_GROUPS) add(state, name, note, shown.filter((t) => t.state === state));
    } else if (group === "sender") {
      const by = new Map<string, Thread[]>();
      for (const t of shown) {
        const k = t.latest.sender_email || senderName(t.latest);
        by.set(k, [...(by.get(k) || []), t]);
      }
      for (const [k, list] of by) add(k, senderName(list[0].latest), k, list);
    } else {
      let run: Thread[] = [];
      let day = { name: "", date: "", key: "" };
      for (const t of shown) {
        const d = dayLabel(t.latest.received_at);
        if (d.key !== day.key) {
          add(day.key, day.name, day.date, run);
          run = [];
          day = d;
        }
        run.push(t);
      }
      add(day.key, day.name, day.date, run);
    }
    return out;
  }, [threads, filter, group, hasMore, emails]);

  const rows = useMemo(() => items.filter((i): i is Thread => !("head" in i)), [items]);
  const cursor = rows.find((t) => t.key === cursorKey) || rows[0] || null;
  const cursorIndex = cursor ? items.indexOf(cursor) : -1;
  const heightOf = useCallback((i: Item) => ("head" in i ? 34 : 32), []);

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorKey(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].key);
  };

  const pick = (t: Thread, range = false) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && anchor.current) {
        const a = rows.findIndex((r) => r.key === anchor.current);
        const b = rows.indexOf(t);
        if (a >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(rows[i].key);
      } else if (next.has(t.key)) next.delete(t.key);
      else next.add(t.key);
      return next;
    });
    anchor.current = t.key;
  };

  const targets = (): Thread[] => (picked.size ? rows.filter((t) => picked.has(t.key)) : cursor ? [cursor] : []);

  const archive = async (list: Thread[]) => {
    if (!list.length) return;
    const ids = list.flatMap((t) => t.ids);
    const gone = new Set(ids);
    const next = rows[rows.findIndex((r) => !list.includes(r) && rows.indexOf(r) > rows.indexOf(list[list.length - 1]))] || rows.find((r) => !list.includes(r));
    setEmails((prev) => prev.filter((e) => !gone.has(e.id)));
    setPicked(new Set());
    setCursorKey(next?.key ?? null);
    const { error } = await supabase.from("emails").update({ is_archived: true }).in("id", ids);
    if (error) {
      addToast("error", "Could not archive. Nothing was changed.");
      return reload();
    }
    invalidateViewCache("inbox");
    const run = async () => {
      await supabase.from("emails").update({ is_archived: false }).in("id", ids);
      await reload();
    };
    lastUndo.current = { label: "archive", run };
    addToast("success", list.length === 1 ? "Archived" : `Archived ${list.length} conversations`, { action: { label: "Undo", onClick: run } });
  };

  const approve = async (list: Thread[]) => {
    const proposals = list.flatMap((t) => t.outcomes).filter((o) => o.act?.kind === "approve");
    if (!proposals.length) return addToast("info", "Nothing here is waiting for approval");
    let done = 0;
    for (const o of proposals) {
      if (o.act?.kind !== "approve") continue;
      try {
        await mail.approve(o.act.id, o.act.hash);
        done++;
      } catch {
        // the reason is already shown; keep going with the rest
      }
    }
    setPicked(new Set());
    if (!done) return;
    const ids = proposals.map((o) => (o.act as { id: string }).id);
    const run = async () => {
      for (const id of ids) await mail.undo(id).catch(() => {});
    };
    lastUndo.current = { label: "approval", run };
    addToast("success", done === 1 ? "Approved" : `Approved ${done}`, { action: { label: "Undo", onClick: run } });
  };

  const markRead = async (list: Thread[], read: boolean) => {
    const ids = list.flatMap((t) => t.ids);
    if (!ids.length) return;
    setEmails((prev) => prev.map((e) => (ids.includes(e.id) ? { ...e, is_read: read } : e)));
    setPicked(new Set());
    await supabase.from("emails").update({ is_read: read }).in("id", ids);
  };

  const open = (t: Thread) => {
    setReading(t.latest);
    if (!t.latest.is_read) markRead([t], true);
  };

  // What Enter does: the one thing this row is waiting for, else open the email.
  const primary = (t: Thread): { label: string; run: () => void } => {
    const o = t.outcomes.find((x) => x.act && (x.state === "need" || x.state === "going"));
    if (o?.act?.kind === "review") {
      const id = o.act.draftId;
      return { label: "Review reply", run: () => (setViewCache("replies:focus", id), setView("replies")) };
    }
    if (o?.act?.kind === "approve") return { label: "Approve", run: () => approve([t]) };
    if (o?.act?.kind === "view") {
      const v = o.act.view;
      return { label: "Open in Meetings", run: () => setView(v) };
    }
    if (o?.act?.kind === "cancel") {
      const id = o.act.id;
      return { label: "Cancel reply", run: () => mail.undo(id).then(() => addToast("success", "Reply cancelled. It is kept as a draft.")).catch(() => {}) };
    }
    return { label: "Open email", run: () => open(t) };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[data-compose-modal]")) return;
      if (reading) {
        if (e.key === "Escape") setReading(null);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "x" && cursor) pick(cursor, e.shiftKey);
      else if (e.key === " ") {
        setDetails((d) => (localStorage.setItem("tabellar_inbox_details", d ? "off" : "on"), !d));
      } else if (e.key === "Enter" && cursor) primary(cursor).run();
      else if (k === "o" && cursor) open(cursor);
      else if (k === "e") archive(targets());
      else if (k === "a") approve(targets());
      else if (k === "r" && cursor) openCompose(cursor.latest);
      else if (k === "u") markRead(targets(), false);
      else if (k === "z" && lastUndo.current) {
        const u = lastUndo.current;
        lastUndo.current = null;
        u.run().then(() => addToast("info", `Undid the ${u.label}`));
      } else if (e.key === "Escape" && picked.size) setPicked(new Set());
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (reading)
    return (
      <EmailDetail
        key={reading.id}
        email={reading as any}
        showBack
        onBack={() => setReading(null)}
        onArchive={() => {
          const t = rows.find((r) => r.ids.includes(reading.id));
          setReading(null);
          if (t) archive([t]);
        }}
        onReply={() => openCompose(reading)}
        onMarkUnread={() => {
          const t = rows.find((r) => r.ids.includes(reading.id));
          setReading(null);
          if (t) markRead([t], false);
        }}
        onSnooze={() => {
          setEmails((prev) => prev.filter((e) => e.id !== reading.id));
          setReading(null);
        }}
        onRethink={(updated: any) => setEmails((prev) => prev.map((e) => (e.id === reading.id ? { ...e, email_processed: updated } : e)))}
        onResolvedChange={(id: string, at: string | null) => setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, resolved_at: at } : e)))}
      />
    );

  const selected = rows.filter((t) => picked.has(t.key));
  const waiting = selected.flatMap((t) => t.outcomes).filter((o) => o.act?.kind === "approve").length;

  const renderItem = (item: Item) => {
    if ("head" in item) return <GroupHead key={item.key} head={item} />;
    const t = item;
    const e = t.latest;
    const isCursor = cursor === t;
    const isPicked = picked.has(t.key);
    const filed = t.state === "filed";
    const need = t.state === "need";
    return (
      <div
        key={t.key}
        role="option"
        aria-selected={isCursor}
        className={`row group ${COLUMNS} ${isPicked && !isCursor ? "bg-hover" : ""}`}
        onClick={(ev) => (ev.shiftKey ? pick(t, true) : setCursorKey(t.key))}
        onDoubleClick={() => open(t)}
      >
        <span className="grid place-items-center">
          <span className={isPicked ? "" : "hidden group-hover:block"}>
            <Tick checked={isPicked} onChange={(_, ev) => pick(t, ev.shiftKey)} label={`Select ${senderName(e)}`} />
          </span>
          <span className={isPicked ? "hidden" : "group-hover:hidden"}>
            <Glyph state={t.state} />
          </span>
        </span>
        <span className={`truncate pr-3 ${filed ? "text-ink2" : "text-ink"} ${need ? "font-[650]" : ""}`}>
          {senderName(e)}
          {t.count > 1 && <span className="ml-[5px] text-xs font-normal text-ink3">{t.count}</span>}
        </span>
        <span className="hidden min-w-0 items-center gap-2 pr-4 md:flex">
          <b className={`shrink truncate ${filed ? "font-normal text-ink3" : need ? "font-medium text-ink" : "font-normal text-ink"}`}>{e.subject || "(no subject)"}</b>
          {e.has_attachments && <Icon name="attachment" size={13} className="text-ink3" />}
          {!filed && <span className="min-w-0 flex-1 truncate text-ink3">{e.email_processed?.summary || e.snippet}</span>}
        </span>
        <span className={`truncate text-[12.5px] ${need ? "font-semibold text-wax-ink" : t.state === "going" ? "font-medium text-wax-ink" : t.state === "held" ? "font-medium text-warn" : t.state === "failed" ? "font-medium text-danger" : t.state === "done" ? "text-ink2" : "text-ink3"}`}>
          {t.text}
          {t.state === "going" && t.sendAt && (
            <>
              {" in "}
              <Countdown until={t.sendAt} />
            </>
          )}
        </span>
        <time className="text-right text-xs text-ink3">{shortWhen(e.received_at)}</time>
      </div>
    );
  };

  const firstHead = (first: number): Head | null => {
    for (let i = Math.min(first, items.length - 1); i >= 0; i--) if ("head" in items[i]) return items[i] as Head;
    return null;
  };

  return (
    <>
      {initialPhase >= 0 && <InitialFetchOverlay phaseIndex={initialPhase} mode={syncMode} />}
      {picked.size ? (
        <header className="bar">
          <b className="bar-title mr-1.5">{picked.size} selected</b>
          {waiting > 0 && (
            <button className="btn btn-pri" onClick={() => approve(selected)}>
              Approve {waiting} <Kbd>A</Kbd>
            </button>
          )}
          <button className="btn" onClick={() => archive(selected)}>
            Archive <Kbd>E</Kbd>
          </button>
          <button className="btn" onClick={() => markRead(selected, true)}>
            Mark read
          </button>
          <button className="btn btn-plain" onClick={() => setPicked(new Set())}>
            Clear <Kbd>esc</Kbd>
          </button>
        </header>
      ) : (
        <ViewBar
          title="Inbox"
          search="Search mail"
          right={
            <>
              <Menu
                label="Group"
                value={group}
                onChange={(g) => (localStorage.setItem("tabellar_inbox_group", g), setGroup(g))}
                options={[
                  { id: "day", label: "Day" },
                  { id: "sender", label: "Sender" },
                  { id: "outcome", label: "Outcome" },
                ]}
              />
              <button className="iconbtn" title="Check Gmail now" aria-label="Check Gmail now" disabled={syncing} onClick={() => syncInbox()}>
                <Icon name="refresh" size={16} className={syncing ? "animate-spin" : ""} />
              </button>
              <button className="iconbtn" title="Details (Space)" aria-label="Details" aria-pressed={details} onClick={() => (localStorage.setItem("tabellar_inbox_details", details ? "off" : "on"), setDetails(!details))}>
                <Icon name="panel" size={16} />
              </button>
            </>
          }
        >
          <Seg
            value={filter}
            onChange={setFilter}
            options={[
              { id: "all", label: "All" },
              { id: "need", label: "Needs you", count: counts.need, need: true },
              { id: "going", label: "Going out", count: counts.going },
              { id: "handled", label: "Handled" },
              { id: "filed", label: "Filed" },
            ]}
          />
        </ViewBar>
      )}
      {syncError && (
        <div className="flex items-center gap-2 border-b border-line bg-danger-soft px-5 py-1.5 text-xs text-danger" role="alert">
          <Icon name="error" size={14} />
          <span className="flex-1">{syncError}</span>
          <button className="link !text-danger" onClick={() => syncInbox()}>
            Try again
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Questions />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" role="listbox" aria-label="Inbox">
          {loading && !emails.length ? (
            <div className="pt-9">
              <SkeletonRows count={22} />
            </div>
          ) : noAccountsConnected && !emails.length ? (
            <Empty icon="link_off" title="No Gmail account is connected">
              Connect one in Settings, under General, and your mail appears here.{" "}
              <button className="link" onClick={() => setView("settings")}>
                Open Settings
              </button>
            </Empty>
          ) : !rows.length ? (
            search ? (
              <Empty icon="search" title="No mail matches that search">
                Try fewer words, or an operator such as from:, subject:, is:unread or has:attachment.
              </Empty>
            ) : filter !== "all" ? (
              <Empty icon="inbox" title={filter === "need" ? "Nothing needs you" : filter === "going" ? "Nothing is going out" : "Nothing here"}>
                {filter === "need" ? "When a reply is ready to send or a proposal waits for approval, it shows here in red." : "Mail in this state will appear here."}{" "}
                <button className="link" onClick={() => setFilter("all")}>
                  Show all mail
                </button>
              </Empty>
            ) : (
              <Empty icon="inbox" title="Your inbox is empty">
                New mail arrives here within two minutes, already sorted, with what Tabellar did on the right of each line.
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
                return h ? <GroupHead head={h} /> : null;
              }}
            />
          )}
          </div>
        </div>
        {details && cursor && rows.length > 0 && <Details thread={cursor} primary={primary(cursor)} onOpen={() => open(cursor)} onArchive={() => archive([cursor])} />}
      </div>
      <KeyHints
        left={total === null ? "" : `${total.toLocaleString()} in Inbox${hasMore ? `, ${emails.length.toLocaleString()} loaded` : ""}`}
        keys={[
          ["J K", "Move"],
          ["X", "Select"],
          ["Space", "Details"],
          ["↵", "Act"],
          ["A", "Approve"],
          ["E", "Archive"],
          ["Z", "Undo"],
          ["?", "All keys"],
        ]}
      />
    </>
  );
}

function rank(s: MailState): number {
  return { going: 0, need: 1, failed: 2, held: 3, done: 4, info: 5, filed: 6 }[s];
}

function GroupHead({ head }: { head: Head }) {
  return (
    <div className="day !static">
      <b>{head.name}</b>
      <span className="truncate">{head.note}</span>
      <span className="flex-1" />
      <span className="whitespace-nowrap">
        {head.count.toLocaleString()} {head.count === 1 ? "email" : "emails"}
        {head.need > 0 && (
          <>
            , <b className="count-need">{head.need} need you</b>
          </>
        )}
        {head.going > 0 && `, ${head.going} going out`}
      </span>
    </div>
  );
}

// The panel on the right: what the email says, what Tabellar did about it and
// why, and how to take each thing back.
function Details({ thread, primary, onOpen, onArchive }: { thread: Thread; primary: { label: string; run: () => void }; onOpen: () => void; onArchive: () => void }) {
  const { mail, setView, setViewCache, addToast } = useApp();
  const e = thread.latest;
  // The email's own words, fetched when the panel shows it; long ones are cut
  // with a way to open the whole thing.
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setBody(null);
    createClient()
      .from("emails")
      .select("body_text")
      .eq("id", e.id)
      .single()
      .then(({ data }: { data: { body_text: string | null } | null }) => {
        if (live) setBody((data?.body_text || "").replace(/\n{3,}/g, "\n\n").trim());
      });
    return () => {
      live = false;
    };
  }, [e.id]);
  const LIMIT = 1400;
  const act = (o: Outcome) => {
    const a = o.act;
    if (!a) return null;
    if (a.kind === "undo")
      return (
        <button className="link" onClick={() => mail.undo(a.id).then(() => addToast("info", "Undone")).catch(() => {})}>
          Undo
        </button>
      );
    if (a.kind === "cancel")
      return (
        <button className="link" onClick={() => mail.undo(a.id).then(() => addToast("success", "Reply cancelled. It is kept as a draft.")).catch(() => {})}>
          Cancel
        </button>
      );
    if (a.kind === "approve")
      return (
        <span className="flex gap-3">
          <button className="link" onClick={() => mail.dismiss(a.id).catch(() => {})}>
            Not this
          </button>
          <button className="link !text-wax-ink" onClick={() => mail.approve(a.id, a.hash).then(() => addToast("success", "Approved")).catch(() => {})}>
            Approve
          </button>
        </span>
      );
    if (a.kind === "review")
      return (
        <button className="link" onClick={() => (setViewCache("replies:focus", a.draftId), setView("replies"))}>
          Review
        </button>
      );
    return (
      <button className="link" onClick={() => setView(a.view)}>
        Show
      </button>
    );
  };
  return (
    <aside className="hidden w-[404px] flex-none flex-col border-l border-line md:flex" aria-label="Details">
      <div className="border-b border-line-soft px-5 pb-3.5 pt-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-[650] leading-tight tracking-[-0.01em]">{senderName(e)}</h2>
            <p className="mt-0.5 truncate text-xs text-ink3">
              {e.sender_email}, {dayLabel(e.received_at).name.toLowerCase()} {shortWhen(e.received_at)}
            </p>
          </div>
          <button className="iconbtn" title="Open email (O)" aria-label="Open email" onClick={onOpen}>
            <Icon name="open" size={16} />
          </button>
        </div>
        <p className="mt-3 font-semibold leading-snug">{e.subject || "(no subject)"}</p>
        {e.email_processed?.summary && <p className="mt-1.5 leading-normal text-ink2">{e.email_processed.summary}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        <h3 className="label mb-1 mt-4">What Tabellar did</h3>
        {thread.outcomes.length ? (
          thread.outcomes.map((o) => (
            <div key={o.key} className="grid grid-cols-[22px_1fr_auto] items-start gap-x-1 border-b border-line-soft py-[9px] last:border-0">
              <Glyph state={o.state} className="mt-px" />
              <div className="min-w-0">
                <b className={`block leading-snug ${o.state === "info" ? "font-normal text-ink2" : "font-medium"}`}>{o.title}</b>
                {o.why && <p className="mt-0.5 text-[12.5px] leading-snug text-ink2">{o.why}</p>}
                {o.sendAt && (
                  <p className="mt-0.5 text-[12.5px] font-medium text-wax-ink">
                    Sends in <Countdown until={o.sendAt} />
                  </p>
                )}
              </div>
              <div className="pt-px">{act(o)}</div>
            </div>
          ))
        ) : (
          <p className="py-2 text-[12.5px] leading-snug text-ink2">Sorted as {thread.text || "mail"} and left alone. There was nothing to reply to, add or schedule.</p>
        )}
        <h3 className="label mb-1 mt-4">The email</h3>
        {body === null ? (
          <div className="space-y-2 pt-1" aria-busy="true">
            <span className="skel block h-2.5 w-full" />
            <span className="skel block h-2.5 w-11/12" />
            <span className="skel block h-2.5 w-3/5" />
          </div>
        ) : (
          <>
            <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-ink2">{body.length > LIMIT ? `${body.slice(0, LIMIT).replace(/\s+\S*$/, "")}...` : body || e.snippet}</p>
            {body.length > LIMIT && (
              <button className="link mt-1.5" onClick={onOpen}>
                Read the whole email
              </button>
            )}
          </>
        )}
      </div>
      <div className="flex flex-none items-center gap-2 border-t border-line py-2.5 pl-5 pr-3.5">
        <button className="btn btn-pri" onClick={primary.run}>
          {primary.label} <Kbd>↵</Kbd>
        </button>
        <button className="btn" onClick={onArchive}>
          Archive <Kbd>E</Kbd>
        </button>
        <span className="flex-1" />
        {primary.label !== "Open email" && (
          <button className="btn btn-plain" onClick={onOpen}>
            Open email
          </button>
        )}
      </div>
    </aside>
  );
}
