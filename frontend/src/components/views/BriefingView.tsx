import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Icon from "@/components/Icon";
import { Mark } from "@/components/Logo";
import { api } from "@/lib/outcomes";
import { isTypingTarget } from "@/lib/shortcuts";
import { blocksOf, choicesOf } from "../../../../server/choices.ts";
import { useApp } from "../AppShell";
import { confirmLevel } from "../Sidebar";
import { ReaderById } from "../EmailDetail";
import { MeetingPrep, useUpNext } from "../Prep";
import { SkeletonRows, clock, initials, shortWhen } from "../ui";

// The Brief: where the window opens. What needs the user today, each line with
// its answers (server/answers.ts), so nothing has to be opened to deal with it;
// who they are waiting on, the same way; and today's calendar beside them.
// The day's paragraph sits at the top beside the date. The line the
// cursor is on shows what its answers stand on: the reply as it would go out,
// the sentence a meeting came from. Settings, Brief chooses the sections.

type Answer = { pick: string; label: string; sends?: string };
type Answerable = { key: string; who: string; text: string; email_id: string | null; to: string; shows: string; options: Answer[] };
type Need = Answerable & { kind: "reply" | "forward" | "approve" | "meeting" | "todo" | "question" | "back" | "read" | "proof"; id: string; start?: string; due?: string };
type Waiting = Answerable & { kind: "wait"; address: string; subject: string; sent_at: string };
type Line = Need | Waiting;
type Handled = { email_id: string; who: string; subject: string; what: string; at: string };
type Digest = { id: string; title: string; at: string; items: { email_id: string; who: string; text: string; at: string }[] };
type Brief = {
  digests: Digest[];
  changes: { id: string; text: string; email_id: string | null; at: string }[];
  settings: { sections: string[]; summary: boolean };
  away: string | null;
  summary: string | null;
  needs: Need[];
  more: number;
  proof: Need | null;
  waiting: Waiting[];
  waitingMore: number;
  handled: Handled[];
};
type CalEvent = { id: string; title: string; start: string; end: string; allDay: boolean; attendees: string[]; people?: string[]; htmlLink: string | null };

const DAY = 86_400_000;
const LAND_MS = 300;

function ago(iso: string): string {
  const n = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  return n <= 0 ? "Today" : n === 1 ? "1 day" : `${n} days`;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function when(n: Line): string {
  if (n.kind === "wait") return ago(n.sent_at);
  if (n.kind === "todo") return n.due && n.due < today() ? "Overdue" : "Today";
  if (n.kind === "meeting" && n.start) return shortWhen(n.start) === clock(n.start) ? clock(n.start) : `${new Date(n.start).toLocaleDateString([], { weekday: "short" })} ${clock(n.start)}`;
  return "";
}

// What a line is, apart from what it says: "Todo to approve: Send the form".
function lead(n: Line): [string, string] {
  const m = /^((?:Reply|Forward|Todo|Meeting|Follow-up|Label) (?:to approve|drafted|to send|to confirm)): (.+)$/.exec(n.text);
  return m ? [m[1], m[2]] : ["", n.text];
}

// Who a line is from, as two letters; a question is asked by Tabellar.
function Monogram({ who, asks }: { who: string; asks: boolean }) {
  return (
    <span aria-hidden className="grid h-9 w-9 flex-none place-items-center rounded-full bg-sel text-[12.5px] font-semibold tracking-[0.01em] text-ink2">
      {asks || who === "Tabellar" ? <Mark size={18} /> : initials(who)}
    </span>
  );
}

// What a line's answers stand on: a draft as it would go out, with the answers
// it leaves open in their place, or a few lines about the rest.
function Shows({ line, onAnswer }: { line: Line; onAnswer: (a: Answer) => void }) {
  if (!line.shows) return null;
  const draft = line.options.some((o) => o.sends !== undefined) || line.kind === "reply" || line.kind === "forward";
  if (!draft)
    return (
      <p className="whitespace-pre-line break-words" data-shows>
        {line.shows}
      </p>
    );
  let open = 0;
  return (
    <div className="grid gap-2.5 text-ink" data-shows>
      {line.to && <p className="truncate text-xs text-ink3">To {line.to}</p>}
      {blocksOf(line.shows).map((b, i) => {
        if ("text" in b || b.choice.length < 2)
          return (
            <p key={i} className="whitespace-pre-line break-words">
              {"text" in b ? b.text : b.choice[0].text}
            </p>
          );
        // Only the first decision is answered from here; the next one follows it.
        const first = open++ === 0;
        return (
          <div key={i} className="-mx-2 grid gap-0.5">
            {b.choice.map((c) => {
              const a = first ? line.options.find((o) => o.label === c.label && o.sends !== undefined) : undefined;
              const words = (
                <>
                  <span className={`break-words font-medium ${a ? "text-wax-ink" : "text-ink3"}`}>{c.label}</span>
                  <span className="break-words text-ink2">{c.text}</span>
                </>
              );
              const grid = "grid grid-cols-[84px_minmax(0,1fr)] items-baseline gap-x-2 rounded-md px-2 py-1 text-left";
              return a ? (
                <button key={c.label} type="button" className={`${grid} transition-colors duration-150 hover:bg-hover`} onClick={() => onAnswer(a)}>
                  {words}
                </button>
              ) : (
                <div key={c.label} className={grid}>
                  {words}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export default function BriefingView() {
  const { mail, profile, setView, setSidebarOpen, setViewCache, updateProfile, addToast, notifyDraftChange, liveChanges } = useApp();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [failed, setFailed] = useState(false);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [calError, setCalError] = useState(false);
  const [shownDigest, setShownDigest] = useState<string | null>(null);
  // Every line, past the Brief's length.
  const [all, setAll] = useState(false);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  // Lines just answered, until the server's list says the same.
  const [gone, setGone] = useState<Set<string>>(new Set());
  const busy = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  const [reading, setReading] = useState<string | null>(null);
  const upNext = useUpNext(events);
  const [writing, setWriting] = useState(false);
  const asked = useRef(false);

  const load = useCallback(async () => {
    try {
      const b = (await api(`/briefing${all ? "?all=1" : ""}`)) as Brief;
      setBrief({ ...b, waiting: b.waiting.map((w) => ({ ...w, kind: "wait" })) });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [all]);

  useEffect(() => {
    load();
  }, [load, liveChanges.action_log, liveChanges.draft_emails, liveChanges.todos, liveChanges.meetings, liveChanges.questions, liveChanges.email_processed, liveChanges.follow_up_reminders, liveChanges.emails, liveChanges.preferences, liveChanges.automations, liveChanges.scheduled_emails]);

  // Today's opening paragraph, when it is on and not written yet, or when a
  // line it was written from is dealt with.
  useEffect(() => {
    if (!brief?.settings.summary || brief.summary !== null || asked.current) return;
    asked.current = true;
    setWriting(true);
    (api("/briefing/summary", {}) as Promise<{ summary: string | null }>)
      .then((r) => setBrief((b) => b && { ...b, summary: r.summary ?? "" }))
      .catch(() => setBrief((b) => b && { ...b, summary: "" }))
      .finally(() => {
        asked.current = false;
        setWriting(false);
      });
  }, [brief]);

  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    api(`/calendar/events?date=${today()}&days=1&timezone=${encodeURIComponent(tz)}`)
      .then((r: { events?: CalEvent[]; error?: string }) => {
        setCalError(!!r.error);
        setEvents(r.events || []);
      })
      .catch(() => (setCalError(true), setEvents([])));
  }, [liveChanges.meetings]);

  const show = (section: string) => !!brief?.settings.sections.includes(section);
  const needs = useMemo(() => (brief && show("needs") ? [...brief.needs, ...(brief.proof ? [brief.proof] : [])].filter((n) => !gone.has(n.key)) : []), [brief, gone]);
  const waiting = useMemo(() => (brief && show("waiting") ? brief.waiting.filter((w) => !gone.has(w.key)) : []), [brief, gone]);
  const lines: Line[] = [...needs, ...waiting];
  const cursor = lines.find((l) => l.key === cursorKey) ?? lines[0] ?? null;
  const move = (delta: number) => lines.length && setCursorKey(lines[Math.min(lines.length - 1, Math.max(0, (cursor ? lines.indexOf(cursor) : 0) + delta))].key);

  // The cursor holds to its line when others come in above it. A number pressed
  // as it lands on another one was meant for the one before.
  const landed = useRef(0);
  useEffect(() => {
    landed.current = Date.now();
    if (cursor && cursor.key !== cursorKey) setCursorKey(cursor.key);
  }, [cursor?.key]);
  useEffect(() => {
    if (cursorKey) listRef.current?.querySelector('[aria-selected="true"]')?.closest("[data-line]")?.scrollIntoView({ block: "nearest" });
  }, [cursorKey]);

  const refresh = useCallback(async () => {
    notifyDraftChange();
    mail.reload();
    mail.refreshEngine();
    await load();
  }, [load, notifyDraftChange, mail.reload, mail.refreshEngine]);

  const answer = async (line: Line, a: Answer) => {
    // The one answer that lets Tabellar send mail by itself.
    if (line.kind === "proof" && a === line.options[0] && !confirmLevel("autopilot")) return;
    if (busy.current.has(line.key)) return;
    busy.current.add(line.key);
    // One of two decisions: the line stays, and the next one is asked on it.
    const stays = !!a.sends && choicesOf(a.sends).length > 0;
    const at = lines.indexOf(line);
    let next: string | null = null;
    if (!stays) {
      setGone((g) => new Set(g).add(line.key));
      setCursorKey((lines[at + 1] ?? lines[at - 1])?.key ?? null);
    }
    try {
      const done = (await api("/briefing/answer", { key: line.key, pick: a.pick })) as { said: string; undo: string | null; ms: number | null; link: string | null; next: string | null };
      next = done.next;
      const undo = async () => {
        let back = false;
        try {
          const u = (await api("/briefing/undo", { id: done.undo })) as { said?: string };
          back = true;
          addToast("info", u.said ?? `Undone: ${done.said}`);
        } catch (e) {
          addToast("error", (e as Error).message);
        } finally {
          if (line.kind === "proof") updateProfile({ autonomy_level: profile.autonomy_level, autopilot_known_only: profile.autopilot_known_only });
          await refresh();
          if (back) setCursorKey(line.key);
        }
      };
      if (line.kind === "proof" && a === line.options[0]) updateProfile({ autonomy_level: "autopilot", autopilot_known_only: true });
      addToast(done.ms ? "info" : "success", done.said, { duration: done.ms ?? undefined, action: done.undo ? { label: "Undo", onClick: undo } : done.link ? { label: "Open", onClick: () => window.open(done.link!, "_blank", "noopener") } : undefined });
    } catch (e) {
      addToast("error", (e as Error).message);
    } finally {
      await refresh();
      if (next) setCursorKey(next);
      busy.current.delete(line.key);
      setGone((g) => new Set([...g].filter((k) => k !== line.key)));
    }
  };

  const open = (line: Line) => {
    if (line.kind === "forward") return (setViewCache("replies:focus", line.id), setView("replies"));
    if (line.email_id) setReading(line.email_id);
    else if (line.kind === "todo") setView("todos");
    else if (line.kind === "meeting") setView("meetings");
    else if (line.kind === "reply") setView("replies");
  };

  useEffect(() => {
    if (reading) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[data-compose-modal]")) return;
      const k = e.key.toLowerCase();
      const a = cursor?.options[Number(k) - 1];
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      // A key held down answers one line, not the ones after it.
      else if (/^[1-3]$/.test(k) && cursor && a) e.repeat || Date.now() - landed.current < LAND_MS || void answer(cursor, a);
      else if (e.key === "Enter" && cursor && !(e.target as HTMLElement).closest?.("button, a")) open(cursor);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (reading) return <ReaderById emailId={reading} onClose={() => (setReading(null), load())} />;

  const head = (name: string, action?: ReactNode) => (
    <div className="flex items-baseline justify-between gap-4 px-6 pb-2 pt-9">
      <h2 className="font-brand text-[19px] font-[620] leading-none text-ink">{name}</h2>
      {action}
    </div>
  );
  const quiet = (text: string) => <p className="px-6 py-1.5 text-ink3">{text}</p>;
  // Under a section: what is past its length.
  const more = (text: string, run: () => void) => (
    <p className="px-6 pt-2">
      <button className="link" onClick={run}>
        {text}
      </button>
    </p>
  );
  const render = (n: Line) => {
    const on = cursor === n;
    const need = n.kind !== "wait";
    const [kind, text] = lead(n);
    const answers = (className: string) => (
      <span className={`flex-none items-center gap-1 ${className}`}>
        {n.options.map((o, i) => (
          <button
            key={o.pick}
            className={`btn btn-sm max-w-[190px] ${i > 0 ? "btn-plain" : on && need ? "btn-pri" : ""}`}
            title={o.sends ?? o.label}
            onClick={(e) => (e.stopPropagation(), void answer(n, o))}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <span className="truncate">{o.label}</span>
          </button>
        ))}
      </span>
    );
    return (
      <div key={n.key} data-line className={`mx-2 rounded-[12px] transition-colors duration-150 ${on ? "bg-side" : "hover:bg-hover"}`}>
        <div role="option" aria-selected={on} className="flex min-h-[58px] cursor-default items-center gap-3.5 px-4 py-2" title={on ? undefined : n.text} onClick={() => setCursorKey(n.key)} onDoubleClick={() => open(n)}>
          <Monogram who={n.who} asks={n.kind === "question" || n.kind === "proof"} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={`truncate text-[14px] text-ink ${need ? "font-[650]" : "font-medium"}`}>{n.who}</span>
              <span className="flex-none text-xs text-ink3">{[kind, when(n)].filter(Boolean).join(", ")}</span>
            </span>
            <span className={`block truncate text-[13.5px] leading-snug ${need ? "text-ink" : "text-ink2"}`}>{text}</span>
          </span>
          {answers("hidden pl-2 md:flex")}
        </div>
        {on && (n.shows || n.options.length > 0) && (
          <div className={`px-4 pb-3 pl-[65px] text-[13px] leading-relaxed text-ink2 ${n.shows ? "" : "md:hidden"}`}>
            {n.shows && (
              <div className="max-w-[62ch] rounded-[10px] bg-canvas px-4 py-3 shadow-control">
                <Shows line={n} onAnswer={(a) => void answer(n, a)} />
              </div>
            )}
            {answers("mt-2 flex flex-wrap md:hidden")}
          </div>
        )}
      </div>
    );
  };
  const now = new Date();
  const weekday = now.toLocaleDateString([], { weekday: "long" });
  const date = now.toLocaleDateString([], { day: "numeric", month: "long" });
  const hour = now.getHours();
  const greeting = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = String(profile.display_name ?? "").trim().split(/\s+/)[0];
  const nextUp = events?.find((e) => !e.allDay && new Date(e.start).getTime() > Date.now());
  const count = needs.length + (brief?.more ?? 0);
  const owed = waiting.length + (show("waiting") ? (brief?.waitingMore ?? 0) : 0);
  // Where things stand, from the lines below, when there is no paragraph.
  const stands = [
    show("needs") && (count ? `${count.toLocaleString()} ${count === 1 ? "thing needs" : "things need"} you today.` : "Nothing needs you today."),
    owed > 0 && `${owed.toLocaleString()} ${owed === 1 ? "person owes" : "people owe"} you an answer.`,
    show("calendar") && nextUp && `${nextUp.title} at ${clock(nextUp.start)}.`,
  ].filter(Boolean).join(" ");
  const main = brief?.settings.summary && brief.summary ? brief.summary : stands;
  const facts = [
    show("needs") && { n: count, label: count === 1 ? "needs you" : "need you", need: count > 0 },
    show("waiting") && { n: owed, label: owed === 1 ? "owes you" : "owe you", need: false },
    show("calendar") && events && { n: events.length, label: events.length === 1 ? "event today" : "events today", need: false },
  ].filter((f) => f && f.n > 0) as { n: number; label: string; need: boolean }[];
  const calendar = show("calendar") && (calError || !!events?.length);

  return (
    <>
      <div className="relative min-h-0 flex-1 overflow-y-auto pb-16">
        <header className="flex items-start gap-3 px-4 pt-4 lg:absolute lg:right-0 lg:top-0 lg:z-[1]">
          <button className="iconbtn lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Show sidebar">
            <Icon name="menu" size={16} />
          </button>
          <span className="flex-1" />
          <button className="iconbtn" title="Brief settings" aria-label="Brief settings" onClick={() => (setViewCache("settings:tab", "brief"), setView("settings"))}>
            <Icon name="settings" size={16} />
          </button>
        </header>
        <div ref={listRef} className="mx-auto w-full max-w-[1080px]">
          <div className="grid gap-x-12 gap-y-5 border-b border-line-soft px-6 pb-8 pt-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:pt-14">
            <div>
              <p className="text-[13px] text-ink3">
                {greeting}
                {first ? `, ${first}` : ""}
              </p>
              <h1 className="mt-1.5 font-brand text-[46px] font-[600] leading-[1] tracking-[-0.014em] text-ink">
                {weekday}
                <span className="block text-ink3">{date}</span>
              </h1>
            </div>
            <div className="min-w-0 self-end lg:pb-1">
              {!brief ? (
                <div className="grid gap-2">
                  <span className="skel block h-3 w-[85%]" />
                  <span className="skel block h-3 w-[60%]" />
                </div>
              ) : (
                <>
                  <p className="text-[17px] leading-[1.55] text-ink" aria-busy={writing || undefined}>
                    {writing && !brief.summary ? <span className="text-ink3">{stands}</span> : main}
                  </p>
                  {facts.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1">
                      {facts.map((f) => (
                        <span key={f.label} className="flex items-baseline gap-1.5">
                          <b className={`font-brand text-[22px] font-[620] leading-none ${f.need ? "text-wax-ink" : "text-ink"}`}>{f.n.toLocaleString()}</b>
                          <span className="text-[12.5px] text-ink3">{f.label}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {brief.away && <p className="mt-3 text-[12.5px] text-ink3">{brief.away}</p>}
                </>
              )}
            </div>
          </div>
          {failed && !brief ? (
            <p className="px-6 pt-6 text-danger" role="alert">
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
            <div className={`grid gap-x-6 ${calendar ? "lg:grid-cols-[minmax(0,1fr)_300px]" : ""}`}>
              <div className="min-w-0">
                {show("needs") && (
                  <>
                    {head("Needs you today")}
                    {!needs.length ? (
                      <div className="mx-2 flex items-center gap-3.5 rounded-[12px] px-4 py-3 text-ink2">
                        <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-ok-soft text-ok">
                          <Icon name="check" size={16} />
                        </span>
                        You are clear. New mail that needs you shows up here.
                      </div>
                    ) : (
                      <div role="listbox" aria-label="Needs you today">
                        {needs.map(render)}
                      </div>
                    )}
                    {brief.more > 0 && more(`${brief.more.toLocaleString()} more`, () => setAll(true))}
                  </>
                )}

                {brief.changes.length > 0 && (
                  <>
                    {head("Changed on your calendar")}
                    {brief.changes.map((c) => (
                      <div key={c.id} className="mx-2 flex min-h-[40px] items-center gap-3.5 rounded-[12px] px-4 py-1.5 transition-colors duration-150 hover:bg-hover">
                        <Icon name="event" size={16} className="flex-none text-ink3" />
                        <button className="min-w-0 flex-1 truncate text-left text-ink" title={c.text} onClick={() => (c.email_id ? setReading(c.email_id) : setView("meetings"))}>
                          {c.text}
                        </button>
                        <button className="btn btn-plain btn-sm flex-none" onClick={() => mail.undo(c.id).then(() => (addToast("info", "Undone"), refresh())).catch((e) => addToast("error", (e as Error).message))}>
                          Undo
                        </button>
                      </div>
                    ))}
                  </>
                )}

                {waiting.length > 0 && (
                  <>
                    {head("Waiting on others")}
                    <div role="listbox" aria-label="Waiting on others">
                      {waiting.map(render)}
                    </div>
                    {brief.waitingMore > 0 && more(`${brief.waitingMore.toLocaleString()} more in Follow-ups`, () => setView("followups"))}
                  </>
                )}

                {brief.digests.map((d) => (
                  <div key={d.id}>
                    {head(
                      d.title,
                      <button className="link" aria-expanded={shownDigest === d.id} onClick={() => setShownDigest(shownDigest === d.id ? null : d.id)}>
                        {shownDigest === d.id ? "Hide" : `Show ${d.items.length.toLocaleString()}`}
                      </button>,
                    )}
                    {shownDigest === d.id &&
                      d.items.map((m) => (
                        <div key={m.email_id} className="row cursor-default !mx-2 !px-4" onClick={() => setReading(m.email_id)} title={m.text}>
                          <span className="w-[96px] flex-none truncate pr-3 md:w-[164px]">{m.who}</span>
                          <span className="min-w-0 flex-1 truncate">{m.text}</span>
                          <time className="w-[46px] flex-none text-right text-xs text-ink3">{shortWhen(m.at)}</time>
                        </div>
                      ))}
                  </div>
                ))}

                {show("handled") && brief.handled.length > 0 && (
                  <p className="px-6 pt-10">
                    <button className="link" onClick={() => setView("history")}>
                      What Tabellar did for you
                    </button>
                  </p>
                )}
              </div>

              {calendar && (
                <aside className="min-w-0 lg:pr-2">
                  {head("Today")}
                  {calError ? (
                    quiet("The calendar could not be read")
                  ) : (
                    <div className="mx-2 rounded-[12px] bg-side p-1.5">
                      {events!.map((ev) => {
                        const over = !ev.allDay && new Date(ev.end).getTime() < Date.now();
                        return (
                          <div key={ev.id}>
                            <a className="grid min-h-[44px] grid-cols-[2px_minmax(0,1fr)] items-center gap-x-3 rounded-[9px] px-2.5 py-1.5 transition-colors duration-150 hover:bg-hover" href={ev.htmlLink || undefined} target="_blank" rel="noopener noreferrer">
                              <span className={`h-full min-h-[28px] rounded-full ${upNext === ev.id ? "bg-wax" : "bg-line"}`} />
                              <span className="min-w-0">
                                <span className={`block truncate ${over ? "text-ink3" : "font-medium text-ink"}`}>{ev.title}</span>
                                <span className="block truncate text-[12.5px] text-ink3">
                                  {ev.allDay ? "All day" : `${clock(ev.start)} to ${clock(ev.end)}`}
                                  {ev.attendees.length > 0 && `, ${ev.attendees.join(", ")}`}
                                </span>
                              </span>
                            </a>
                            {upNext === ev.id && !!ev.people?.length && <MeetingPrep title={ev.title} people={ev.people} onOpen={setReading} className="px-3 pb-2" />}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </aside>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
