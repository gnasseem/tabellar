import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { parseSearch } from "@/lib/searchQuery";
import { isTypingTarget } from "@/lib/shortcuts";
import { rowStatus, setMailState, type Outcome } from "@/lib/outcomes";
import { useInboxSync } from "@/lib/useInboxSync";
import { addressesIn } from "@/lib/accounts";
import { useApp } from "../AppShell";
import EmailBody from "../EmailBody";
import EmailDetail from "../EmailDetail";
import InitialFetchOverlay from "../InitialFetchOverlay";
import { Questions } from "../Profile";
import { AccountMark, Countdown, Empty, Glyph, Menu, OutcomeLines, Seg, SkeletonRows, Tick, ViewBar, VirtualList, dayLabel, shortWhen, type MailState } from "../ui";

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
  account_id?: string | null;
  recipients?: string | null;
  cc_recipients?: string | null;
  resolved_at?: string | null;
  email_processed: { category: string; summary: string; quick_actions: any[]; extra_labels: string[] | null } | null;
};

type Thread = { key: string; latest: Email; ids: string[]; count: number; outcomes: Outcome[]; state: MailState; text: string; sendAt?: string };
type Head = { head: true; key: string; name: string; fold?: boolean };
type Item = Head | Thread;
type Filter = "need" | "all";
type Group = "priority" | "day" | "sender";

const CHUNK = 300;
// Narrow windows drop the subject column; the status stays.
const COLUMNS = "!grid grid-cols-[26px_minmax(0,1fr)_minmax(0,auto)_44px] md:grid-cols-[26px_164px_minmax(0,1fr)_172px_46px]";
// With several accounts the last column also holds the account's mark.
const COLUMNS_MARKED = "!grid grid-cols-[26px_minmax(0,1fr)_minmax(0,auto)_66px] md:grid-cols-[26px_164px_minmax(0,1fr)_172px_68px]";
const SELECT =
  "id, user_id, gmail_id, thread_id, account_id, subject, sender, sender_email, recipients, snippet, received_at, is_read, is_starred, is_archived, is_snoozed, snooze_until, label_ids, has_attachments, has_list_unsubscribe, is_reply, reply_to_email, cc_recipients, attachments, resolved_at, email_processed(*)";
const CATEGORY: Record<string, string> = { important: "Important", "action-required": "Action required", promotions: "Promotions", updates: "Updates" };
// Priority grouping: what waits on the user, then the user's own labels in
// the order set in Labels, then mail from people, updates and promotions
// (folded until opened).
type UserLabel = { slug: string; display_name: string };
const REST: [string, string][] = [
  ["people", "People"],
  ["updates", "Updates"],
  ["promotions", "Promotions"],
];

// The first of the user's labels the email carries, in their order.
function firstLabel(t: Thread, labels: UserLabel[]): UserLabel | null {
  const own = t.latest.email_processed?.extra_labels;
  return own?.length ? labels.find((l) => own.includes(l.slug)) ?? null : null;
}

function priorityOf(t: Thread, labels: UserLabel[]): string {
  if (t.state === "need" || t.state === "going" || t.state === "failed") return "need";
  const own = firstLabel(t, labels);
  if (own) return `label:${own.slug}`;
  const cat = t.latest.email_processed?.category;
  return cat === "updates" || cat === "promotions" ? cat : "people";
}

function readFolded(): Set<string> {
  try {
    const saved = localStorage.getItem("tabellar_inbox_folded");
    return new Set(saved ? (JSON.parse(saved) as string[]) : ["promotions"]);
  } catch {
    return new Set(["promotions"]);
  }
}

function senderName(e: Email): string {
  return (e.sender || e.sender_email || "Unknown").replace(/<.*>/, "").replace(/"/g, "").trim() || e.sender_email;
}

export default function InboxView() {
  const { user, openCompose, addToast, search, getViewCache, setViewCache, invalidateViewCache, liveChanges, mail, setView, accounts } = useApp();
  // The sidebar's account switch: one account, or every account merged.
  const only = accounts.only;
  const columns = accounts.list.length > 1 ? COLUMNS_MARKED : COLUMNS;
  const supabase = createClient();
  const [emails, setEmails] = useState<Email[]>(() => getViewCache("inbox")?.emails ?? []);
  const [loading, setLoading] = useState(() => !getViewCache("inbox"));
  const [hasMore, setHasMore] = useState(false);
  const [labels, setLabels] = useState<UserLabel[]>([]);
  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem("tabellar_inbox_filter") === "need" ? "need" : "all"));
  const [group, setGroup] = useState<Group>(() => {
    const g = localStorage.getItem("tabellar_inbox_group");
    return g === "day" || g === "sender" ? g : "priority";
  });
  const [folded, setFolded] = useState<Set<string>>(readFolded);
  const [details, setDetails] = useState(() => localStorage.getItem("tabellar_inbox_details") !== "off");
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState<Email | null>(null);
  const loaded = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);
  const anchor = useRef<string | null>(null);
  const lastUndo = useRef<{ label: string; run: () => Promise<void> } | null>(null);

  const load = useCallback(
    async (more = false) => {
      // A change while a load runs is loaded once more after it, not dropped.
      if (busy.current) {
        again.current = true;
        return;
      }
      busy.current = true;
      try {
        const want = more ? loaded.current + CHUNK : Math.max(CHUNK, loaded.current);
        // Mail shows as soon as it is fetched; a category search needs it read.
        const category = search ? parseSearch(search).category : "";
        let query = supabase
          .from("emails")
          .select(category ? SELECT.replace("email_processed(*)", "email_processed!inner(*)") : SELECT)
          .eq("user_id", user.id)
          .eq("is_archived", false)
          .not("label_ids", "cs", '{"SENT"}')
          .or("is_snoozed.eq.false,snooze_until.lt." + new Date().toISOString())
          .order("received_at", { ascending: false })
          .range(0, want);
        if (only) query = query.eq("account_id", only);
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
        if (!search && !only) setViewCache("inbox", { emails: rows });
      } finally {
        busy.current = false;
        setLoading(false);
        if (again.current) {
          again.current = false;
          void load();
        }
      }
    },
    [user.id, search, only],
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
    const q = parseSearch(search);
    const stateOnly = !!q.state && !q.text && Object.keys(q).filter((k) => k !== "text" && k !== "state").length === 0;
    if (!ids.length || (search && !stateOnly)) return setAttention([]);
    let live = true;
    (async () => {
      const found: Email[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        let q = supabase.from("emails").select(SELECT).in("id", ids.slice(i, i + 200)).eq("is_archived", false).not("label_ids", "cs", '{"SENT"}');
        if (only) q = q.eq("account_id", only);
        const { data } = await q;
        found.push(...((data || []) as any[]).map((e) => ({ ...e, email_processed: Array.isArray(e.email_processed) ? e.email_processed[0] : e.email_processed })));
      }
      if (live) setAttention(found);
    })();
    return () => {
      live = false;
    };
  }, [mail.byEmail, emails, search, only]);
  const { syncInbox, syncError, initialPhase, noAccountsConnected } = useInboxSync(reload);

  useEffect(() => {
    loaded.current = 0;
    load();
  }, [load, liveChanges.emails, liveChanges.email_processed]);

  useEffect(() => {
    supabase
      .from("categories")
      .select("slug, display_name")
      .eq("user_id", user.id)
      .order("position", { ascending: true })
      .then(({ data }: { data: UserLabel[] | null }) => setLabels(data || []));
  }, [user.id]);

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
      // Fetched but not read by the model yet.
      const unread = !t.latest.email_processed && mail.engine?.model;
      t.text = s.text || firstLabel(t, labels)?.display_name || CATEGORY[cat] || cat || (unread ? "Reading" : "");
      // Marked done by hand: handled, unless Tabellar has something on it.
      if (t.latest.resolved_at && s.state === "filed") {
        t.state = "done";
        t.text = "Done";
      }
      t.sendAt = s.sendAt;
    }
    return list;
  }, [emails, attention, mail.byEmail, mail.engine?.model, labels]);

  const counts = useMemo(() => ({ need: threads.filter((t) => t.state === "need").length }), [threads]);

  const items = useMemo(() => {
    // Older mail fetched only because it needs attention stays out of the
    // plain listing until scrolling reaches it.
    const oldest = hasMore && emails.length ? emails[emails.length - 1].received_at : "";
    const state = search ? parseSearch(search).state : undefined;
    const shown = threads.filter((t) => {
      if (filter === "need" && t.state !== "need") return false;
      if (state === "need" && t.state !== "need") return false;
      if (state === "going" && t.state !== "going") return false;
      if (state === "filed" && t.state !== "filed") return false;
      if (state === "handled" && t.state !== "done" && t.state !== "held" && t.state !== "failed") return false;
      if (filter === "need" || state === "need" || state === "going" || state === "handled") return true;
      if (group === "priority" && priorityOf(t, labels) === "need") return true;
      return !(oldest && t.latest.received_at < oldest);
    });
    const out: Item[] = [];
    const add = (key: string, name: string, list: Thread[], fold = false) => {
      if (!list.length) return;
      out.push({ head: true, key: `head:${key}`, name, fold });
      if (!(fold && folded.has(key))) out.push(...list);
    };
    if (group === "priority") {
      const groups: [string, string][] = [["need", "Needs you"], ...labels.map((l): [string, string] => [`label:${l.slug}`, l.display_name]), ...REST];
      for (const [key, name] of groups) add(key, name, shown.filter((t) => priorityOf(t, labels) === key), key !== "need");
    } else if (group === "sender") {
      const by = new Map<string, Thread[]>();
      for (const t of shown) {
        const k = t.latest.sender_email || senderName(t.latest);
        by.set(k, [...(by.get(k) || []), t]);
      }
      for (const [k, list] of by) add(k, senderName(list[0].latest), list);
    } else {
      let run: Thread[] = [];
      let day = { head: "", key: "" };
      for (const t of shown) {
        const d = dayLabel(t.latest.received_at);
        if (d.key !== day.key) {
          add(day.key, day.head, run);
          run = [];
          day = d;
        }
        run.push(t);
      }
      add(day.key, day.head, run);
    }
    return out;
  }, [threads, filter, group, folded, hasMore, emails, search, labels]);

  const fold = (key: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      const k = key.replace(/^head:/, "");
      if (next.has(k)) next.delete(k);
      else next.add(k);
      try {
        localStorage.setItem("tabellar_inbox_folded", JSON.stringify([...next]));
      } catch {
        // a remembered fold is a convenience
      }
      return next;
    });

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
    try {
      await setMailState(ids, { archived: true });
    } catch {
      addToast("error", "Could not archive. Nothing was changed.");
      return reload();
    }
    invalidateViewCache("inbox");
    const run = async () => {
      await setMailState(ids, { archived: false }).catch(() => addToast("error", "Could not move it back to the inbox."));
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
    await setMailState(ids, { read }).catch(() => addToast("error", read ? "Could not mark it read in the mailbox." : "Could not mark it unread in the mailbox."));
  };

  // Done: dealt with, kept in the inbox. Done again takes it back.
  const markDone = async (t: Thread) => {
    const at = t.latest.resolved_at ? null : new Date().toISOString();
    const ids = t.ids;
    const set = (v: string | null) => setEmails((prev) => prev.map((e) => (ids.includes(e.id) ? { ...e, resolved_at: v } : e)));
    set(at);
    const { error } = await supabase.from("emails").update({ resolved_at: at }).in("id", ids);
    if (error) {
      set(t.latest.resolved_at ?? null);
      return addToast("error", "Could not mark it done.");
    }
    if (at && !t.latest.is_read) markRead([t], true);
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
    if ("head" in item) return <GroupHead key={item.key} head={item} folded={folded.has(item.key.replace(/^head:/, ""))} onFold={fold} />;
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
        className={`row group relative ${columns} ${isPicked && !isCursor ? "bg-hover" : ""}`}
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
        <span className="flex items-center justify-end gap-2">
          <AccountMark id={e.account_id} />
          <time className="min-w-[30px] text-right text-xs text-ink3">{shortWhen(e.received_at)}</time>
        </span>
        <span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 gap-0.5 rounded-md bg-hover pl-1 group-hover:flex group-aria-selected:bg-sel">
          <button className="iconbtn h-6 w-6" title="Archive" aria-label="Archive" onClick={(ev) => (ev.stopPropagation(), archive([t]))}>
            <Icon name="archive" size={15} />
          </button>
          <button className="iconbtn h-6 w-6" title={e.resolved_at ? "Not done" : "Done"} aria-label={e.resolved_at ? "Not done" : "Done"} aria-pressed={!!e.resolved_at} onClick={(ev) => (ev.stopPropagation(), markDone(t))}>
            <Icon name="check" size={15} />
          </button>
        </span>
      </div>
    );
  };

  const firstHead = (first: number): Head | null => {
    for (let i = Math.min(first, items.length - 1); i >= 0; i--) if ("head" in items[i]) return items[i] as Head;
    return null;
  };

  return (
    <>
      {initialPhase >= 0 && <InitialFetchOverlay phaseIndex={initialPhase} />}
      {picked.size ? (
        <header className="bar">
          <b className="bar-title mr-1.5">{picked.size} selected</b>
          {waiting > 0 && (
            <button className="btn btn-pri" onClick={() => approve(selected)}>
              Approve {waiting}
            </button>
          )}
          <button className="btn" onClick={() => archive(selected)}>
            Archive
          </button>
          <button className="btn" onClick={() => markRead(selected, true)}>
            Mark read
          </button>
          <button className="btn btn-plain" onClick={() => setPicked(new Set())}>
            Clear
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
                  { id: "priority", label: "Priority" },
                  { id: "day", label: "Day" },
                  { id: "sender", label: "Sender" },
                ]}
              />
              <button className="iconbtn" title="Details (Space)" aria-label="Details" aria-pressed={details} onClick={() => (localStorage.setItem("tabellar_inbox_details", details ? "off" : "on"), setDetails(!details))}>
                <Icon name="panel" size={16} />
              </button>
            </>
          }
        >
          <Seg
            value={filter}
            onChange={(f) => (localStorage.setItem("tabellar_inbox_filter", f), setFilter(f))}
            options={[
              { id: "need", label: "Needs you", count: counts.need, need: true },
              { id: "all", label: "All" },
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
            <Empty icon="link_off" title="No mailbox connected">
              <button className="link" onClick={() => setView("settings")}>
                Connect one in Settings
              </button>
            </Empty>
          ) : !rows.length && !items.length ? (
            search ? (
              <Empty icon="search" title="Nothing matches that search" />
            ) : filter === "need" ? (
              <Empty icon="inbox" title="Nothing needs you">
                <button className="link" onClick={() => (localStorage.setItem("tabellar_inbox_filter", "all"), setFilter("all"))}>
                  Show all mail
                </button>
              </Empty>
            ) : (
              <Empty icon="inbox" title="Inbox is empty" />
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
                return h ? <GroupHead head={h} folded={folded.has(h.key.replace(/^head:/, ""))} onFold={fold} /> : null;
              }}
            />
          )}
          </div>
        </div>
        {details && cursor && rows.length > 0 && <Details key={cursor.latest.id} thread={cursor} primary={primary(cursor)} onOpen={() => open(cursor)} onReply={() => openCompose(cursor.latest)} onArchive={() => archive([cursor])} />}
      </div>
    </>
  );
}

function rank(s: MailState): number {
  return { going: 0, need: 1, failed: 2, held: 3, done: 4, info: 5, filed: 6 }[s];
}

function GroupHead({ head, folded, onFold }: { head: Head; folded: boolean; onFold: (key: string) => void }) {
  if (!head.fold)
    return (
      <div className="day !static">
        <b>{head.name}</b>
      </div>
    );
  return (
    <div className="day !static">
      <button className="flex items-center gap-1 text-ink3 hover:text-ink" aria-expanded={!folded} onClick={() => onFold(head.key)}>
        <b className="font-[650] text-ink">{head.name}</b>
        <Icon name={folded ? "chevron_right" : "expand_more"} size={13} />
      </button>
    </div>
  );
}

// The panel on the right: who wrote, what it is about, what Tabellar made of
// it, then the email itself. Its width is dragged and remembered.
const PANEL_MIN = 320;
const PANEL_MAX = 760;
// The list keeps room for its sender, subject, status and time.
const LIST_MIN = 600;

function readPanelWidth(): number {
  try {
    const w = Number(localStorage.getItem("tabellar_inbox_details_width"));
    return w ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, w)) : 404;
  } catch {
    return 404;
  }
}

function Details({ thread, primary, onOpen, onReply, onArchive }: { thread: Thread; primary: { label: string; run: () => void }; onOpen: () => void; onReply: () => void; onArchive: () => void }) {
  const { accounts } = useApp();
  const e = thread.latest;
  const [width, setWidth] = useState(readPanelWidth);
  const [room, setRoom] = useState(Infinity);
  const aside = useRef<HTMLElement>(null);
  useEffect(() => {
    const parent = aside.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setRoom(parent.clientWidth - LIST_MIN));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  const shown = Math.max(PANEL_MIN, Math.min(width, room));
  const [body, setBody] = useState<{ body_html: string | null; body_text: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    createClient()
      .from("emails")
      .select("body_html, body_text")
      .eq("id", e.id)
      .single()
      .then(({ data }: { data: { body_html: string | null; body_text: string | null } | null }) => live && setBody(data || { body_html: null, body_text: null }));
    return () => {
      live = false;
    };
  }, [e.id]);

  const resize = (next: number) => {
    const w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, next)));
    setWidth(w);
    try {
      localStorage.setItem("tabellar_inbox_details_width", String(w));
    } catch {
      // a remembered width is a convenience
    }
  };
  const drag = (ev: React.PointerEvent<HTMLDivElement>) => {
    const handle = ev.currentTarget;
    const startX = ev.clientX;
    const start = shown;
    handle.setPointerCapture(ev.pointerId);
    const onMove = (m: PointerEvent) => resize(Math.min(room, start + startX - m.clientX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  const waiting = primary.label !== "Open email";
  // Which of the user's addresses it came to, once they have more than one.
  const account = accounts.byId.get(e.account_id ?? "");
  const hit = account?.from.find((f) => addressesIn(`${e.recipients ?? ""}, ${e.cc_recipients ?? ""}`).includes(f.address))?.address;
  const to = accounts.mine.size > 1 ? (hit ?? (accounts.list.length > 1 ? account?.address : "")) : "";
  const noreply = /no.?reply|do.?not.?reply|mailer-daemon|postmaster/i.test(e.sender_email || "");
  return (
    <aside ref={aside} className="relative hidden flex-none flex-col border-l border-line md:flex" style={{ width: shown }} aria-label="Details">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Panel width"
        aria-valuemin={PANEL_MIN}
        aria-valuemax={PANEL_MAX}
        aria-valuenow={shown}
        tabIndex={0}
        className="absolute -left-[3px] bottom-0 top-0 z-10 w-[6px] cursor-col-resize outline-none transition-colors duration-150 hover:bg-line focus-visible:bg-wax/40"
        onPointerDown={drag}
        onDoubleClick={() => resize(404)}
        onKeyDown={(k) => {
          if (k.key === "ArrowLeft") resize(Math.min(room, shown + 24));
          else if (k.key === "ArrowRight") resize(shown - 24);
          else return;
          k.preventDefault();
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="px-5 pb-3 pt-4">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-[650] leading-tight tracking-[-0.01em]">{senderName(e)}</h2>
              <p className="mt-0.5 truncate text-xs text-ink3">
                {e.sender_email}, {dayLabel(e.received_at).name.toLowerCase()} {shortWhen(e.received_at)}
                {to && <>, to {to}</>}
              </p>
            </div>
            <button className="iconbtn -mr-1.5" title="Open" aria-label="Open email" onClick={onOpen}>
              <Icon name="open" size={16} />
            </button>
          </div>
          <p className="mt-3 font-semibold leading-snug text-ink">{e.subject || "(no subject)"}</p>
          {e.email_processed?.summary && <p className="mt-1 line-clamp-2 leading-normal text-ink2">{e.email_processed.summary}</p>}
          <OutcomeLines outcomes={thread.outcomes} className="mt-2" />
        </header>
        <div className="border-t border-line-soft px-5 pb-6 pt-4">
          {body === null ? (
            <div className="space-y-2 pt-1" aria-busy="true">
              <span className="skel block h-2.5 w-full" />
              <span className="skel block h-2.5 w-11/12" />
              <span className="skel block h-2.5 w-3/5" />
            </div>
          ) : (
            <EmailBody email={{ ...body, snippet: e.snippet }} size="sm" />
          )}
        </div>
      </div>
      <div className="flex flex-none items-center gap-2 border-t border-line py-2.5 pl-5 pr-3.5">
        {waiting && (
          <button className="btn btn-pri" onClick={primary.run}>
            {primary.label}
          </button>
        )}
        {!noreply && (
          <button className="btn" onClick={onReply}>
            Reply
          </button>
        )}
        <button className="btn" onClick={onArchive}>
          Archive
        </button>
      </div>
    </aside>
  );
}
