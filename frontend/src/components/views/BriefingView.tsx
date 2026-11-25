import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { api } from "@/lib/outcomes";
import { isTypingTarget } from "@/lib/shortcuts";
import { blocksOf, choicesOf } from "../../../../server/choices.ts";
import { useApp } from "../AppShell";
import { confirmLevel } from "../Sidebar";
import { ReaderById } from "../EmailDetail";
import { MeetingPrep, useUpNext } from "../Prep";
import { Glyph, SkeletonRows, ViewBar, clock, shortWhen } from "../ui";

// The Brief: where the window opens. What needs the user today, each line with
// its answers (server/answers.ts), so nothing has to be opened to deal with it;
// who they are waiting on, the same way; today's calendar; and how much
// Tabellar handled since yesterday, one line until it is opened. The line the
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
  const { mail, profile, setView, setViewCache, updateProfile, addToast, notifyDraftChange, liveChanges } = useApp();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [failed, setFailed] = useState(false);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [calError, setCalError] = useState(false);
  const [showHandled, setShowHandled] = useState(false);
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

  const head = (name: string) => (
    <div className="day !static">
      <b>{name}</b>
    </div>
  );
  const quiet = (text: string) => <p className="flex h-row items-center pl-[40px] text-ink3">{text}</p>;
  const render = (n: Line) => {
    const on = cursor === n;
    const need = n.kind !== "wait";
    const answers = (className: string) => (
      <span className={`flex-none items-center gap-0.5 pl-3 ${className}`}>
        {n.options.map((o, i) => (
          <button
            key={o.pick}
            className={`btn btn-plain btn-sm max-w-[190px] ${i === 0 ? `!font-medium ${need ? "!text-wax-ink" : "!text-ink"}` : ""}`}
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
      <div key={n.key} data-line>
        <div role="option" aria-selected={on} className="row cursor-default" title={on ? undefined : n.text} onClick={() => setCursorKey(n.key)} onDoubleClick={() => open(n)}>
          <span className="grid w-[26px] flex-none place-items-center">{need && <Glyph state={n.kind === "question" || n.kind === "proof" ? "info" : "need"} />}</span>
          <span className={`w-[96px] flex-none truncate pr-3 text-ink md:w-[164px] ${need ? "font-[650]" : ""}`}>{n.who}</span>
          <span className={`min-w-0 flex-1 truncate ${need ? "font-medium text-ink" : "text-ink2"}`}>{n.text}</span>
          {when(n) && <span className="flex-none pl-3 text-right text-xs text-ink3 max-md:hidden">{when(n)}</span>}
          {answers("hidden md:flex")}
        </div>
        {on && (
          <div className="pb-2.5 pl-[40px] pr-5 pt-1.5 text-[12.5px] leading-relaxed text-ink2 md:pl-[204px]">
            <div className="max-w-[62ch]">
              <Shows line={n} onAnswer={(a) => void answer(n, a)} />
            </div>
            {answers("-ml-5 mt-1 flex flex-wrap md:hidden")}
          </div>
        )}
      </div>
    );
  };
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
        right={
          <button className="iconbtn" title="Brief settings" aria-label="Brief settings" onClick={() => (setViewCache("settings:tab", "brief"), setView("settings"))}>
            <Icon name="settings" size={16} />
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <div ref={listRef} className="w-full max-w-[880px]">
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
              {brief.away && <p className="px-5 pt-4 text-ink2">{brief.away}</p>}
              {brief.settings.summary && (brief.summary || writing) && (
                <p className="max-w-[68ch] px-5 pb-1.5 pt-4 leading-relaxed text-ink" aria-busy={writing || undefined}>
                  {brief.summary || <span className="skel mt-1 block h-2.5 w-[60%]" />}
                </p>
              )}
              {show("needs") && (
                <>
                  {head("Needs you today")}
                  {!needs.length && quiet("Nothing needs you")}
                  <div role="listbox" aria-label="Needs you today">
                    {needs.map(render)}
                  </div>
                  {brief.more > 0 && (
                    <p className="flex h-row items-center pl-[40px]">
                      <button className="link" onClick={() => setAll(true)}>
                        {brief.more.toLocaleString()} more
                      </button>
                    </p>
                  )}
                </>
              )}

              {brief.digests.map((d) => (
                <div key={d.id}>
                  {head("Digest")}
                  <button className="row w-[calc(100%-16px)] text-left" aria-expanded={shownDigest === d.id} title={d.title} onClick={() => setShownDigest(shownDigest === d.id ? null : d.id)}>
                    <span className="w-[26px] flex-none" />
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {d.items.length.toLocaleString()} email{d.items.length === 1 ? "" : "s"}
                      <span className="pl-2 text-ink3">{d.title}</span>
                    </span>
                    <span className="flex-none pl-3 text-xs text-ink3">{shownDigest === d.id ? "Hide" : "Show"}</span>
                  </button>
                  {shownDigest === d.id &&
                    d.items.map((m) => (
                      <div key={m.email_id} className="row cursor-default" onClick={() => setReading(m.email_id)} title={m.text}>
                        <span className="w-[26px] flex-none" />
                        <span className="w-[96px] flex-none truncate pr-3 md:w-[164px]">{m.who}</span>
                        <span className="min-w-0 flex-1 truncate">{m.text}</span>
                        <time className="w-[46px] flex-none text-right text-xs text-ink3">{shortWhen(m.at)}</time>
                      </div>
                    ))}
                </div>
              ))}

              {waiting.length > 0 && (
                <>
                  {head("Waiting on others")}
                  <div role="listbox" aria-label="Waiting on others">
                    {waiting.map(render)}
                  </div>
                  {brief.waitingMore > 0 && (
                    <p className="flex h-row items-center pl-[40px]">
                      <button className="link" onClick={() => setView("followups")}>
                        {brief.waitingMore.toLocaleString()} more in Follow-ups
                      </button>
                    </p>
                  )}
                </>
              )}

              {show("calendar") && (calError || !!events?.length) && (
                <>
                  {head("Today's calendar")}
                  {calError ? (
                    quiet("The calendar could not be read")
                  ) : (
                    events!.map((ev) => {
                      const over = !ev.allDay && new Date(ev.end).getTime() < Date.now();
                      return (
                        <div key={ev.id}>
                        <a className="row" href={ev.htmlLink || undefined} target="_blank" rel="noopener noreferrer">
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
                        {upNext === ev.id && !!ev.people?.length && <MeetingPrep title={ev.title} people={ev.people} onOpen={setReading} className="pl-10 md:pl-[204px]" />}
                        </div>
                      );
                    })
                  )}
                </>
              )}

              {show("handled") && brief.handled.length > 0 && (
                <>
                  {head("Handled for you")}
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
