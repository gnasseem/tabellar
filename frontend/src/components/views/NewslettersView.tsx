import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/db";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { api } from "@/lib/outcomes";
import { Empty, Seg, SkeletonRows, Tick, ViewBar } from "../ui";
import { NotThis } from "../Profile";

// Newsletter cleanup: senders of bulk mail, the ones filling the inbox first.
// Which senders are listed, and why, is decided on the server (newsletters.ts).
// Unsubscribe follows the sender's own unsubscribe header (the server reads it
// fresh from Gmail); an unsubscribe that sends an email shows the address and
// is confirmed first, and one that needs the sender's web page hands over the
// link. Archiving a sender is one action that can be undone.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sender = {
  sender_email: string;
  name: string;
  total: number;
  inbox: number;
  unread: number;
  opened: number;
  last_at: string;
  can_unsubscribe: boolean;
  reason: string;
  status: "kept" | "unsubscribed" | null;
  method: string | null;
};

type Tab = "clean" | "kept" | "unsubscribed";
type Ask = { name: string; to: string; subject: string; answer: (send: boolean) => void };

const COLUMNS = "!grid grid-cols-[26px_minmax(0,1fr)_88px] md:grid-cols-[26px_minmax(0,220px)_minmax(0,1fr)_88px_288px]";
const METHOD: Record<string, string> = { "one-click": "Unsubscribed by their link", mailto: "Unsubscribed by email", web: "Finish on their page if you have not" };

function emails(n: number): string {
  return `${n.toLocaleString()} email${n === 1 ? "" : "s"}`;
}


export default function NewslettersView() {
  const { user, addToast, search, mail } = useApp();
  const supabase = createClient();
  const [senders, setSenders] = useState<Sender[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("clean");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cursorAddr, setCursorAddr] = useState<string | null>(null);
  // Unsubscribes that have to be finished on the sender's own page.
  const [pages, setPages] = useState<{ addr: string; sender: string; url: string }[]>([]);
  // The unsubscribe email waiting for the user's yes or no.
  const [ask, setAsk] = useState<Ask | null>(null);
  const anchor = useRef<string | null>(null);
  const lastUndo = useRef<(() => Promise<void>) | null>(null);
  const goKey = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api("/newsletters");
      setSenders(r.senders || []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = (addr: string, p: Partial<Sender>) => setSenders((list) => list.map((s) => (s.sender_email === addr ? { ...s, ...p } : s)));

  const withBusy = async (addrs: string[], fn: () => Promise<void>) => {
    setBusy((b) => new Set([...b, ...addrs]));
    try {
      await fn();
    } catch (e) {
      addToast("error", (e as Error).message);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        addrs.forEach((a) => n.delete(a));
        return n;
      });
    }
  };

  // Shows the address the unsubscribe email would go to; resolves with the answer.
  const confirmEmail = (name: string, to: string, subject: string) =>
    new Promise<boolean>((resolve) =>
      setAsk({
        name,
        to,
        subject,
        answer: (send) => {
          setAsk(null);
          resolve(send);
        },
      }),
    );

  // Returns false when the user declined to send an unsubscribe email, "web"
  // when it has to be finished on the sender's page, else "done".
  const doUnsubscribe = async (s: Sender): Promise<false | "web" | "done"> => {
    let r = await api("/newsletters/unsubscribe", { sender: s.sender_email });
    if (r.confirm) {
      if (!(await confirmEmail(s.name, r.confirm.to, r.confirm.subject))) return false;
      r = await api("/newsletters/unsubscribe", { sender: s.sender_email, confirm: r.confirm.to });
    }
    if (r.open) setPages((p) => [...p.filter((x) => x.addr !== s.sender_email), { addr: s.sender_email, sender: s.name, url: r.open }]);
    patch(s.sender_email, { status: "unsubscribed", method: r.method ?? (r.open ? "web" : null) });
    return r.open ? "web" : "done";
  };

  // Archives the sender's inbox mail and returns how many, with the id of the
  // logged action so it can be undone from here.
  const doArchive = async (s: Sender): Promise<{ archived: number; actionId: string | null }> => {
    const r = await api("/newsletters/archive", { sender: s.sender_email });
    patch(s.sender_email, { inbox: 0 });
    if (!r.archived) return { archived: 0, actionId: null };
    const { data } = await supabase.from("action_log").select("id, detail").eq("user_id", user.id).eq("kind", "archive").eq("source", "user").eq("status", "done").order("created_at", { ascending: false }).limit(10);
    const row = ((data || []) as any[]).find((x) => x.detail?.sender === s.sender_email);
    return { archived: r.archived as number, actionId: row?.id ?? null };
  };

  const archivedToast = (text: string, actionIds: (string | null)[]) => {
    const ids = actionIds.filter((x): x is string => !!x);
    if (!ids.length) return addToast("success", `${text} Undo it in History, in Settings.`);
    const undo = async () => {
      for (const id of ids) await mail.undo(id).catch(() => {});
      await load();
      addToast("info", "Back in your inbox");
    };
    lastUndo.current = undo;
    addToast("success", text, { action: { label: "Undo", onClick: undo } });
  };

  const unsubscribe = (s: Sender) =>
    withBusy([s.sender_email], async () => {
      const how = await doUnsubscribe(s);
      if (how === "done") addToast("success", `Unsubscribed from ${s.name}`);
      if (how === "web") addToast("info", `${s.name} only unsubscribes on its own page. The link is at the top of the list.`);
    });

  const archive = (list: Sender[]) => {
    list = list.filter((s) => s.inbox > 0);
    if (!list.length) return;
    return withBusy(list.map((s) => s.sender_email), async () => {
      let n = 0;
      const ids: (string | null)[] = [];
      for (const s of list) {
        try {
          const r = await doArchive(s);
          n += r.archived;
          ids.push(r.actionId);
        } catch (e) {
          addToast("error", `${s.name}: ${(e as Error).message}`);
        }
      }
      setPicked(new Set());
      if (n) archivedToast(list.length === 1 ? `Archived ${emails(n)} from ${list[0].name}.` : `Archived ${emails(n)} from ${list.length} senders.`, ids);
    });
  };

  const keep = (list: Sender[], on: boolean) =>
    withBusy(list.map((s) => s.sender_email), async () => {
      for (const s of list) {
        await api("/newsletters/keep", { sender: s.sender_email, keep: on });
        patch(s.sender_email, { status: on ? "kept" : null });
      }
      setPicked(new Set());
    });

  const cleanSelected = (list: Sender[]) =>
    withBusy(list.map((s) => s.sender_email), async () => {
      let unsubscribed = 0;
      let archived = 0;
      const ids: (string | null)[] = [];
      for (const s of list) {
        try {
          if (s.can_unsubscribe && s.status !== "unsubscribed" && (await doUnsubscribe(s))) unsubscribed++;
          if (s.inbox > 0) {
            const r = await doArchive(s);
            archived += r.archived;
            ids.push(r.actionId);
          }
        } catch (e) {
          addToast("error", `${s.name}: ${(e as Error).message}`);
        }
      }
      setPicked(new Set());
      archivedToast(`Unsubscribed from ${unsubscribed} sender${unsubscribed === 1 ? "" : "s"} and archived ${emails(archived)}.`, ids);
    });

  // The heaviest senders first: most mail in the inbox, then most mail in all.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return senders
      .filter((s) => (tab === "clean" ? s.status === null : s.status === tab))
      .filter((s) => !q || `${s.name} ${s.sender_email}`.toLowerCase().includes(q))
      .sort((a, b) => b.inbox - a.inbox || b.total - a.total);
  }, [senders, tab, search]);

  const cursor = rows.find((s) => s.sender_email === cursorAddr) || rows[0] || null;
  const selected = rows.filter((s) => picked.has(s.sender_email));
  const targets = (): Sender[] => (selected.length ? selected : cursor ? [cursor] : []);
  const canUnsubscribe = (s: Sender) => s.status === null && s.can_unsubscribe;

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor?.sender_email]);

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorAddr(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].sender_email);
  };

  const pick = (s: Sender, range = false) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && anchor.current) {
        const a = rows.findIndex((r) => r.sender_email === anchor.current);
        const b = rows.indexOf(s);
        if (a >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(rows[i].sender_email);
      } else if (next.has(s.sender_email)) next.delete(s.sender_email);
      else next.add(s.sender_email);
      return next;
    });
    anchor.current = s.sender_email;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While the unsubscribe email is being confirmed, only Escape does anything.
      if (ask) {
        if (e.key === "Escape") ask.answer(false);
        return;
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[data-compose-modal]")) return;
      // "g" then a letter goes to another view; that letter is not an action here.
      if (Date.now() - goKey.current < 1500) return void (goKey.current = 0);
      const k = e.key.toLowerCase();
      if (k === "g") return void (goKey.current = Date.now());
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "x" && cursor) pick(cursor, e.shiftKey);
      else if (k === "u" && cursor && canUnsubscribe(cursor) && !busy.has(cursor.sender_email)) unsubscribe(cursor);
      else if (k === "e") archive(targets().filter((s) => !busy.has(s.sender_email)));
      else if (k === "y" && tab === "clean") keep(targets().filter((s) => !busy.has(s.sender_email)), true);
      else if (k === "z" && lastUndo.current) {
        const undo = lastUndo.current;
        lastUndo.current = null;
        undo();
      } else if (e.key === "Escape" && picked.size) setPicked(new Set());
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const change = (t: Tab) => {
    setTab(t);
    setPicked(new Set());
  };

  // The actions for one sender, shown on its row and, in a narrow window, in
  // the strip under the list.
  const actions = (s: Sender) => {
    const off = busy.has(s.sender_email);
    return (
      <>
        {canUnsubscribe(s) && (
          <button className="btn btn-sm" disabled={off} onClick={(e) => (e.stopPropagation(), unsubscribe(s))}>
            Unsubscribe
          </button>
        )}
        {s.inbox > 0 && (
          <button className="btn btn-sm" disabled={off} title={`Archive the ${s.inbox.toLocaleString()} in your inbox`} onClick={(e) => (e.stopPropagation(), archive([s]))}>
            Archive all
          </button>
        )}
        <button className="btn btn-plain btn-sm" disabled={off} onClick={(e) => (e.stopPropagation(), keep([s], s.status === null))}>
          {s.status === null ? "Keep" : "Move back"}
        </button>
        <NotThis thing="newsletter" sender={s.sender_email} who={s.name} onDone={load} />
      </>
    );
  };

  return (
    <>
      {selected.length ? (
        <header className="bar">
          <b className="bar-title mr-1.5">{selected.length} selected</b>
          {tab === "clean" && (
            <button className="btn btn-pri" onClick={() => cleanSelected(selected)}>
              Unsubscribe and archive
            </button>
          )}
          <button className="btn" disabled={!selected.some((s) => s.inbox > 0)} onClick={() => archive(selected)}>
            Archive
          </button>
          {tab === "clean" ? (
            <button className="btn" onClick={() => keep(selected, true)}>
              Keep
            </button>
          ) : (
            <button className="btn" onClick={() => keep(selected, false)}>
              Move back
            </button>
          )}
          <button className="btn btn-plain" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </header>
      ) : (
        <ViewBar title="Newsletters" search="Search senders">
          <Seg
            value={tab}
            onChange={change}
            options={[
              { id: "clean", label: "In your inbox" },
              { id: "unsubscribed", label: "Unsubscribed" },
              { id: "kept", label: "Kept" },
            ]}
          />
        </ViewBar>
      )}
      {pages.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-b border-line py-2 pl-5 pr-3.5 text-xs text-ink2">
          <b className="font-semibold text-ink">Finish on their page</b>
                    {pages.map((p) => (
            <a key={p.addr} href={p.url} target="_blank" rel="noopener noreferrer" className="link">
              {p.sender}
            </a>
          ))}
          <span className="flex-1" />
          <button className="btn btn-plain btn-sm" onClick={() => setPages([])}>
            Done
          </button>
        </div>
      )}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Newsletter senders">
        {loading ? (
          <div className="pt-9">
            <SkeletonRows count={18} />
          </div>
        ) : error ? (
          <p className="px-5 py-4 text-danger" role="alert">
            Could not load the senders: {error}.{" "}
            <button className="link !text-danger" onClick={() => (setLoading(true), load())}>
              Try again
            </button>
          </p>
        ) : !rows.length ? (
          search ? (
            <Empty icon="search" title="Nothing matches that search" />
          ) : tab === "clean" ? (
            <Empty icon="newspaper" title="No newsletters" />
          ) : (
            <Empty icon="newspaper" title={tab === "kept" ? "No senders kept yet" : "No unsubscribes yet"}>
              <button className="link" onClick={() => change("clean")}>
                Show senders in your inbox
              </button>
            </Empty>
          )
        ) : (
          <>
            <div className="day">
              <b>{tab === "clean" ? "In your inbox" : tab === "kept" ? "Kept" : "Unsubscribed"}</b>
            </div>
            {rows.map((s) => {
              const isCursor = cursor === s;
              const isPicked = picked.has(s.sender_email);
              const isBusy = busy.has(s.sender_email);
              return (
                <div
                  key={s.sender_email}
                  role="option"
                  aria-selected={isCursor}
                  aria-busy={isBusy}
                  className={`row group scroll-mt-head ${COLUMNS} ${isPicked && !isCursor ? "bg-hover" : ""}`}
                  onClick={(e) => (e.shiftKey ? pick(s, true) : setCursorAddr(s.sender_email))}
                >
                  <span className="grid place-items-center">
                    <span className={isPicked || isCursor ? "" : "hidden group-hover:block"}>
                      <Tick checked={isPicked} onChange={(_, e) => pick(s, e.shiftKey)} label={`Select ${s.name}`} />
                    </span>
                  </span>
                  <span className={`truncate pr-3 ${s.inbox > 0 ? "text-ink" : "text-ink2"}`}>{s.name}</span>
                  <span className="hidden truncate pr-4 text-ink3 md:block">{s.sender_email}</span>
                  <span className={`whitespace-nowrap text-right ${s.inbox > 0 ? "text-ink" : "text-ink3"}`}>{isBusy ? "Working" : s.inbox > 0 ? `${s.inbox.toLocaleString()} in inbox` : "None in inbox"}</span>
                  <span className="hidden min-w-0 items-center justify-end gap-1.5 md:flex">
                    <span className={`truncate text-xs text-ink3 ${isCursor ? "hidden" : "group-hover:hidden"}`}>
                      {s.status === "unsubscribed" ? METHOD[s.method || ""] || "Unsubscribed" : s.reason}
                    </span>
                    <span className={`items-center gap-1.5 ${isCursor ? "flex" : "hidden group-hover:flex has-[[aria-expanded=true]]:flex"}`}>{actions(s)}</span>
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
      {cursor && !selected.length && (
        <div className="flex flex-none items-center gap-1.5 border-t border-line py-2 pl-5 pr-3.5 md:hidden">
          <span className="min-w-0 flex-1 truncate text-xs text-ink2">{cursor.name}</span>
          {actions(cursor)}
        </div>
      )}
      {ask && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" onClick={() => ask.answer(false)}>
          <div className="w-full max-w-[440px] rounded-[12px] bg-raised p-5 shadow-pop" role="alertdialog" aria-modal="true" aria-labelledby="unsubscribe-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="unsubscribe-title" className="text-[15px] font-[650] tracking-[-0.01em]">
              {ask.name} unsubscribes by email
            </h2>
            <p className="mt-1.5 leading-normal text-ink2">This sends one email from your account. The sender chose the address, so check it.</p>
            <dl className="inset mt-3.5 grid grid-cols-[58px_1fr] gap-y-1 text-[12.5px]">
              <dt className="text-ink3">To</dt>
              <dd className="min-w-0 break-all font-medium text-ink">{ask.to}</dd>
              <dt className="text-ink3">Subject</dt>
              <dd className="min-w-0 break-words text-ink2">{ask.subject}</dd>
            </dl>
            <div className="mt-[18px] flex justify-end gap-2">
              <button className="btn" autoFocus onClick={() => ask.answer(false)}>
                Do not send
              </button>
              <button className="btn btn-pri" onClick={() => ask.answer(true)}>
                Send unsubscribe email
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
