import { useEffect, useRef, useState, type ReactNode } from "react";
import Logo from "@/components/Logo";
import { Glyph } from "@/components/ui";
import type { Session } from "@/lib/db";
import { setupPost, type SetupState } from "@/lib/setup";
import ModelSetup, { ErrorLine, Icon, modelLabel, ui, useSetupState } from "./ModelSetup";

// First run, shown until a Google account is connected: the model, then
// signing in to Gmail. Sign-in uses the Google client built into Tabellar; the
// Google client step is for bringing your own instead, and comes first only
// in a copy that has none built in. Each step can be revisited from the line
// of steps at the top; the model step can be skipped and finished in Settings
// later.

const SKIP_AI = "tabellar_setup_skip_ai";

// No profile exists yet, so light or dark follows the system.
function useSystemTheme() {
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", m.matches);
    apply();
    m.addEventListener("change", apply);
    return () => m.removeEventListener("change", apply);
  }, []);
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export default function Welcome({ error }: { session?: Session; error?: string }) {
  useSystemTheme();
  const { state, error: stateError, refresh } = useSetupState();
  const [step, setStep] = useState<number | null>(null);
  const [skippedAi, setSkippedAi] = useState(() => {
    try {
      return localStorage.getItem(SKIP_AI) === "1";
    } catch {
      return false;
    }
  });

  // Open at the first step that still needs doing.
  useEffect(() => {
    if (!state || step !== null) return;
    setStep(!state.google.clientId && !state.google.builtIn ? 0 : !state.model?.ready && !skippedAi ? 1 : 2);
  }, [state, step, skippedAi]);

  // While the Google step waits for its file, keep looking for the download.
  const waitingForFile = step === 0 && !!state && !state.google.clientId;
  useEffect(() => {
    if (!waitingForFile) return;
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [waitingForFile, refresh]);

  const skipAi = () => {
    try {
      localStorage.setItem(SKIP_AI, "1");
    } catch {
      /* private window */
    }
    setSkippedAi(true);
    setStep(2);
  };

  const failure = error ?? (!state ? stateError : "");
  const ownClient = !!state?.google.clientId;
  const builtIn = !!state?.google.builtIn;
  const googleDone = ownClient || builtIn;
  const modelDone = !!state?.model?.ready;
  // With the built-in client there is nothing to do for Google, so its step
  // is listed only once the user has gone there to bring their own.
  const steps = [
    { step: 0, title: "Google client", done: googleDone },
    { step: 1, title: "Model", done: modelDone },
    { step: 2, title: "Gmail", done: false },
  ].filter((s) => s.step > 0 || !builtIn || ownClient || step === 0);
  const reachable = (i: number) => i === 0 || googleDone;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div className="mx-auto w-full max-w-[560px] px-5 pb-14 pt-10 sm:pt-16">
        <Logo size={30} />

        <ol className="mt-9 flex items-center gap-2.5 text-xs">
          {steps.map((s, i) => (
            <li key={s.title} className={`flex items-center gap-2.5 ${i ? "min-w-0 flex-1" : ""}`}>
              {i > 0 && <span aria-hidden className="h-px min-w-3 flex-1 bg-line" />}
              <button
                type="button"
                disabled={!reachable(s.step) || !!failure}
                onClick={() => setStep(s.step)}
                aria-current={step === s.step ? "step" : undefined}
                className={`flex flex-none items-center gap-1.5 rounded-md py-0.5 transition-colors duration-150 ${step === s.step ? "font-semibold text-ink" : "text-ink3 enabled:hover:text-ink"}`}
              >
                {s.done ? <Glyph state="done" /> : <span className="w-4 text-center">{i + 1}</span>}
                {s.title}
              </button>
            </li>
          ))}
        </ol>

        <main className="mt-9">
          {failure ? (
            <ErrorScreen message={failure} />
          ) : !state || step === null ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading">
              <span className="skel block h-5 w-52" />
              <span className="skel block h-3 w-full" />
              <span className="skel block h-3 w-4/5" />
            </div>
          ) : step === 0 ? (
            <GoogleStep state={state} refresh={refresh} onNext={() => setStep(builtIn && (modelDone || skippedAi) ? 2 : 1)} onBuiltIn={builtIn ? () => setStep(2) : undefined} />
          ) : step === 1 ? (
            <ModelStep state={state} refresh={refresh} onBack={builtIn && !ownClient ? undefined : () => setStep(0)} onNext={() => setStep(2)} onSkip={skipAi} />
          ) : (
            <GmailStep state={state} goTo={setStep} />
          )}
        </main>

        <footer className="mt-12 border-t border-line-soft pt-4 text-xs leading-relaxed text-ink3">
          <p>
            <b className="font-semibold text-ink2">What stays on this Mac.</b> Your mail, in one file in your home folder. Keys and sign-in tokens, in the macOS Keychain. Nothing is hosted anywhere and there is no account to create.
          </p>
          <p className="mt-1.5">
            <b className="font-semibold text-ink2">What leaves it.</b> Calls to Google, to read and act on your own Gmail and Calendar, and calls to the model you choose. With a model on this Mac, nothing else leaves at all.
          </p>
        </footer>
      </div>
    </div>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="mb-6">
      <h1 className="font-brand text-[24px] font-[650] leading-[1.2] text-ink">{title}</h1>
      <p className="mt-2 text-sm leading-[1.6] text-ink2">{children}</p>
    </header>
  );
}

// The row of actions under a step: the way forward on the left, the way back after it.
function Actions({ onBack, children }: { onBack?: () => void; children?: ReactNode }) {
  return (
    <div className="mt-8 flex items-center gap-2">
      {children}
      {onBack && (
        <button type="button" onClick={onBack} className="btn btn-plain h-8">
          Back
        </button>
      )}
    </div>
  );
}

// The Google sign-in client. onBuiltIn is set when Tabellar has a client
// built in, and returns to it.

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

function GoogleStep({ state, refresh, onNext, onBuiltIn }: { state: SetupState; refresh: () => Promise<void>; onNext: () => void; onBuiltIn?: () => void }) {
  const configured = !!state.google.clientId;
  const [replacing, setReplacing] = useState(false);
  const [trash, setTrash] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const found = state.google.file;
  const showSetup = !configured || replacing;

  async function save(body: { path?: string; text?: string; trash?: boolean }) {
    setBusy(true);
    setError("");
    try {
      const r = await setupPost<{ clientId: string; warning?: string }>("/google", body);
      setWarning(r.warning ?? "");
      setReplacing(false);
      await refresh();
      if (!r.warning) onNext();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function backToBuiltIn() {
    setBusy(true);
    setError("");
    try {
      if (configured) {
        await setupPost("/google", { builtIn: true });
        await refresh();
      }
      onBuiltIn!();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const readFile = async (f?: File | null) => {
    if (f) await save({ text: await f.text() });
  };

  const chooseFile = (
    <>
      <button type="button" className={found ? "link" : ui.btnPrimary} disabled={busy} onClick={() => fileInput.current?.click()}>
        {found ? "Choose a different file" : busy ? "Saving" : "Choose the file"}
      </button>
      <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} />
    </>
  );

  return (
    <>
      {onBuiltIn ? (
        <Heading title="Use your own Google client">
          Tabellar signs in to Google through a client built into it, and nothing here needs doing. Bring your own instead if your organisation blocks apps that Google has not verified, or if you would rather sign in through a Google Cloud project you control. It takes about five minutes, once.
        </Heading>
      ) : (
        <Heading title="Add your Google client">
          Tabellar reaches Gmail through a sign-in client that you create in your own Google Cloud project, so your mail never passes through anyone else's app. It takes about five minutes, once.
        </Heading>
      )}

      {!showSetup ? (
        <>
          <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start border-y border-line-soft py-3">
            <Glyph state="done" className="mt-px" />
            <div className="min-w-0">
              <p className="font-medium text-ink">Google client saved</p>
              <p className="truncate font-mono text-xs text-ink3" title={state.google.clientId!}>
                {state.google.clientId}
              </p>
              <p className="text-xs text-ink2">The secret is in your Keychain.</p>
              {warning && <p className="mt-1 text-xs text-warn">{warning}</p>}
            </div>
            <button type="button" onClick={() => setReplacing(true)} className="link">
              Replace
            </button>
          </div>
          <Actions>
            <button type="button" className={ui.btnPrimary} onClick={onNext}>
              Continue
            </button>
            {onBuiltIn && (
              <button type="button" className="btn btn-plain h-8" disabled={busy} onClick={backToBuiltIn}>
                Use Tabellar's client instead
              </button>
            )}
          </Actions>
        </>
      ) : (
        <div
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
          className={`-mx-3 rounded-[10px] px-3 transition-colors duration-150 ${dragging ? "bg-sel" : ""}`}
        >
          {found ? (
            <>
              <div className="border-y border-line-soft py-3">
                <p className="font-medium text-ink">Found your client file</p>
                <p className="truncate font-mono text-xs text-ink3" title={found.path}>
                  {found.folder}/{found.name}
                </p>
                <p className="text-xs text-ink2">Saved {ago(found.modified)}</p>
                <label className="mt-2.5 flex items-center gap-2 text-ink2">
                  <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} />
                  Move the file to the Trash once it is saved to the Keychain
                </label>
              </div>
              <Actions onBack={configured ? () => setReplacing(false) : onBuiltIn && backToBuiltIn}>
                <button type="button" className={ui.btnPrimary} disabled={busy} onClick={() => save({ path: found.path, trash })}>
                  {busy ? "Saving" : "Use this file"}
                </button>
              </Actions>
              <p className="mt-4 text-xs text-ink2">Not the right one? {chooseFile}, or drop it anywhere here.</p>
              <details className="mt-3">
                <summary className="link inline cursor-default list-none">How to make a new client</summary>
                <GoogleList />
              </details>
            </>
          ) : (
            <>
              <GoogleList />
              <div className="grid grid-cols-[24px_minmax(0,1fr)] border-t border-line-soft py-2.5">
                <span className="text-ink3">{GOOGLE_STEPS.length + 1}</span>
                <div>
                  <p className="font-medium text-ink">Give the downloaded file to Tabellar</p>
                  <p className="mt-0.5 text-xs leading-normal text-ink2">
                    Drop the client_secret file anywhere here, or choose it. Tabellar is also watching Downloads, Desktop and Documents and will pick it up when it appears.
                  </p>
                </div>
              </div>
              <Actions onBack={configured ? () => setReplacing(false) : onBuiltIn && backToBuiltIn}>{chooseFile}</Actions>
            </>
          )}
        </div>
      )}

      <div className="mt-4">
        <ErrorLine text={error} />
      </div>
    </>
  );
}

function GoogleList() {
  return (
    <ol>
      {GOOGLE_STEPS.map((s, i) => (
        <li key={s.title} className={`grid grid-cols-[24px_minmax(0,1fr)] py-2.5 ${i ? "border-t border-line-soft" : ""}`}>
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
    </ol>
  );
}

// Step 2: the model

function ModelStep({ state, refresh, onBack, onNext, onSkip }: { state: SetupState; refresh: () => Promise<void>; onBack?: () => void; onNext: () => void; onSkip: () => void }) {
  return (
    <>
      <Heading title="Choose the model Tabellar uses">
        A language model sorts your mail, writes the daily briefing and drafts replies. You can change it later in Settings, under Models, or give reading mail a smaller, faster model of its own.
      </Heading>
      <ModelSetup state={state} refresh={refresh} onSaved={onNext} />
      <Actions onBack={onBack}>
        {state.model?.ready ? (
          <button type="button" className={ui.btnPrimary} onClick={onNext}>
            Continue
          </button>
        ) : (
          <button type="button" className={ui.btnSecondary} onClick={onSkip}>
            Skip for now
          </button>
        )}
      </Actions>
    </>
  );
}

// Step 3: sign in to Gmail

function GmailStep({ state, goTo }: { state: SetupState; goTo: (i: number) => void }) {
  const [going, setGoing] = useState(false);
  const own = !!state.google.clientId;
  const rows = [
    { label: "Google client", value: own ? "Your own, saved to your Keychain" : "Built into Tabellar", step: 0 },
    { label: "Model", value: state.model?.ready ? modelLabel(state.model, state.providers) : "Not chosen yet. Mail syncs, sorting waits.", step: 1 },
  ];
  const notes = [
    "Pick the Google account whose mail Tabellar should handle.",
    own
      ? "Google will say it has not verified the app. That is expected, because the client is your own. Choose Advanced, then Go to Tabellar."
      : "Google will say it has not verified the app, because Tabellar has not been through Google's review yet. Choose Advanced, then Go to Tabellar.",
    "Allow access to Gmail and Calendar. Tabellar then fetches your recent mail, sorts it and writes your first briefing.",
  ];
  return (
    <>
      <Heading title="Sign in to Gmail">
        The last step. Expect a minute or two before the Inbox fills{state.model?.format === "ollama" ? ", longer with a model on this Mac" : ""}.
      </Heading>

      <dl className="border-y border-line-soft">
        {rows.map((r, i) => (
          <div key={r.label} className={`flex items-baseline gap-3 py-2 ${i ? "border-t border-line-soft" : ""}`}>
            <dt className="w-28 flex-none text-ink3">{r.label}</dt>
            <dd className="min-w-0 flex-1 truncate text-ink">{r.value}</dd>
            <button type="button" onClick={() => goTo(r.step)} className="link flex-none">
              Change
            </button>
          </div>
        ))}
      </dl>

      <ol className="mt-4">
        {notes.map((n, i) => (
          <li key={i} className="grid grid-cols-[24px_minmax(0,1fr)] py-1.5 leading-normal text-ink2">
            <span className="text-ink3">{i + 1}</span>
            {n}
          </li>
        ))}
      </ol>

      {!own && (
        <p className="mt-3 text-xs leading-normal text-ink2">
          If Google blocks the sign-in instead, your organisation does not allow apps it has not verified.{" "}
          <button type="button" onClick={() => goTo(0)} className="link">
            Use your own Google client
          </button>
          .
        </p>
      )}

      <Actions onBack={() => goTo(1)}>
        <a href="/oauth/start" onClick={() => setGoing(true)} className={ui.btnPrimary} aria-busy={going}>
          {going ? "Opening Google" : "Sign in with Google"}
        </a>
      </Actions>
    </>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <>
      <Heading title="Tabellar is not answering">
        This window could not reach the Tabellar server on this Mac. Make sure <code className="rounded bg-field px-1 py-0.5 font-mono text-[12.5px]">tabellar start</code> is still running in Terminal, then try again.
      </Heading>
      <ErrorLine text={message} />
      <Actions>
        <button type="button" className={ui.btnPrimary} onClick={() => window.location.reload()}>
          Try again
        </button>
      </Actions>
    </>
  );
}
