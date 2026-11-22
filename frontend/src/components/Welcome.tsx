import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@/lib/db";
import { setupPost, type SetupState } from "@/lib/setup";
import ModelSetup, { ErrorLine, Icon, Spinner, modelLabel, ui, useSetupState } from "./ModelSetup";

// First run, shown until a Google account is connected: the Google sign-in
// client, the AI model, then signing in to Gmail. Each step can be revisited
// from the rail; the AI step can be skipped and finished in Settings later.

const SKIP_AI = "tabellar_setup_skip_ai";

function usePrefersDark(): boolean {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return dark;
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
  const dark = usePrefersDark();
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
    setStep(!state.google.clientId ? 0 : !state.model?.ready && !skippedAi ? 1 : 2);
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
  const googleDone = !!state?.google.clientId;
  const modelDone = !!state?.model?.ready;
  const steps = [
    { title: "Google client", detail: googleDone ? "Saved to your Keychain" : "Your own sign-in client", done: googleDone },
    { title: "AI model", detail: modelDone && state ? modelLabel(state.model, state.providers) : skippedAi ? "Skipped for now" : "On this Mac or in the cloud", done: modelDone },
    { title: "Gmail", detail: "Sign in and fetch your mail", done: false },
  ];
  const reachable = (i: number) => i === 0 || googleDone;

  return (
    <div className={dark ? "dark" : ""}>
      <div className="ob flex min-h-screen flex-col bg-[var(--background)] text-[var(--foreground)] md:flex-row">
        {/* Rail */}
        <aside className="ob-rail relative flex shrink-0 flex-col gap-8 px-5 pb-5 pt-5 md:sticky md:top-0 md:h-screen md:w-[360px] md:gap-12 md:px-10 md:pb-10 md:pt-10 lg:w-[400px]">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="" width={32} height={32} className="rounded-[9px] shadow-[0_2px_8px_rgba(0,0,0,0.25)]" />
            <span className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--ob-rail-fg)]">Tabellar</span>
          </div>

          <div className="hidden space-y-3 md:block">
            <h2 className="max-w-[13ch] text-balance text-[30px] font-semibold leading-[1.12] tracking-[-0.025em] text-[var(--ob-rail-fg)]">
              Your inbox, sorted on your Mac.
            </h2>
            <p className="max-w-[30ch] text-[14px] leading-relaxed text-[var(--ob-rail-muted)]">Three steps, about five minutes, and only once.</p>
          </div>

          {/* Steps: a vertical list on wide screens, a compact bar on phones */}
          <ol className="hidden md:block">
            {steps.map((s, i) => {
              const active = step === i;
              const can = reachable(i) && !failure;
              return (
                <li key={s.title} className="relative pb-7 last:pb-0">
                  {i < steps.length - 1 && (
                    <span aria-hidden className={`absolute left-[13px] top-8 h-[calc(100%-36px)] w-px ${s.done ? "bg-[color-mix(in_srgb,var(--ob-rail-accent)_55%,transparent)]" : "bg-[var(--ob-rail-line)]"}`} />
                  )}
                  <button
                    type="button"
                    disabled={!can}
                    onClick={() => setStep(i)}
                    aria-current={active ? "step" : undefined}
                    className="group flex w-full items-start gap-4 rounded-lg text-left disabled:cursor-default"
                  >
                    <span
                      className={`grid h-[27px] w-[27px] shrink-0 place-items-center rounded-full text-[13px] font-semibold tabular-nums transition-colors duration-300 ${
                        s.done
                          ? "bg-[var(--ob-rail-accent)] text-[var(--ob-rail)]"
                          : active
                            ? "bg-[var(--ob-rail-fg)] text-[var(--ob-rail)]"
                            : "border border-[var(--ob-rail-line)] text-[var(--ob-rail-muted)]"
                      }`}
                    >
                      {s.done ? <Icon name="check" size={16} className="font-bold" /> : i + 1}
                    </span>
                    <span className="min-w-0 pt-[3px]">
                      <span className={`block text-[15px] font-medium leading-tight transition-colors ${active ? "text-[var(--ob-rail-fg)]" : "text-[color-mix(in_srgb,var(--ob-rail-fg)_80%,transparent)] group-enabled:group-hover:text-[var(--ob-rail-fg)]"}`}>
                        {s.title}
                      </span>
                      <span className="mt-1 block truncate text-[13px] text-[var(--ob-rail-muted)]">{s.detail}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="flex gap-1.5 md:hidden" aria-hidden>
            {steps.map((s, i) => (
              <span key={s.title} className={`h-1 flex-1 rounded-full ${s.done || step === i ? "bg-[var(--ob-rail-accent)]" : "bg-[var(--ob-rail-line)]"}`} />
            ))}
          </div>

          <p className="mt-auto hidden items-start gap-2.5 text-[13px] leading-relaxed text-[var(--ob-rail-muted)] md:flex">
            <Icon name="lock" size={16} className="mt-0.5" />
            Mail is kept in one file on this Mac. Keys and tokens go to the macOS Keychain.
          </p>
        </aside>

        {/* Step */}
        <main className="flex-1">
          <div key={failure ? "error" : step ?? "loading"} className="ob-enter mx-auto w-full max-w-[620px] px-4 pb-16 pt-8 sm:px-8 md:px-12 md:pt-20">
            {failure ? (
              <ErrorScreen message={failure} />
            ) : !state || step === null ? (
              <p className="flex items-center gap-2 text-sm text-[var(--muted)]">
                <Spinner /> Loading
              </p>
            ) : step === 0 ? (
              <GoogleStep state={state} refresh={refresh} onNext={() => setStep(1)} />
            ) : step === 1 ? (
              <ModelStep state={state} refresh={refresh} onBack={() => setStep(0)} onNext={() => setStep(2)} onSkip={skipAi} />
            ) : (
              <GmailStep state={state} goTo={setStep} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="mb-8 space-y-3">
      <h1 className="text-balance text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-[var(--foreground)] sm:text-[32px]">{title}</h1>
      <p className="max-w-[60ch] text-[15px] leading-relaxed text-[var(--muted)]">{children}</p>
    </header>
  );
}

function Footer({ onBack, children }: { onBack?: () => void; children?: ReactNode }) {
  return (
    <div className="mt-10 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-6">
      {onBack ? (
        <button type="button" onClick={onBack} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]">
          <Icon name="arrow_back" size={18} /> Back
        </button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

// ── Step 1: the Google sign-in client ───────────────────────────────────────

const CONSOLE = "https://console.cloud.google.com";
const GOOGLE_STEPS: { title: string; detail: string; href: string; action: string }[] = [
  { title: "Create a project", detail: "Any name works, Tabellar is fine.", href: `${CONSOLE}/projectcreate`, action: "Create" },
  {
    title: "Turn on the Gmail, Calendar and People APIs",
    detail: "One page enables all three for the project.",
    href: `${CONSOLE}/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,people.googleapis.com`,
    action: "Enable",
  },
  {
    title: "Set up the consent screen",
    detail: "Name it Tabellar. Choose External and add your own address as a test user, or Internal on a Workspace account.",
    href: `${CONSOLE}/auth/overview`,
    action: "Open",
  },
  {
    title: "Create a Desktop app client",
    detail: "Pick Desktop app as the type, create it, then download the JSON file.",
    href: `${CONSOLE}/auth/clients/create`,
    action: "Create",
  },
];

function GoogleStep({ state, refresh, onNext }: { state: SetupState; refresh: () => Promise<void>; onNext: () => void }) {
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

  const readFile = async (f?: File | null) => {
    if (f) await save({ text: await f.text() });
  };

  const checklist = (
    <ol className="space-y-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      {GOOGLE_STEPS.map((s, i) => (
        <li key={s.title} className={`flex items-start gap-4 px-5 py-4 ${i ? "border-t border-[var(--border)]" : ""}`}>
          <span className="mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-2)] text-[12px] font-semibold tabular-nums text-[var(--foreground)]">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-medium leading-snug text-[var(--foreground)]">{s.title}</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--muted)]">{s.detail}</p>
          </div>
          <a
            href={s.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 text-[13px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            {s.action}
            <Icon name="arrow_outward" size={15} />
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <>
      <Heading title="Add your Google client">
        Tabellar reaches Gmail through a sign-in client that you create in your own Google Cloud project, so your mail never passes through anyone else's app.
      </Heading>

      {!showSetup ? (
        <div className="flex items-start gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--accent-light)] text-[var(--accent)]">
            <Icon name="check" size={20} />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[15px] font-semibold text-[var(--foreground)]">Google client saved</p>
            <p className="truncate font-mono text-[12.5px] text-[var(--muted)]" title={state.google.clientId!}>
              {state.google.clientId}
            </p>
            <p className="text-[13px] text-[var(--muted)]">The secret is in your Keychain.</p>
            {warning && <p className="pt-1 text-[13px] text-[var(--warning)]">{warning}</p>}
          </div>
          <button type="button" onClick={() => setReplacing(true)} className="shrink-0 text-[13px] font-medium text-[var(--accent)] underline-offset-2 hover:underline">
            Replace
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {!found && checklist}

          {found ? (
            <div className="space-y-4 rounded-xl border border-[var(--accent)] bg-[var(--accent-light)] p-5">
              <div className="flex items-start gap-3">
                <Icon name="description" size={22} className="mt-px text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-[var(--foreground)]">Found your client file</p>
                  <p className="mt-0.5 truncate font-mono text-[12.5px] text-[var(--muted)]" title={found.path}>
                    {found.folder}/{found.name}
                  </p>
                  <p className="text-[13px] text-[var(--muted)]">Saved {ago(found.modified)}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-[var(--foreground)]">
                  <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
                  Move it to the Trash once saved
                </label>
                <button type="button" className={ui.btnPrimary} disabled={busy} onClick={() => save({ path: found.path, trash })}>
                  {busy ? <Spinner /> : <Icon name="key" size={18} />}
                  Use this file
                </button>
              </div>
            </div>
          ) : null}

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
            className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 text-center transition-colors ${found ? "py-6" : "py-10"} ${
              dragging ? "border-[var(--accent)] bg-[var(--accent-light)]" : "border-[var(--border)]"
            }`}
          >
            {!found && (
              <span className="grid h-11 w-11 place-items-center rounded-full bg-[var(--surface-2)] text-[var(--muted)]">
                {busy ? <Spinner size={20} /> : <Icon name="upload_file" size={22} />}
              </span>
            )}
            <p className="text-[14px] text-[var(--foreground)]">
              {found ? "A different file? " : "Drop the downloaded client_secret file here, or "}
              <button type="button" onClick={() => fileInput.current?.click()} className="font-medium text-[var(--accent)] underline-offset-2 hover:underline">
                choose it
              </button>
            </p>
            {!found && (
              <p className="flex items-center gap-1.5 text-[13px] text-[var(--muted)]">
                <Spinner size={14} /> Watching Downloads, Desktop and Documents for it
              </p>
            )}
            <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} />
          </div>
          {found && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-[var(--muted)] hover:text-[var(--foreground)]">
                <Icon name="chevron_right" size={18} className="transition-transform duration-200 group-open:rotate-90" />
                How to make a new client
              </summary>
              <div className="mt-3">{checklist}</div>
            </details>
          )}
          {configured && (
            <button type="button" onClick={() => setReplacing(false)} className="text-[13px] font-medium text-[var(--muted)] hover:text-[var(--foreground)]">
              Keep the current client
            </button>
          )}
        </div>
      )}

      <div className="mt-4">
        <ErrorLine text={error} />
      </div>

      <Footer>
        <button type="button" className={ui.btnPrimary} disabled={!configured || replacing} onClick={onNext}>
          Continue <Icon name="arrow_forward" size={18} />
        </button>
      </Footer>
    </>
  );
}

// ── Step 2: the AI model ────────────────────────────────────────────────────

function ModelStep({ state, refresh, onBack, onNext, onSkip }: { state: SetupState; refresh: () => Promise<void>; onBack: () => void; onNext: () => void; onSkip: () => void }) {
  return (
    <>
      <Heading title="Choose where the AI runs">
        Tabellar uses a language model to sort your mail, write the daily briefing and draft replies. Settings, under AI, can switch it later or give reading mail a smaller, faster model of its own.
      </Heading>
      <ModelSetup state={state} refresh={refresh} onSaved={onNext} />
      <Footer onBack={onBack}>
        {state.model?.ready ? (
          <button type="button" className={ui.btnPrimary} onClick={onNext}>
            Continue <Icon name="arrow_forward" size={18} />
          </button>
        ) : (
          <button type="button" className={ui.btnSecondary} onClick={onSkip}>
            Skip for now
          </button>
        )}
      </Footer>
    </>
  );
}

// ── Step 3: sign in to Gmail ────────────────────────────────────────────────

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function GmailStep({ state, goTo }: { state: SetupState; goTo: (i: number) => void }) {
  const [going, setGoing] = useState(false);
  const rows = [
    { label: "Google client", value: "Saved to your Keychain", ok: true, step: 0 },
    { label: "AI model", value: state.model?.ready ? modelLabel(state.model, state.providers) : "Not chosen yet; mail syncs, sorting waits", ok: !!state.model?.ready, step: 1 },
  ];
  return (
    <>
      <Heading title="Sign in to Gmail">
        Tabellar fetches your recent mail, sorts it and writes your first briefing. Expect a minute or two{state.model?.format === "ollama" ? ", longer with a model on this Mac" : ""}.
      </Heading>

      <dl className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {rows.map((r, i) => (
          <div key={r.label} className={`flex items-center gap-4 px-5 py-3.5 ${i ? "border-t border-[var(--border)]" : ""}`}>
            <Icon name={r.ok ? "check_circle" : "radio_button_unchecked"} size={20} className={r.ok ? "text-[var(--accent)]" : "text-[var(--muted)]"} />
            <dt className="w-28 shrink-0 text-[13px] text-[var(--muted)]">{r.label}</dt>
            <dd className="min-w-0 flex-1 truncate text-[14px] text-[var(--foreground)]">{r.value}</dd>
            <button type="button" onClick={() => goTo(r.step)} className="shrink-0 text-[13px] font-medium text-[var(--accent)] underline-offset-2 hover:underline">
              Change
            </button>
          </div>
        ))}
      </dl>

      <div className="mt-6 flex items-start gap-3 rounded-xl bg-[var(--surface-2)] px-5 py-4">
        <Icon name="info" size={20} className="mt-px text-[var(--muted)]" />
        <p className="text-[13.5px] leading-relaxed text-[var(--foreground)]">
          Google will say it hasn't verified the app. That is expected, since the client is your own. Choose <b className="font-semibold">Advanced</b>, then{" "}
          <b className="font-semibold">Go to Tabellar</b>, and allow access to Gmail and Calendar.
        </p>
      </div>

      <a
        href="/oauth/start"
        onClick={() => setGoing(true)}
        className="mt-8 flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[15px] font-semibold text-[var(--foreground)] shadow-[0_1px_2px_rgba(16,24,40,0.06),0_8px_24px_-12px_rgba(16,24,40,0.25)] transition-[box-shadow,transform] hover:shadow-[0_2px_4px_rgba(16,24,40,0.08),0_12px_28px_-12px_rgba(16,24,40,0.35)] active:translate-y-px"
      >
        {going ? <Spinner size={18} /> : <GoogleMark />}
        Continue with Google
      </a>

      <Footer onBack={() => goTo(1)} />
    </>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <>
      <Heading title="Tabellar isn't answering">
        The window couldn't reach the Tabellar server on this Mac. Make sure <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[13px]">tabellar start</code> is still running in
        Terminal, then try again.
      </Heading>
      <ErrorLine text={message} />
      <button type="button" className={`${ui.btnPrimary} mt-6`} onClick={() => window.location.reload()}>
        <Icon name="refresh" size={18} /> Try again
      </button>
    </>
  );
}
