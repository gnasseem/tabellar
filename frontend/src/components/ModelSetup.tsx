import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import { formatBytes, getSetupState, setupPost, setupStream, type ModelInfo, type Progress, type SetupState, type Slot } from "@/lib/setup";

// Choosing an AI model: on this Mac through Ollama (installing Ollama and
// downloading a model if needed) or a cloud provider with the user's own key.
// There are two slots: the careful model writes and plans, the fast model
// reads each email. Onboarding sets the careful one, which the fast slot
// follows until Settings > AI gives it its own.

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

const btnPrimary =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-wax px-4 text-sm font-semibold text-on-wax transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100";
const btnSecondary =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line bg-raised px-4 text-sm font-medium text-ink transition-colors hover:bg-field disabled:cursor-not-allowed disabled:opacity-40";
const input =
  "h-10 w-full rounded-lg border border-line bg-raised px-3 text-sm text-ink placeholder:text-ink3 transition-shadow focus:border-wax focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--wax)_22%,transparent)]";

export const ui = { btnPrimary, btnSecondary, input };

export { Icon };

export function Spinner({ size = 16 }: { size?: number }) {
  return <Icon name="progress_activity" size={size} className="animate-spin" />;
}

export function ErrorLine({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-danger">
      <Icon name="error" size={18} className="mt-px" />
      <span>{text}</span>
    </p>
  );
}

function RadioDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2 transition-colors ${
        on ? "border-wax" : "border-line"
      }`}
    >
      <span className={`h-2 w-2 rounded-full bg-wax transition-transform duration-200 ${on ? "scale-100" : "scale-0"}`} />
    </span>
  );
}

function InUse({ name }: { name: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-ink">
      <Icon name="check_circle" size={18} className="text-wax" />
      <span>
        <span className="font-mono text-[13px] font-medium">{name}</span> is in use
      </span>
    </p>
  );
}

export function ProgressBar({ label, p }: { label: string; p?: Progress }) {
  const pct = p?.total && p.completed !== undefined ? Math.min(100, (p.completed / p.total) * 100) : null;
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-medium text-ink">{label}</span>
        {pct !== null && (
          <span className="tabular-nums text-xs text-ink3">
            {formatBytes(p!.completed!)} of {formatBytes(p!.total!)}
          </span>
        )}
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-field">
        {pct !== null ? (
          <div className="h-full rounded-full bg-wax transition-[width] duration-300 ease-out" style={{ width: `${Math.max(2, pct)}%` }} />
        ) : (
          <div className="ob-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-wax" />
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
  const options = [
    { id: "local" as const, icon: "laptop_mac", title: "On this Mac", text: "Free and private. Runs with Ollama; slower on long threads." },
    { id: "cloud" as const, icon: "cloud", title: "Cloud provider", text: "Faster and sharper. Your own API key, billed by the provider." },
  ];
  return (
    <div className="space-y-6">
      <div role="radiogroup" aria-label="Where the AI runs" className="grid gap-3 sm:grid-cols-2">
        {options.map((o) => {
          const on = where === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setWhere(o.id)}
              className={`group flex items-start gap-3 rounded-xl border p-4 text-left transition-[border-color,background-color,box-shadow] ${
                on
                  ? "border-wax bg-wax-soft shadow-[0_1px_2px_rgba(16,40,28,0.06),0_6px_16px_-8px_rgba(16,64,40,0.25)]"
                  : "border-line bg-raised hover:border-[color-mix(in_srgb,var(--ink3)_55%,transparent)]"
              }`}
            >
              <Icon name={o.icon} size={22} className={on ? "text-wax" : "text-ink3"} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-semibold text-ink">{o.title}</span>
                  <RadioDot on={on} />
                </span>
                <span className="mt-1 block text-[13px] leading-snug text-ink3">{o.text}</span>
              </span>
            </button>
          );
        })}
      </div>
      {where === "local" ? (
        <LocalPanel state={state} slot={slot} current={current} refresh={refresh} onSaved={onSaved} />
      ) : (
        <CloudPanel state={state} slot={slot} current={current} refresh={refresh} onSaved={onSaved} />
      )}
    </div>
  );
}

// ── On this Mac ─────────────────────────────────────────────────────────────

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
      if (!running) throw new Error("Ollama did not start. Open it from your Applications folder.");
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
      <div className="space-y-4 rounded-xl border border-line bg-raised p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-field text-ink">
            <Icon name={missing ? "download" : "power_settings_new"} size={20} />
          </span>
          <div className="space-y-1">
            <p className="text-[15px] font-semibold text-ink">{busy ? "Setting up Ollama" : missing ? "Ollama isn't installed yet" : "Ollama isn't running"}</p>
            <p className="text-[13px] leading-relaxed text-ink3">
              {missing
                ? "Ollama is the free app that runs AI models on your Mac. Tabellar downloads it from ollama.com, checks its signature and puts it in Applications."
                : "Ollama is installed. Start it and Tabellar will list your models."}
            </p>
          </div>
        </div>
        {busy ? (
          <ProgressBar label={busy.label} p={busy.p} />
        ) : (
          <button type="button" className={btnPrimary} onClick={missing ? install : start}>
            <Icon name={missing ? "download" : "play_arrow"} size={18} />
            {missing ? "Install Ollama, about 230 MB" : "Start Ollama"}
          </button>
        )}
        <ErrorLine text={error} />
      </div>
    );
  }

  const inUse = current === choice && !!model?.ready;
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Local model" className="overflow-hidden rounded-xl border border-line bg-raised">
        {rows.map((m, i) => {
          const on = selected === m.name;
          const recommended = m.name === recommendedName;
          const has = installed.has(m.name);
          const about: Record<string, string> = {
            "qwen3.5:4b": "Small and quick; sorts mail well, simpler drafts",
            "gemma4:12b": "Writes good drafts in your voice; wants 24 GB of memory",
            "gemma4:26b": "Best drafts, and quick for its size; wants 48 GB of memory",
          };
          const hint = recommended ? `Recommended for this Mac's ${local.memoryGb} GB of memory` : (about[m.name] ?? "Already on this Mac");
          return (
            <button
              key={m.name}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!!busy}
              onClick={() => setSelected(m.name)}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${i ? "border-t border-line" : ""} ${
                on ? "bg-wax-soft" : "hover:bg-field"
              }`}
            >
              <RadioDot on={on} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-medium text-ink">{m.name}</span>
                  {recommended && (
                    <span className="rounded-full bg-wax-soft px-2 py-0.5 text-[11px] font-semibold text-wax">Recommended</span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-ink3">{hint}</span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-ink3">
                {current === m.name && model?.ready ? "In use" : has ? "On this Mac" : formatBytes(m.size)}
              </span>
            </button>
          );
        })}
        <div
          className={`flex w-full items-center gap-3 border-t border-line px-4 py-3 transition-colors ${
            selected === "__other" ? "bg-wax-soft" : "hover:bg-field"
          }`}
          onClick={() => !busy && setSelected("__other")}
        >
          <button type="button" role="radio" aria-checked={selected === "__other"} aria-label="Another model" disabled={!!busy} onClick={() => setSelected("__other")}>
            <RadioDot on={selected === "__other"} />
          </button>
          <input
            value={other}
            disabled={!!busy}
            onFocus={() => setSelected("__other")}
            onChange={(e) => setOther(e.target.value)}
            placeholder="Another model from ollama.com/library, e.g. qwen3.5:9b"
            className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-ink3 focus:outline-none"
            aria-label="Another Ollama model"
          />
        </div>
      </div>
      {busy ? (
        <ProgressBar label={busy.label} p={busy.p} />
      ) : (
        <div className="flex min-h-10 flex-wrap items-center gap-3">
          {inUse ? (
            <InUse name={choice} />
          ) : (
            <button type="button" className={btnPrimary} disabled={!choice} onClick={use}>
              {installed.has(choice) ? (
                `Use ${choice}`
              ) : (
                <>
                  <Icon name="download" size={18} />
                  {choice ? `Download and use ${choice}` : "Download and use"}
                </>
              )}
            </button>
          )}
          {!inUse && pairFast && (
            <span className="text-xs text-ink3">
              {installed.has(pairFast) ? "Also uses" : "Also downloads"} <span className="font-mono">{pairFast}</span> to read new mail quickly{installed.has(pairFast) && installed.has(choice) ? "." : "; downloads once, then runs offline."}
            </span>
          )}
          {!installed.has(choice) && choice && !inUse && !pairFast && <span className="text-xs text-ink3">Downloads once, then runs offline.</span>}
        </div>
      )}
      <ErrorLine text={error} />
    </div>
  );
}

// ── Cloud provider ──────────────────────────────────────────────────────────

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
    <div className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-ink">Provider</legend>
        <div className="flex flex-wrap gap-2">
          {state.providers.map((p) => {
            const on = p.id === providerId;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => setProviderId(p.id)}
                className={`h-9 rounded-full border px-3.5 text-[13px] font-medium transition-colors ${
                  on
                    ? "border-wax bg-wax-soft text-wax"
                    : "border-line bg-raised text-ink hover:bg-field"
                }`}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      </fieldset>

      {providerId === "custom" && (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-ink">Base URL</span>
          <input className={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com/v1" spellCheck={false} />
        </label>
      )}

      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          check(key);
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="api-key" className="text-sm font-medium text-ink">
            API key
          </label>
          {provider.keyUrl && (
            <a href={provider.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-medium text-wax hover:underline underline-offset-2">
              Get a key from {provider.name} <Icon name="open_in_new" size={14} />
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
          <button type="submit" className={`${btnSecondary} shrink-0`} disabled={busy !== "" || (!key && !provider.hasKey)}>
            {busy === "check" ? <Spinner /> : null}
            {models && !key ? "Refresh" : "Check key"}
          </button>
        </div>
        <p className="text-xs text-ink3">Stored in the macOS Keychain, never in a file. Usage is billed by {providerId === "custom" ? "your provider" : provider.name}.</p>
      </form>

      {models && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-ink">Model</span>
            {models.length > 0 && <span className="text-xs tabular-nums text-ink3">{models.length} available</span>}
          </div>
          {models.length ? (
            <div className="overflow-hidden rounded-xl border border-line bg-raised">
              <div className="flex items-center gap-2 border-b border-line px-3">
                <Icon name="search" size={18} className="text-ink3" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models"
                  aria-label="Search models"
                  className="h-10 min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink3 focus:outline-none"
                />
              </div>
              <div role="radiogroup" aria-label="Model" className="max-h-64 overflow-y-auto overscroll-contain py-1">
                {shown.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={selected === m}
                    onClick={() => setSelected(m)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left font-mono text-[13px] transition-colors ${
                      selected === m ? "bg-wax-soft text-ink" : "text-ink hover:bg-field"
                    }`}
                  >
                    <RadioDot on={selected === m} />
                    <span className="truncate">{m}</span>
                  </button>
                ))}
                {!shown.length && <p className="px-3 py-3 text-sm text-ink3">No model matches "{query}".</p>}
              </div>
            </div>
          ) : (
            <input className={`${input} font-mono`} value={selected} onChange={(e) => setSelected(e.target.value)} placeholder="Model name" spellCheck={false} aria-label="Model name" />
          )}
          <div className="flex min-h-10 items-center gap-3 pt-2">
            {inUse ? (
              <InUse name={selected} />
            ) : (
              <button type="button" className={btnPrimary} disabled={!selected.trim() || busy !== ""} onClick={save}>
                {busy === "save" ? <Spinner /> : null}
                {selected ? `Use ${selected.length > 32 ? selected.slice(0, 31) + "…" : selected}` : "Choose a model"}
              </button>
            )}
          </div>
        </div>
      )}
      <ErrorLine text={error} />
    </div>
  );
}

// Settings > AI: the same picker for each slot, with its own state.
export function ModelSettings() {
  const { state, error, refresh } = useSetupState();
  const [slot, setSlot] = useState<Slot>("careful");
  const [saved, setSaved] = useState<Slot | null>(null);
  if (!state) return error ? <ErrorLine text={error} /> : <p className="flex items-center gap-2 text-sm text-ink3"><Spinner /> Loading</p>;
  const slots = [
    { id: "careful" as const, title: "Careful model", text: "Writes drafts and the briefing, answers in the assistant, runs the agent." },
    { id: "fast" as const, title: "Fast model", text: "Reads each new email to sort it, summarise it and find todos and meetings." },
  ];
  const sameAsCareful = !state.fastModel;
  const shown = slot === "fast" ? (state.fastModel ?? state.model) : state.model;

  const followCareful = async () => {
    await setupPost("/model", { slot: "fast", same: true });
    await refresh();
    setSaved("fast");
  };

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Model slot" className="grid gap-2 sm:grid-cols-2">
        {slots.map((s) => {
          const on = slot === s.id;
          const m = s.id === "fast" ? (state.fastModel ?? state.model) : state.model;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => {
                setSlot(s.id);
                setSaved(null);
              }}
              className={`rounded-xl border p-3.5 text-left transition-[border-color,background-color] ${
                on ? "border-wax bg-wax-soft" : "border-line bg-raised hover:bg-field"
              }`}
            >
              <span className="block text-sm font-semibold text-ink">{s.title}</span>
              <span className="mt-0.5 block text-xs leading-snug text-ink3">{s.text}</span>
              <span className="mt-2 block truncate font-mono text-[12px] text-ink">
                {m?.ready ? (s.id === "fast" && sameAsCareful ? `Same as careful, ${m.model}` : modelLabel(m, state.providers)) : "Not chosen yet"}
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-sm text-ink3">
        {shown?.ready ? (
          <>
            {slot === "fast" && sameAsCareful ? "Reading mail with the careful model, " : "Using "}
            <span className="font-medium text-ink">{modelLabel(shown, state.providers)}</span>.
          </>
        ) : (
          "No model yet. Mail still syncs, but sorting, the briefing and drafts wait until you choose one."
        )}
        {saved === slot && <span className="ml-2 font-medium text-ok">Saved.</span>}
      </p>

      {slot === "fast" && state.model?.ready && !sameAsCareful && (
        <button type="button" className={btnSecondary} onClick={followCareful}>
          <Icon name="link" size={18} />
          Use the careful model for this too
        </button>
      )}

      <ModelSetup key={slot} slot={slot} state={state} refresh={refresh} onSaved={() => setSaved(slot)} />
    </div>
  );
}
