#!/usr/bin/env node
// The `tabellar` command. The terminal is only for setting up, starting and
// opening Tabellar; everything else happens in the app window.
//
//   tabellar setup    Google sign-in client and the AI model (local or cloud)
//   tabellar start    Run Tabellar and open its window (Ctrl-C stops it)
//   tabellar open     Open the window of a running Tabellar
//   tabellar status   Is it running, which accounts and model it uses

import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, renameSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, keychainGet, keychainSet, accessToken, HOME, type Config, type ModelConfig } from "./config.ts";

const [command = "help", ...args] = process.argv.slice(2);

// One reader for the whole session, so answers piped in all at once are not lost.
let lines: AsyncIterator<string> | null = null;
async function readLine(): Promise<string> {
  lines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const r = await lines.next();
  if (r.done) throw new Error("Setup was cancelled.");
  return r.value.trim();
}

async function ask(question: string, fallback = ""): Promise<string> {
  process.stdout.write(fallback ? `${question} [${fallback}] ` : `${question} `);
  return (await readLine()) || fallback;
}

// Read a secret without echoing it to the terminal.
async function askSecret(question: string): Promise<string> {
  process.stdout.write(`${question} `);
  const tty = process.stdin.isTTY;
  if (tty) spawnSync("stty", ["-echo"], { stdio: "inherit" });
  try {
    return await readLine();
  } finally {
    if (tty) spawnSync("stty", ["echo"], { stdio: "inherit" });
    process.stdout.write("\n");
  }
}

function baseUrl(): string {
  return `http://127.0.0.1:${loadConfig().port}`;
}

async function running(): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl()}/api/health`, { headers: { Authorization: `Bearer ${accessToken()}` } });
    return r.ok;
  } catch {
    return false;
  }
}

async function openWindow() {
  const r = await fetch(`${baseUrl()}/auth/login-code`, { method: "POST", headers: { Authorization: `Bearer ${accessToken()}` } });
  if (!r.ok) throw new Error(`Tabellar did not answer (${r.status})`);
  const { code } = (await r.json()) as { code: string };
  spawnSync("open", [`${baseUrl()}/?code=${code}`]);
}

async function yes(question: string, fallback = true): Promise<boolean> {
  const a = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  return a ? a.startsWith("y") : fallback;
}

// Numbered menu; returns the chosen index.
async function choose(question: string, options: string[], fallback = 0): Promise<number> {
  options.forEach((o, i) => console.log(`   ${String(i + 1).padStart(2)}. ${o}`));
  for (;;) {
    const n = Number(await ask(question, String(fallback + 1)));
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    console.log(`   Type a number from 1 to ${options.length}.`);
  }
}

// ── Google sign-in client ───────────────────────────────────────────────────

// Google Cloud's "Download JSON" saves client_secret_<id>.json. Look wherever
// it is likely to be: here, the Tabellar folder, Downloads, Desktop, Documents.
const INSTALL_DIR = fileURLToPath(new URL("..", import.meta.url));
function findClientFiles(): string[] {
  const found = new Set<string>();
  const home = homedir();
  for (const dir of [process.cwd(), INSTALL_DIR, join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents")]) {
    try {
      for (const f of readdirSync(dir)) if (/^client_secret.*\.json$/i.test(f)) found.add(join(dir, f));
    } catch {
      /* folder missing or not readable */
    }
  }
  return [...found].sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs);
}

// A path dragged into Terminal arrives quoted or with escaped spaces.
function cleanPath(input: string): string {
  let p = input.trim().replace(/^['"]|['"]$/g, "").replace(/\\(.)/g, "$1");
  if (p.startsWith("~")) p = homedir() + p.slice(1);
  return p;
}

async function setupGoogle(config: Config) {
  const redo = args.includes("google");
  if (!redo && config.googleClientId && keychainGet("google-client-secret")) {
    console.log("1. Google sign-in: already set up. (`tabellar setup google` replaces it.)");
    return;
  }
  console.log("1. Google sign-in");
  let path = findClientFiles()[0] ?? "";
  if (path) {
    console.log(`   Using ${basename(path)}`);
    console.log(`   from ${dirname(path)}.`);
  } else {
    console.log("   No client_secret file found in Downloads, Desktop, Documents or the Tabellar folder.");
    const typed = cleanPath(await ask("   Drag the file into this window and press Enter, or just press Enter to skip for now:"));
    if (!typed) {
      console.log("   Skipped. Run `tabellar setup` again once the file is downloaded.");
      return;
    }
    if (!existsSync(typed)) throw new Error(`No file at ${typed}`);
    path = typed;
  }
  const json = JSON.parse(readFileSync(path, "utf8"));
  const client = json.installed ?? json.web;
  if (!client?.client_id || !client?.client_secret) throw new Error(`${basename(path)} is not a Google OAuth client file.`);
  if (!json.installed) console.log("   This is a Web application client. Tabellar needs a Desktop app client, so sign-in may fail.");
  config.googleClientId = client.client_id;
  keychainSet("google-client-secret", client.client_secret);
  saveConfig(config);
  console.log("   Saved. The client secret is now in the Keychain.");
  if (await yes(`   Move ${basename(path)} to the Trash? Tabellar no longer needs it.`)) {
    try {
      renameSync(path, join(homedir(), ".Trash", `${Date.now()}-${basename(path)}`));
      console.log("   Moved to the Trash.");
    } catch {
      console.log(`   Could not move it. Delete it yourself: ${path}`);
    }
  }
}

// ── AI model ────────────────────────────────────────────────────────────────

const OLLAMA_URL = "http://127.0.0.1:11434";

type Provider = { id: string; name: string; format: ModelConfig["format"]; baseUrl: string; suggested?: string };
const PROVIDERS: Provider[] = [
  { id: "openrouter", name: "OpenRouter (most models, one key)", format: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "anthropic", name: "Anthropic (Claude)", format: "anthropic", baseUrl: "https://api.anthropic.com/v1", suggested: "claude-opus-5-5" },
  { id: "openai", name: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "gemini", name: "Google Gemini", format: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "groq", name: "Groq", format: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "mistral", name: "Mistral", format: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { id: "deepseek", name: "DeepSeek", format: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "xai", name: "xAI (Grok)", format: "openai", baseUrl: "https://api.x.ai/v1" },
  { id: "together", name: "Together AI", format: "openai", baseUrl: "https://api.together.xyz/v1" },
  { id: "cerebras", name: "Cerebras", format: "openai", baseUrl: "https://api.cerebras.ai/v1" },
  { id: "custom", name: "Another OpenAI-compatible endpoint", format: "openai", baseUrl: "" },
];

async function ollamaModels(): Promise<string[] | null> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!r.ok) return null;
    return (((await r.json()) as { models?: { name: string }[] }).models ?? []).map((m) => m.name);
  } catch {
    return null;
  }
}

// Download a model through Ollama, printing progress on one line.
async function ollamaPull(model: string): Promise<boolean> {
  const r = await fetch(`${OLLAMA_URL}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: true }) });
  if (!r.ok || !r.body) return false;
  let buffer = "";
  let ok = false;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += Buffer.from(chunk).toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
      if (e.error) {
        console.log(`\n   Ollama: ${e.error}`);
        return false;
      }
      const pct = e.total && e.completed ? ` ${Math.floor((e.completed / e.total) * 100)}%` : "";
      process.stdout.write(`\r   ${e.status ?? ""}${pct}`.padEnd(60));
      if (e.status === "success") ok = true;
    }
  }
  process.stdout.write("\n");
  return ok;
}

async function setupLocal(current?: ModelConfig): Promise<ModelConfig | undefined> {
  const models = await ollamaModels();
  if (models === null) {
    const installed = existsSync("/Applications/Ollama.app") || spawnSync("which", ["ollama"]).status === 0;
    console.log(
      installed
        ? "   Ollama is installed but not running. Open the Ollama app, then run `tabellar setup` again."
        : "   Local models run through Ollama, which is not installed yet. Get it from https://ollama.com/download,\n   open it once, then run `tabellar setup` again.",
    );
    return current;
  }
  const gb = totalmem() / 2 ** 30;
  const suggested = gb >= 48 ? "qwen3:14b" : gb >= 12 ? "qwen3:8b" : "qwen3:4b";
  const sizes: Record<string, string> = { "qwen3:14b": "about 9 GB", "qwen3:8b": "about 5 GB", "qwen3:4b": "about 2.5 GB" };
  let model: string;
  if (models.length) {
    const options = [...models];
    if (!models.includes(suggested)) options.push(`Download ${suggested}, recommended for this Mac (${sizes[suggested]})`);
    const fallback = current?.format === "ollama" && models.includes(current.model) ? models.indexOf(current.model) : Math.max(0, options.findIndex((o) => o === suggested || o.startsWith("Download")));
    const i = await choose("   Model:", options, fallback);
    model = i < models.length ? models[i] : suggested;
  } else {
    console.log(`   No local models yet. The recommended one for this Mac is ${suggested} (${sizes[suggested]}).`);
    if (!(await yes(`   Download ${suggested} now?`))) return current;
    model = suggested;
  }
  if (!models.includes(model) && !(await ollamaPull(model))) throw new Error(`Could not download ${model}.`);
  return { provider: "ollama", format: "ollama", baseUrl: OLLAMA_URL, model };
}

// The provider's model list, which also checks the key. Listing models is free.
async function listModels(p: Provider, base: string, key: string): Promise<string[] | "unauthorized" | null> {
  const headers: Record<string, string> = p.format === "anthropic" ? { "x-api-key": key, "anthropic-version": "2026-10-21" } : { Authorization: `Bearer ${key}` };
  try {
    // OpenRouter lists models without a key, so check the key on its own.
    if (p.id === "openrouter") {
      const k = await fetch(`${base}/key`, { headers });
      if (k.status === 401 || k.status === 403) return "unauthorized";
    }
    const r = await fetch(`${base}/models${p.format === "anthropic" ? "?limit=100" : ""}`, { headers });
    if (r.status === 401 || r.status === 403) return "unauthorized";
    if (!r.ok) return null;
    const data = (await r.json()) as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] };
    return (data.data ?? data.models ?? []).map((m) => m.id ?? m.name ?? "").filter(Boolean);
  } catch {
    return null;
  }
}

// Models that are not for chat, left out of the menu.
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|audio|realtime|transcri|image|rerank|guard|babbage|davinci/i;

async function chooseModel(all: string[], suggested: string): Promise<string> {
  const ids = all.filter((id) => !NOT_CHAT.test(id));
  if (!ids.length) {
    const typed = await ask("   Model name:", suggested);
    if (!typed) throw new Error("A model name is needed.");
    return typed;
  }
  if (ids.length <= 30) return ids[await choose("   Model:", ids, Math.max(0, ids.indexOf(suggested)))];
  for (;;) {
    const q = await ask(`   ${ids.length} models. Type part of a name to search (claude, gpt, gemini, llama, ...):`, suggested);
    if (ids.includes(q)) return q;
    const hits = ids.filter((id) => id.toLowerCase().includes(q.toLowerCase())).sort();
    if (!q || !hits.length) console.log("   No match, try another name.");
    else if (hits.length > 30) console.log(`   ${hits.length} matches, be more specific.`);
    else return hits[await choose("   Model:", hits, 0)];
  }
}

async function setupCloud(current?: ModelConfig): Promise<ModelConfig> {
  const p = PROVIDERS[await choose("   Provider:", PROVIDERS.map((x) => x.name), Math.max(0, PROVIDERS.findIndex((x) => x.id === current?.provider)))];
  const same = current?.provider === p.id;
  let base = p.baseUrl;
  if (p.id === "custom") base = await ask("   Base URL (usually ends in /v1):", same ? current!.baseUrl : "");
  base = base.replace(/\/+$/, "");
  const saved = same ? keychainGet("model-api-key") : null;
  const key = (await askSecret(`   API key${saved ? " (Enter to keep the saved one)" : ""}:`)) || saved || "";
  if (!key) throw new Error("A cloud model needs an API key.");
  const listed = await listModels(p, base, key);
  if (listed === "unauthorized") throw new Error("The provider rejected that API key, so it was not saved.");
  keychainSet("model-api-key", key);
  const model = await chooseModel(listed ?? [], same ? current!.model : (p.suggested ?? ""));
  return { provider: p.id, format: p.format, baseUrl: base, model };
}

async function setupModel(config: Config) {
  console.log("\n2. AI model");
  const ollamaUp = (await ollamaModels()) !== null;
  const fallback = config.model ? (config.model.format === "ollama" ? 0 : 1) : ollamaUp ? 0 : 1;
  const where = await choose(
    "   Where should the AI run?",
    ["On this Mac, free and private (Ollama)", "In the cloud, with your own API key (billed by the provider)"],
    fallback,
  );
  config.model = where === 0 ? await setupLocal(config.model) : await setupCloud(config.model);
  saveConfig(config);
  if (config.model) console.log(`   Using ${config.model.model}.`);
}

async function setup() {
  const config = loadConfig();
  console.log("Tabellar setup. Press Enter to accept the answer in brackets.\n");
  await setupGoogle(config);
  await setupModel(config);
  console.log(`\nSettings are in ${HOME}/config.json; secrets are in the macOS Keychain.`);
  if (!config.model) console.log("No AI model is set up yet, so Tabellar can sync mail but not sort or draft it. Run `tabellar setup` again when ready.");
  console.log("Next: run `tabellar start`, then sign in with Google in the window that opens.");
  process.stdin.pause();
}

async function start() {
  if (await running()) {
    console.log("Tabellar is already running. Opening its window.");
    return openWindow();
  }
  const { startServer } = await import("./server.ts");
  const { port } = await startServer();
  console.log(`Tabellar is running at http://127.0.0.1:${port} (Ctrl-C to stop).`);
  if (!args.includes("--no-open")) await openWindow();
}

async function status() {
  const config = loadConfig();
  const up = await running();
  console.log(`Running:  ${up ? `yes, http://127.0.0.1:${config.port}` : "no"}`);
  console.log(`Google:   ${config.googleClientId ? "sign-in client set" : "not set up (tabellar setup)"}`);
  const m = config.model;
  const where = m?.format === "ollama" ? "on this Mac (Ollama)" : `via ${PROVIDERS.find((p) => p.id === m?.provider)?.name ?? m?.baseUrl}`;
  console.log(`Model:    ${m ? `${m.model} ${where}` : "not set up (tabellar setup)"}`);
  if (up) {
    const r = await fetch(`${baseUrl()}/session`, { headers: { Authorization: `Bearer ${accessToken()}` } });
    const s = (await r.json()) as { user: { email: string } | null; accounts: number };
    console.log(`Accounts: ${s.user ? `${s.accounts} connected (${s.user.email})` : "none yet, sign in from the window"}`);
  }
}

try {
  if (command === "setup") await setup();
  else if (command === "start") await start();
  else if (command === "open") {
    if (!(await running())) throw new Error("Tabellar is not running. Start it with `tabellar start`.");
    await openWindow();
  } else if (command === "status") await status();
  else {
    console.log("Usage: tabellar <setup|start|open|status>");
    process.exitCode = command === "help" ? 0 : 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
