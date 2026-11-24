import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";
import { useApp } from "../AppShell";
import { ReaderById } from "../EmailDetail";
import { Glyph, SkeletonRows, ViewBar, clock, shortWhen } from "../ui";

// The Brief: one page, top to bottom. What needs the user today (five lines
// at most, one action each), who they are waiting on, today's calendar, and
// how much Tabellar handled since yesterday, which opens to the list. Every
// line is something the engine stored (brief.ts), never a summary written
// for the page.

type Need = { key: string; kind: "reply" | "approve" | "meeting" | "todo" | "question"; who: string; text: string; email_id: string | null; id: string; hash?: string; start?: string; due?: string };
type Waiting = { key: string; email_id: string; thread_id: string; who: string; address: string; text: string; subject: string; sent_at: string };
type Handled = { email_id: string; who: string; subject: string; what: string; at: string };
type Brief = { needs: Need[]; more: number; waiting: Waiting[]; handled: Handled[] };
type CalEvent = { id: string; title: string; start: string; end: string; allDay: boolean; attendees: string[]; htmlLink: string | null };

const WAITING_MAX = 5;
const DAY = 86_400_000;

const ACTION: Record<Need["kind"], string> = { reply: "Review", approve: "Approve", meeting: "Add to calendar", todo: "Done", question: "Answer" };

function ago(iso: string): string {
  const n = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  return n <= 0 ? "Today" : n === 1 ? "1 day" : `${n} days`;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function when(n: Need): string {
  if (n.kind === "todo") return n.due && n.due < today() ? "Overdue" : "Today";
  if (n.kind === "meeting" && n.start) return shortWhen(n.start) === clock(n.start) ? clock(n.start) : `${new Date(n.start).toLocaleDateString([], { weekday: "short" })} ${clock(n.start)}`;
  return "";
}

export default function BriefingView() {
  const { user, mail, setView, addToast, openCompose, liveChanges } = useApp();
  const supabase = createClient();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [failed, setFailed] = useState(false);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [calError, setCalError] = useState(false);
  const [showHandled, setShowHandled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBrief((await api("/briefing")) as Brief);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, liveChanges.action_log, liveChanges.draft_emails, liveChanges.todos, liveChanges.meetings, liveChanges.questions, liveChanges.email_processed, liveChanges.follow_up_reminders]);

  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    api(`/calendar/events?date=${today()}&days=1&timezone=${encodeURIComponent(tz)}`)
      .then((r: { events?: CalEvent[]; error?: string }) => {
        setCalError(!!r.error);
        setEvents(r.events || []);
      })
      .catch(() => (setCalError(true), setEvents([])));
  }, [liveChanges.meetings]);

  const act = async (n: Need) => {
    if (n.kind === "reply") return n.email_id && setReading(n.email_id);
    if (n.kind === "question") return setView("inbox");
    setBusy(n.key);
    try {
      if (n.kind === "approve") await mail.approve(n.id, n.hash || "");
      else if (n.kind === "meeting") {
        const r = (await api("/meetings/confirm", { id: n.id })) as { link: string | null };
        addToast("success", "On your Google Calendar", r.link ? { action: { label: "Open", onClick: () => window.open(r.link!, "_blank", "noopener") } } : undefined);
      } else if (n.kind === "todo") {
        const { error } = await supabase.from("todos").update({ is_completed: true }).eq("id", n.id).eq("user_id", user.id);
        if (error) throw new Error(`That was not saved: ${error.message}`);
        addToast("info", "Done", { action: { label: "Undo", onClick: () => void supabase.from("todos").update({ is_completed: false }).eq("id", n.id).then(load) } });
      }
    } catch (e) {
      addToast("error", (e as Error).message);
    } finally {
      setBusy(null);
      load();
    }
  };

  // A follow-up in the same thread, drafted from what was asked.
  const nudge = async (w: Waiting) => {
    const { data } = await supabase.from("emails").select("gmail_id, account_id, body_text").eq("id", w.email_id).maybeSingle();
    const e = (data || {}) as { gmail_id?: string; account_id?: string; body_text?: string };
    const since = ago(w.sent_at);
    openCompose({
      sender_email: w.address,
      subject: w.subject,
      thread_id: w.thread_id,
      gmail_id: e.gmail_id,
      account_id: e.account_id,
      body_text: e.body_text || w.text,
      _autoGenerate: true,
      _prefillBody: `I sent this ${since === "Today" ? "earlier today" : `${since} ago`} and have had no answer. Write a short, friendly follow-up that asks again${w.text ? `: ${w.text}` : "."}`,
    });
  };

  if (reading) return <ReaderById emailId={reading} onClose={() => (setReading(null), load())} />;

  const head = (name: string) => (
    <div className="day !static">
      <b>{name}</b>
    </div>
  );
  const quiet = (text: string) => <p className="flex h-8 items-center pl-[46px] text-ink3">{text}</p>;
  const day = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  return (
    <>
      <ViewBar
        title={
          <span className="flex min-w-0 flex-none items-baseline gap-2">
            <h1 className="bar-title">Brief</h1>
            <span className="truncate text-xs text-ink3">{day}</span>
          </span>
        }
        search={false}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <div className="w-full max-w-[880px]">
          {failed && !brief ? (
            <p className="px-5 pt-4 text-danger" role="alert">
              The brief could not be loaded.{" "}
              <button className="link !text-danger" onClick={load}>
                Try again
              </button>
            </p>
          ) : !brief ? (
            <div className="pt-9">
              <SkeletonRows count={9} />
            </div>
          ) : (
            <>
              {head("Needs you today")}
              {!brief.needs.length && quiet("Nothing needs you")}
              {brief.needs.map((n) => (
                <div key={n.key} className={`row group ${n.email_id ? "cursor-default" : ""}`} onClick={() => n.email_id && setReading(n.email_id)} title={n.text}>
                  <span className="grid w-[26px] flex-none place-items-center">
                    <Glyph state={n.kind === "question" ? "info" : "need"} />
                  </span>
                  <span className="w-[96px] flex-none truncate pr-3 font-[650] text-ink md:w-[164px]">{n.who}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{n.text}</span>
                  <span className="w-[72px] flex-none pl-3 text-right text-xs text-ink3 max-md:hidden">{when(n)}</span>
                  <button className="link flex-none pl-3 text-right !text-wax-ink md:w-[108px]" disabled={busy === n.key} onClick={(e) => (e.stopPropagation(), act(n))}>
                    {busy === n.key ? "Working" : ACTION[n.kind]}
                  </button>
                </div>
              ))}
              {brief.more > 0 && (
                <p className="flex h-8 items-center pl-[46px]">
                  <button className="link" onClick={() => setView("inbox")}>
                    {brief.more.toLocaleString()} more in the inbox
                  </button>
                </p>
              )}

              {head("Waiting on others")}
              {!brief.waiting.length && quiet("Nobody owes you an answer")}
              {brief.waiting.slice(0, WAITING_MAX).map((w) => (
                <div key={w.key} className="row group cursor-default" onClick={() => setReading(w.email_id)} title={w.subject}>
                  <span className="w-[26px] flex-none" />
                  <span className="w-[96px] flex-none truncate pr-3 text-ink md:w-[164px]" title={w.address}>
                    {w.who}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink2">{w.text}</span>
                  <span className="w-[72px] flex-none pl-3 text-right text-xs text-ink3 max-md:hidden">{ago(w.sent_at)}</span>
                  <button className="link flex-none pl-3 text-right md:w-[108px]" onClick={(e) => (e.stopPropagation(), nudge(w))}>
                    Nudge
                  </button>
                </div>
              ))}
              {brief.waiting.length > WAITING_MAX && (
                <p className="flex h-8 items-center pl-[46px]">
                  <button className="link" onClick={() => setView("followups")}>
                    {(brief.waiting.length - WAITING_MAX).toLocaleString()} more in Follow-ups
                  </button>
                </p>
              )}

              {head("Today's calendar")}
              {events === null ? (
                <SkeletonRows count={2} />
              ) : calError ? (
                quiet("Google Calendar could not be read")
              ) : !events.length ? (
                quiet("Nothing on the calendar")
              ) : (
                events.map((ev) => {
                  const over = !ev.allDay && new Date(ev.end).getTime() < Date.now();
                  return (
                    <a key={ev.id} className="row" href={ev.htmlLink || undefined} target="_blank" rel="noopener noreferrer">
                      <span className="w-[26px] flex-none" />
                      <span className={`w-[96px] flex-none truncate pr-3 md:w-[164px] ${over ? "text-ink3" : "text-ink"}`}>{ev.allDay ? (
                          "All day"
                        ) : (
                          <>
                            {clock(ev.start)}
                            <span className="max-md:hidden"> to {clock(ev.end)}</span>
                          </>
                        )}</span>
                      <span className={`min-w-0 flex-1 truncate ${over ? "text-ink3" : "text-ink"}`}>{ev.title}</span>
                      {ev.attendees.length > 0 && <span className="min-w-0 max-w-[40%] flex-none truncate pl-3 text-ink3 max-md:hidden">{ev.attendees.join(", ")}</span>}
                    </a>
                  );
                })
              )}

              {head("Handled for you")}
              {!brief.handled.length ? (
                quiet("Nothing since yesterday")
              ) : (
                <>
                  <button className="row w-[calc(100%-16px)] text-left" aria-expanded={showHandled} onClick={() => setShowHandled(!showHandled)}>
                    <span className="grid w-[26px] flex-none place-items-center">
                      <Glyph state="done" />
                    </span>
                    <span className="flex-1 text-ink">
                      {brief.handled.length.toLocaleString()} email{brief.handled.length === 1 ? "" : "s"} since yesterday
                    </span>
                    <span className="text-xs text-ink3">{showHandled ? "Hide" : "Show"}</span>
                  </button>
                  {showHandled &&
                    brief.handled.map((h) => (
                      <div key={h.email_id} className="row cursor-default" onClick={() => setReading(h.email_id)} title={h.subject}>
                        <span className="w-[26px] flex-none" />
                        <span className="w-[96px] flex-none truncate pr-3 md:w-[164px]">{h.who}</span>
                        <span className="min-w-0 flex-1 truncate">{h.subject}</span>
                        <span className="w-[172px] flex-none truncate pl-3 text-[12.5px] text-ink3 max-md:hidden">{h.what}</span>
                        <time className="w-[46px] flex-none text-right text-xs text-ink3">{shortWhen(h.at)}</time>
                      </div>
                    ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
