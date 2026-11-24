import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import DateTimePicker from "../DateTimePicker";
import { Countdown, Empty, Glyph, Seg, SkeletonRows, ViewBar, clock } from "../ui";

// Scheduled: mail the user queued to send later. Each one can be read, sent
// now, moved to another time, edited in the compose window or cancelled.
// Replies Autopilot is about to send are not here; they are in Replies.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Scheduled = {
  id: string;
  to_addresses: string[] | null;
  cc_addresses: string[] | null;
  subject: string;
  body_html: string;
  body_text: string | null;
  send_at: string;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  error_message: string | null;
  [key: string]: any;
};
type Head = { head: true; key: string; name: string };
type Filter = "queued" | "history";

const HOUR = 3_600_000;

function plain(html: string): string {
  return (html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
function recipient(s: Scheduled): string {
  const to = s.to_addresses || [];
  if (!to.length) return "No recipient";
  return to.length === 1 ? to[0] : `${to[0]} and ${to.length - 1} more`;
}
// The day an email goes out: Today, Tomorrow, else the weekday and date.
function sendDay(iso: string): { key: string; name: string; date: string; near: boolean; head: string } {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  const date = d.toLocaleDateString([], { day: "numeric", month: "long" });
  const weekday = d.toLocaleDateString([], { weekday: "long" });
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (days >= -1 && days <= 1) return { key, name: ["Yesterday", "Today", "Tomorrow"][days + 1], date: `${weekday} ${date}`, near: true, head: ["Yesterday", "Today", "Tomorrow"][days + 1] };
  return { key, name: weekday, date, near: false, head: `${weekday} ${date}` };
}
// "tomorrow at 9:00", "Thursday 27 November at 9:00"
function sendsAt(iso: string): string {
  const day = sendDay(iso);
  return `${day.near ? day.name.toLowerCase() : `${day.name} ${day.date}`} at ${clock(iso)}`;
}
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ScheduledView() {
  const { user, liveChanges, openCompose, addToast, search, mail } = useApp();
  const supabase = createClient();
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("queued");
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [open, setOpen] = useState(false); // narrow windows: the list or the email, one at a time
  const [timeOpen, setTimeOpen] = useState(false);
  const [newTime, setNewTime] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Everything still to go out or that failed, and the last hundred already
  // sent or cancelled.
  const loadScheduled = useCallback(async () => {
    try {
      const [queue, past] = await Promise.all([
        supabase.from("scheduled_emails").select("*").eq("user_id", user.id).neq("source", "autopilot").in("status", ["pending", "sending", "failed"]).order("send_at", { ascending: true }),
        supabase.from("scheduled_emails").select("*").eq("user_id", user.id).neq("source", "autopilot").in("status", ["sent", "cancelled"]).order("send_at", { ascending: false }).limit(100),
      ]);
      if (queue.error || past.error) throw queue.error || past.error;
      setScheduled([...((queue.data || []) as Scheduled[]), ...((past.data || []) as Scheduled[])]);
      setError(null);
    } catch {
      setError("Could not load your scheduled mail.");
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    loadScheduled();
  }, [loadScheduled, liveChanges.scheduled_emails]);


  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const shown = q ? scheduled.filter((s) => `${(s.to_addresses || []).join(" ")} ${s.subject} ${plain(s.body_html)}`.toLowerCase().includes(q)) : scheduled;
    const out: (Head | Scheduled)[] = [];
    const add = (key: string, name: string, list: Scheduled[]) => list.length && out.push({ head: true, key, name }, ...list);
    if (filter === "history") {
      add("sent", "Sent", shown.filter((s) => s.status === "sent"));
      add("cancelled", "Cancelled", shown.filter((s) => s.status === "cancelled"));
      return out;
    }
    add("failed", "Could not send", shown.filter((s) => s.status === "failed"));
    let run: Scheduled[] = [];
    let day = { key: "", head: "" };
    for (const s of shown.filter((x) => x.status === "pending" || x.status === "sending")) {
      const d = sendDay(s.send_at);
      if (d.key !== day.key) {
        add(`d:${day.key}`, day.head, run);
        run = [];
        day = d;
      }
      run.push(s);
    }
    add(`d:${day.key}`, day.head, run);
    return out;
  }, [scheduled, filter, search]);

  const rows = useMemo(() => items.filter((i): i is Scheduled => !("head" in i)), [items]);
  const cursor = rows.find((s) => s.id === cursorId) || rows[0] || null;
  const waiting = cursor?.status === "pending";
  const failed = cursor?.status === "failed";

  useEffect(() => {
    setTimeOpen(false);
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor?.id]);

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorId(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].id);
  };

  const edit = (s: Scheduled) => {
    if (s.status === "pending" || s.status === "failed") openCompose(undefined, { _scheduledId: s.id, ...s });
  };

  // Writes a change to one queued email, but only while it has not gone out.
  const change = async (s: Scheduled, values: Partial<Scheduled>): Promise<boolean> => {
    const { data, error: failedWrite } = await supabase.from("scheduled_emails").update(values).eq("id", s.id).in("status", ["pending", "failed", "cancelled"]).select("id");
    mail.reload();
    await loadScheduled();
    if (failedWrite) addToast("error", "Could not change that email. Nothing was changed.");
    return !failedWrite && !!data?.length;
  };

  const cancel = async (s: Scheduled) => {
    if (!(await change(s, { status: "cancelled" }))) return;
    const undo = async () => {
      const back = await change(s, { status: s.status, send_at: s.send_at });
      if (back) addToast("success", s.status === "pending" ? `Back in the queue for ${sendsAt(s.send_at)}` : "Restored");
    };
    addToast("info", "Cancelled. It will not be sent.", { action: { label: "Undo", onClick: undo } });
  };

  // Sending now goes through the outbox with a short window, so a slip can be
  // taken back; the email returns to its old time if it is.
  const sendNow = async (s: Scheduled) => {
    if (!(s.to_addresses || []).length) return addToast("error", "This email has no recipient. Open it with Edit to add one.");
    if (!(await change(s, { status: "pending", send_at: new Date(Date.now() + 15_000).toISOString(), error_message: null }))) return;
    const undo = async () => {
      const { data } = await supabase.from("scheduled_emails").update({ status: s.status, send_at: s.send_at, error_message: s.error_message }).eq("id", s.id).eq("status", "pending").select("id");
      mail.reload();
      await loadScheduled();
      addToast(data?.length ? "success" : "info", data?.length ? "Not sent. It is back where it was." : "Too late, already sent.");
    };
    addToast("info", `Sending to ${recipient(s)} in 15 seconds`, { duration: 15_000, action: { label: "Undo", onClick: undo } });
  };

  const reschedule = async (s: Scheduled) => {
    const at = new Date(newTime);
    if (isNaN(at.getTime())) return;
    setTimeOpen(false);
    if (await change(s, { status: "pending", send_at: at.toISOString(), error_message: null })) addToast("success", `Now sends ${sendsAt(at.toISOString())}`, { action: { label: "Undo", onClick: () => change(s, { status: s.status, send_at: s.send_at, error_message: s.error_message }) } });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[data-compose-modal]")) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if ((k === "e" || e.key === "Enter") && cursor) edit(cursor);
      else if (e.key === "Backspace" && cursor && (waiting || failed)) cancel(cursor);
      else if (e.key === "Escape" && timeOpen) setTimeOpen(false);
      else if (e.key === "Escape" && open) setOpen(false);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // The start of a row's second line: when it sends, or what became of it.
  // The last hour before sending counts down in wax red.
  const when = (s: Scheduled) => {
    if (s.status === "failed") return <span className="flex-none font-medium text-danger">Could not send</span>;
    if (s.status === "sending") return <span className="flex-none font-medium text-wax-ink">Sending now</span>;
    if (s.status === "sent") return <span className="flex-none">Sent {sendsAt(s.send_at)}</span>;
    if (s.status === "cancelled") return <span className="flex-none">Cancelled, was due {sendsAt(s.send_at)}</span>;
    if (new Date(s.send_at).getTime() - Date.now() < HOUR)
      return (
        <span className="flex-none font-semibold text-wax-ink">
          Sends in <Countdown until={s.send_at} />
        </span>
      );
    return <span className="flex-none text-ink2">Sends {sendsAt(s.send_at)}</span>;
  };

  return (
    <>
      <ViewBar title="Scheduled" search="Search scheduled mail">
        <Seg
          value={filter}
          onChange={(f) => (setFilter(f), setOpen(false))}
          options={[
            { id: "queued", label: "Queued" },
            { id: "history", label: "History" },
          ]}
        />
      </ViewBar>
      <div className="flex min-h-0 flex-1">
        <div ref={listRef} className={`w-full flex-none overflow-y-auto border-line md:w-[440px] md:border-r ${open ? "hidden md:block" : ""}`} role="listbox" aria-label="Scheduled mail">
          {loading ? (
            <div className="pt-9">
              <SkeletonRows count={6} tall />
            </div>
          ) : error ? (
            <p className="px-5 py-4 text-danger" role="alert">
              {error} Check that Tabellar is still running, then{" "}
              <button className="link !text-danger" onClick={() => loadScheduled()}>
                try again
              </button>
              .
            </p>
          ) : !rows.length ? (
            search ? (
              <Empty icon="search" title="Nothing matches that search" />
            ) : filter === "queued" ? (
              <Empty icon="schedule" title="Nothing scheduled" />
            ) : (
              <Empty icon="schedule" title="Nothing sent or cancelled yet" />
            )
          ) : (
            items.map((item) =>
              "head" in item ? (
                <div key={item.key} className="day">
                  <b>{item.name}</b>
                  <span className="flex-1" />
                </div>
              ) : (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={cursor === item}
                  className="row2 grid scroll-mt-head grid-cols-[26px_minmax(0,1fr)] gap-y-[3px]"
                  onClick={() => (setCursorId(item.id), setOpen(true))}
                  onDoubleClick={() => edit(item)}
                >
                  <span className="row-span-2 grid place-items-start justify-center pt-px">
                    <Glyph state={item.status === "failed" ? "failed" : item.status === "sent" ? "done" : item.status === "cancelled" ? "filed" : "going"} />
                  </span>
                  <div className="flex min-w-0 items-baseline gap-2">
                    <b className={`max-w-[55%] flex-none truncate ${item.status === "pending" || item.status === "sending" || item.status === "failed" ? "font-semibold text-ink" : "font-normal text-ink2"}`}>{recipient(item)}</b>
                    <span className="truncate text-ink2">{item.subject || "(no subject)"}</span>
                  </div>
                  <div className="flex min-w-0 gap-2.5 text-ink3">
                    {when(item)}
                    <span className="min-w-0 flex-1 truncate">{item.status === "failed" ? item.error_message : plain(item.body_html || item.body_text || "") || "Empty email"}</span>
                  </div>
                </div>
              ),
            )
          )}
        </div>
        {cursor ? (
          <div className={`min-w-0 flex-1 flex-col ${open ? "flex" : "hidden md:flex"}`}>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-[22px] md:px-10">
              <div className="max-w-[580px]">
                <button className="btn btn-plain -ml-2 mb-3 md:hidden" onClick={() => setOpen(false)}>
                  <Icon name="arrow_back" size={15} /> Scheduled
                </button>
                <dl className="grid grid-cols-[58px_1fr] gap-y-[5px] border-b border-line-soft pb-4 text-[12.5px] text-ink2">
                  <dt className="text-ink3">To</dt>
                  <dd className="min-w-0 break-words font-medium text-ink">{(cursor.to_addresses || []).join(", ") || "No recipient"}</dd>
                  {(cursor.cc_addresses || []).length > 0 && (
                    <>
                      <dt className="text-ink3">Cc</dt>
                      <dd className="min-w-0 break-words">{(cursor.cc_addresses || []).join(", ")}</dd>
                    </>
                  )}
                  <dt className="text-ink3">Subject</dt>
                  <dd className="min-w-0 break-words">{cursor.subject || "(no subject)"}</dd>
                  <dt className="text-ink3">{cursor.status === "sent" ? "Sent" : cursor.status === "cancelled" || failed ? "Was due" : "Sends"}</dt>
                  <dd className={waiting ? "font-medium text-ink" : ""}>{capital(sendsAt(cursor.send_at))}</dd>
                </dl>
                {failed && (
                  <p className="mt-4 leading-normal text-danger" role="alert">
                    The mailbox did not send this: {cursor.error_message || "no reason was given"}. Try again, or edit it first.
                  </p>
                )}
                {cursor.body_html ? (
                  <div
                    className="mt-4 text-sm leading-[1.6] tracking-[-0.006em] [&_a]:underline [&_p]:mb-3"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(cursor.body_html, { FORBID_TAGS: ["style", "img"], FORBID_ATTR: ["style"] }) }}
                  />
                ) : (
                  <p className="mt-4 whitespace-pre-wrap text-sm leading-[1.6] tracking-[-0.006em]">{cursor.body_text || "This email is empty."}</p>
                )}
                {failed && <p className="mt-[22px] border-t border-line-soft pt-3.5 text-[12.5px] font-medium text-danger">Not sent{cursor.error_message ? `: ${cursor.error_message}` : ""}</p>}
              </div>
            </div>
            <div className="flex flex-none flex-wrap items-center gap-2 border-t border-line py-[11px] pl-6 pr-4 md:pl-10">
              {(waiting || failed) && (
                <>
                  <button className="btn" onClick={() => edit(cursor)}>
                    Edit
                  </button>
                  <div className="relative">
                    <button className="btn" aria-haspopup="dialog" aria-expanded={timeOpen} onClick={() => (setNewTime(toLocalInput(cursor.send_at)), setTimeOpen(!timeOpen))}>
                      Change time <Icon name="expand_more" size={13} className="text-ink3" />
                    </button>
                    {timeOpen && (
                      <div className="pop absolute bottom-9 left-0 w-[264px] !p-3" role="dialog" aria-label="Change the send time">
                        <label className="label mb-1.5 block">Send at</label>
                        <DateTimePicker value={newTime} onChange={setNewTime} />
                        <div className="mt-3 flex justify-end gap-2">
                          <button className="btn btn-plain" onClick={() => setTimeOpen(false)}>
                            Close
                          </button>
                          <button className="btn" disabled={!newTime || new Date(newTime) <= new Date()} onClick={() => reschedule(cursor)}>
                            Save time
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <button className="btn" onClick={() => sendNow(cursor)}>
                    {failed ? "Try again now" : "Send now"}
                  </button>
                </>
              )}
              <span className="flex-1" />
              <span className="flex items-center gap-0.5 whitespace-nowrap text-xs text-ink3">
                {rows.indexOf(cursor) + 1} of {rows.length}
                <button className="iconbtn" aria-label="Previous email" onClick={() => move(-1)}>
                  <Icon name="expand_less" size={16} />
                </button>
                <button className="iconbtn" aria-label="Next email" onClick={() => move(1)}>
                  <Icon name="expand_more" size={16} />
                </button>
              </span>
              {(waiting || failed) && (
                <button className="btn btn-plain" onClick={() => cancel(cursor)}>
                  {failed ? "Dismiss" : "Cancel sending"}
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
