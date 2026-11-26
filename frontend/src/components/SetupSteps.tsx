import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import Icon from "@/components/Icon";
import { Tick, initials } from "@/components/ui";
import { createClient } from "@/lib/db";
import { LABEL_COLORS, slugOf } from "@/lib/labelColors";
import { api, formatBytes, type Onboarding } from "@/lib/setup";
import { useTimeLeft } from "./ModelSetup";

// The frame every first-run step is set in, and the steps that use the mail
// read meanwhile: About you, Examples, and People and labels. The flow itself
// is in Welcome.tsx.

export type Flow = {
  header: ReactNode;
  // The steps there are and the one shown; none on the welcome screen.
  steps: { title: string; state: "done" | "now" | "later"; go?: () => void }[];
  onboarding: Onboarding | null;
  back?: () => void;
  userId: string | null;
};
export const FlowContext = createContext<Flow>({ header: null, steps: [], onboarding: null, userId: null });

// One step: the question and its controls on paper at the left, and at the
// right the stage, a sheet of wax in the accent, where what the answer does is
// laid out. What is being read meanwhile runs along the foot of the stage. On
// a narrow window the stage comes under the question.
export function Step({ title, text, children, stage, actions, big }: { title: string; text: ReactNode; children?: ReactNode; stage?: ReactNode; actions?: ReactNode; big?: boolean }) {
  const { header, steps, onboarding, back } = useContext(FlowContext);
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-canvas text-ink lg:flex-row lg:overflow-hidden">
      <section className="flex flex-none flex-col lg:w-[44%] lg:min-w-[440px] lg:max-w-[600px]">
        <header className="flex h-[72px] flex-none items-center gap-6 px-6 sm:px-10 lg:px-14">{header}</header>
        <main className="flex min-h-0 flex-1 flex-col px-6 sm:px-10 lg:overflow-y-auto lg:px-14">
          <div key={title} className="ob-enter my-auto w-full max-w-[460px] py-6">
            {steps.length > 0 && <Steps steps={steps} />}
            {title && <h1 className={`font-brand font-[600] leading-[1.04] tracking-[-0.012em] text-ink [text-wrap:balance] ${big ? "text-[54px]" : "text-[40px]"}`}>{title}</h1>}
            <div className="mt-4 max-w-[44ch] text-[15px] leading-[1.55] text-ink2 [text-wrap:pretty]">{text}</div>
            {children && <div className="mt-8">{children}</div>}
            {big && <div className="mt-9">{actions}</div>}
          </div>
        </main>
        {!big && (actions || back) && (
          <footer className="flex min-h-[84px] flex-none flex-wrap items-center gap-2 px-6 py-4 max-lg:order-last max-lg:sticky max-lg:bottom-0 max-lg:z-10 max-lg:bg-canvas sm:px-10 lg:px-14">
            {actions}
            <span className="flex-1" />
            {back && (
              <button type="button" className="btn btn-plain h-10 px-3 text-[14px]" onClick={back}>
                Back
              </button>
            )}
          </footer>
        )}
      </section>
      <aside className="stage relative flex min-h-[320px] flex-1 flex-col overflow-hidden lg:m-2 lg:ml-0 lg:rounded-[18px]">
        <Tablets />
        <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-8 sm:px-10 lg:px-[clamp(32px,5vw,80px)] lg:py-12">
          <div key={title} className="stage-enter my-auto w-full">
            {stage}
          </div>
        </div>
        <Live o={onboarding} />
      </aside>
    </div>
  );
}

// The primary button of a step.
export function Go({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="btn btn-pri h-10 rounded-[10px] px-5 text-[14px]" {...props}>
      {children}
    </button>
  );
}

// How far along: one tablet a step, sealed once done, each with its name.
function Steps({ steps }: { steps: Flow["steps"] }) {
  return (
    <ol className="mb-7 flex gap-1.5" aria-label="Steps">
      {steps.map((s) => (
        <li key={s.title} className="flex-1 sm:max-w-[56px]">
          <button
            type="button"
            title={s.title}
            aria-label={s.title}
            aria-current={s.state === "now" ? "step" : undefined}
            disabled={!s.go}
            onClick={s.go}
            className="group flex h-5 w-full items-center"
          >
            <span className={`h-[5px] w-full rounded-full transition-colors duration-300 ${s.state === "done" ? "bg-wax group-enabled:group-hover:bg-wax-ink" : s.state === "now" ? "bg-ink" : "bg-sel group-enabled:group-hover:bg-ink4"}`} />
          </button>
        </li>
      ))}
    </ol>
  );
}

// The mark, large and cropped, pressed into the wax.
function Tablets() {
  return (
    <svg aria-hidden viewBox="0 0 100 100" className="pointer-events-none absolute -bottom-[16%] -right-[14%] h-[92%] max-h-[900px] text-black opacity-[0.09]">
      <rect width="100" height="33" rx="5" fill="currentColor" />
      <rect y="40" width="46.5" height="60" rx="5" fill="currentColor" />
      <rect x="53.5" y="40" width="46.5" height="60" rx="5" fill="currentColor" />
    </svg>
  );
}

// A sheet of paper on the stage.
export function Sheet({ title, note, children, className = "" }: { title?: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`mx-auto w-full max-w-[600px] rounded-[16px] bg-canvas px-6 pb-5 pt-5 text-ink shadow-pop sm:px-7 ${className}`}>
      {title && (
        <div className="mb-2 flex items-baseline justify-between gap-4">
          <h2 className="font-brand text-[21px] font-[620] leading-tight text-ink">{title}</h2>
          {note && <span className="text-xs text-ink3">{note}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

// What the server is doing meanwhile: the model download, then the first
// read (headers of 90 days, the sent mail, the last 30 days sorted).
function Live({ o }: { o: Onboarding | null }) {
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
  if (r.error) items.push(<LiveItem key="read" label={`Reading stopped: ${r.error.replace(/\.+$/, "")}. It starts again on its own.`} failed />);
  else if (r.step === "headers") items.push(r.headers_total ? <LiveItem key="read" label="Reading the last 90 days" pct={(r.headers / r.headers_total) * 100} numbers={`${n(r.headers)} of ${n(r.headers_total)} emails`} /> : <LiveItem key="read" label="Connecting to your mailbox" pct={null} />);
  else if (r.step === "sent") items.push(o.model ? <LiveItem key="read" label={r.learned ? "Working out labels to suggest" : "Learning from your sent mail"} pct={null} /> : <LiveItem key="read" label={`${n(r.headers_total || r.headers)} emails listed. ${noModel(o) ? "Sorting needs a model." : "Sorting starts once the model is ready."}`} />);
  else if (r.step === "deep") items.push(r.deep_total ? <LiveItem key="read" label="Sorting your recent mail" pct={(r.deep / r.deep_total) * 100} numbers={`${n(r.deep)} of ${n(r.deep_total)}`} /> : <LiveItem key="read" label="Fetching your recent mail" pct={null} />);
  else items.push(<LiveItem key="read" label={`Your mail is read: ${n(o.sorted)} emails sorted`} done />);
  if (r.step === "headers" && o.model && !r.learned && !r.error) items.push(<LiveItem key="sent" label="Learning from your sent mail" pct={null} />);
  return <div className="relative flex min-h-[64px] flex-none flex-wrap items-center gap-x-8 gap-y-1.5 px-5 py-4 sm:px-10 lg:px-[clamp(32px,5vw,80px)]">{items}</div>;
}

function LiveItem({ label, pct, numbers, failed, done }: { label: string; pct?: number | null; numbers?: string; failed?: boolean; done?: boolean }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-3 text-white" role="status" aria-live="polite">
      {done ? <Icon name="check" size={15} /> : failed ? <Icon name="warning" size={15} /> : null}
      <span className={`min-w-0 text-[13px] ${failed ? "leading-snug" : "truncate"}`}>{label}</span>
      {pct !== undefined && (
        <span className="relative h-[3px] w-28 flex-none overflow-hidden rounded-full bg-white/30">
          {pct === null ? <span className="ob-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-white" /> : <span className="block h-full rounded-full bg-white transition-[width] duration-300 ease-out" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />}
        </span>
      )}
      {numbers && <span className="flex-none text-[12.5px] text-white/80">{numbers}</span>}
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
      text="Kept in mind for every email. It fills in from your sent mail; change anything that is off."
      actions={
        <Go disabled={saving} onClick={save}>
          {saving ? "Saving" : "Continue"}
        </Go>
      }
      stage={
        <Sheet title="From your sent mail" note={about?.learned ? `${about.sent.toLocaleString()} emails read` : undefined}>
          {reading ? (
            noModel(onboarding) ? <Waiting lines={0} text={NEEDS_MODEL} /> : <Waiting lines={5} text={onboarding && !onboarding.model ? "Read once the model is ready." : "Reading your sent mail. What it shows appears here."} />
          ) : !facts.length ? (
            <p className="py-2 text-ink3">Nothing more to note.</p>
          ) : (
            <ul className="lg:max-h-[52vh] lg:overflow-y-auto">
              {facts.map((f) => {
                const off = removed.has(f.id);
                return (
                  <li key={f.id} className="flex min-h-11 items-center gap-3 border-b border-line-soft py-2 last:border-0">
                    <span className={`min-w-0 flex-1 text-[14px] leading-snug ${off ? "text-ink3 line-through decoration-ink4" : "text-ink"}`}>{f.value}</span>
                    <button
                      type="button"
                      className="link flex-none"
                      aria-label={`${off ? "Keep" : "Remove"}: ${f.value}`}
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
        </Sheet>
      }
    >
      <div className="space-y-5">
        <Field label="Role" note={learnedRole ? "From your sent mail" : undefined}>
          <input className="input h-10 text-[14px]" value={roleValue} onChange={(e) => setRole(e.target.value)} placeholder="Such as Head of sales at Acme" spellCheck={false} />
        </Field>
        <Field label="Working on" note={learnedWork ? "From your sent mail" : undefined}>
          <textarea className="input min-h-[64px] resize-none text-[14px]" rows={2} value={workValue} onChange={(e) => setWork(e.target.value)} placeholder="Such as the spring launch and hiring two engineers" />
        </Field>
        <Field label="Never tell me about">
          <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-[8px] bg-field px-1.5 py-1 focus-within:shadow-[0_0_0_2px_color-mix(in_oklch,var(--wax)_55%,transparent)]">
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
const ANSWERED: Record<Answer, string> = { yes: "Yes", no: "No", never: "Never" };

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

  const answered = list.filter((e) => answers[e.key]);
  const now = list.find((e) => !answers[e.key]);
  const left = list.length - answered.length;
  const waiting = !readDone && list.length < MOST;

  // Y, N and X answer the letter on top.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!now || busy || ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const a = ({ y: "yes", n: "no", x: "never" } as const)[ev.key.toLowerCase() as "y" | "n" | "x"];
      if (!a || (a === "never" && now.kind === "newsletter")) return;
      ev.preventDefault();
      void answer(now, a);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <Step
      title="Would you want these?"
      text="From your own mail: what Tabellar would do. Your answers decide what it does from now on."
      actions={
        now && !answered.length ? (
          <button type="button" className="btn h-10 rounded-[10px] px-5 text-[14px]" onClick={onNext}>
            Skip
          </button>
        ) : (
          <Go onClick={onNext}>Continue</Go>
        )
      }
      stage={
        now ? (
          <div className="mx-auto w-full max-w-[560px]">
            <div className="relative">
              {/* The letters under the one on top. */}
              {left > 2 && <span aria-hidden className="absolute inset-x-7 -bottom-4 top-6 rounded-[16px] bg-canvas opacity-35" />}
              {left > 1 && <span aria-hidden className="absolute inset-x-3.5 -bottom-2 top-3 rounded-[16px] bg-canvas opacity-60" />}
              <div key={now.key} className="deal relative flex min-h-[200px] flex-col rounded-[16px] bg-canvas px-7 pb-6 pt-6 text-ink shadow-pop">
                <p className="flex items-baseline justify-between gap-4 text-[13px] text-ink3">
                  <span className="font-medium text-wax-ink">{QUESTION[now.kind]}</span>
                  <span>{left === 1 ? "Last one" : `${left} left`}</span>
                </p>
                <p className="mt-4 font-brand text-[27px] font-[600] leading-[1.15] text-ink [overflow-wrap:anywhere] [text-wrap:balance]">{now.kind === "followup" ? `"${now.what}"` : now.what}</p>
                <p className="mt-3 text-[14px] leading-snug text-ink2">{detail(now)}</p>
                {now.quote && now.kind !== "newsletter" && now.quote !== now.what && <p className="mt-2 line-clamp-3 text-[13px] leading-snug text-ink3">"{now.quote}"</p>}
              </div>
            </div>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-2.5" role="group" aria-label={QUESTION[now.kind]}>
              <button type="button" className="btn h-12 min-w-[112px] justify-center rounded-lg px-6 text-[15px]" disabled={busy === now.key} onClick={() => answer(now, "yes")} title="Y">
                <Icon name="check" size={17} />
                Yes
              </button>
              <button type="button" className="btn h-12 min-w-[112px] justify-center rounded-lg px-6 text-[15px]" disabled={busy === now.key} onClick={() => answer(now, "no")} title="N">
                <Icon name="close" size={17} />
                No
              </button>
              {now.kind !== "newsletter" && (
                <button type="button" className="h-12 max-w-[240px] truncate rounded-lg px-5 text-[15px] text-white transition-colors duration-150 hover:bg-white/15 disabled:opacity-50" disabled={busy === now.key} onClick={() => answer(now, "never")} title="X">
                  Never for {firstName(now.who)}
                </button>
              )}
            </div>
            {failed && <p className="mt-4 text-center text-[13px] text-white">{failed}</p>}
          </div>
        ) : (
          <Sheet>
            {waiting ? (
              <Waiting lines={noModel(onboarding) ? 0 : 4} text={noModel(onboarding) ? NEEDS_MODEL : onboarding && !onboarding.model ? "Examples appear once the model is ready and your mail is sorted." : answered.length ? "More appear here as your mail is sorted." : "The first ones appear here as your mail is sorted."} />
            ) : (
              <p className="py-2 text-[14px] text-ink2">{answered.length ? "That is all of them." : "Nothing to ask about yet. Tabellar asks in the Brief when it needs to."}</p>
            )}
          </Sheet>
        )
      }
    >
      {answered.length > 0 && (
        <ul className="border-t border-line-soft" aria-label="Answered">
          {answered
            .slice(-5)
            .reverse()
            .map((e) => (
              <li key={e.key} className="ob-enter flex h-10 items-center gap-3 border-b border-line-soft">
                <span className={`w-[46px] flex-none text-[13px] ${answers[e.key] === "yes" ? "font-medium text-ink" : "text-ink3"}`}>{ANSWERED[answers[e.key]]}</span>
                <span className="min-w-0 flex-1 truncate text-ink2" title={e.what}>
                  {e.what}
                </span>
              </li>
            ))}
        </ul>
      )}
    </Step>
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
      title="Who matters most?"
      text="Their mail counts as important, always."
      actions={
        <Go disabled={saving} onClick={save}>
          {saving ? "Saving" : "Continue"}
        </Go>
      }
      stage={
        <Sheet title="Labels to keep" note={suggestions?.length ? "Click a name to change it" : undefined}>
          {!suggestions ? (
            <Waiting lines={noModel(onboarding) ? 0 : 4} text={noModel(onboarding) ? NEEDS_MODEL : onboarding && !onboarding.model ? "Suggested once the model is ready." : "Suggested from who writes to you and about what, once enough mail is read."} />
          ) : !suggestions.length ? (
            <p className="py-2 text-ink3">None to suggest. Labels can be made any time in Labels.</p>
          ) : (
            <ul className="lg:max-h-[56vh] lg:overflow-y-auto">
              {suggestions.map((s) => {
                const kept = !dropped.has(s.name);
                return (
                  <li key={s.name} className="flex items-start gap-3 border-b border-line-soft py-3 last:border-0">
                    <span className="pt-[5px]">
                      <Tick checked={kept} onChange={(v) => setDropped((d) => (v ? new Set([...d].filter((x) => x !== s.name)) : new Set(d).add(s.name)))} label={`Keep ${s.name}`} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <input
                        className={`-ml-1 h-7 w-full rounded-md bg-transparent px-1 text-[14px] font-medium outline-none transition-colors duration-150 hover:bg-hover focus:bg-field ${kept ? "text-ink" : "text-ink3 line-through"}`}
                        value={names[s.name] ?? s.name}
                        onChange={(e) => setNames((n) => ({ ...n, [s.name]: e.target.value }))}
                        disabled={!kept}
                        aria-label={`Name of the label ${s.name}`}
                        spellCheck={false}
                      />
                      <span className="block text-[13px] leading-snug text-ink3">{s.description}</span>
                    </span>
                    <span className="flex-none pt-1.5 text-xs text-ink3">{s.count.toLocaleString()} emails</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Sheet>
      }
    >
      {!list.length ? (
        people.value && readDone ? (
          <p className="text-ink3">No one yet.</p>
        ) : (
          <Waiting lines={5} text="Worked out from who you write to and answer." />
        )
      ) : (
        <ul className="-mx-2">
          {list.map((p) => {
            const on = vip[p.address] ?? p.vip;
            return (
              <li key={p.address}>
                <label className={`flex h-12 items-center gap-3 rounded-[10px] px-2 transition-colors duration-150 ${on ? "bg-sel" : "hover:bg-hover"}`}>
                  <span aria-hidden className={`grid h-8 w-8 flex-none place-items-center rounded-full text-[12px] font-semibold ${on ? "bg-ink text-canvas" : "bg-field text-ink2"}`}>{initials(p.name)}</span>
                  <span className="min-w-0 flex-1 truncate" title={p.address}>
                    <span className={`text-[14px] text-ink ${on ? "font-medium" : ""}`}>{p.name}</span>
                    {p.name !== p.address && <span className="ml-2 text-ink3">{p.address.split("@")[1]}</span>}
                  </span>
                  <Tick checked={on} onChange={(v) => toggleVip(p, v)} label={`${p.name} matters most`} />
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {failed && <p className="mt-2 text-xs text-danger">{failed}</p>}
    </Step>
  );
}
