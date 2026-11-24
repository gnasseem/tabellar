import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { measureEmailIframeBodyHeight } from "@/lib/emailIframe";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { Empty, Glyph, SkeletonRows, ViewBar, VirtualList, useSizes, dayLabel, shortWhen } from "../ui";

// Sent: everything that went out, one line each, grouped by day. A line ends
// in whether a follow-up is waiting on it. Opening one shows it on the right.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sent = {
  id: string;
  thread_id?: string | null;
  subject: string;
  recipients: string;
  received_at: string;
  snippet?: string;
  has_attachments?: boolean;
  body_html?: string; // only on an email sent a moment ago, before the mailbox has it
};
type Body = { body_text: string | null; body_html: string | null; attachments: { filename: string; mime_type: string; size: number; attachment_id: string }[] | null };
type FollowUp = { thread_id: string; status: string; remind_at: string; snooze_until: string | null };
type Head = { head: true; key: string; name: string };
type Item = Head | Sent;

const CHUNK = 300;
const LIST = "id, thread_id, subject, recipients, received_at, snippet, has_attachments";
const COLUMNS = "!grid grid-cols-[26px_128px_minmax(0,1fr)_46px] md:grid-cols-[26px_164px_minmax(0,1fr)_132px_46px]";
const COLUMNS_BESIDE_READER = "!grid grid-cols-[26px_128px_minmax(0,1fr)_46px]";

// "Ann Lee <ann@x.org>, bo@y.org" to the names to show: Ann Lee, bo@y.org.
function people(recipients: string): string[] {
  const out: string[] = [];
  for (const m of (recipients || "").matchAll(/(?:"([^"]*)"|([^,<"]*))\s*<([^>]+)>|([^\s,<>"]+@[^\s,<>"]+)/g)) out.push((m[1] || m[2] || "").trim() || m[3] || m[4]);
  return out.length ? out : [recipients || "No recipient"];
}
function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}
function size(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

// What became of a sent email, from its follow-up: red only once the reminder is due.
function followState(e: Sent, f: FollowUp | undefined): { text: string; due: boolean; answered: boolean } {
  if (!f || f.status === "dismissed") return { text: "", due: false, answered: false };
  if (f.status === "replied") return { text: "Answered", due: false, answered: true };
  const n = daysAgo(e.received_at);
  const text = n <= 0 ? "Waiting" : `Waiting ${n} day${n === 1 ? "" : "s"}`;
  if (f.status === "snoozed" && f.snooze_until && new Date(f.snooze_until) > new Date()) return { text: "Snoozed", due: false, answered: false };
  return { text, due: new Date(f.remind_at) <= new Date(), answered: false };
}

// The email itself, in a frame of its own so its markup cannot touch the window.
function SentEmailFrame({ html, isDark }: { html: string; isDark: boolean }) {
  const { scale } = useSizes();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const srcDoc = useMemo(() => {
    const lightCss = `<style>html,body{margin:0;padding:0;box-sizing:border-box;min-height:0!important;height:auto!important;overflow-x:hidden}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:${14 * scale}px;line-height:1.6;word-break:break-word;position:relative}img,table{max-width:100%!important;height:auto!important}</style>`;
    // In dark, the frame takes the system's dark colours and lets the window's ground show through.
    const darkCss = isDark ? `<style>:root{color-scheme:dark}html,body{background:transparent!important;color:CanvasText!important}img{opacity:.85}</style>` : "";
    const safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    return `<base target="_blank">` + lightCss + darkCss + safe;
  }, [html, isDark, scale]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let detach: (() => void) | undefined;

    const bind = () => {
      const doc = iframe.contentDocument;
      const body = doc?.body;
      if (!body) return;
      const measureNow = () => {
        const b = iframe.contentDocument?.body;
        if (b) setHeight(measureEmailIframeBodyHeight(b));
      };
      measureNow();
      requestAnimationFrame(measureNow);
      requestAnimationFrame(() => requestAnimationFrame(measureNow));
      const t1 = window.setTimeout(measureNow, 60);
      const t2 = window.setTimeout(measureNow, 280);
      const fontWait = doc.fonts?.ready?.then(measureNow);
      const ro = new ResizeObserver(() => requestAnimationFrame(measureNow));
      ro.observe(body);
      const rootEl = iframe.contentDocument?.documentElement;
      if (rootEl) ro.observe(rootEl);
      const imgs = [...body.querySelectorAll("img")];
      imgs.forEach((img) => img.addEventListener("load", measureNow));
      detach = () => {
        window.clearTimeout(t1);
        window.clearTimeout(t2);
        void fontWait?.catch(() => {});
        ro.disconnect();
        imgs.forEach((img) => img.removeEventListener("load", measureNow));
      };
    };

    const onLoad = () => {
      detach?.();
      bind();
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      detach?.();
    };
  }, [srcDoc]);

  return <iframe ref={iframeRef} srcDoc={srcDoc} sandbox="allow-same-origin allow-popups" title="Email content" style={{ width: "100%", height, border: "none", display: "block" }} />;
}

export default function SentView() {
  const { user, pendingSentEmail, search, liveChanges, theme, setView, accounts } = useApp();
  const supabase = createClient();
  const [emails, setEmails] = useState<Sent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [followUps, setFollowUps] = useState<Map<string, FollowUp>>(new Map());
  const [bodies, setBodies] = useState<Record<string, Body>>({});
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const loaded = useRef(0);
  const busy = useRef(false);
  const goKey = useRef(0);

  const loadSent = useCallback(
    async (more = false) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const want = more ? loaded.current + CHUNK : Math.max(CHUNK, loaded.current);
        let query = supabase.from("emails").select(LIST).eq("user_id", user.id).contains("label_ids", ["SENT"]).order("received_at", { ascending: false }).range(0, want);
        // The search matches the recipient as well as the words of the email.
        const q = search.trim().replace(/[,()"\\%]/g, " ").trim();
        if (q) query = query.or(`search_vector.fts.${q},recipients.ilike.%${q}%`);
        if (accounts.only) query = query.eq("account_id", accounts.only);
        const { data, error: dbError } = await query;
        if (dbError) throw dbError;
        let rows = (data || []) as Sent[];
        const extra = rows.length > want;
        if (extra) rows = rows.slice(0, want);
        loaded.current = rows.length;
        setHasMore(extra);
        setEmails(rows);
        setError(null);
      } catch {
        setError("Could not load your sent mail.");
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [user.id, search, accounts.only],
  );

  useEffect(() => {
    loadSent();
  }, [loadSent, liveChanges.emails]);

  useEffect(() => {
    supabase
      .from("follow_up_reminders")
      .select("thread_id, status, remind_at, snooze_until")
      .eq("user_id", user.id)
      .then(({ data }: { data: FollowUp[] | null }) => setFollowUps(new Map((data || []).map((f) => [f.thread_id, f]))));
  }, [user.id, liveChanges.emails]);

  // Show a just-sent email at once, then load the copy Gmail has.
  useEffect(() => {
    if (!pendingSentEmail) return;
    const optimistic: Sent = { id: pendingSentEmail.id, subject: pendingSentEmail.subject, recipients: pendingSentEmail.to, body_html: pendingSentEmail.body_html, received_at: pendingSentEmail.date };
    setEmails((prev) => (prev.some((e) => e.id === optimistic.id) ? prev : [optimistic, ...prev]));
    const timer = setTimeout(() => loadSent(), 2000);
    return () => clearTimeout(timer);
  }, [pendingSentEmail]);

  const items = useMemo(() => {
    const out: Item[] = [];
    let run: Sent[] = [];
    let day = { head: "", key: "" };
    const flush = () => run.length && out.push({ head: true, key: `head:${day.key}`, name: day.head }, ...run);
    for (const e of emails) {
      const d = dayLabel(e.received_at);
      if (d.key !== day.key) {
        flush();
        run = [];
        day = d;
      }
      run.push(e);
    }
    flush();
    return out;
  }, [emails]);

  const rows = emails;
  const cursor = rows.find((e) => e.id === cursorId) || rows[0] || null;
  const cursorIndex = cursor ? items.indexOf(cursor) : -1;
  const { row, head } = useSizes();
  const heightOf = useCallback((i: Item) => ("head" in i ? head : row), [row, head]);
  const beside = reading && !!cursor;

  // The full text is fetched only for the email being read.
  const body: Body | null = cursor ? bodies[cursor.id] || (cursor.body_html ? { body_html: cursor.body_html, body_text: null, attachments: null } : null) : null;
  useEffect(() => {
    if (!reading || !cursor || bodies[cursor.id] || cursor.body_html) return;
    const id = cursor.id;
    supabase
      .from("emails")
      .select("id, body_text, body_html, attachments")
      .eq("id", id)
      .limit(1)
      .then(({ data }: { data: any[] | null }) => setBodies((prev) => ({ ...prev, [id]: (data?.[0] as Body) || { body_text: null, body_html: null, attachments: null } })));
  }, [reading, cursor?.id]);

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorId(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[data-compose-modal]")) return;
      // "g" then a letter goes to another view; that letter is not an action here.
      if (Date.now() - goKey.current < 1500) return void (goKey.current = 0);
      const k = e.key.toLowerCase();
      if (k === "g") return void (goKey.current = Date.now());
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if ((e.key === "Enter" || k === "o" || e.key === " ") && cursor) setReading(e.key === " " ? !reading : true);
      else if (e.key === "Escape" && reading) setReading(false);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const renderItem = (item: Item) => {
    if ("head" in item) return <GroupHead key={item.key} head={item} />;
    const e = item;
    const to = people(e.recipients);
    const follow = followState(e, e.thread_id ? followUps.get(e.thread_id) : undefined);
    return (
      <div
        key={e.id}
        role="option"
        aria-selected={cursor === e}
        className={`row ${beside ? COLUMNS_BESIDE_READER : COLUMNS}`}
        onClick={() => (setCursorId(e.id), setReading(true))}
      >
        <span className="grid place-items-center">
          <Glyph state={follow.due ? "need" : follow.answered ? "done" : "filed"} />
        </span>
        <span className="truncate pr-3 text-ink">
          {to[0]}
          {to.length > 1 && <span className="ml-[5px] text-xs text-ink3">+{to.length - 1}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-2 pr-4">
          <b className="shrink truncate font-normal text-ink">{e.subject || "(no subject)"}</b>
          {e.has_attachments && <Icon name="attachment" size={13} className="flex-none text-ink3" />}
          <span className="min-w-0 flex-1 truncate text-ink3">{e.snippet}</span>
        </span>
        {!beside && <span className={`hidden truncate text-[12.5px] md:block ${follow.due ? "font-semibold text-wax-ink" : "text-ink3"}`}>{follow.text}</span>}
        <time className="text-right text-xs text-ink3">{shortWhen(e.received_at)}</time>
      </div>
    );
  };

  const firstHead = (first: number): Head | null => {
    for (let i = Math.min(first, items.length - 1); i >= 0; i--) if ("head" in items[i]) return items[i] as Head;
    return null;
  };

  const follow = cursor ? followState(cursor, cursor.thread_id ? followUps.get(cursor.thread_id) : undefined) : null;

  return (
    <>
      <ViewBar title="Sent" search="Search sent mail" />
      <div className="flex min-h-0 flex-1">
        <div className={`min-w-0 flex-1 flex-col ${beside ? "hidden md:flex" : "flex"}`} role="listbox" aria-label="Sent">
          {loading && !emails.length ? (
            <div className="pt-9">
              <SkeletonRows count={22} />
            </div>
          ) : error && !emails.length ? (
            <p className="px-5 py-4 text-danger" role="alert">
              {error} Check that Tabellar is still running, then{" "}
              <button className="link !text-danger" onClick={() => (setLoading(true), loadSent())}>
                try again
              </button>
              .
            </p>
          ) : !rows.length ? (
            search ? (
              <Empty icon="search" title="Nothing matches that search" />
            ) : (
              <Empty icon="send" title="Nothing sent yet" />
            )
          ) : (
            <VirtualList
              items={items}
              heightOf={heightOf}
              render={renderItem}
              cursor={cursorIndex}
              onEnd={hasMore ? () => loadSent(true) : undefined}
              sticky={(first) => {
                const h = firstHead(first);
                return h ? <GroupHead head={h} /> : null;
              }}
            />
          )}
        </div>
        {beside && cursor && (
          <article className="flex w-full min-w-0 flex-none flex-col border-line md:w-[54%] md:min-w-[380px] md:max-w-[720px] md:border-l" aria-label="Sent email">
            <header className="flex flex-none items-start gap-1 border-b border-line-soft pb-3.5 pl-6 pr-3 pt-4">
              <button className="iconbtn -ml-2 md:hidden" aria-label="Back to Sent" onClick={() => setReading(false)}>
                <Icon name="arrow_back" size={16} />
              </button>
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-[650] leading-snug tracking-[-0.01em]">{cursor.subject || "(no subject)"}</h2>
                <p className="mt-1 break-words text-xs leading-normal text-ink3">
                  To {people(cursor.recipients).join(", ")}, {dayLabel(cursor.received_at).name.toLowerCase()} {shortWhen(cursor.received_at)}
                </p>
                {follow?.text && (
                  <p className={`mt-1 text-xs ${follow.due ? "font-semibold text-wax-ink" : "text-ink2"}`}>
                    {follow.answered ? "Answered." : follow.due ? `${follow.text}, a follow-up is due.` : `${follow.text} for an answer.`}{" "}
                    <button className="link" onClick={() => setView("followups")}>
                      Open Follow-ups
                    </button>
                  </p>
                )}
              </div>
              <button className="iconbtn" aria-label="Previous email" title="Previous (K)" onClick={() => move(-1)}>
                <Icon name="expand_less" size={16} />
              </button>
              <button className="iconbtn" aria-label="Next email" title="Next (J)" onClick={() => move(1)}>
                <Icon name="expand_more" size={16} />
              </button>
              <button className="iconbtn hidden md:grid" aria-label="Close" title="Close (Esc)" onClick={() => setReading(false)}>
                <Icon name="close" size={16} />
              </button>
            </header>
            <div className="email-reader-pane min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {!body ? (
                <div aria-busy="true" aria-label="Loading" className="space-y-3">
                  <div className="skel h-3 w-3/4" />
                  <div className="skel h-3 w-full" />
                  <div className="skel h-3 w-5/6" />
                  <div className="skel h-3 w-2/3" />
                </div>
              ) : body.body_html ? (
                <SentEmailFrame html={body.body_html} isDark={theme === "dark"} />
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-[1.6]">{body.body_text || cursor.snippet || "This email has no text."}</p>
              )}
              {body && Array.isArray(body.attachments) && body.attachments.length > 0 && (
                <div className="mt-6 border-t border-line-soft pt-3.5">
                  <h3 className="label mb-1.5">
                    {body.attachments.length} attachment{body.attachments.length === 1 ? "" : "s"}
                  </h3>
                  {body.attachments.map((att, i) => (
                    <div key={i} className="flex h-item items-center gap-2 text-ink2">
                      <Icon name={att.mime_type?.startsWith("image/") ? "image" : att.mime_type?.includes("pdf") ? "picture_as_pdf" : "attach_file"} size={15} className="flex-none text-ink3" />
                      <span className="min-w-0 truncate text-ink">{att.filename}</span>
                      <span className="flex-none text-xs text-ink3">{size(att.size)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </article>
        )}
      </div>
    </>
  );
}

function GroupHead({ head }: { head: Head }) {
  return (
    <div className="day !static">
      <b>{head.name}</b>
      <span className="flex-1" />
    </div>
  );
}
