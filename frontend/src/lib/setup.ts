// Calls to the server's /api/setup and /api/onboarding routes, used by the
// first run and by Settings > Models and Accounts.

export type LocalModel = { name: string; size: number; about?: string; firstRead?: number };

// The local models being downloaded in the background (server/setup.ts).
export type LocalJob = { careful?: string; fast?: string | null; label: string; completed?: number; total?: number; done: boolean; error: string | null };

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
  // What can be added as a mailbox (server/providers.ts CHOICES).
  mailboxes: MailboxChoice[];
  microsoft: { clientId: string | null };
};

export type MailboxChoice = {
  id: string;
  name: string;
  provider: "gmail" | "microsoft" | "imap";
  imap?: { host: string; port: number };
  smtp?: { host: string; port: number };
  passwordUrl?: string;
  calendar: boolean;
  // Google with a sign-in client, Outlook with a registered app.
  ready: boolean;
};

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

export async function getLocalJob(): Promise<LocalJob | null> {
  const r = await fetch("/api/setup/local", { headers: headers() });
  return r.ok ? r.json() : null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

// The first run's state, from /api/onboarding (server/onboarding.ts).
export type FirstRead = {
  step: "headers" | "sent" | "deep" | "done";
  headers: number;
  headers_total: number;
  senders: number;
  sent: number;
  facts: number;
  learned: boolean;
  deep: number;
  deep_total: number;
  error: string | null;
};
export type Onboarding = { step: string; read: FirstRead; emails: number; sorted: number; model: boolean; local: LocalJob | null };

export async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, body === undefined ? { headers: headers() } : { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error ?? `Tabellar answered ${r.status}`);
  return data as T;
}
