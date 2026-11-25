import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Logo from "@/components/Logo";
import { Glyph, initials } from "@/components/ui";
import type { Session } from "@/lib/db";
import { here, host, vault } from "@/lib/host";
import { appearanceOf, applyAppearance, useTheme, type ThemeChoice } from "@/lib/appearance";
import { api, formatBytes, setupPost, type Onboarding, type SetupState } from "@/lib/setup";
import { CloudPanel, ErrorLine, Icon, LocalPanel, localPair, modelLabel, ProgressBar, RadioDot, ui, useLocalJob, useSetupState, useTimeLeft } from "./ModelSetup";
import AddMailbox, { SignIn } from "./AddMailbox";
import { AboutStep, ExamplesStep, FlowContext, Go, PeopleStep, Sheet, Step } from "./SetupSteps";
import { confirmLevel, type Level } from "./Sidebar";

// The first run: what Tabellar is, the mailboxes (the first read starts the
// moment one is connected), the model, then About you, examples from the
// user's own mail and People and labels while that mail is read, and last
// the level. One decision per screen; every step after the mailboxes can be
// skipped and none waits on the model. The step is kept on the server
// (profiles.onboarding), so a sign-in that leaves the window, or a restart,
// comes back to it. Settings opens the same steps again (`again`), from the
// mailboxes on, without holding the engine.

type StepId = "welcome" | "mailboxes" | "model" | "about" | "examples" | "people" | "level";
const STEPS: { id: Exclude<StepId, "welcome">; title: string }[] = [
  { id: "mailboxes", title: "Mail" },
  { id: "model", title: "Model" },
  { id: "about", title: "About you" },
  { id: "examples", title: "Examples" },
  { id: "people", title: "People" },
  { id: "level", title: "Level" },
];
const ORDER: StepId[] = ["welcome", ...STEPS.map((s) => s.id)];

// Past the welcome screen, before any mailbox (and so any profile) exists.
const WELCOMED = "tabellar_welcomed";
// Set before a sign-in that leaves the window during the steps opened again
// from Settings, so the window comes back to them.
export const AGAIN = "tabellar:setup-again";

const store = (fn: () => void) => {
  try {
    fn();
  } catch {
    // Storage blocked: the window then opens on the server's step.
  }
};

type AccountRow = { id: string; provider: string; choice: string; address: string };

function useAccounts(on: boolean) {
  const [list, setList] = useState<AccountRow[]>([]);
  const reload = useCallback(async () => {
    if (!on) return;
    const r = await api<{ accounts: AccountRow[] }>("/accounts").catch(() => null);
    if (r) setList(r.accounts);
  }, [on]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { list, reload };
}

// The server's first-run state, every two seconds.
function useOnboarding(on: boolean): Onboarding | null {
  const [o, setO] = useState<Onboarding | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () => api<Onboarding>("/onboarding").then((v) => live && setO(v), () => {});
    load();
    const id = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [on]);
  return o;
}

function firstStep(session: Session | undefined, again: boolean): StepId {
  const p = session?.profile;
  if (again) return "mailboxes";
  if (!p) {
    let welcomed = false;
    store(() => (welcomed = localStorage.getItem(WELCOMED) === "1"));
    return welcomed ? "mailboxes" : "welcome";
  }
  if (!session!.accounts) return "mailboxes";
  return (STEPS.find((s) => s.id === p.onboarding)?.id ?? "mailboxes") as StepId;
}

export default function Welcome({ session, error, again = false }: { session?: Session; error?: string; again?: boolean }) {
  // The system's theme during the first run, the user's own look when the
  // steps are opened again.
  useTheme(again ? ((session?.profile?.theme as ThemeChoice | undefined) ?? "auto") : "auto");
  useLayoutEffect(() => {
    if (again) applyAppearance(appearanceOf(session?.profile as { appearance?: unknown } | null));
  }, [again]);
  const { state, error: stateError, refresh } = useSetupState();
  const profile = session?.profile ?? null;
  const userId = session?.user?.id ?? null;
  const [step, setStep] = useState<StepId>(() => firstStep(session, again));
  // Opened again, every step was already done.
  const [reached, setReached] = useState(() => (again ? ORDER.length : ORDER.indexOf(step)));
  const accounts = useAccounts(!!profile);
  const onboarding = useOnboarding(!!profile && step !== "welcome");

  const go = useCallback(
    (next: StepId) => {
      setStep(next);
      setReached((r) => Math.max(r, ORDER.indexOf(next)));
      if (next !== "welcome") store(() => localStorage.setItem(WELCOMED, "1"));
      if (profile && !again && next !== "welcome") api("/onboarding/step", { step: next }).catch(() => {});
    },
    [profile, again],
  );
  const at = ORDER.indexOf(step);
  const next = () => go(ORDER[Math.min(at + 1, ORDER.length - 1)]);
  const previous = at > (again || profile ? 1 : 0) ? () => go(ORDER[at - 1]) : undefined;

  const header = (
    <>
      <Logo size={25} />
      {again && (
        <a href="/" className="link ml-auto">
          Back to Tabellar
        </a>
      )}
    </>
  );
  const steps =
    step === "welcome"
      ? []
      : STEPS.map((s, i) => {
          const n = i + 1;
          return { title: s.title, state: n < at ? ("done" as const) : n === at ? ("now" as const) : ("later" as const), go: !!profile && n <= reached && n !== at ? () => go(s.id) : undefined };
        });

  const failure = error ?? (!state ? stateError : "");
  let content: ReactNode;
  if (failure) content = <NotAnswering message={failure} />;
  else if (!state) content = <Loading />;
  else if (step === "welcome") content = <WelcomeStep onNext={next} />;
  else if (step === "mailboxes" || !profile)
    content = (
      <MailboxesStep
        state={state}
        refresh={refresh}
        accounts={accounts.list}
        reloadAccounts={accounts.reload}
        signedIn={!!profile}
        again={again}
        onNext={next}
      />
    );
  else if (step === "model") content = <ModelStep state={state} refresh={refresh} onNext={next} />;
  else if (step === "about") content = <AboutStep onNext={next} />;
  else if (step === "examples") content = <ExamplesStep onNext={next} />;
  else if (step === "people") content = <PeopleStep onNext={next} />;
  else content = <LevelStep again={again} current={String(profile.autonomy_level ?? "suggest")} />;

  return <FlowContext.Provider value={{ header, steps: failure || !state ? [] : steps, onboarding, back: failure || !state ? undefined : previous, userId }}>{content}</FlowContext.Provider>;
}

function Loading() {
  return <Step title="" text="" />;
}

// ── Welcome ─────────────────────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <Step
      big
      title="Tabellar handles your mail"
      text={
        <>
          Sorts it, drafts replies, keeps todos and meetings.
          <br />
          You decide how much it does on its own.
        </>
      }
      actions={
        <Go onClick={onNext} autoFocus>
          Get started
        </Go>
      }
      stage={<MorningPicture />}
    />
  );
}

// A morning's mail, each email a slip that ends in what was done with it. The
// slips are dealt one after another and each is then dealt with.
const PICTURE: { state: "need" | "going" | "done"; who: string; subject: string; status: string }[] = [
  { state: "need", who: "Maya Okafor", subject: "Contract for the March pilot", status: "Reply ready" },
  { state: "done", who: "Northwind Bank", subject: "Your statement is ready", status: "Filed" },
  { state: "done", who: "Sam Whitaker", subject: "Can you send the notes by Friday?", status: "Todo added" },
  { state: "going", who: "Daniel Reyes", subject: "Dinner on Thursday?", status: "Replying in 2:41" },
  { state: "need", who: "Priya Natarajan", subject: "Move the review to 3pm?", status: "Meeting to confirm" },
  { state: "done", who: "The Weekly Brief", subject: "Five things this week", status: "Newsletter" },
];

function MorningPicture() {
  return (
    <figure role="img" aria-label="Six emails, each ending in what Tabellar did with it" className="mx-auto grid w-full max-w-[560px] select-none gap-2.5">
      {PICTURE.map((r, i) => (
        <div key={r.who} aria-hidden className="slip flex h-[62px] items-center gap-3.5 rounded-[14px] bg-canvas px-4 text-ink shadow-pop" style={{ animationDelay: `${120 + i * 110}ms`, marginLeft: `${[0, 1.75, 0.5, 2.5, 1, 2][i]}rem`, marginRight: `${[2.5, 0.75, 2, 0, 1.5, 0.5][i]}rem` }}>
          <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-field text-[12.5px] font-semibold text-ink2">{initials(r.who)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-[650]">{r.who}</span>
            <span className="block truncate text-[13px] text-ink2">{r.subject}</span>
          </span>
          <span className={`slip-status flex flex-none items-center gap-1.5 text-[12.5px] max-sm:hidden ${r.state === "done" ? "text-ink3" : "font-medium text-ink"}`} style={{ animationDelay: `${900 + i * 260}ms` }}>
            <Glyph state={r.state} />
            {r.status}
          </span>
        </div>
      ))}
    </figure>
  );
}

// ── Mailboxes ───────────────────────────────────────────────────────────────

function MailboxesStep({ state, refresh, accounts, reloadAccounts, signedIn, again, onNext }: {
  state: SetupState;
  refresh: () => Promise<void>;
  accounts: AccountRow[];
  reloadAccounts: () => Promise<void>;
  signedIn: boolean;
  again: boolean;
  onNext: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [own, setOwn] = useState(false);
  const { onboarding } = useContext(FlowContext);
  const has = accounts.length > 0;
  const nameOf = (choice: string) => state.mailboxes.find((c) => c.id === choice)?.name ?? choice;
  const before = () =>
    store(() => {
      localStorage.setItem(WELCOMED, "1");
      if (again) sessionStorage.setItem(AGAIN, "1");
    });

  if (own) return <OwnGoogleClient state={state} refresh={refresh} onDone={() => setOwn(false)} />;

  const google = (
    <div>
      <SignIn href="/oauth/start" label="Sign in with Google" before={before} />
      <p className="mt-2.5 max-w-[46ch] text-xs leading-normal text-ink3">
        Google will say it has not verified {state.google.clientId ? "your app" : "Tabellar"}. Choose Advanced, then Go to Tabellar.
      </p>
    </div>
  );
  return (
    <Step
      title={has ? "Your mail" : "Add your mail"}
      text={has ? `${onboarding && onboarding.read.step !== "done" ? "It is being read now. " : ""}Add another mailbox, or carry on.` : "Reading starts as soon as one is connected. You can add more later."}
      actions={
        has && <Go onClick={onNext}>Continue</Go>
      }
      stage={<WhatStays />}
    >
      {has && (
        <ul className="mb-5 border-t border-line-soft">
          {accounts.map((a) => (
            <li key={a.id} className="flex h-12 items-center gap-2.5 border-b border-line-soft text-[14px]">
              <Glyph state="done" />
              <span className="min-w-0 flex-1 truncate text-ink">{a.address}</span>
              <span className="flex-none text-xs text-ink3">{nameOf(a.choice)}</span>
            </li>
          ))}
        </ul>
      )}
      {has && !adding ? (
        <button type="button" className="btn h-9 px-3.5" onClick={() => setAdding(true)}>
          <Icon name="add" size={15} />
          Add another
        </button>
      ) : (
        <AddMailbox
          state={state}
          refresh={refresh}
          google={google}
          beforeSignIn={before}
          onAdded={async () => {
            before();
            if (!signedIn) return window.location.reload();
            await reloadAccounts();
            setAdding(false);
          }}
        />
      )}
      <p className="mt-8">
        {!host.hosted && (
          <button type="button" className="link" onClick={() => setOwn(true)}>
            {state.google.clientId ? "Your own Google client" : "Advanced: use your own Google client"}
          </button>
        )}
      </p>
    </Step>
  );
}

function WhatStays() {
  const block = (icon: string, title: string, text: string) => (
    <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-4 border-b border-line-soft py-5 first:pt-2 last:border-0 last:pb-2">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-field text-ink2">
        <Icon name={icon} size={17} />
      </span>
      <div>
        <h2 className="font-brand text-[19px] font-[620] leading-tight text-ink">{title}</h2>
        <p className="mt-1.5 text-[14px] leading-[1.55] text-ink2">{text}</p>
      </div>
    </div>
  );
  return (
    <Sheet>
      {host.hosted
        ? block("home", "Stays on your server", "Your mail, keys and sign-ins, on a server of your own that Tabellar+ runs, on an encrypted disk. Whoever runs Tabellar+ looks after that server, so it is not out of their reach.")
        : block("home", `Stays on ${here()}`, `Your mail, in one file in your home folder. Keys and sign-in tokens, in ${vault()}. Nothing is hosted anywhere else.`)}
      {block("send", "Leaves it", `Calls to your mail provider, and to the model you choose. With a model on ${here()}, nothing else leaves at all.`)}
      {block("shield", "Never happens", "Mail deleted, archived on its own, or sent before you choose a level that allows it.")}
    </Sheet>
  );
}

// ── Your own Google client ──────────────────────────────────────────────────

const CONSOLE = "https://console.cloud.google.com";
const GOOGLE_STEPS: { title: string; detail: string; href: string }[] = [
  { title: "Create a project", detail: "Any name works, Tabellar is fine.", href: `${CONSOLE}/projectcreate` },
  {
    title: "Turn on the Gmail, Calendar and People APIs",
    detail: "One page enables all three for the project.",
    href: `${CONSOLE}/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,people.googleapis.com`,
  },
  {
    title: "Set up the consent screen",
    detail: "Name it Tabellar. Choose External and add your own address as a test user, or Internal on a Workspace account.",
    href: `${CONSOLE}/auth/overview`,
  },
  {
    title: "Create a Desktop app client",
    detail: "Pick Desktop app as the type, create it, then download the JSON file.",
    href: `${CONSOLE}/auth/clients/create`,
  },
];

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// For an organisation that blocks apps Google has not verified, or anyone who
// would rather sign in through a Google Cloud project of their own. The file
// Google gives is found in Downloads, Desktop or Documents, or dropped here.
function OwnGoogleClient({ state, refresh, onDone }: { state: SetupState; refresh: () => Promise<void>; onDone: () => void }) {
  const flow = useContext(FlowContext);
  const configured = !!state.google.clientId;
  const [trash, setTrash] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const found = state.google.file;

  // Keep looking for the download while the client is not saved.
  useEffect(() => {
    if (configured) return;
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [configured, refresh]);

  async function save(body: { path?: string; text?: string; trash?: boolean; builtIn?: boolean }) {
    setBusy(true);
    setError("");
    try {
      const r = await setupPost<{ warning?: string }>("/google", body);
      setWarning(r.warning ?? "");
      await refresh();
      if (body.builtIn) onDone();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  const readFile = async (f?: File | null) => {
    if (f) await save({ text: await f.text() });
  };

  return (
    <FlowContext.Provider value={{ ...flow, back: onDone }}>
      <div
        className="h-full"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          readFile(e.dataTransfer.files[0]);
        }}
      >
        <Step
          title="Your own Google client"
          text="For an organisation that blocks apps Google has not verified, or to sign in through a Google Cloud project you control. It takes about five minutes, once."
          actions={
            <Go onClick={onDone} disabled={!configured && !state.google.builtIn}>
              {configured ? "Use it to sign in" : "Done"}
            </Go>
          }
          stage={
            <Sheet>
            <ol>
              {GOOGLE_STEPS.map((s, i) => (
                <li key={s.title} className="grid grid-cols-[28px_minmax(0,1fr)] border-b border-line-soft py-3">
                  <span className="text-ink3">{i + 1}</span>
                  <div>
                    <a href={s.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-ink underline decoration-ink4 underline-offset-[2.5px] hover:decoration-ink2">
                      {s.title}
                      <Icon name="arrow_outward" size={13} className="text-ink3" />
                    </a>
                    <p className="mt-0.5 text-xs leading-normal text-ink2">{s.detail}</p>
                  </div>
                </li>
              ))}
              <li className="grid grid-cols-[28px_minmax(0,1fr)] py-3">
                <span className="text-ink3">{GOOGLE_STEPS.length + 1}</span>
                <p className="text-ink2">Give the downloaded file to Tabellar, here on the left.</p>
              </li>
            </ol>
            </Sheet>
          }
        >
          <div className={`-mx-3 rounded-[10px] px-3 py-2 transition-colors duration-150 ${dragging ? "bg-sel" : ""}`}>
            {configured ? (
              <div className="grid grid-cols-[22px_minmax(0,1fr)] items-start">
                <Glyph state="done" className="mt-px" />
                <div className="min-w-0">
                  <p className="font-medium text-ink">Your client is saved</p>
                  <p className="truncate font-mono text-xs text-ink3" title={state.google.clientId!}>
                    {state.google.clientId}
                  </p>
                  <p className="text-xs text-ink2">The secret is in {vault()}.</p>
                  {warning && <p className="mt-1 text-xs text-warn">{warning}</p>}
                </div>
              </div>
            ) : found ? (
              <div>
                <p className="font-medium text-ink">Found your client file</p>
                <p className="truncate font-mono text-xs text-ink3" title={found.path}>
                  {found.folder}/{found.name}
                </p>
                <p className="text-xs text-ink2">Saved {ago(found.modified)}</p>
                <label className="mt-2.5 flex items-center gap-2 text-ink2">
                  <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} />
                  Move the file to the Trash once it is in {vault()}
                </label>
                <button type="button" className={`${ui.btnPrimary} mt-4`} disabled={busy} onClick={() => save({ path: found.path, trash })}>
                  {busy ? "Saving" : "Use this file"}
                </button>
              </div>
            ) : (
              <p className="leading-normal text-ink2">Drop the client_secret file here, or choose it. Tabellar is also watching Downloads, Desktop and Documents and picks it up when it appears.</p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <button type="button" className={found || configured ? "link" : ui.btnSecondary} disabled={busy} onClick={() => fileInput.current?.click()}>
                {configured ? "Replace it" : found ? "Choose a different file" : "Choose the file"}
              </button>
              <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} />
              {configured && state.google.builtIn && (
                <button type="button" className="link" disabled={busy} onClick={() => save({ builtIn: true })}>
                  Use Tabellar's client instead
                </button>
              )}
            </div>
            <div className="mt-3">
              <ErrorLine text={error} />
            </div>
          </div>
        </Step>
      </div>
    </FlowContext.Provider>
  );
}

// ── Model ───────────────────────────────────────────────────────────────────

function BigChoice({ on, onClick, title, tag, detail }: { on: boolean; onClick: () => void; title: string; tag: string; detail: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`grid w-full grid-cols-[26px_minmax(0,1fr)] items-start rounded-[12px] px-4 py-3.5 text-left transition-[background-color,box-shadow] duration-150 ${on ? "bg-raised shadow-chosen" : "shadow-control hover:bg-hover"}`}
    >
      <RadioDot on={on} />
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="text-[15px] font-[650] text-ink">{title}</span>
          <span className="text-[12.5px] text-ink3">{tag}</span>
        </span>
        <span className="mt-1 block text-[13px] leading-snug text-ink2">{detail}</span>
      </span>
    </button>
  );
}

function ModelStep({ state, refresh, onNext }: { state: SetupState; refresh: () => Promise<void>; onNext: () => void }) {
  const pair = useMemo(() => localPair(state), [state]);
  const current = state.model;
  const [where, setWhere] = useState<"local" | "cloud">((current ? current.format !== "ollama" : !host.mac && !state.ollama.installed) ? "cloud" : "local");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState("");
  const { job, running, start } = useLocalJob(refresh);
  const left = useTimeLeft(job ?? undefined);
  const ready = !!current?.ready;
  const localReady = ready && current!.format === "ollama";
  const cloudReady = ready && current!.format !== "ollama";

  const choosing = !running && (where === "cloud" ? !cloudReady : advanced && !localReady);

  const go = async () => {
    setError("");
    if (where === "local" && !localReady && !running && !advanced) {
      try {
        await start({ careful: pair.careful, fast: pair.fast });
      } catch (e) {
        return setError((e as Error).message);
      }
    }
    onNext();
  };

  const installed = new Set(state.ollama.models.map((m) => m.name));
  const sizeOf = (name: string) => (installed.has(name) ? `On ${here()}` : formatBytes(state.local.choices.find((c) => c.name === name)?.size ?? 0));
  const localDetail = (
    <>
      {pair.fast ? `${pair.careful} writes, ${pair.fast} reads each email. ` : `${pair.careful} reads and writes. `}
      {pair.missing.length || !state.ollama.installed ? `${formatBytes(pair.download)} to download` : `Already on ${here()}`}
      {pair.minutes ? `; the first 300 emails take about ${pair.minutes} minutes.` : "."}
    </>
  );
  const label = where === "cloud" ? "Continue" : localReady || running || advanced ? "Continue" : pair.missing.length || !state.ollama.installed ? "Download and continue" : "Use and continue";

  return (
    <Step
      title="Where the model runs"
      text="The model reads every email and writes the drafts. You can change it later in Settings."
      actions={
        <>
          {((!ready && !running) || choosing) && (
            <button type="button" className={`btn h-10 px-4 text-[14px] ${choosing ? "" : "btn-plain order-1"}`} onClick={onNext}>
              Skip for now
            </button>
          )}
          {/* Until one is chosen in a panel, the panel has the one wax button. */}
          {!choosing && <Go onClick={go}>{label}</Go>}
        </>
      }
      stage={
        where === "cloud" ? (
          <Sheet title="Your provider">
            <CloudPanel state={state} slot="careful" current={current} refresh={refresh} />
          </Sheet>
        ) : advanced ? (
          <Sheet title="Models">
            <LocalPanel state={state} slot="careful" current={current} refresh={refresh} />
          </Sheet>
        ) : (
          <Sheet title={`Picked for ${here()}`}>
            <div>
              {[
                { what: pair.fast ? "Writes drafts" : "Reads and writes", name: pair.careful },
                ...(pair.fast ? [{ what: "Reads each email", name: pair.fast }] : []),
              ].map((r) => (
                <div key={r.name} className="grid min-h-12 grid-cols-[116px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line-soft text-[14px]">
                  <span className="text-ink3">{r.what}</span>
                  <span className="truncate font-mono text-[13px] text-ink">{r.name}</span>
                  <span className="text-xs text-ink3">{sizeOf(r.name)}</span>
                </div>
              ))}
              {!state.ollama.installed && (
                <div className="grid min-h-12 grid-cols-[116px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line-soft text-[14px]">
                  <span className="text-ink3">Runs them</span>
                  <span className="text-ink">Ollama, the free app for local models</span>
                  <span className="text-xs text-ink3">230 MB</span>
                </div>
              )}
            </div>
            <p className="mt-3 text-[12.5px] leading-normal text-ink3">
              For {state.local.memoryGb} GB of memory. Downloads once, then runs offline{state.local.small ? "; with this much memory a cloud model writes drafts faster and closer to your voice" : ""}.
            </p>
            {(running || localReady || job?.error) && (
              <div className="mt-6">
                {running ? (
                  <>
                    <ProgressBar label={job!.label} p={job!.total ? job! : undefined} note={left} />
                    <p className="mt-2 text-[12.5px] text-ink3">You can carry on; it keeps downloading.</p>
                  </>
                ) : localReady ? (
                  <p className="flex items-center gap-1.5 text-ink2">
                    <Glyph state="done" />
                    In use: {modelLabel(current, state.providers)}
                  </p>
                ) : (
                  <ErrorLine text={job!.error!} />
                )}
              </div>
            )}
          </Sheet>
        )
      }
    >
      <div role="radiogroup" aria-label="Where the model runs" className="space-y-2">
        <BigChoice on={where === "local"} onClick={() => setWhere("local")} title={`On ${here()}`} tag="Private, slower" detail={localDetail} />
        <BigChoice
          on={where === "cloud"}
          onClick={() => setWhere("cloud")}
          title="Cloud"
          tag="Faster, your key"
          detail="Anthropic, OpenAI, Gemini and others, with your own API key. The mail being read is sent to the provider."
        />
      </div>
      {where === "local" && (
        <p className="mt-4">
          <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>
            {advanced ? "Back to the recommended pair" : "Advanced: choose the models"}
          </button>
        </p>
      )}
      {cloudReady && where === "cloud" && (
        <p className="mt-4 flex items-center gap-1.5 text-ink2">
          <Glyph state="done" />
          In use: {modelLabel(current, state.providers)}
        </p>
      )}
      <div className="mt-3">
        <ErrorLine text={error} />
      </div>
    </Step>
  );
}

// ── Level ───────────────────────────────────────────────────────────────────

const LEVEL_ROWS: { id: Level; label: string; text: string }[] = [
  { id: "observe", label: "Observe", text: "Sorts mail and tells you what came in." },
  { id: "suggest", label: "Suggest", text: "Labels mail. The rest waits for your yes." },
  { id: "assist", label: "Assist", text: "Also drafts, todos and meetings on its own. Sends nothing." },
  { id: "autopilot", label: "Autopilot", text: "Also replies, after minutes in which you can cancel." },
];

// What one email becomes at each level: each line is made, waits for a yes, is
// on its way out, or is not there yet.
type Made = "done" | "need" | "going" | "off";
const OUTCOMES: { what: string; at: Record<Level, Made> }[] = [
  { what: "Sorted: needs an answer", at: { observe: "done", suggest: "done", assist: "done", autopilot: "done" } },
  { what: "Label: Pilot", at: { observe: "off", suggest: "done", assist: "done", autopilot: "done" } },
  { what: "Reply drafted", at: { observe: "off", suggest: "need", assist: "done", autopilot: "done" } },
  { what: "Todo: Send the signed copy", at: { observe: "off", suggest: "need", assist: "done", autopilot: "done" } },
  { what: "Meeting: Thursday at 15:00", at: { observe: "off", suggest: "need", assist: "need", autopilot: "need" } },
  { what: "Reply sent", at: { observe: "off", suggest: "off", assist: "off", autopilot: "going" } },
];
const SAYS: Record<Made, string> = { done: "Done", need: "Asks you", going: "In 5 minutes, unless you cancel", off: "" };

function LevelPicture({ level }: { level: Level }) {
  return (
    <Sheet>
      <p className="flex items-center gap-3.5">
        <span aria-hidden className="grid h-9 w-9 flex-none place-items-center rounded-full bg-field text-[12.5px] font-semibold text-ink2">MO</span>
        <span className="min-w-0">
          <span className="block font-[650]">Maya Okafor</span>
          <span className="block truncate text-ink3">Contract for the March pilot</span>
        </span>
      </p>
      <p className="mt-4 text-[14.5px] leading-[1.6] text-ink2">Could you send back the signed copy this week? And are you free on Thursday at 3 to go through it?</p>
      <ul className="mt-5 border-t border-line pt-2" aria-live="polite">
        {OUTCOMES.map((o) => {
          const made = o.at[level];
          return (
            <li key={o.what} className={`flex h-10 items-center gap-2.5 text-[14px] transition-opacity duration-300 ${made === "off" ? "opacity-35" : ""}`}>
              {made === "off" ? <span className="h-4 w-4 flex-none" /> : <Glyph state={made} />}
              <span className={`min-w-0 flex-1 truncate ${made === "off" ? "text-ink3" : "text-ink"}`}>{o.what}</span>
              <span className={`flex-none text-[13px] ${made === "need" || made === "going" ? "font-medium text-ink" : "text-ink3"}`}>{SAYS[made]}</span>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

function LevelStep({ again, current }: { again: boolean; current: string }) {
  const [level, setLevel] = useState<Level>(again && LEVEL_ROWS.some((l) => l.id === current) ? (current as Level) : "suggest");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const finish = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/onboarding/finish", { level });
      store(() => {
        localStorage.removeItem(WELCOMED);
        localStorage.removeItem("tabellar_first_run_answers");
        sessionStorage.removeItem(AGAIN);
      });
      window.location.assign("/");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Step
      title="How much should it do on its own?"
      text="Change it any time at the foot of the sidebar, where Pause stops everything."
      actions={
        <Go disabled={busy} onClick={finish}>
          {busy ? "Opening" : "Open Tabellar"}
        </Go>
      }
      stage={<LevelPicture level={level} />}
    >
      <div role="radiogroup" aria-label="Level" className="space-y-1.5">
        {LEVEL_ROWS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={level === l.id}
            onClick={() => l.id !== level && confirmLevel(l.id) && setLevel(l.id)}
            className={`grid w-full grid-cols-[26px_minmax(0,1fr)] items-start rounded-[12px] px-4 py-3 text-left transition-[background-color,box-shadow] duration-150 ${level === l.id ? "bg-raised shadow-chosen" : "shadow-control hover:bg-hover"}`}
          >
            <RadioDot on={level === l.id} />
            <span className="min-w-0">
              <span className="block text-[15px] font-[650] leading-tight text-ink">{l.label}</span>
              <span className="mt-1 block text-[13px] leading-snug text-ink2">{l.text}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="mt-3">
        <ErrorLine text={error} />
      </div>
    </Step>
  );
}

// ── Not answering ───────────────────────────────────────────────────────────

function NotAnswering({ message }: { message: string }) {
  return (
    <Step
      title="Tabellar is not answering"
      text={
        <>
          This window could not reach the Tabellar server. Make sure <code className="rounded bg-field px-1 py-0.5 font-mono text-[12.5px]">tabellar start</code> is still running in Terminal, then try again.
        </>
      }
    >
      <ErrorLine text={message} />
      <button type="button" className={`${ui.btnPrimary} mt-5`} onClick={() => window.location.reload()}>
        Try again
      </button>
    </Step>
  );
}
