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

export const HOME = process.env.TABELLAR_HOME || join(homedir(), ".tabellar");
export const DB_PATH = join(HOME, "tabellar.db");
export const CONFIG_PATH = join(HOME, "config.json");
export const DEFAULT_PORT = 4848;

mkdirSync(HOME, { recursive: true, mode: 0o700 });

export type ModelConfig = {
  provider?: string; // "ollama", "openrouter", "anthropic", "openai", ... (setup's provider list)
  // Wire format: Ollama's native chat API, Anthropic Messages, or OpenAI chat completions.
  format: "ollama" | "anthropic" | "openai";
  baseUrl: string; // e.g. http://127.0.0.1:11434, https://api.anthropic.com/v1, https://openrouter.ai/api/v1
  model: string;
};

export type Config = {
  port: number;
  googleClientId?: string;
  model?: ModelConfig;
};

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

// The backend code reads its settings through getEnv, as it did on the hosted
// runtime. Here the values come from config.json and the Keychain.
export function getEnv(key: string): string {
  if (key === "GOOGLE_CLIENT_ID") return loadConfig().googleClientId ?? "";
  if (key === "GOOGLE_CLIENT_SECRET") return keychainGet("google-client-secret") ?? "";
  return process.env[key] ?? "";
}
