// Where Tabellar keeps its files, its settings, and its secrets.
//
// ~/.tabellar/ holds the database and config.json. Secrets (the Google client
// secret, Google refresh tokens, the model API key, the local access token)
// live in the macOS Keychain under the service "tabellar", never in a file.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const HOME = process.env.TABELLAR_HOME || join(homedir(), ".tabellar");
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
  // Set only when the user brought their own Google client; its secret is in
  // the Keychain. Unset means the built-in client.
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
  return m.format === "ollama" ? null : keychainGet(modelKeyName(m.provider));
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { port: DEFAULT_PORT };
  return { port: DEFAULT_PORT, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

// ── Keychain ────────────────────────────────────────────────────────────────
// Values go through `security -i` on stdin so they never appear in the process
// list, and are stored hex-encoded so no quoting or non-printable byte can
// break the round trip.

const SERVICE = "tabellar";
const keychainCache = new Map<string, string | null>();

export function keychainGet(account: string): string | null {
  if (keychainCache.has(account)) return keychainCache.get(account)!;
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
    encoding: "utf8",
  });
  const value = r.status === 0 ? Buffer.from(r.stdout.trim(), "hex").toString("utf8") : null;
  keychainCache.set(account, value);
  return value;
}

export function keychainSet(account: string, value: string): void {
  if (!/^[\w.:@+-]+$/.test(account)) throw new Error(`bad keychain account name: ${account}`);
  const hex = Buffer.from(value, "utf8").toString("hex");
  const r = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -s ${SERVICE} -a ${account} -w ${hex}\n`,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`could not write to the Keychain: ${r.stderr || r.stdout}`);
  keychainCache.set(account, value);
}

export function keychainDelete(account: string): void {
  spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { encoding: "utf8" });
  keychainCache.delete(account);
}

// The token the interface and CLI present to the local server.
export function accessToken(): string {
  let token = keychainGet("access-token");
  if (!token) {
    token = randomBytes(32).toString("hex");
    keychainSet("access-token", token);
  }
  return token;
}

// The Google client sign-in uses: the user's own when they saved one, else
// the built-in one. An account's tokens only work with the client that issued
// them, so changing this means signing in again.
export function googleClient(): { id: string; secret: string; own: boolean } | null {
  const id = loadConfig().googleClientId;
  const secret = id ? keychainGet("google-client-secret") : null;
  if (id && secret) return { id, secret, own: true };
  if (BUILT_IN_GOOGLE.clientId) return { id: BUILT_IN_GOOGLE.clientId, secret: BUILT_IN_GOOGLE.clientSecret, own: false };
  return null;
}

// The backend code reads its settings through getEnv, as it did on the hosted
// runtime. Here the values come from config.json and the Keychain.
export function getEnv(key: string): string {
  if (key === "GOOGLE_CLIENT_ID") return googleClient()?.id ?? "";
  if (key === "GOOGLE_CLIENT_SECRET") return googleClient()?.secret ?? "";
  return process.env[key] ?? "";
}
