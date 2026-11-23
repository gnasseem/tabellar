import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { Countdown, Empty, Glyph, Menu, SearchBox, SkeletonRows, Tick, ViewBar, dayLabel, shortWhen } from "../ui";

// Replies: every answer Tabellar has written, ready to read and send, and the
// ones Autopilot is about to send on its own. Reading and sending happen here,
// one after another or several at once.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Source = { id: string; gmail_id: string; thread_id: string | null; gmail_account_id: string | null; sender: string; sender_email: string; subject: string; snippet: string; received_at: string; summary?: string };
type Reply = {
  id: string;
  going: boolean;
  to: string[];
  subject: string;
  html: string;
  text: string;
  at: string; // when the email it answers arrived, else when it was drafted
  sendAt?: string;
  actionId?: string | null;
  source: Source | null;
  raw: any;
};
type Head = { head: true; key: string; name: string };

function plain(html: string): string {
  return (html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}
function nameOf(s: string): string {
  return (s || "").replace(/<.*>/, "").replace(/"/g, "").trim();
}
function recipient(r: Reply): string {
  const to = r.to[0] || "";
  if (r.source && (r.source.sender_email || "").toLowerCase() === to.toLowerCase()) return nameOf(r.source.sender) || to;
  return to || "No recipient";
}
function later(choice: "hour" | "evening" | "morning"): string {
  const d = new Date();
  if (choice === "hour") d.setHours(d.getHours() + 1);
  else if (choice === "evening") {
    if (d.getHours() >= 18) d.setDate(d.getDate() + 1);
    d.setHours(18, 0, 0, 0);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  return d.toISOString();
}

export default function RepliesView() {
  const { user, search, liveChanges, mail, addToast, openCompose, getViewCache, setViewCache, notifyDraftChange, draftVersion } = useApp();
  const supabase = createClient();
  const [replies, setReplies] = useState<Reply[] | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState<"day" | "person">("day");
  const [showSource, setShowSource] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const account = useRef<string | null>(null);
  const [accounts, setAccounts] = useState<Record<string, string>>({});
  // A reply to someone the user has never written to is marked New sender.
  const isNew = (r: Reply) => mail.written.size > 0 && !!r.to[0] && !mail.written.has(r.to[0].toLowerCase());
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [d, s, a] = await Promise.all([
      supabase.from("draft_emails").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
      supabase.from("scheduled_emails").select("*").eq("user_id", user.id).eq("status", "pending").eq("source", "autopilot").order("send_at", { ascending: true }),
      supabase.from("gmail_accounts").select("id, gmail_address").eq("user_id", user.id).eq("is_active", true),
    ]);
    account.current = a.data?.[0]?.id ?? null;
    setAccounts(Object.fromEntries(((a.data || []) as any[]).map((x) => [x.id, x.gmail_address])));

    const drafts = (d.data || []) as any[];
    const sched = (s.data || []) as any[];
    const ids = [...new Set([...drafts, ...sched].map((x) => x.email_id).filter(Boolean))];
    const sources = new Map<string, Source>();
    if (ids.length) {
      const [e, p] = await Promise.all([
        supabase.from("emails").select("id, gmail_id, thread_id, gmail_account_id, sender, sender_email, subject, snippet, received_at").in("id", ids),
        supabase.from("email_processed").select("email_id, summary").in("email_id", ids),
      ]);
      const summary = new Map(((p.data || []) as any[]).map((x) => [x.email_id, x.summary]));
      for (const x of (e.data || []) as any[]) sources.set(x.id, { ...x, summary: summary.get(x.id) });
    }
    const out: Reply[] = [
      ...sched.map((x) => ({ id: x.id, going: true, to: x.to_addresses || [], subject: x.subject || "", html: x.body_html || "", text: plain(x.body_html || x.body_text || ""), at: x.created_at, sendAt: x.send_at, actionId: x.action_id, source: sources.get(x.email_id) || null, raw: x })),
      ...drafts.map((x) => {
        const src = sources.get(x.email_id) || null;
        return { id: x.id, going: false, to: x.to_addresses || [], subject: x.subject || "", html: x.body_html || "", text: plain(x.body_html || ""), at: src?.received_at || x.created_at, source: src, raw: x };
      }),
    ];
    setReplies(out);
  }, [user.id]);

  useEffect(() => {
    load();
  }, [load, liveChanges.draft_emails, liveChanges.scheduled_emails, draftVersion]);

  // Arriving from the inbox with a particular reply to review.
  useEffect(() => {
    const focus = getViewCache("replies:focus");
    if (focus && replies?.some((r) => r.id === focus)) {
      setCursorId(focus);
      setViewCache("replies:focus", null);
    }
  }, [replies]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (replies || []).filter((r) => !q || `${recipient(r)} ${r.to.join(" ")} ${r.subject} ${r.text}`.toLowerCase().includes(q));
  }, [replies, search]);

  const items = useMemo(() => {
    const out: (Head | Reply)[] = [];
    const going = shown.filter((r) => r.going);
    const ready = shown.filter((r) => !r.going).sort((a, b) => b.at.localeCompare(a.at));
    if (going.length) out.push({ head: true, key: "going", name: "Going out" }, ...going);
    if (group === "person") {
      const by = new Map<string, Reply[]>();
      for (const r of ready) by.set(recipient(r), [...(by.get(recipient(r)) || []), r]);
      for (const [name, list] of by) out.push({ head: true, key: `p:${name}`, name }, ...list);
    } else {
      let run: Reply[] = [];
      let day = { head: "", key: "" };
      const flush = () => run.length && out.push({ head: true, key: `d:${day.key}`, name: day.head }, ...run);
      for (const r of ready) {
        const d = dayLabel(r.at);
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
  }, [shown, group]);

  const rows = useMemo(() => items.filter((i): i is Reply => !("head" in i)), [items]);
  const cursor = rows.find((r) => r.id === cursorId) || rows[0] || null;
  const ready = rows.filter((r) => !r.going);
  const selected = ready.filter((r) => picked.has(r.id));

  useEffect(() => {
    setShowSource(false);
    setLaterOpen(false);
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor?.id]);

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorId(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].id);
  };

  const pick = (r: Reply, range = false) => {
    if (r.going) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && anchor.current) {
        const a = ready.findIndex((x) => x.id === anchor.current);
        const b = ready.indexOf(r);
        if (a >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ready[i].id);
      } else if (next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });
    anchor.current = r.id;
  };

  // Sending goes through the outbox with a short window, so a slip can be
  // taken back; the draft is restored if it is.
  const send = async (list: Reply[], at?: string) => {
    list = list.filter((r) => !r.going);
    if (!list.length || sending) return;
    const bad = list.find((r) => !r.to.length);
    if (bad) return addToast("error", `"${bad.subject || "A reply"}" has no recipient. Open it with Edit to add one.`);
    setSending(true);
    const sendAt = at || new Date(Date.now() + 15_000).toISOString();
    const queued: string[] = [];
    try {
      for (const r of list) {
        const gmailAccount = r.source?.gmail_account_id || account.current;
        if (!gmailAccount) throw new Error("No Gmail account is connected");
        const { data, error } = await supabase
          .from("scheduled_emails")
          .insert({ user_id: user.id, gmail_account_id: gmailAccount, to_addresses: r.to, subject: r.subject, body_html: r.html, in_reply_to: r.source?.gmail_id, thread_id: r.source?.thread_id, send_at: sendAt, email_id: r.source?.id })
          .select("id")
          .single();
        if (error || !data?.id) throw new Error(error?.message || "Could not queue the reply");
        queued.push(data.id);
        await supabase.from("draft_emails").delete().eq("id", r.id);
      }
    } catch (e) {
      addToast("error", `${(e as Error).message}. ${queued.length ? `${queued.length} queued, the rest are still drafts.` : "Nothing was sent."}`);
    }
    const done = list.slice(0, queued.length);
    setSending(false);
    setPicked(new Set());
    if (cursor && done.includes(cursor)) {
      const rest = rows.filter((r) => !done.includes(r));
      setCursorId((rest[rows.indexOf(cursor) - done.filter((d) => rows.indexOf(d) < rows.indexOf(cursor)).length] || rest[rest.length - 1])?.id ?? null);
    }
    notifyDraftChange();
    mail.reload();
    await load();
    if (!done.length) return;
    const undo = async () => {
      const { data } = await supabase.from("scheduled_emails").update({ status: "cancelled" }).in("id", queued).eq("status", "pending").select("id");
      const stopped = new Set(((data || []) as any[]).map((x) => x.id));
      const back = done.filter((_, i) => stopped.has(queued[i]));
      for (const r of back) await supabase.from("draft_emails").insert({ user_id: user.id, to_addresses: r.to, subject: r.subject, body_html: r.html, email_id: r.raw.email_id, source: r.raw.source });
      notifyDraftChange();
      mail.reload();
      await load();
      addToast(back.length ? "success" : "info", back.length === done.length ? "Not sent. Back in Replies." : back.length ? `${back.length} stopped, the rest had already gone.` : "Too late, already sent.");
    };
    const who = done.length === 1 ? `to ${recipient(done[0])}` : `${done.length} replies`;
    if (at) addToast("success", `Scheduled ${who} for ${new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`, { action: { label: "Undo", onClick: undo } });
    else addToast("info", `Sending ${who} in 15 seconds`, { duration: 15_000, action: { label: "Undo", onClick: undo } });
  };

  const discard = async (list: Reply[]) => {
    list = list.filter((r) => !r.going);
    if (!list.length) return;
    await supabase.from("draft_emails").delete().in("id", list.map((r) => r.id));
    setPicked(new Set());
    notifyDraftChange();
    mail.reload();
    await load();
    const undo = async () => {
      for (const r of list) await supabase.from("draft_emails").insert({ user_id: user.id, to_addresses: r.to, subject: r.subject, body_html: r.html, email_id: r.raw.email_id, source: r.raw.source });
      notifyDraftChange();
      mail.reload();
      await load();
    };
    addToast("info", list.length === 1 ? "Draft discarded" : `${list.length} drafts discarded`, { action: { label: "Undo", onClick: undo } });
  };

  const edit = (r: Reply) => {
    if (r.going) return;
    openCompose(r.source ? { ...r.source, id: r.source.id } : undefined, r.raw);
  };

  const cancel = (r: Reply) => {
    if (r.actionId) mail.undo(r.actionId).then(() => (addToast("success", "Reply cancelled. It is kept as a draft."), load())).catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("[data-compose-modal]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        return void send(selected.length ? selected : cursor ? [cursor] : []);
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "x" && cursor) pick(cursor, e.shiftKey);
      else if (k === "e" && cursor) edit(cursor);
      else if (e.key === "Backspace" && (selected.length || cursor)) discard(selected.length ? selected : [cursor!]);
      else if (e.key === "Escape" && picked.size) setPicked(new Set());
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const position = cursor && !cursor.going ? `${ready.indexOf(cursor) + 1} of ${ready.length}` : "";

  return (
    <>
      {selected.length ? (
        <header className="bar">
          <b className="bar-title mr-1.5">{selected.length} selected</b>
          <button className="btn btn-pri" disabled={sending} onClick={() => send(selected)}>
            Send {selected.length}
          </button>
          <button className="btn" onClick={() => send(selected, later("morning"))}>
            Send tomorrow 9:00
          </button>
          <button className="btn" onClick={() => discard(selected)}>
            Discard
          </button>
          <button className="btn btn-plain" onClick={() => setPicked(new Set())}>
            Clear
          </button>
          <span className="flex-1" />
          <SearchBox placeholder="Search replies" />
          <Menu
            label="Group"
            value={group}
            onChange={setGroup}
            options={[
              { id: "day", label: "Day" },
              { id: "person", label: "Person" },
            ]}
          />
        </header>
      ) : (
        <ViewBar
          title="Replies"
          search="Search replies"
          right={
            <Menu
              label="Group"
              value={group}
              onChange={setGroup}
              options={[
                { id: "day", label: "Day" },
                { id: "person", label: "Person" },
              ]}
            />
          }
        />
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={listRef} className={`w-full flex-none overflow-y-auto border-line md:w-[440px] md:border-r ${cursorId && cursor ? "hidden md:block" : ""}`} role="listbox" aria-label="Replies">
          {replies === null ? (
            <div className="pt-9">
              <SkeletonRows count={9} tall />
            </div>
          ) : !rows.length ? (
            <Empty icon="reply" title={search ? "Nothing matches that search" : "No replies waiting"} />
          ) : (
            items.map((item) =>
              "head" in item ? (
                <div key={item.key} className="day">
                  <b>{item.name}</b>
                  <span className="flex-1" />
                </div>
              ) : (
                <div key={item.id} role="option" aria-selected={cursor === item} className={`row2 grid grid-cols-[26px_minmax(0,1fr)_auto] gap-y-[3px] ${picked.has(item.id) && cursor !== item ? "bg-hover" : ""}`} onClick={(e) => (e.shiftKey ? pick(item, true) : setCursorId(item.id))} onDoubleClick={() => edit(item)}>
                  <span className="row-span-2 grid place-items-start justify-center pt-px">{item.going ? <Glyph state="going" /> : <Tick checked={picked.has(item.id)} onChange={(_, e) => pick(item, e.shiftKey)} label={`Select reply to ${recipient(item)}`} />}</span>
                  <div className="flex min-w-0 items-baseline gap-2">
                    <b className="flex-none font-semibold">{recipient(item)}</b>
                    <span className="truncate text-ink2">{item.subject.replace(/^re:\s*/i, "") || "(no subject)"}</span>
                  </div>
                  {item.going && item.sendAt ? (
                    <span className="pl-2.5 text-xs font-semibold text-wax-ink">
                      in <Countdown until={item.sendAt} />
                    </span>
                  ) : (
                    <time className="pl-2.5 text-xs text-ink3">{shortWhen(item.at)}</time>
                  )}
                  <div className="col-span-2 flex min-w-0 gap-2.5 text-ink3">
                    <span className="min-w-0 flex-1 truncate">{item.text.replace(/\s+/g, " ") || "Empty draft"}</span>
                    {item.going ? (
                      <button className="link" onClick={(e) => (e.stopPropagation(), cancel(item))}>
                        Cancel
                      </button>
                    ) : !item.to.length ? (
                      <em className="flex-none text-xs font-medium not-italic text-warn">No recipient</em>
                    ) : isNew(item) ? (
                      <em className="flex-none text-xs font-medium not-italic text-warn">New sender</em>
                    ) : null}
                  </div>
                </div>
              ),
            )
          )}
        </div>
        {cursor ? (
          <div className={`min-w-0 flex-1 flex-col ${cursorId ? "flex" : "hidden md:flex"}`}>
            <button className="btn btn-plain mx-4 mt-2 self-start md:hidden" onClick={() => setCursorId(null)}>
              <Icon name="arrow_back" size={14} /> All replies
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-[22px] md:px-10">
              <div className="max-w-[580px]">
                <dl className="grid grid-cols-[58px_1fr] gap-y-[5px] border-b border-line-soft pb-4 text-[12.5px] text-ink2">
                  <dt className="text-ink3">To</dt>
                  <dd>
                    <b className="font-medium text-ink">{recipient(cursor)}</b> {cursor.to.join(", ") !== recipient(cursor) && cursor.to.join(", ")}
                  </dd>
                  <dt className="text-ink3">Subject</dt>
                  <dd>{cursor.subject || "(no subject)"}</dd>
                  {(accounts[cursor.source?.gmail_account_id || ""] || Object.values(accounts)[0]) && (
                    <>
                      <dt className="text-ink3">From</dt>
                      <dd>{accounts[cursor.source?.gmail_account_id || ""] || Object.values(accounts)[0]}</dd>
                    </>
                  )}
                </dl>
                {cursor.source && (
                  <div className="inset mb-5 mt-4">
                    <div className="mb-1 flex justify-between text-xs text-ink3">
                      <b className="font-semibold text-ink2">
                        {nameOf(cursor.source.sender) || cursor.source.sender_email} wrote, {dayLabel(cursor.source.received_at).name.toLowerCase()} {shortWhen(cursor.source.received_at)}
                      </b>
                      <button className="link" onClick={() => setShowSource(!showSource)}>
                        {showSource ? "Show summary" : "Show the email"}
                      </button>
                    </div>
                    <p className="leading-normal text-ink2">{showSource ? cursor.source.snippet : cursor.source.summary || cursor.source.snippet}</p>
                  </div>
                )}
                <div
                  className="mt-4 text-sm leading-[1.6] tracking-[-0.006em] [&_a]:underline [&_p]:mb-3"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(cursor.html || "<p>This draft is empty.</p>", { FORBID_TAGS: ["style", "img"], FORBID_ATTR: ["style"] }) }}
                />
              </div>
            </div>
            <div className="flex flex-none items-center gap-2 border-t border-line py-[11px] pl-6 pr-4 md:pl-10">
              {cursor.going ? (
                <>
                  <button className="btn" onClick={() => cancel(cursor)}>
                    Cancel this reply
                  </button>
                  {cursor.sendAt && (
                    <small className="ml-1.5 whitespace-nowrap text-xs font-medium text-wax-ink">
                      Sends in <Countdown until={cursor.sendAt} />
                    </small>
                  )}
                </>
              ) : (
                <>
                  <button className="btn btn-pri" disabled={sending} onClick={() => send([cursor])}>
                    Send
                  </button>
                  <div className="relative">
                    <button className="btn" aria-haspopup="menu" aria-expanded={laterOpen} onClick={() => setLaterOpen(!laterOpen)}>
                      Send later <Icon name="expand_more" size={13} className="text-ink3" />
                    </button>
                    {laterOpen && (
                      <div className="pop absolute bottom-9 left-0 min-w-[170px]" role="menu">
                        {(
                          [
                            ["hour", "In one hour"],
                            ["evening", "This evening, 18:00"],
                            ["morning", "Tomorrow, 9:00"],
                          ] as const
                        ).map(([id, label]) => (
                          <button key={id} className="pop-item" role="menuitem" onClick={() => (setLaterOpen(false), send([cursor], later(id)))}>
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button className="btn" onClick={() => edit(cursor)}>
                    Edit
                  </button>
                  <small className="ml-1.5 hidden whitespace-nowrap text-xs text-ink3 xl:block">{cursor.source ? `To ${recipient(cursor).split(" ")[0]} only, same thread` : ""}</small>
                </>
              )}
              <span className="flex-1" />
              <span className="flex items-center gap-0.5 whitespace-nowrap text-xs text-ink3">
                {position}
                <button className="iconbtn" aria-label="Previous reply" onClick={() => move(-1)}>
                  <Icon name="expand_less" size={16} />
                </button>
                <button className="iconbtn" aria-label="Next reply" onClick={() => move(1)}>
                  <Icon name="expand_more" size={16} />
                </button>
              </span>
              {!cursor.going && (
                <button className="btn btn-plain" onClick={() => discard([cursor])}>
                  Discard
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="hidden flex-1 md:block" />
        )}
      </div>
    </>
  );
}
