import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import { Glyph, Seg } from "@/components/ui";
import { formatBytes, getSetupState, setupPost, setupStream, type ModelInfo, type Progress, type SetupState, type Slot } from "@/lib/setup";

// Choosing a model: on this Mac through Ollama (installing Ollama and
// downloading a model if needed) or a cloud provider with the user's own key.
// There are two slots: the careful model writes and plans, the fast model
// reads each email. Onboarding sets the careful one, which the fast slot
// follows until Settings, under Models, gives it its own.

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

export function modelLabel(m: ModelInfo | null, providers: SetupState["providers"]): string {
  if (!m) return "";
  if (m.format === "ollama") return `${m.model} on this Mac`;
  const name = providers.find((p) => p.id === m.provider)?.name ?? "the cloud";
  return `${m.model} through ${m.provider === "custom" ? "your endpoint" : name}`;
}

// Buttons and fields at the size used during setup, a little larger than in
// the rest of the window.
const btnPrimary = "btn btn-pri h-8 px-3.5";
const btnSecondary = "btn h-8 px-3.5";
const input = "input h-8";

export const ui = { btnPrimary, btnSecondary, input };

export { Icon };

export function Spinner({ size = 16 }: { size?: number }) {
  return <Icon name="progress_activity" size={size} className="animate-spin" />;
}

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
function Choice({ on, onClick, disabled, title, hint, right, mono }: { on: boolean; onClick: () => void; disabled?: boolean; title: string; hint?: string; right?: string; mono?: boolean }) {
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
export function ProgressBar({ label, p }: { label: string; p?: Progress }) {
  const pct = p?.total && p.completed !== undefined ? Math.min(100, (p.completed / p.total) * 100) : null;
  return (
    <div role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-ink">{label}</span>
        {pct !== null && (
          <span className="text-xs text-ink3">
            {formatBytes(p!.completed!)} of {formatBytes(p!.total!)}, {Math.round(pct)}%
          </span>
        )}
      </div>
      <div className="relative mt-1.5 h-[3px] overflow-hidden rounded-full bg-field">
        {pct !== null ? (
          <div className="h-full rounded-full bg-ink2 transition-[width] duration-300 ease-out" style={{ width: `${Math.max(2, pct)}%` }} />
        ) : (
          <div className="ob-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-ink2" />
        )}
      </div>
    </div>
  );
}

// Ollama's pull statuses ("pulling 3a2f...", "verifying sha256 digest") in plain words.
function pullLabel(model: string, status: string): string {
  if (status === "pulling manifest") return `Preparing ${model}`;
  if (status.startsWith("pulling")) return `Downloading ${model}`;
  if (status.startsWith("verifying")) return "Checking the download";
  if (status === "writing manifest" || status === "success") return "Finishing up";
  return status;
}

type PanelProps = { state: SetupState; slot: Slot; current: ModelInfo | null; refresh: () => Promise<void>; onSaved?: () => void };

export default function ModelSetup({ state, refresh, onSaved, slot = "careful" }: { state: SetupState; refresh: () => Promise<void>; onSaved?: () => void; slot?: Slot }) {
  const current = slot === "fast" ? (state.fastModel ?? state.model) : state.model;
  const [where, setWhere] = useState<"local" | "cloud">(current && current.format !== "ollama" ? "cloud" : "local");
  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="Where the model runs" className="-mx-2">
        <Choice on={where === "local"} onClick={() => setWhere("local")} title="On this Mac" hint="Free and private: nothing is sent to a model provider. Runs with Ollama; slower on long threads." />
        <Choice on={where === "cloud"} onClick={() => setWhere("cloud")} title="Cloud provider" hint="Faster and sharper. Your own API key, billed by the provider; the mail being read is sent to it." />
      </div>
      {where === "local" ? (
        <LocalPanel state={state} slot={slot} current={current} refresh={refresh} onSaved={onSaved} />
      ) : (
        <CloudPanel state={state} slot={slot} current={current} refresh={refresh} onSaved={onSaved} />
      )}
    </div>
  );
}

// On this Mac

const ABOUT: Record<string, string> = {
  "qwen3.5:4b": "Small and quick; sorts mail well, simpler drafts",
  "gemma4:12b": "Writes good drafts in your voice; wants 24 GB of memory",
  "gemma4:26b": "Best drafts, and quick for its size; wants 48 GB of memory",
};

function LocalPanel({ state, slot, current: model, refresh, onSaved }: PanelProps) {
  const { ollama, local } = state;
  const current = model?.format === "ollama" ? model.model : null;
  const recommendedName = slot === "fast" ? local.recommendedFast : local.recommended;
  const [selected, setSelected] = useState(current ?? recommendedName);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState<{ label: string; p?: Progress } | null>(null);
  const [error, setError] = useState("");

  const installed = useMemo(() => new Map(ollama.models.map((m) => [m.name, m.size])), [ollama.models]);
  const rows = useMemo(() => {
    const curated = new Set(local.choices.map((c) => c.name));
    return [...ollama.models.filter((m) => !curated.has(m.name)), ...local.choices];
  }, [ollama.models, local.choices]);
  const choice = selected === "__other" ? other.trim() : selected;
  // Choosing the recommended careful model while the fast slot still follows
  // it also sets up the recommended fast model, so mail is read quickly.
  const pairFast = slot === "careful" && !state.fastModel && choice === local.recommended && local.recommendedFast !== choice ? local.recommendedFast : null;

  async function run(work: () => Promise<void>) {
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const install = () =>
    run(async () => {
      setBusy({ label: "Downloading Ollama" });
      await setupStream("/ollama/install", {}, (p) => setBusy({ label: p.status === "success" ? "Ollama is ready" : p.status, p: p.total ? p : undefined }));
      await refresh();
    });

  const start = () =>
    run(async () => {
      setBusy({ label: "Starting Ollama" });
      const { running } = await setupPost<{ running: boolean }>("/ollama/start");
      if (!running) throw new Error("Ollama did not start. Open it from your Applications folder, then try again.");
      await refresh();
    });

  const use = () =>
    run(async () => {
      if (!choice) throw new Error("Type the name of an Ollama model.");
      for (const name of [choice, pairFast].filter((n): n is string => !!n && !installed.has(n))) {
        setBusy({ label: `Preparing ${name}` });
        await setupStream("/ollama/pull", { model: name }, (p) => setBusy({ label: pullLabel(name, p.status), p: p.total ? p : undefined }));
      }
      setBusy({ label: "Saving" });
      await setupPost("/model", { slot, provider: "ollama", model: choice });
      if (pairFast) await setupPost("/model", { slot: "fast", provider: "ollama", model: pairFast });
      await refresh();
      onSaved?.();
    });

  if (!ollama.installed || !ollama.running) {
    const missing = !ollama.installed;
    return (
      <div className="space-y-3">
        <div>
          <p className="font-medium text-ink">{busy ? "Setting up Ollama" : missing ? "Ollama is not installed yet" : "Ollama is not running"}</p>
          <p className="mt-0.5 text-xs leading-normal text-ink2">
            {missing
              ? "Ollama is the free app that runs models on your Mac. Tabellar downloads it from ollama.com, checks its signature and puts it in Applications."
              : "Ollama is installed. Start it and Tabellar will list your models."}
          </p>
        </div>
        {busy ? (
          <ProgressBar label={busy.label} p={busy.p} />
        ) : (
          <button type="button" className={btnPrimary} onClick={missing ? install : start}>
            {missing ? "Install Ollama, about 230 MB" : "Start Ollama"}
          </button>
        )}
        <ErrorLine text={error} />
      </div>
    );
  }

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
              disabled={!!busy}
              onClick={() => setSelected(m.name)}
              title={m.name}
              hint={m.name === recommendedName ? `Recommended for this Mac's ${local.memoryGb} GB of memory` : (ABOUT[m.name] ?? "Already on this Mac")}
              right={current === m.name && model?.ready ? "In use" : installed.has(m.name) ? "On this Mac" : formatBytes(m.size)}
            />
          ))}
          <div className={`flex items-center gap-2.5 rounded-md px-2 py-1 transition-colors duration-150 ${selected === "__other" ? "bg-sel" : "hover:bg-hover"}`} onClick={() => !busy && setSelected("__other")}>
            <button type="button" role="radio" aria-checked={selected === "__other"} aria-label="Another model" disabled={!!busy} onClick={() => setSelected("__other")} className="flex">
              <RadioDot on={selected === "__other"} />
            </button>
            <input
              value={other}
              disabled={!!busy}
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
      {busy ? (
        <ProgressBar label={busy.label} p={busy.p} />
      ) : (
        <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
          {inUse ? (
            <InUse name={choice} />
          ) : (
            <button type="button" className={btnPrimary} disabled={!choice} onClick={use}>
              {installed.has(choice) ? `Use ${choice}` : choice ? `Download and use ${choice}` : "Download and use"}
            </button>
          )}
          {!inUse && pairFast && (
            <span className="text-xs text-ink2">
              {installed.has(pairFast) ? "Also uses" : "Also downloads"} <span className="font-mono">{pairFast}</span> to read new mail quickly{installed.has(pairFast) && installed.has(choice) ? "." : "; downloads once, then runs offline."}
            </span>
          )}
          {!installed.has(choice) && choice && !inUse && !pairFast && <span className="text-xs text-ink2">Downloads once, then runs offline.</span>}
        </div>
      )}
      <ErrorLine text={error} />
    </div>
  );
}

// Cloud provider

function CloudPanel({ state, slot, current: model, refresh, onSaved }: PanelProps) {
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
