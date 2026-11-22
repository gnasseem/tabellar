#!/usr/bin/env node
// The `tabellar` command. The terminal is only for setting up, starting and
// opening Tabellar; everything else happens in the app window.
//
//   tabellar setup    Google sign-in client and the cloud model
//   tabellar start    Run Tabellar and open its window (Ctrl-C stops it)
//   tabellar open     Open the window of a running Tabellar
//   tabellar status   Is it running, which accounts and model it uses

import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, saveConfig, keychainGet, keychainSet, accessToken, HOME, type ModelConfig } from "./config.ts";

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

async function setup() {
  const config = loadConfig();
  console.log("Tabellar setup. Press Enter to keep the value in brackets.\n");

  console.log("1. Google sign-in client");
  console.log("   In Google Cloud Console, create an OAuth client of type \"Desktop app\" and download its JSON file.");
  const clientInput = await ask("   Path to the downloaded JSON file, or the client ID:", config.googleClientId ?? "");
  if (clientInput.endsWith(".json") && existsSync(clientInput.replace(/^~/, process.env.HOME ?? ""))) {
    const json = JSON.parse(readFileSync(clientInput.replace(/^~/, process.env.HOME ?? ""), "utf8"));
    const c = json.installed ?? json.web;
    if (!c?.client_id || !c?.client_secret) throw new Error("That file does not look like a Google OAuth client.");
    config.googleClientId = c.client_id;
    keychainSet("google-client-secret", c.client_secret);
  } else if (clientInput) {
    config.googleClientId = clientInput;
    const secret = await askSecret(`   Client secret${keychainGet("google-client-secret") ? " (Enter to keep the saved one)" : ""}:`);
    if (secret) keychainSet("google-client-secret", secret);
  }

  console.log("\n2. Cloud model (billed to your own key)");
  const current = config.model;
  const format = (await ask("   API format: anthropic or openai (any OpenAI-compatible endpoint):", current?.format ?? "anthropic")) as ModelConfig["format"];
  if (format !== "anthropic" && format !== "openai") throw new Error("Choose anthropic or openai.");
  const defaults = format === "anthropic" ? { baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-5-5" } : { baseUrl: "https://openrouter.ai/api/v1", model: "" };
  const sameFormat = current?.format === format;
  const base = await ask("   Base URL:", sameFormat ? current!.baseUrl : defaults.baseUrl);
  const model = await ask("   Model:", sameFormat ? current!.model : defaults.model);
  if (!model) throw new Error("A model name is needed.");
  const key = await askSecret(`   API key${keychainGet("model-api-key") ? " (Enter to keep the saved one)" : ""}:`);
  if (key) keychainSet("model-api-key", key);
  config.model = { format, baseUrl: base, model };
  saveConfig(config);

  // Check the key and model without spending anything: both providers list models for free.
  const savedKey = keychainGet("model-api-key") ?? "";
  const check =
    format === "anthropic"
      ? await fetch(`${base.replace(/\/+$/, "")}/models/${model}`, { headers: { "x-api-key": savedKey, "anthropic-version": "2026-10-21" } })
      : await fetch(`${base.replace(/\/+$/, "")}/models`, { headers: { Authorization: `Bearer ${savedKey}` } });
  console.log(check.ok ? "   Key and model look good." : `   The provider answered ${check.status}; check the key and model name.`);

  console.log(`\nSaved settings in ${HOME}/config.json and secrets in the macOS Keychain.`);
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
  console.log(`Model:    ${config.model ? `${config.model.model} via ${config.model.baseUrl}` : "not set up (tabellar setup)"}`);
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
