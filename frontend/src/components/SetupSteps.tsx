import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Icon from "@/components/Icon";
import { Glyph, Tick } from "@/components/ui";
import { createClient } from "@/lib/db";
import { LABEL_COLORS, slugOf } from "@/lib/labelColors";
import { api, formatBytes, type Onboarding } from "@/lib/setup";
import { Bar, useTimeLeft } from "./ModelSetup";

// The frame every first-run step is set in, the live line along its bottom,
// and the steps that use the mail read meanwhile: About you, Examples, and
// People and labels. The flow itself is in Welcome.tsx.

export type Flow = {
  header: ReactNode;
  onboarding: Onboarding | null;
  back?: () => void;
  userId: string | null;
};
export const FlowContext = createContext<Flow>({ header: null, onboarding: null, userId: null });

// One step: the question and its controls on the left, what it is about on
// the right, and the way on along the bottom with what is being read.
export function Step({ title, text, children, aside, actions, bare }: { title: string; text: ReactNode; children?: ReactNode; aside?: ReactNode; actions?: ReactNode; bare?: boolean }) {
  const { header, onboarding, back } = useContext(FlowContext);
  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex h-[52px] flex-none items-center gap-6 px-5">{header}</header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className={`ob-enter mx-auto grid w-full max-w-[1320px] gap-x-[clamp(40px,6vw,104px)] gap-y-10 px-6 pb-16 sm:px-10 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] lg:px-14 ${bare ? "min-h-full content-center py-10" : "pt-[clamp(28px,7vh,76px)]"}`}>
          <section className="min-w-0">
            {title && <h1 className="text-[26px] font-[650] leading-[1.15] tracking-[-0.018em] text-ink [text-wrap:balance]">{title}</h1>}
            <div className="mt-3 max-w-[42ch] text-[14px] leading-[1.55] text-ink2 [text-wrap:pretty]">{text}</div>
            {children && <div className="mt-8">{children}</div>}
          </section>
          {aside && <div className="min-w-0 lg:pt-1">{aside}</div>}
        </div>
      </main>
      {!bare && (
        <footer className="flex min-h-[60px] flex-none flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            <Live o={onboarding} />
          </div>
          <div className="ml-auto flex flex-none items-center gap-2">
            {back && (
              <button type="button" className="btn btn-plain h-8" onClick={back}>
                Back
              </button>
            )}
            {actions}
          </div>
        </footer>
      )}
    </div>
  );
}

// What the server is doing meanwhile: the model download, then the first
// read (headers of 90 days, the sent mail, the last 30 days sorted).
export function Live({ o }: { o: Onboarding | null }) {
  const job = o?.local && !o.local.done ? o.local : null;
  const left = useTimeLeft(job ?? undefined);
  if (!o) return null;
  const items: ReactNode[] = [];
  if (job) {
    const pct = job.total && job.completed !== undefined ? (job.completed / job.total) * 100 : null;
    items.push(<LiveItem key="job" label={job.label} pct={pct} numbers={pct !== null ? `${formatBytes(job.completed!)} of ${formatBytes(job.total!)}${left ? `, ${left}` : ""}` : ""} />);
  } else if (o.local?.error) {
    items.push(<LiveItem key="job" label={`The model download stopped: ${o.local.error}`} failed />);
  }
  const r = o.read;
  const n = (x: number) => x.toLocaleString();
  if (r.error) items.push(<LiveItem key="read" label={`Reading stopped: ${r.error}. It starts again on its own.`} failed />);
  else if (r.step === "headers") items.push(r.headers_total ? <LiveItem key="read" label="Reading the last 90 days" pct={(r.headers / r.headers_total) * 100} numbers={`${n(r.headers)} of ${n(r.headers_total)} emails`} /> : <LiveItem key="read" label="Connecting to your mailbox" pct={null} />);
  else if (r.step === "sent") items.push(o.model ? <LiveItem key="read" label={r.learned ? "Working out labels to suggest" : "Learning from your sent mail"} pct={null} /> : <LiveItem key="read" label={`${n(r.headers_total || r.headers)} emails listed. ${noModel(o) ? "Sorting needs a model." : "Sorting starts once the model is ready."}`} />);
  else if (r.step === "deep") items.push(r.deep_total ? <LiveItem key="read" label="Sorting the last 30 days" pct={(r.deep / r.deep_total) * 100} numbers={`${n(r.deep)} of ${n(r.deep_total)}`} /> : <LiveItem key="read" label="Fetching the last 30 days" pct={null} />);
  else items.push(<LiveItem key="read" label={`Your mail is read: ${n(o.sorted)} emails sorted`} done />);
  if (r.step === "headers" && o.model && !r.learned && !r.error) items.push(<LiveItem key="sent" label="Learning from your sent mail" pct={null} />);
  return <div className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-1.5">{items}</div>;
}

function LiveItem({ label, pct, numbers, failed, done }: { label: string; pct?: number | null; numbers?: string; failed?: boolean; done?: boolean }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-3" role="status" aria-live="polite">
      {done ? <Glyph state="done" /> : failed ? <Glyph state="failed" /> : null}
      <span className={`min-w-0 truncate text-[12.5px] ${failed ? "text-danger" : "text-ink2"}`}>{label}</span>
      {pct !== undefined && <Bar pct={pct === null ? null : Math.min(100, pct)} className="w-24 flex-none" />}
      {numbers && <span className="flex-none text-xs text-ink3">{numbers}</span>}
    </div>
  );
}

// A section heading on the right of a step.
function Heading({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-4 border-b border-line pb-2">
      <h2 className="text-[13px] font-[650] text-ink">{title}</h2>
      {note && <span className="text-xs text-ink3">{note}</span>}
    </div>
  );
}

// Neither a model nor one on its way: what needs one says so, rather than
// showing lines that will not fill.
const noModel = (o: Onboarding | null) => !!o && !o.model && !(o.local && !o.local.done);
const NEEDS_MODEL = "Needs a model. Choose one in the Model step, or later in Settings.";

function Waiting({ lines, text }: { lines: number; text: string }) {
  return (
    <div aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex h-10 items-center border-b border-line-soft">
          <span className="skel block h-2.5" style={{ width: `${[62, 48, 71, 55, 66][i % 5]}%` }} />
        </div>
      ))}
      <p className={`text-[12.5px] text-ink3 ${lines ? "mt-3" : "py-3"}`}>{text}</p>
    </div>
  );
}

// Poll while `on`; the first load happens at once.
function usePoll<T>(load: () => Promise<T>, every: number, on: (v: T | null) => boolean) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState("");
  const keep = useRef(on);
  keep.current = on;
  const run = useCallback(async () => {
    try {
      const v = await load();
      setValue(v);
      setError("");
      return v;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const v = await run();
      if (live && keep.current(v)) timer = setTimeout(tick, every);
    };
    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [run, every]);
  return { value, error, reload: run };
}

// ── About you ───────────────────────────────────────────────────────────────

type About = {
  role: { value: string; source: string } | null;
  work: { value: string; source: string } | null;
  facts: { id: string; value: string; source: string }[];
  never: string[];
  learned: boolean;
  sent: number;
};

export function AboutStep({ onNext }: { onNext: () => void }) {
  const { onboarding } = useContext(FlowContext);
  const { value: about, error } = usePoll(() => api<About>("/onboarding/about"), 3000, (v) => !v?.learned);
  const [role, setRole] = useState<string | null>(null);
  const [work, setWork] = useState<string | null>(null);
  const [never, setNever] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState("");

  // What the sent mail shows fills the fields until the user types in them.
  const roleValue = role ?? about?.role?.value ?? "";
  const workValue = work ?? about?.work?.value ?? "";
  const topics = never ?? about?.never ?? [];
  const learnedRole = role === null && about?.role?.source === "learned";
  const learnedWork = work === null && about?.work?.source === "learned";

  const addTopic = (text: string) => {
    const parts = text.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1);
    if (parts.length) setNever([...new Set([...topics, ...parts])]);
    setDraft("");
  };

  const save = async () => {
    setSaving(true);
    setFailed("");
    try {
      const pending = draft.trim() ? [...new Set([...topics, ...draft.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1)])] : topics;
      await api("/onboarding/about", { role: roleValue, work: workValue, never: pending, removed: [...removed] });
      onNext();
    } catch (e) {
      setFailed((e as Error).message);
    }
    setSaving(false);
  };

  const reading = !about?.learned;
  const facts = about?.facts ?? [];
  return (
    <Step
      title="About you"
      text="Tabellar keeps this in mind for every email. It fills in from your sent mail as that is read; change anything that is off."
      actions={
        <button type="button" className="btn btn-pri h-8 px-3.5" disabled={saving} onClick={save}>
          {saving ? "Saving" : "Continue"}
        </button>
      }
      aside={
        <div>
          <Heading title="From your sent mail" note={about?.learned ? `${about.sent.toLocaleString()} emails read` : undefined} />
          {reading ? (
            noModel(onboarding) ? <Waiting lines={0} text={NEEDS_MODEL} /> : <Waiting lines={5} text={onboarding && !onboarding.model ? "Read once the model is ready." : "Reading your sent mail. What it shows appears here."} />
          ) : !facts.length ? (
            <p className="py-3 text-ink3">Nothing more to note.</p>
          ) : (
            <ul>
              {facts.map((f) => {
                const off = removed.has(f.id);
                return (
                  <li key={f.id} className="group flex min-h-10 items-center gap-3 border-b border-line-soft py-2">
                    <span className={`min-w-0 flex-1 leading-snug ${off ? "text-ink3 line-through decoration-ink4" : "text-ink2"}`}>{f.value}</span>
                    <button
                      type="button"
                      className={`link flex-none ${off ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"}`}
                      onClick={() => setRemoved((s) => (s.has(f.id) ? new Set([...s].filter((x) => x !== f.id)) : new Set(s).add(f.id)))}
                    >
                      {off ? "Keep" : "Remove"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Role" note={learnedRole ? "From your sent mail" : undefined}>
          <input className="input h-9" value={roleValue} onChange={(e) => setRole(e.target.value)} placeholder="Such as Head of sales at Acme" spellCheck={false} />
        </Field>
        <Field label="Working on" note={learnedWork ? "From your sent mail" : undefined}>
          <textarea className="input min-h-[60px] resize-none" rows={2} value={workValue} onChange={(e) => setWork(e.target.value)} placeholder="Such as the spring launch and hiring two engineers" />
        </Field>
        <Field label="Never tell me about">
          <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-[7px] bg-field px-1.5 py-1 focus-within:shadow-[0_0_0_2px_color-mix(in_oklch,var(--wax)_55%,transparent)]">
            {topics.map((t) => (
              <span key={t} className="inline-flex h-6 items-center gap-1 rounded-md bg-raised pl-2 pr-1 text-[12.5px] text-ink shadow-control">
                {t}
                <button type="button" className="grid h-4 w-4 place-items-center rounded text-ink3 hover:text-ink" aria-label={`Remove ${t}`} onClick={() => setNever(topics.filter((x) => x !== t))}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
            <input
              className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-[13px] text-ink outline-none"
              value={draft}
              onChange={(e) => (e.target.value.endsWith(",") ? addTopic(e.target.value) : setDraft(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTopic(draft);
                } else if (e.key === "Backspace" && !draft && topics.length) setNever(topics.slice(0, -1));
              }}
              onBlur={() => draft.trim() && addTopic(draft)}
              placeholder={topics.length ? "" : "Such as crypto, webinars, recruiters"}
              aria-label="Topics you never want to hear about"
            />
          </div>
        </Field>
        {failed && <p className="text-danger">{failed}</p>}
      </div>
    </Step>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="label">{label}</span>
        {note && <span className="text-xs text-ink3">{note}</span>}
      </span>
      {children}
    </label>
  );
}

// ── Examples from their own mail ────────────────────────────────────────────

type Example = {
  key: string;
  kind: "todo" | "meeting" | "followup" | "newsletter";
  what: string;
  quote: string | null;
  who: string;
  address: string;
  subject: string;
  at: string | null;
  emailId: string | null;
};
type Answer = "yes" | "no" | "never";

const MOST = 10;
const ASKED = "tabellar_first_run_answers";
const QUESTION: Record<Example["kind"], string> = {
  todo: "Add this todo?",
  meeting: "Propose this meeting?",
  followup: "Follow up here?",
  newsletter: "Treat as a newsletter?",
};

function loadAnswers(): Record<string, Answer> {
  try {
    return JSON.parse(localStorage.getItem(ASKED) || "{}");
  } catch {
    return {};
  }
}

const firstName = (who: string) => (who.includes("@") ? who.split("@")[0] : who.split(/\s+/)[0]);
const ago = (iso: string | null) => {
  if (!iso) return "";
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

function detail(e: Example): string {
  if (e.kind === "followup") return `You wrote to ${e.who} ${ago(e.at)}, no answer yet`;
  if (e.kind === "newsletter") return e.quote ?? e.address;
  if (e.kind === "meeting") return `${when(e.at)}, from ${e.who}`;
  return `From ${e.who}${e.subject ? `, "${e.subject}"` : ""}`;
}

export function ExamplesStep({ onNext }: { onNext: () => void }) {
  const { onboarding } = useContext(FlowContext);
  const readDone = onboarding?.read.step === "done";
  const [list, setList] = useState<Example[]>([]);
  const [answers, setAnswers] = useState<Record<string, Answer>>(loadAnswers);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const full = useRef(false);

  // New examples are added below as the mail is sorted; the ones shown stay put.
  const { value } = usePoll(() => api<{ examples: Example[] }>("/onboarding/examples"), 4000, () => !full.current);
  useEffect(() => {
    if (!value) return;
    setList((prev) => {
      const have = new Set(prev.map((e) => e.key));
      const all = [...prev, ...value.examples.filter((e) => !have.has(e.key))].slice(0, MOST);
      full.current = all.length >= MOST;
      return all;
    });
  }, [value]);

  const answer = async (e: Example, a: Answer) => {
    setBusy(e.key);
    setFailed("");
    try {
      await api("/onboarding/examples/answer", { kind: e.kind, address: e.address, emailId: e.emailId, answer: a });
      // Added to what is there by then: answers come faster than they are kept.
      setAnswers((now) => {
        const next = { ...now, [e.key]: a };
        try {
          localStorage.setItem(ASKED, JSON.stringify(next));
        } catch {
          // Kept for this window only.
        }
        return next;
      });
    } catch (err) {
      setFailed((err as Error).message);
    }
    setBusy(null);
  };

  const answered = list.filter((e) => answers[e.key]).length;
  const waiting = !readDone && list.length < 6;
  return (
    <Step
      title="Would you want these?"
      text="Examples from your own mail, of what Tabellar would do. Your answers decide what it does from now on; Never covers everything from that sender."
      actions={
        <button type="button" className="btn btn-pri h-8 px-3.5" onClick={onNext}>
          Continue
        </button>
      }
      aside={
        <div>
          <Heading title="From your mail" note={list.length ? `${answered} of ${list.length} answered` : undefined} />
          <ul>
            {list.map((e) => {
              const a = answers[e.key];
              return (
                <li key={e.key} className="ob-enter grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 border-b border-line-soft py-3">
                  <div className="min-w-0">
                    <p className="text-xs text-ink3">{QUESTION[e.kind]}</p>
                    <p className={`mt-0.5 truncate text-[14px] font-medium ${a ? "text-ink2" : "text-ink"}`} title={e.what}>
                      {e.kind === "followup" ? `"${e.what}"` : e.what}
                    </p>
                    <p className="mt-0.5 truncate text-[12.5px] text-ink3" title={detail(e)}>
                      {detail(e)}
                    </p>
                  </div>
                  {a ? (
                    <span className="text-[12.5px] text-ink2">
                      {a === "yes" ? "Yes" : a === "no" ? "No" : `Never for ${firstName(e.who)}`}
                    </span>
                  ) : (
                    <div className="grid grid-cols-[auto_auto_132px] items-center gap-1.5">
                      <button type="button" className="btn btn-sm" disabled={busy === e.key} onClick={() => answer(e, "yes")}>
                        Yes
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy === e.key} onClick={() => answer(e, "no")}>
                        No
                      </button>
                      {e.kind !== "newsletter" && (
                        <button type="button" className="btn btn-plain btn-sm !block max-w-full justify-self-start truncate" disabled={busy === e.key} onClick={() => answer(e, "never")}>
                          Never for {firstName(e.who)}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {waiting && <Waiting lines={noModel(onboarding) ? 0 : list.length ? 2 : 4} text={noModel(onboarding) ? NEEDS_MODEL : onboarding && !onboarding.model ? "Examples appear once the model is ready and your mail is sorted." : "More appear here as your mail is sorted."} />}
          {!waiting && !list.length && <p className="py-3 text-ink3">Nothing to ask about yet. Tabellar asks in the Brief when it needs to.</p>}
          {failed && <p className="mt-2 text-xs text-danger">{failed}</p>}
        </div>
      }
    />
  );
}

// ── People and labels ───────────────────────────────────────────────────────

type Person = { address: string; name: string; sent: number; received: number; vip: boolean };
type Suggestion = { name: string; description: string; senders: string[]; count: number };

export function PeopleStep({ onNext }: { onNext: () => void }) {
  const { onboarding, userId } = useContext(FlowContext);
  const readDone = onboarding?.read.step === "done";
  const done = useRef(readDone);
  done.current = readDone;
  const people = usePoll(() => api<{ people: Person[] }>("/onboarding/people"), 5000, (v) => !done.current && (v?.people.length ?? 0) < 8);
  const labels = usePoll(() => api<{ suggestions: Suggestion[] | null }>("/onboarding/labels"), 4000, (v) => !v?.suggestions);
  const [vip, setVip] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState("");

  const toggleVip = async (p: Person, on: boolean) => {
    setVip((v) => ({ ...v, [p.address]: on }));
    try {
      await api("/onboarding/people", { address: p.address, vip: on });
    } catch (e) {
      setVip((v) => ({ ...v, [p.address]: !on }));
      setFailed((e as Error).message);
    }
  };

  const save = async () => {
    setSaving(true);
    setFailed("");
    try {
      const supabase = createClient();
      const list = labels.value?.suggestions ?? [];
      const { data: existing } = await supabase.from("categories").select("display_name").eq("user_id", userId);
      const taken = new Set(((existing ?? []) as { display_name: string }[]).map((l) => l.display_name.toLowerCase()));
      let position = taken.size;
      for (const s of list) {
        if (dropped.has(s.name)) {
          await api("/labels/suggestions/dismiss", { name: s.name });
          continue;
        }
        const name = (names[s.name] ?? s.name).trim() || s.name;
        if (taken.has(name.toLowerCase())) continue;
        const { error } = await supabase.from("categories").insert({
          user_id: userId, slug: slugOf(name), display_name: name, description: s.description,
          color: LABEL_COLORS[position % LABEL_COLORS.length].hex, examples: s.senders.map((sender) => ({ sender })), position,
        });
        if (error) throw new Error(`The label "${name}" was not added: ${error.message}`);
        await api("/labels/suggestions/dismiss", { name: s.name });
        taken.add(name.toLowerCase());
        position++;
      }
      onNext();
    } catch (e) {
      setFailed((e as Error).message);
    }
    setSaving(false);
  };

  const list = people.value?.people ?? [];
  const suggestions = labels.value?.suggestions;
  return (
    <Step
      title="People and labels"
      text="Tick the people who matter most: their mail counts as important. Keep the labels you want, and click a name to change it."
      actions={
        <button type="button" className="btn btn-pri h-8 px-3.5" disabled={saving} onClick={save}>
          {saving ? "Saving" : "Continue"}
        </button>
      }
      aside={
        <div className="grid gap-x-12 gap-y-10 xl:grid-cols-2">
          <div className="min-w-0">
            <Heading title="People you deal with most" />
            {!list.length ? (
              people.value && readDone ? (
                <p className="py-3 text-ink3">No one yet.</p>
              ) : (
                <Waiting lines={5} text="Worked out from who you write to and answer." />
              )
            ) : (
              <ul>
                {list.map((p) => {
                  const on = vip[p.address] ?? p.vip;
                  return (
                    <li key={p.address} className="flex h-10 items-center gap-3 border-b border-line-soft">
                      <Tick checked={on} onChange={(v) => toggleVip(p, v)} label={`${p.name} matters`} />
                      <span className="min-w-0 flex-1 truncate" title={p.address}>
                        <span className={on ? "font-medium text-ink" : "text-ink"}>{p.name}</span>
                        {p.name !== p.address && <span className="ml-2 text-ink3">{p.address.split("@")[1]}</span>}
                      </span>
                      {p.sent > 0 && <span className="flex-none text-xs text-ink3">{p.sent} sent</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="min-w-0">
            <Heading title="Suggested labels" />
            {!suggestions ? (
              <Waiting lines={noModel(onboarding) ? 0 : 4} text={noModel(onboarding) ? NEEDS_MODEL : onboarding && !onboarding.model ? "Suggested once the model is ready." : "Suggested from who writes to you and about what, once enough mail is read."} />
            ) : !suggestions.length ? (
              <p className="py-3 text-ink3">None to suggest. Labels can be made any time in Labels.</p>
            ) : (
              <ul>
                {suggestions.map((s) => {
                  const kept = !dropped.has(s.name);
                  return (
                    <li key={s.name} className="flex items-start gap-3 border-b border-line-soft py-2.5">
                      <span className="pt-[5px]">
                        <Tick checked={kept} onChange={(v) => setDropped((d) => (v ? new Set([...d].filter((x) => x !== s.name)) : new Set(d).add(s.name)))} label={`Keep ${s.name}`} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <input
                          className={`-ml-1 h-7 w-full rounded-md bg-transparent px-1 font-medium outline-none transition-colors duration-150 hover:bg-hover focus:bg-field ${kept ? "text-ink" : "text-ink3 line-through"}`}
                          value={names[s.name] ?? s.name}
                          onChange={(e) => setNames((n) => ({ ...n, [s.name]: e.target.value }))}
                          disabled={!kept}
                          aria-label={`Name of the label ${s.name}`}
                          spellCheck={false}
                        />
                        <span className="block text-[12.5px] leading-snug text-ink3">{s.description}</span>
                      </span>
                      <span className="flex-none pt-1.5 text-xs text-ink3">{s.count.toLocaleString()} emails</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {failed && <p className="mt-2 text-xs text-danger">{failed}</p>}
          </div>
        </div>
      }
    />
  );
}
