// Where Tabellar keeps its files, its settings, and its secrets.
//
// ~/.tabellar/ holds the database and config.json. Secrets (the Google client
// secret, Google refresh tokens, the model API key, the local access token)
// live in the macOS Keychain under the service "tabellar". Where there is no
// Keychain (Linux), or TABELLAR_PASSPHRASE is set, they are in one file
// encrypted with that passphrase.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { seal, unseal } from "./seal.ts";

export const MAC = process.platform === "darwin";

// On Linux: the passphrase and the data folder, for the service and for the
// commands typed beside it (autostart.ts writes it). What is set already stays.
export const ENV_FILE = join(homedir(), ".config", "tabellar.env");
if (!MAC && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export const DEFAULT_HOME = join(homedir(), ".tabellar");
export const HOME = process.env.TABELLAR_HOME || DEFAULT_HOME;
export const DB_PATH = join(HOME, "tabellar.db");
export const CONFIG_PATH = join(HOME, "config.json");
export const DEFAULT_PORT = 4848;

mkdirSync(HOME, { recursive: true, mode: 0o700 });

// The path of a file next to this one. A source checkout runs the .ts files;
// the npm package holds the same files built to .js.
export function sibling(name: string): string {
  return fileURLToPath(new URL(`./${name}${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url));
}

// The Google sign-in client that ships with Tabellar, so nobody has to open
// Google Cloud to sign in. Google does not treat the secret of a desktop app's
// client as confidential: it identifies the app, and sign-in is still
// protected by PKCE and the loopback redirect. When empty, setup asks for the
// user's own client.
export const BUILT_IN_GOOGLE = {
  clientId: "128573573035-8c8cgs7na3dnndtm2k21tu7nb8hii2f0.apps.googleusercontent.com",
  clientSecret: "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",
};

// The app registered with Microsoft that ships with Tabellar: its Application
// (client) ID. A public client, so there is no secret. When empty, the user
// registers their own.
export const BUILT_IN_MICROSOFT = "5d0d05a5-5f0d-4942-a765-49eeb696596f";

// The Tabellar+ service (plus/), where a code is exchanged for a model key.
// When empty, Tabellar+ is not offered.
export const PLUS_URL = process.env.TABELLAR_PLUS_URL ?? "";

export type ModelConfig = {
  provider?: string; // "ollama", "openrouter", "anthropic", "openai", ... (setup's provider list)
  // Wire format: Ollama's native chat API, Anthropic Messages, or OpenAI chat completions.
  format: "ollama" | "anthropic" | "openai";
  baseUrl: string; // e.g. http://127.0.0.1:11434, https://api.anthropic.com/v1, https://openrouter.ai/api/v1
  model: string;
};

// Two model slots. `model` is the careful one (drafts, Ask, the cleanup
// plan); `fastModel` reads each email (sorting, summaries, todos, meetings)
// and, when unset, is the same model.
export type Slot = "fast" | "careful";

export type Config = {
  port: number;
  // Set only when the user brought their own Google client; its secret is
  // among the secrets. Unset means the built-in client.
  googleClientId?: string;
  // The Application (client) ID of the app registered in Microsoft's Azure
  // portal, for Outlook and Microsoft 365 accounts. It has no secret.
  microsoftClientId?: string;
  model?: ModelConfig;
  fastModel?: ModelConfig;
};

export function slotModel(slot: Slot, config = loadConfig()): ModelConfig | undefined {
  return slot === "fast" ? (config.fastModel ?? config.model) : config.model;
}

// Cloud keys are kept per provider, so the two slots can use different ones.
export function modelKeyName(provider: string | undefined): string {
  return `model-api-key:${provider || "custom"}`;
}

export function modelKey(m: ModelConfig): string | null {
  return m.format === "ollama" ? null : secrets.get(modelKeyName(m.provider));
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { port: DEFAULT_PORT };
  return { port: DEFAULT_PORT, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

// ── Secrets ─────────────────────────────────────────────────────────────────

const goodName = (account: string) => {
  if (!/^[\w.:@+-]+$/.test(account)) throw new Error(`bad name for a secret: ${account}`);
};

// The Keychain. Values go through `security -i` on stdin so they never appear
// in the process list, and are stored hex-encoded so no quoting or
// non-printable byte can break the round trip.
const SERVICE = "tabellar";
const keychainCache = new Map<string, string | null>();

const keychain = {
  get(account: string): string | null {
    if (keychainCache.has(account)) return keychainCache.get(account)!;
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
      encoding: "utf8",
    });
    const value = r.status === 0 ? Buffer.from(r.stdout.trim(), "hex").toString("utf8") : null;
    keychainCache.set(account, value);
    return value;
  },
  set(account: string, value: string): void {
    goodName(account);
    const hex = Buffer.from(value, "utf8").toString("hex");
    const r = spawnSync("security", ["-i"], {
      input: `add-generic-password -U -s ${SERVICE} -a ${account} -w ${hex}\n`,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`could not write to the Keychain: ${r.stderr || r.stdout}`);
    keychainCache.set(account, value);
  },
  delete(account: string): void {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { encoding: "utf8" });
    keychainCache.delete(account);
  },
};

// One file, readable by its owner only, encrypted with TABELLAR_PASSPHRASE.
// Read again when another process (`tabellar setup` beside the server) wrote it.
export const SECRETS_PATH = join(HOME, "secrets");
let kept: { stamp: string; values: Record<string, string> } | null = null;

function stamp(): string {
  const s = statSync(SECRETS_PATH, { throwIfNoEntry: false, bigint: true });
  return s ? `${s.ino} ${s.mtimeNs} ${s.size}` : "";
}

function passphrase(): string {
  const p = process.env.TABELLAR_PASSPHRASE;
  if (!p) throw new Error("Set TABELLAR_PASSPHRASE. The sign-ins and keys are kept in a file encrypted with it, because this machine has no Keychain.");
  return p;
}

function readSecrets(): Record<string, string> {
  const now = stamp();
  if (!now) return {};
  if (kept?.stamp !== now) {
    const bytes = unseal(passphrase(), readFileSync(SECRETS_PATH), "TABELLAR_PASSPHRASE is not the one the sign-ins and keys were kept with.");
    kept = { stamp: now, values: JSON.parse(bytes.toString("utf8")) };
  }
  return { ...kept.values };
}

function writeSecrets(values: Record<string, string>): void {
  const part = `${SECRETS_PATH}.${process.pid}`;
  writeFileSync(part, seal(passphrase(), Buffer.from(JSON.stringify(values), "utf8")), { mode: 0o600 });
  renameSync(part, SECRETS_PATH);
  kept = { stamp: stamp(), values };
}

const file = {
  get: (account: string): string | null => readSecrets()[account] ?? null,
  set(account: string, value: string): void {
    goodName(account);
    writeSecrets({ ...readSecrets(), [account]: value });
  },
  delete(account: string): void {
    const { [account]: gone, ...rest } = readSecrets();
    if (gone !== undefined) writeSecrets(rest);
  },
};

// What keeps every secret. `tabellar check` swaps these, so what it makes up
// is kept nowhere.
export const KEYCHAIN = MAC && !process.env.TABELLAR_PASSPHRASE;
export const secrets = { ...(KEYCHAIN ? keychain : file) };

// The token the interface and CLI present to the local server.
export function accessToken(): string {
  let token = secrets.get("access-token");
  if (!token) {
    token = randomBytes(32).toString("hex");
    secrets.set("access-token", token);
  }
  return token;
}

// The Google client sign-in uses: the user's own when they saved one, else
// the built-in one. An account's tokens only work with the client that issued
// them, so changing this means signing in again.
export function googleClient(): { id: string; secret: string; own: boolean } | null {
  const id = loadConfig().googleClientId;
  const secret = id ? secrets.get("google-client-secret") : null;
  if (id && secret) return { id, secret, own: true };
  if (BUILT_IN_GOOGLE.clientId) return { id: BUILT_IN_GOOGLE.clientId, secret: BUILT_IN_GOOGLE.clientSecret, own: false };
  return null;
}

// The backend code reads its settings through getEnv, as it did on the hosted
// runtime. Here the values come from config.json and the secrets.
export function getEnv(key: string): string {
  if (key === "GOOGLE_CLIENT_ID") return googleClient()?.id ?? "";
  if (key === "GOOGLE_CLIENT_SECRET") return googleClient()?.secret ?? "";
  return process.env[key] ?? "";
}
