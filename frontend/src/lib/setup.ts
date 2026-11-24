// Calls to the server's /api/setup routes, used by the first-run onboarding
// and by Settings > Models.

export type LocalModel = { name: string; size: number; about?: string };

export type Slot = "careful" | "fast";

export type ModelInfo = { provider?: string; format: "ollama" | "anthropic" | "openai"; baseUrl: string; model: string; ready: boolean };

export type SetupState = {
  google: {
    // The user's own client, when they saved one.
    clientId: string | null;
    // Whether this copy of Tabellar ships with a sign-in client.
    builtIn: boolean;
    file: { path: string; name: string; folder: string; modified: number } | null;
  };
  // The careful model (drafts, briefing, assistant, agent).
  model: ModelInfo | null;
  // The fast model that reads each email; null when it is the careful one.
  fastModel: ModelInfo | null;
  ollama: { installed: boolean; running: boolean; models: LocalModel[] };
  local: { choices: LocalModel[]; recommended: string; recommendedFast: string; memoryGb: number; small: boolean };
  providers: { id: string; name: string; keyUrl: string; suggested?: string; hasKey: boolean }[];
};

export type Progress = { status: string; completed?: number; total?: number };

function headers(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${window.__TABELLAR_TOKEN__ ?? ""}` };
}

export async function getSetupState(): Promise<SetupState> {
  const r = await fetch("/api/setup/state", { headers: headers() });
  if (!r.ok) throw new Error(`Tabellar answered ${r.status}`);
  return r.json();
}

export async function setupPost<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/setup${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error ?? `Tabellar answered ${r.status}`);
  return data as T;
}

// Routes that report progress send one JSON object per line.
export async function setupStream(path: string, body: unknown, onProgress: (p: Progress) => void): Promise<void> {
  const r = await fetch(`/api/setup${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error ?? `Tabellar answered ${r.status}`);
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const p = JSON.parse(line) as Progress & { error?: string };
      if (p.error) throw new Error(p.error);
      onProgress(p);
    }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
