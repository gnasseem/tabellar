import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";
import { isTypingTarget } from "@/lib/shortcuts";
import { Switch } from "../settings/parts";
import { useApp } from "../AppShell";
import { ReaderById } from "../EmailDetail";
import { Glyph, Seg, SkeletonRows, ViewBar, shortWhen, type MailState } from "../ui";

// Automations: a sentence in, a standing behaviour out. The field on top, one
// row for each, and a row opens to what the sentence was read as (the server's
// words for what will run), what it would have matched, and what it did, each
// with its undo. One is off until what it would have matched was shown.

type Match = { email_id: string | null; who: string; subject: string; at: string; quote: string };
type Trial = { state: "running" | "done" | "failed"; done: number; of: number; matches: Match[]; more: number; error?: string };
type Automation = {
  id: string; text: string; mode: "ask" | "own"; enabled: boolean; enabled_at: string | null; tried_at: string | null; trial: Trial | null; runs: number; last_run: string | null;
  spec: { trigger: { on: "mail" | "time" | "silence" | "meeting" }; conditions: { question: string | null }; actions: { do: string }[] };
  when: string; then: string[]; waiting: number;
};
type Done = { id: string; kind: string; status: string; summary: string; hash: string | null; error: string | null; created_at: string; email_id: string | null; emails: { subject: string | null } | null };

// One tap each to see what they would match.
const STARTERS = [
  "When an invoice arrives, label it Finance and add a todo due in a week",
  "When a newsletter arrives, mark it read and archive it",
  "If nobody answers me in 4 days, draft a follow-up",
  "When one of my most important people writes, notify me and put it first in the Brief",
  "When someone I do not know asks for a meeting, draft a polite no",
  "Every weekday at 17:00, put a digest of updates in the Brief",
];

const UNDOABLE = new Set(["label", "archive", "draft", "todo", "snooze", "read", "brief", "vip"]);
const emails = (n: number) => (n === 1 ? "1 email" : `${n.toLocaleString()} emails`);

// What the trial found, in a line.
function trialLine(a: Automation): string {
  const t = a.trial;
  if (!t) return "";
  if (t.state === "failed") return t.error || "It could not be tried.";
  const n = t.matches.length + t.more;
  const on = a.spec.trigger.on;
  if (t.state === "running") return t.of && a.spec.conditions.question ? `Looking through ${t.done} of ${t.of}` : "Looking through your mail";
  if (on === "silence") return n ? `${emails(n)} waiting that long now` : "Nothing is waiting that long now";
  if (on === "meeting") return n ? `${n === 1 ? "1 meeting" : `${n} meetings`} in the next two hours` : "No such meeting in the next two hours";
  if (on === "time") return a.spec.actions.every((x) => x.do === "todo" || x.do === "notify") && !n ? "" : n ? `${emails(n)} if it ran now` : "Nothing if it ran now";
  if (!n) return a.spec.conditions.question && t.of ? `None of ${emails(t.of)} in the last 30 days` : "Nothing in the last 30 days";
  return a.spec.conditions.question ? `${n} of ${emails(t.of)} in the last 30 days` : `${emails(n)} in the last 30 days`;
}

function stateOf(d: Done): MailState {
  return d.status === "proposed" ? "need" : d.status === "failed" ? "failed" : d.status === "blocked" ? "held" : d.status === "done" ? "done" : "filed";
}

export default function AutomationsView() {
  const { user, mail, addToast, liveChanges, setView, setViewCache, getViewCache } = useApp();
  const supabase = createClient();
  const [list, setList] = useState<Automation[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [reading, setReading] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [edited, setEdited] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [done, setDone] = useState<Done[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { automations } = (await api("/automations")) as { automations: Automation[] };
      setList(automations);
      setFailed(false);
      // Arriving from Ask with one to turn on.
      const focus = getViewCache("automations:open");
      if (focus && automations.some((a) => a.id === focus)) {
        setOpen(focus);
        setCursorId(focus);
        setViewCache("automations:open", null);
      }
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, liveChanges.automations, liveChanges.action_log]);

  // What the open one did.
  useEffect(() => {
    if (!open) return setDone(null);
    let gone = false;
    supabase
      .from("action_log")
      .select("id, kind, status, summary, hash, error, created_at, email_id, emails(subject)")
      .eq("user_id", user.id)
      .eq("automation_id", open)
      .neq("status", "blocked")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (!gone) setDone(((data || []) as (Done & { emails: Done["emails"] | Done["emails"][] })[]).map((d) => ({ ...d, emails: Array.isArray(d.emails) ? (d.emails[0] ?? null) : d.emails })));
      });
    return () => {
      gone = true;
    };
  }, [open, user.id, liveChanges.action_log]);

  const compile = async (sentence: string, id?: string) => {
    const s = sentence.trim();
    if (!s || reading) return;
    setReading(s);
    setError("");
    try {
      const r = (await api("/automations/compile", { text: s, id })) as { id?: string; rule?: string };
      if (r.rule) {
        addToast("success", "Kept as a rule", { action: { label: "Show", onClick: () => (setViewCache("settings:tab", "about"), setView("settings")) } });
      } else if (r.id) {
        setOpen(r.id);
        setCursorId(r.id);
      }
      if (!id) setText("");
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      if (!id) setText(s);
    } finally {
      setReading("");
    }
  };

  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await run();
    } catch (e) {
      addToast("error", (e as Error).message);
    } finally {
      setBusy(null);
      load();
    }
  };

  const turn = (a: Automation, on: boolean) => {
    // What it would match is looked at before it is on for the first time.
    if (on && (!a.tried_at || (!a.enabled_at && open !== a.id))) return (setCursorId(a.id), setOpen(a.id));
    act(a.id, async () => {
      setList((l) => (l || []).map((x) => (x.id === a.id ? { ...x, enabled: on } : x)));
      await api("/automations/enable", { id: a.id, on });
    });
  };

  const remove = (a: Automation) =>
    act(a.id, async () => {
      const { data: row } = await supabase.from("automations").select("*").eq("id", a.id).single();
      await api("/automations/delete", { id: a.id });
      if (open === a.id) setOpen(null);
      addToast("info", "Automation deleted", { action: { label: "Undo", onClick: () => void supabase.from("automations").insert(row).then(load) } });
    });

  const toggle = (a: Automation) => {
    setCursorId(a.id);
    setEditing(null);
    setOpen(open === a.id ? null : a.id);
  };

  const rows = list || [];
  const cursor = rows.find((r) => r.id === cursorId) || null;
  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorId(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (email || document.querySelector("[data-compose-modal]")) return;
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (k === "n") input.current?.focus();
      else if (e.key === "Enter" && cursor && !(e.target as HTMLElement).closest?.("button, a")) toggle(cursor);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (email) return <ReaderById emailId={email} onClose={() => setEmail(null)} />;

  const status = (a: Automation) => {
    if (a.waiting) return <span className="font-semibold text-wax-ink">{a.waiting} to approve</span>;
    if (a.trial?.state === "running") return "Looking";
    if (!a.enabled) return a.runs ? `Off, ran ${a.runs === 1 ? "once" : `${a.runs.toLocaleString()} times`}` : "Off";
    const how = a.mode === "ask" ? "Asks first" : "On its own";
    return a.runs ? `${how}, ran ${a.runs === 1 ? "once" : `${a.runs.toLocaleString()} times`}` : how;
  };

  const matchRow = (m: Match, i: number) => (
    <button key={`${m.email_id}${i}`} className="flex h-item w-full items-center gap-3 rounded-md text-left enabled:hover:text-ink" disabled={!m.email_id} title={m.quote ? `"${m.quote}"` : m.subject} onClick={() => m.email_id && setEmail(m.email_id)}>
      <span className="w-[96px] flex-none truncate text-ink md:w-[148px]">{m.who}</span>
      <span className="min-w-0 flex-1 truncate text-ink2">{m.subject}</span>
      {m.quote && <span className="min-w-0 max-w-[38%] flex-none truncate text-ink3 max-md:hidden">"{m.quote}"</span>}
      <time className="w-[46px] flex-none text-right text-xs text-ink3">{shortWhen(m.at)}</time>
    </button>
  );

  const doneRow = (d: Done) => (
    <div key={d.id} className="flex h-item items-center gap-2">
      <Glyph state={stateOf(d)} />
      <span className={`flex-none truncate max-w-[55%] ${d.status === "undone" || d.status === "dismissed" ? "text-ink3" : "text-ink"}`} title={d.error || d.summary}>
        {d.summary}
      </span>
      {d.emails?.subject ? (
        <button className="min-w-0 flex-1 truncate text-left text-ink3 hover:text-ink" onClick={() => d.email_id && setEmail(d.email_id)}>
          {d.emails.subject}
        </button>
      ) : (
        <span className="flex-1" />
      )}
      {d.status === "proposed" ? (
        <span className="flex flex-none gap-3">
          <button className="link !text-wax-ink" disabled={busy === d.id} onClick={() => act(d.id, () => mail.approve(d.id, d.hash || ""))}>
            Approve
          </button>
          <button className="link" disabled={busy === d.id} onClick={() => act(d.id, () => mail.dismiss(d.id))}>
            Dismiss
          </button>
        </span>
      ) : d.status === "done" && UNDOABLE.has(d.kind) ? (
        <button className="link flex-none" disabled={busy === d.id} onClick={() => act(d.id, () => mail.undo(d.id))}>
          Undo
        </button>
      ) : d.status === "undone" || d.status === "dismissed" ? (
        <span className="flex-none text-xs text-ink3">{d.status === "undone" ? "Undone" : "Dismissed"}</span>
      ) : d.status === "failed" ? (
        <span className="flex-none text-xs font-medium text-danger">Failed</span>
      ) : null}
      <time className="w-[46px] flex-none text-right text-xs text-ink3">{shortWhen(d.created_at)}</time>
    </div>
  );

  const panel = (a: Automation) => {
    const line = trialLine(a);
    return (
      <div className="inset mb-2 ml-10 mr-5 mt-1 text-[13px]">
        {editing === a.id ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => (e.preventDefault(), compile(edited, a.id))}
            onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
          >
            <input className="input !bg-canvas" autoFocus value={edited} onChange={(e) => setEdited(e.target.value)} aria-label="The sentence" disabled={!!reading} />
            <button className="btn btn-sm" type="submit" disabled={!edited.trim() || !!reading}>
              {reading ? "Reading" : "Save"}
            </button>
            <button className="btn btn-plain btn-sm" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <dl className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-3 gap-y-1 leading-5">
            <dt className="text-ink3">When</dt>
            <dd className="text-ink">{a.when}</dd>
            <dt className="text-ink3">Then</dt>
            <dd className="text-ink">
              {a.then.map((t) => (
                <div key={t}>{t}</div>
              ))}
            </dd>
          </dl>
        )}
        {editing === a.id && error && (
          <p className="pt-2 text-danger" role="alert">
            {error}
          </p>
        )}
        {(!a.enabled || !a.runs) && line && (
          <div className="mt-3 border-t border-line-soft pt-2.5" aria-busy={a.trial?.state === "running" || undefined}>
            <p className={a.trial?.state === "failed" ? "text-danger" : "text-ink2"}>
              {line}
              {a.trial?.state === "failed" && (
                <button className="link ml-2" onClick={() => act(a.id, () => api("/automations/try", { id: a.id }))}>
                  Try again
                </button>
              )}
            </p>
            {!!a.trial?.matches.length && <div className="mt-1 max-h-[300px] overflow-y-auto">{a.trial.matches.map(matchRow)}</div>}
            {!!a.trial?.more && <p className="pt-1 text-xs text-ink3">{a.trial.more.toLocaleString()} more</p>}
          </div>
        )}
        {!!done?.length && open === a.id && (
          <div className="mt-3 max-h-[320px] overflow-y-auto border-t border-line-soft pt-2">{done.map(doneRow)}</div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!a.enabled && (
            <button className="btn btn-pri btn-sm" disabled={!a.tried_at || busy === a.id} onClick={() => turn(a, true)}>
              Turn on
            </button>
          )}
          <Seg
            value={a.mode}
            onChange={(mode) => act(a.id, () => api("/automations/mode", { id: a.id, mode }))}
            options={[
              { id: "own", label: "On its own" },
              { id: "ask", label: "Asks first" },
            ]}
          />
          <span className="flex-1" />
          {editing !== a.id && (
            <button className="btn btn-plain btn-sm" onClick={() => (setError(""), setEdited(a.text), setEditing(a.id))}>
              Edit
            </button>
          )}
          <button className="btn btn-plain btn-sm" disabled={busy === a.id} onClick={() => remove(a)}>
            Delete
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <ViewBar title="Automations" search={false} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <div className="w-full max-w-[880px]">
          <form className="mx-2 flex flex-none items-center pb-1 pl-1.5 pr-3 pt-2.5" onSubmit={(e) => (e.preventDefault(), compile(text))}>
            <span className="grid w-[26px] flex-none place-items-center text-ink3">
              <Icon name="add" size={15} />
            </span>
            <input ref={input} className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="When something happens, do this from now on" aria-label="New automation" disabled={!!reading} maxLength={400} />
          </form>
          {error && editing === null && (
            <p className="pb-1 pl-10 pr-5 pt-1 text-danger" role="alert">
              {error}
            </p>
          )}
          {reading && editing === null && (
            <div className="row" aria-busy="true">
              <span className="w-[26px] flex-none" />
              <span className="min-w-0 flex-1 truncate text-ink2">{reading}</span>
              <span className="flex-none text-[12.5px] text-ink3">Reading</span>
            </div>
          )}
          {failed && !list ? (
            <p className="px-5 pt-3 text-danger" role="alert">
              Your automations could not be loaded.{" "}
              <button className="link !text-danger" onClick={load}>
                Try again
              </button>
            </p>
          ) : !list ? (
            <SkeletonRows count={6} />
          ) : !list.length ? (
            !reading && (
              <>
                <div className="day !static">
                  <b>Ready to try</b>
                </div>
                {STARTERS.map((s) => (
                  <div key={s} className="row cursor-default" onClick={() => compile(s)}>
                    <span className="w-[26px] flex-none" />
                    <span className="min-w-0 flex-1 truncate text-ink">{s}</span>
                    <button className="link flex-none" onClick={(e) => (e.stopPropagation(), compile(s))}>
                      Try
                    </button>
                  </div>
                ))}
              </>
            )
          ) : (
            list.map((a) => (
              <div key={a.id}>
                <div className="row cursor-default gap-3" role="button" tabIndex={-1} aria-expanded={open === a.id} aria-selected={cursorId === a.id} title={a.text} onClick={() => toggle(a)}>
                  <span className="-mr-3 grid w-[26px] flex-none place-items-center">
                    <Glyph state={a.waiting ? "need" : "filed"} />
                  </span>
                  <span className={`min-w-0 flex-1 truncate ${a.enabled ? "text-ink" : "text-ink2"}`}>{a.text}</span>
                  <span className="flex-none text-[12.5px] text-ink3 max-md:hidden">{status(a)}</span>
                  <span className="flex flex-none" onClick={(e) => e.stopPropagation()}>
                    <Switch on={a.enabled} disabled={busy === a.id || (!a.enabled && a.trial?.state === "running")} label={`${a.text}: on`} onChange={(v) => turn(a, v)} />
                  </span>
                </div>
                {open === a.id && panel(a)}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
