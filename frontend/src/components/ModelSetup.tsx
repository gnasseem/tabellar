import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { Glyph, Seg } from "@/components/ui";
import { formatBytes, getLocalJob, getSetupState, setupPost, type LocalJob, type ModelInfo, type SetupState, type Slot } from "@/lib/setup";

// Choosing a model: on this Mac through Ollama, or a cloud provider with the
// user's own key. There are two slots: the careful model writes and plans,
// the fast model reads each email. The first run offers the two plain
// choices (ModelStep in Welcome.tsx) with these panels behind Advanced;
// Settings, under Models, shows the panels for each slot. Local models are
// downloaded by the server in the background (POST /api/setup/local), so the
// window can move on while they arrive.

export function useSetupState() {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setState(await getSetupState());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { state, error, refresh };
}

// The background download, checked every second while it runs.
export function useLocalJob(onDone?: () => void) {
  const [job, setJob] = useState<LocalJob | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const poll = useCallback(async () => {
    const j = await getLocalJob().catch(() => null);
    setJob((prev) => {
      if (prev && !prev.done && j?.done && !j.error) done.current?.();
      return j;
    });
  }, []);
  useEffect(() => {
    poll();
  }, [poll]);
  const running = !!job && !job.done;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [running, poll]);
  const start = useCallback(async (models: { careful?: string; fast?: string | null }) => {
    setJob(await setupPost<LocalJob>("/local", models));
  }, []);
  return { job, running, start };
}

// "About 4 minutes left", from how fast the bytes have been arriving.
export function useTimeLeft(p?: { completed?: number; total?: number; label?: string }): string {
  const samples = useRef<{ label?: string; t: number; n: number }[]>([]);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!p?.total || p.completed === undefined) return setText("");
    const now = Date.now();
    const list = samples.current.filter((s) => s.label === p.label && now - s.t < 20_000);
    list.push({ label: p.label, t: now, n: p.completed });
    samples.current = list;
    const first = list[0];
    const rate = (p.completed - first.n) / Math.max(1, (now - first.t) / 1000);
    if (list.length < 3 || rate <= 0) return setText("");
    const min = Math.round((p.total - p.completed) / rate / 60);
    setText(min < 1 ? "under a minute left" : `about ${min} minute${min === 1 ? "" : "s"} left`);
  }, [p?.completed, p?.total, p?.label]);
  return text;
}

export function modelLabel(m: ModelInfo | null, providers: SetupState["providers"]): string {
  if (!m) return "";
  if (m.format === "ollama") return `${m.model} on this Mac`;
  const name = providers.find((p) => p.id === m.provider)?.name ?? "the cloud";
  return `${m.model} through ${m.provider === "custom" ? "your endpoint" : name}`;
}

// The pair recommended for this Mac's memory: the careful model, the fast one
// (null when one model does both), what is still to download, and how long
// the first read takes where that was timed.
export function localPair(state: SetupState) {
  const { local, ollama } = state;
  const careful = local.recommended;
  const fast = local.recommendedFast !== careful ? local.recommendedFast : null;
  const installed = new Set(ollama.models.map((m) => m.name));
  const size = (name: string) => local.choices.find((c) => c.name === name)?.size ?? 0;
  const missing = [careful, fast].filter((n): n is string => !!n && !installed.has(n));
  const download = missing.reduce((n, m) => n + size(m), 0) + (ollama.installed ? 0 : 230e6);
  const reader = local.choices.find((c) => c.name === (fast ?? careful));
  return { careful, fast, download, missing, minutes: reader?.firstRead ?? null };
}

// Buttons and fields at the size used during setup, a little larger than in
// the rest of the window.
const btnPrimary = "btn btn-pri h-8 px-3.5";
const btnSecondary = "btn h-8 px-3.5";
const input = "input h-8";

export const ui = { btnPrimary, btnSecondary, input };

export { Icon };

export function ErrorLine({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p role="alert" className="text-danger">
      {text}
    </p>
  );
}

export function RadioDot({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`mt-[2.5px] grid h-3.5 w-3.5 flex-none place-items-center rounded-full border-[1.2px] transition-colors duration-150 ${on ? "border-ink" : "border-ink4"}`}>
      {on && <span className="h-1.5 w-1.5 rounded-full bg-ink" />}
    </span>
  );
}

// One choice in a list of them: a radio mark, a name and a line about it.
export function Choice({ on, onClick, disabled, title, hint, right, mono }: { on: boolean; onClick: () => void; disabled?: boolean; title: string; hint?: string; right?: string; mono?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45 ${on ? "bg-sel" : "hover:bg-hover"}`}
    >
      <RadioDot on={on} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-ink ${mono ? "font-mono text-[12.5px]" : "font-medium"}`}>{title}</span>
        {hint && <span className="block text-xs leading-snug text-ink2">{hint}</span>}
      </span>
      {right && <span className="flex-none pt-px text-xs text-ink3">{right}</span>}
    </button>
  );
}

function InUse({ name }: { name: string }) {
  return (
    <p className="flex items-center gap-1.5 text-ink2">
      <Glyph state="done" />
      <span>
        <span className="font-mono text-[12.5px] text-ink">{name}</span> is in use
      </span>
    </p>
  );
}

// A thin bar with the numbers beside it. Without a total it shows only that
// work is going on.
export function ProgressBar({ label, p, note }: { label: string; p?: { completed?: number; total?: number }; note?: string }) {
  const pct = p?.total && p.completed !== undefined ? Math.min(100, (p.completed / p.total) * 100) : null;
  return (
    <div role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-ink">{label}</span>
        {pct !== null && (
          <span className="text-xs text-ink3">
            {formatBytes(p!.completed!)} of {formatBytes(p!.total!)}
            {note ? `, ${note}` : ""}
          </span>
        )}
      </div>
      <Bar pct={pct} className="mt-1.5" />
    </div>
  );
}

export function Bar({ pct, className = "" }: { pct: number | null; className?: string }) {
  return (
    <div className={`relative h-[3px] overflow-hidden rounded-full bg-field ${className}`}>
      {pct !== null ? (
        <div className="h-full rounded-full bg-ink2 transition-[width] duration-300 ease-out" style={{ width: `${Math.max(2, pct)}%` }} />
      ) : (
        <div className="ob-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-ink2" />
      )}
    </div>
  );
}

type PanelProps = { state: SetupState; slot: Slot; current: ModelInfo | null; refresh: () => Promise<void>; onSaved?: () => void };

export default function ModelSetup({ state, refresh, onSaved, slot = "careful" }: { state: SetupState; refresh: () => Promise<void>; onSaved?: () => void; slot?: Slot }) {
  const current = slot === "fast" ? (state.fastModel ?? state.model) : state.model;
  const [where, setWhere] = useState<"local" | "cloud">(current && current.format !== "ollama" ? "cloud" : "local");
  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="Where the model runs" className="-mx-2">
        <Choice on={where === "local"} onClick={() => setWhere("local")} title="On this Mac" hint="Private: nothing is sent to a model provider. Runs with Ollama; slower on long threads." />
        <Choice on={where === "cloud"} onClick={() => setWhere("cloud")} title="Cloud" hint="Faster. Your own API key, billed by the provider; the mail being read is sent to it." />
      </div>
      {where === "local" ? (
        <LocalPanel state={state} slot={slot} current={current} refresh={refresh} onSaved={onSaved} />
      ) : (
        <CloudPanel state={state} slot={slot} current={current} refresh={refresh} onSaved={onSaved} />
      )}
    </div>
  );
}

// On this Mac: every curated model and those already in Ollama, or any other
// by name. Using one downloads it in the background.

export function LocalPanel({ state, slot, current: model, refresh, onSaved }: PanelProps) {
  const { ollama, local } = state;
  const current = model?.format === "ollama" ? model.model : null;
  const recommendedName = slot === "fast" ? local.recommendedFast : local.recommended;
  const [selected, setSelected] = useState(current ?? recommendedName);
  const [other, setOther] = useState("");
  const [error, setError] = useState("");
  const { job, running, start } = useLocalJob(async () => {
    await refresh();
    onSaved?.();
  });
  const left = useTimeLeft(job ?? undefined);

  const installed = useMemo(() => new Map(ollama.models.map((m) => [m.name, m.size])), [ollama.models]);
  const about = useMemo(() => new Map(local.choices.map((c) => [c.name, c.about])), [local.choices]);
  const rows = useMemo(() => {
    const curated = new Set(local.choices.map((c) => c.name));
    return [...ollama.models.filter((m) => !curated.has(m.name)), ...local.choices];
  }, [ollama.models, local.choices]);
  const choice = selected === "__other" ? other.trim() : selected;
  // Choosing the recommended careful model while the fast slot still follows
  // it also sets up the recommended fast model, so mail is read quickly.
  const pairFast = slot === "careful" && !state.fastModel && choice === local.recommended && local.recommendedFast !== choice ? local.recommendedFast : null;

  const use = async () => {
    setError("");
    try {
      if (!choice) throw new Error("Type the name of an Ollama model.");
      await start(slot === "fast" ? { fast: choice } : { careful: choice, ...(pairFast ? { fast: pairFast } : {}) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const inUse = current === choice && !!model?.ready;
  return (
    <div className="space-y-3">
      <div>
        <p className="label mb-1">Model</p>
        <div role="radiogroup" aria-label="Local model" className="-mx-2">
          {rows.map((m) => (
            <Choice
              key={m.name}
              mono
              on={selected === m.name}
              disabled={running}
              onClick={() => setSelected(m.name)}
              title={m.name}
              hint={[m.name === recommendedName && `Recommended for this Mac's ${local.memoryGb} GB of memory`, about.get(m.name) ?? (m.name !== recommendedName && "Already on this Mac")].filter(Boolean).join(". ")}
              right={current === m.name && model?.ready ? "In use" : installed.has(m.name) ? "On this Mac" : formatBytes(m.size)}
            />
          ))}
          <div className={`flex items-center gap-2.5 rounded-md px-2 py-1 transition-colors duration-150 ${selected === "__other" ? "bg-sel" : "hover:bg-hover"}`} onClick={() => !running && setSelected("__other")}>
            <button type="button" role="radio" aria-checked={selected === "__other"} aria-label="Another model" disabled={running} onClick={() => setSelected("__other")} className="flex">
              <RadioDot on={selected === "__other"} />
            </button>
            <input
              value={other}
              disabled={running}
              onFocus={() => setSelected("__other")}
              onChange={(e) => setOther(e.target.value)}
              placeholder="Another model from ollama.com/library, such as qwen3.5:9b"
              className="h-6 min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:font-sans placeholder:text-[13px]"
              spellCheck={false}
              aria-label="Another Ollama model"
            />
          </div>
        </div>
      </div>
      {slot === "careful" && local.small && (
        <p className="text-xs leading-normal text-ink2">
          With {local.memoryGb} GB of memory one small model does everything here, and its drafts are plainer. A cloud model writes drafts faster and closer to your voice.
        </p>
      )}
      {running ? (
        <ProgressBar label={job!.label} p={job!.total ? job! : undefined} note={left} />
      ) : (
        <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
          {inUse ? (
            <InUse name={choice} />
          ) : (
            <button type="button" className={btnPrimary} disabled={!choice} onClick={use}>
              {installed.has(choice) && (!pairFast || installed.has(pairFast)) ? `Use ${choice}` : choice ? `Download and use ${choice}` : "Download and use"}
            </button>
          )}
          {!inUse && pairFast && (
            <span className="text-xs text-ink2">
              {installed.has(pairFast) ? "Also uses" : "Also downloads"} <span className="font-mono">{pairFast}</span> to read new mail quickly.
            </span>
          )}
          {!inUse && !ollama.installed && <span className="text-xs text-ink2">Installs Ollama first, the free app that runs models on this Mac.</span>}
        </div>
      )}
      <ErrorLine text={error || job?.error || ""} />
    </div>
  );
}

// Cloud provider

export function CloudPanel({ state, slot, current: model, refresh, onSaved }: PanelProps) {
  const current = model && model.format !== "ollama" ? model : null;
  const [providerId, setProviderId] = useState(current?.provider ?? "openrouter");
  const provider = state.providers.find((p) => p.id === providerId) ?? state.providers[0];
  const [baseUrl, setBaseUrl] = useState(current?.provider === "custom" ? current.baseUrl : "");
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "save">("");
  const [error, setError] = useState("");

  const check = useCallback(
    async (withKey: string) => {
      setBusy("check");
      setError("");
      try {
        const r = await setupPost<{ models: string[]; suggested?: string }>("/cloud/models", { provider: providerId, baseUrl, key: withKey });
        setModels(r.models);
        setQuery("");
        setSelected((prev) => (r.models.includes(prev) ? prev : r.suggested && (r.models.includes(r.suggested) || !r.models.length) ? r.suggested : (r.models[0] ?? "")));
      } catch (e) {
        setModels(null);
        setError((e as Error).message);
      } finally {
        setBusy("");
      }
    },
    [providerId, baseUrl],
  );

  // A provider whose key is already saved lists its models straight away.
  useEffect(() => {
    setModels(null);
    setKey("");
    setError("");
    setSelected(current?.provider === providerId ? current.model : "");
    if (provider.hasKey && providerId !== "custom") check("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const shown = useMemo(() => {
    if (!models) return [];
    const q = query.trim().toLowerCase();
    const hits = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
    return hits.slice(0, 200);
  }, [models, query]);

  const save = async () => {
    setBusy("save");
    setError("");
    try {
      await setupPost("/model", { slot, provider: providerId, baseUrl, key, model: selected.trim() });
      setKey("");
      await refresh();
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const inUse = !!current && current.provider === providerId && current.model === selected && !key && current.ready;

  return (
    <div className="space-y-4">
      <div>
        <p className="label mb-1">Provider</p>
        <div role="radiogroup" aria-label="Provider" className="-mx-2 grid sm:grid-cols-2">
          {state.providers.map((p) => (
            <Choice key={p.id} on={p.id === providerId} onClick={() => setProviderId(p.id)} title={p.name} right={p.hasKey ? "Key saved" : undefined} />
          ))}
        </div>
      </div>

      {providerId === "custom" && (
        <label className="block">
          <span className="label mb-1 block">Base URL</span>
          <input className={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com/v1" spellCheck={false} />
        </label>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          check(key);
        }}
      >
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <label htmlFor="api-key" className="label">
            API key
          </label>
          {provider.keyUrl && (
            <a href={provider.keyUrl} target="_blank" rel="noreferrer" className="link">
              Get a key from {provider.name}
            </a>
          )}
        </div>
        <div className="flex gap-2">
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={`${input} font-mono`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={provider.hasKey ? "Saved in your Keychain. Paste a new one to replace it." : "Paste your key"}
          />
          <button type="submit" className={`${btnSecondary} flex-none`} disabled={busy !== "" || (!key && !provider.hasKey)}>
            {busy === "check" ? "Checking" : models && !key ? "Refresh" : "Check key"}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-ink2">Stored in the macOS Keychain, never in a file. Usage is billed by {providerId === "custom" ? "your provider" : provider.name}.</p>
      </form>

      {models && (
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="label">Model</span>
            {models.length > 0 && <span className="text-xs text-ink3">{models.length} available</span>}
          </div>
          {models.length ? (
            <>
              <label className="searchbox !w-full">
                <Icon name="search" size={15} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models" aria-label="Search models" spellCheck={false} />
              </label>
              <div role="radiogroup" aria-label="Model" className="-mx-2 mt-1 max-h-64 overflow-y-auto overscroll-contain">
                {shown.map((m) => (
                  <Choice key={m} mono on={selected === m} onClick={() => setSelected(m)} title={m} />
                ))}
                {!shown.length && <p className="px-2 py-2 text-ink3">No model matches "{query}".</p>}
              </div>
            </>
          ) : (
            <input className={`${input} font-mono`} value={selected} onChange={(e) => setSelected(e.target.value)} placeholder="Model name" spellCheck={false} aria-label="Model name" />
          )}
          <div className="mt-3 flex min-h-8 items-center gap-3">
            {inUse ? (
              <InUse name={selected} />
            ) : (
              <button type="button" className={btnPrimary} disabled={!selected.trim() || busy !== ""} onClick={save}>
                {busy === "save" ? "Saving" : selected ? `Use ${selected.length > 32 ? selected.slice(0, 31) + "…" : selected}` : "Choose a model"}
              </button>
            )}
          </div>
        </div>
      )}
      <ErrorLine text={error} />
    </div>
  );
}

// Settings, Models: the same picker for each slot, with its own state.
const SLOTS: { id: Slot; label: string; text: string }[] = [
  { id: "careful", label: "Careful model", text: "Writes drafts, answers in Ask, runs cleanup plans." },
  { id: "fast", label: "Fast model", text: "Reads each new email to sort it, summarise it and find todos and meetings." },
];

export function ModelSettings() {
  const { state, error, refresh } = useSetupState();
  const [slot, setSlot] = useState<Slot>("careful");
  const [saved, setSaved] = useState<Slot | null>(null);
  if (!state)
    return error ? (
      <ErrorLine text={`Could not load the model settings: ${error}. Check that Tabellar is still running, then open Settings again.`} />
    ) : (
      <div className="space-y-2.5 py-1" aria-busy="true" aria-label="Loading">
        <span className="skel block h-2.5 w-40" />
        <span className="skel block h-2.5 w-72" />
        <span className="skel block h-2.5 w-56" />
      </div>
    );
  const sameAsCareful = !state.fastModel;
  const shown = slot === "fast" ? (state.fastModel ?? state.model) : state.model;

  const followCareful = async () => {
    await setupPost("/model", { slot: "fast", same: true });
    await refresh();
    setSaved("fast");
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="-ml-2">
          <Seg
            value={slot}
            onChange={(s) => {
              setSlot(s);
              setSaved(null);
            }}
            options={SLOTS}
          />
        </div>
        <p className="mt-2 text-xs text-ink2">{SLOTS.find((s) => s.id === slot)!.text}</p>
        <p className="mt-1.5 text-ink2">
          {shown?.ready ? (
            <>
              {slot === "fast" && sameAsCareful ? "Reading mail with the careful model, " : "Using "}
              <span className="font-medium text-ink">{modelLabel(shown, state.providers)}</span>.
            </>
          ) : (
            "No model yet. Mail still syncs, but sorting and drafts wait until you choose one."
          )}
          {saved === slot && <span className="ml-2 text-ok">Saved.</span>}
        </p>
        {slot === "fast" && state.model?.ready && !sameAsCareful && (
          <button type="button" className="btn mt-2.5" onClick={followCareful}>
            Use the careful model for this too
          </button>
        )}
      </div>

      <ModelSetup key={slot} slot={slot} state={state} refresh={refresh} onSaved={() => setSaved(slot)} />
    </div>
  );
}
