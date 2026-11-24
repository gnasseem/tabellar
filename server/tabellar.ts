#!/usr/bin/env node
// The `tabellar` command. The terminal is only for setting up, starting and
// opening Tabellar; everything else happens in the app window.
//
//   tabellar setup    The AI model, in the terminal (the window walks through
//                     the same steps on first start)
//   tabellar setup google   Sign in to Google through your own client
//   tabellar setup microsoft   The Azure app for Outlook and Microsoft 365
//   tabellar start    Run Tabellar and open its window (Ctrl-C stops it)
//   tabellar open     Open the window of a running Tabellar
//   tabellar status   Is it running, which accounts and model it uses
//   tabellar autostart on|off   Start Tabellar at login and keep it running
//   tabellar check    Safety checks, with planted-instruction emails

import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadConfig, saveConfig, keychainSet, modelKeyName, accessToken, googleClient, sibling, BUILT_IN_GOOGLE, HOME, type Config, type ModelConfig, type Slot } from "./config.ts";
import { autostartInstalled, installAutostart, removeAutostart } from "./launchd.ts";
import {
  findClientFiles, saveGoogleClient, saveMicrosoftClient, useBuiltInGoogleClient, moveToTrash, OLLAMA_URL, LOCAL_CHOICES, SMALL_MAC_GB, memoryGb, recommendedLocalModel,
  ollamaInstalled, ollamaModels, startOllama, installOllama, pullOllamaModel, PROVIDERS, listModels, savedKeyFor, type Progress,
} from "./setup.ts";

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

// A path dragged into Terminal arrives quoted or with escaped spaces.
function cleanPath(input: string): string {
  let p = input.trim().replace(/^['"]|['"]$/g, "").replace(/\\(.)/g, "$1");
  if (p.startsWith("~")) p = homedir() + p.slice(1);
  return p;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

// One progress line, rewritten in place.
async function showProgress(steps: AsyncGenerator<Progress>) {
  for await (const e of steps) {
    const pct = e.total && e.completed ? ` ${Math.floor((e.completed / e.total) * 100)}%` : "";
    process.stdout.write(`\r   ${e.status}${pct}`.padEnd(60));
  }
  process.stdout.write("\n");
}

// ── Google sign-in client ───────────────────────────────────────────────────

async function setupGoogle(config: Config) {
  const client = googleClient();
  if (!args.includes("google") && client) {
    console.log(
      client.own
        ? "1. Google sign-in: using your own client. (`tabellar setup google` changes it.)"
        : "1. Google sign-in: built in, nothing to set up. (`tabellar setup google` uses your own Google client instead.)",
    );
    return;
  }
  console.log("1. Google sign-in");
  if (client?.own && BUILT_IN_GOOGLE.clientId && (await yes("   Go back to the sign-in client built into Tabellar?", false))) {
    useBuiltInGoogleClient();
    delete config.googleClientId;
    console.log("   Done. Connected accounts need to sign in again from the window.");
    return;
  }
  let path = (await findClientFiles())[0] ?? "";
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
  const { clientId, warning } = saveGoogleClient(readFileSync(path, "utf8"));
  config.googleClientId = clientId;
  if (warning) console.log(`   ${warning}`);
  console.log("   Saved. The client secret is now in the Keychain. An account connected through another client needs to sign in again.");
  if (await yes(`   Move ${basename(path)} to the Trash? Tabellar no longer needs it.`)) {
    console.log(moveToTrash(path) ? "   Moved to the Trash." : `   Could not move it. Delete it yourself: ${path}`);
  }
}

// ── AI model ────────────────────────────────────────────────────────────────

async function setupLocal(current: ModelConfig | undefined, slot: Slot): Promise<ModelConfig | undefined> {
  let models = await ollamaModels();
  if (models === null) {
    if (ollamaInstalled()) {
      console.log("   Starting Ollama...");
      if (!(await startOllama())) throw new Error("Ollama did not start. Open it from Applications, then run `tabellar setup` again.");
    } else {
      console.log("   Local models run through Ollama, which is not installed yet.");
      if (!(await yes("   Download and install Ollama now (about 230 MB)?"))) return current;
      await showProgress(installOllama());
    }
    models = (await ollamaModels()) ?? [];
  }
  const names = models.map((m) => m.name);
  const suggested = recommendedLocalModel(slot);
  const size = gb(LOCAL_CHOICES.find((c) => c.name === suggested)!.size);
  const about = (name: string) => LOCAL_CHOICES.find((c) => c.name === name)?.about;
  if (slot === "careful" && memoryGb() < SMALL_MAC_GB) {
    console.log(`   With ${memoryGb()} GB of memory one small model does everything here, and its drafts are plainer.`);
    console.log("   A cloud model writes drafts faster and closer to your voice.");
  }
  let model: string;
  if (names.length) {
    const options = names.map((n) => (about(n) ? `${n}: ${about(n)}` : n));
    if (!names.includes(suggested)) options.push(`Download ${suggested}, recommended for this Mac (${size}): ${about(suggested)}`);
    const fallback = current?.format === "ollama" && names.includes(current.model) ? names.indexOf(current.model) : Math.max(0, options.findIndex((o) => o === suggested || o.startsWith("Download")));
    const i = await choose("   Model:", options, fallback);
    model = i < names.length ? names[i] : suggested;
  } else {
    console.log(`   No local models yet. The recommended one for this Mac is ${suggested} (${size}).`);
    console.log(`   ${about(suggested)}.`);
    if (!(await yes(`   Download ${suggested} now?`))) return current;
    model = suggested;
  }
  if (!names.includes(model)) await showProgress(pullOllamaModel(model));
  return { provider: "ollama", format: "ollama", baseUrl: OLLAMA_URL, model };
}

async function chooseModel(ids: string[], suggested: string): Promise<string> {
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
  const saved = savedKeyFor(p.id);
  if (!saved && p.keyUrl) console.log(`   Get a key at ${p.keyUrl}`);
  const key = (await askSecret(`   API key${saved ? " (Enter to keep the saved one)" : ""}:`)) || saved || "";
  if (!key) throw new Error("A cloud model needs an API key.");
  const listed = await listModels(p, base, key);
  if (listed === "unauthorized") throw new Error("The provider rejected that API key, so it was not saved.");
  keychainSet(modelKeyName(p.id), key);
  const model = await chooseModel(listed ?? [], same ? current!.model : (p.suggested ?? ""));
  return { provider: p.id, format: p.format, baseUrl: base, model };
}

async function pickModel(current: ModelConfig | undefined, slot: Slot): Promise<ModelConfig | undefined> {
  const ollamaUp = (await ollamaModels()) !== null;
  const fallback = current ? (current.format === "ollama" ? 0 : 1) : ollamaUp ? 0 : 1;
  const where = await choose(
    "   Where should it run?",
    ["On this Mac, free and private (Ollama)", "In the cloud, with your own API key (billed by the provider)"],
    fallback,
  );
  return where === 0 ? await setupLocal(current, slot) : await setupCloud(current);
}

async function setupModel(config: Config) {
  console.log("\n2. AI models");
  console.log("   The careful model writes drafts and runs Ask and its cleanup plans.");
  config.model = await pickModel(config.model, "careful");
  saveConfig(config);
  if (!config.model) return;
  console.log(`   Using ${config.model.model}.`);
  console.log("\n   The fast model reads each new email to sort it, summarise it and find todos and meetings.");
  const suggestSmaller = !!config.fastModel || (config.model.format === "ollama" && recommendedLocalModel("fast") !== config.model.model);
  const same = await choose("   Fast model:", [`The same model, ${config.model.model}`, "A different, usually smaller, model"], suggestSmaller ? 1 : 0);
  if (same === 0) delete config.fastModel;
  else {
    const fast = await pickModel(config.fastModel, "fast");
    if (fast && !(fast.format === config.model.format && fast.baseUrl === config.model.baseUrl && fast.model === config.model.model)) config.fastModel = fast;
    else delete config.fastModel;
  }
  saveConfig(config);
  if (config.fastModel) console.log(`   Reading mail with ${config.fastModel.model}.`);
}

// The Application (client) ID of the app registered in the Azure portal.
async function setupMicrosoft() {
  const current = loadConfig().microsoftClientId;
  console.log(`Outlook and Microsoft 365 sign in through an app you register in Microsoft's Azure portal (the README lists the steps).${current ? `\nIn use now: ${current}` : ""}`);
  const id = (await ask("Paste its Application (client) ID, or press Enter to keep what is there:")).trim();
  if (id) saveMicrosoftClient(id);
  console.log(id ? "Saved. Add the account in the window: Settings, Accounts, Add an account, Outlook." : "Nothing changed.");
  process.stdin.pause();
}

async function setup() {
  if (args.includes("microsoft")) return setupMicrosoft();
  const config = loadConfig();
  console.log("Tabellar setup. Press Enter to accept the answer in brackets.\n");
  await setupGoogle(config);
  await setupModel(config);
  console.log(`\nSettings are in ${HOME}/config.json; secrets are in the macOS Keychain.`);
  if (!config.model) console.log("No AI model is set up yet, so Tabellar can sync mail but not sort or draft it. Run `tabellar setup` again when ready.");
  console.log("Next: run `tabellar start`, then add your mail in the window that opens.");
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
  const client = googleClient();
  console.log(`Google:   ${client ? (client.own ? "your own sign-in client" : "built-in sign-in client") : "not set up (tabellar setup)"}`);
  console.log(`Outlook:  ${config.microsoftClientId ? `app ${config.microsoftClientId}` : "no Azure app yet (tabellar setup microsoft)"}`);
  const where = (m: ModelConfig) => (m.format === "ollama" ? "on this Mac (Ollama)" : `via ${PROVIDERS.find((p) => p.id === m.provider)?.name ?? m.baseUrl}`);
  const m = config.model;
  console.log(`Model:    ${m ? `${m.model} ${where(m)}` : "not set up (tabellar setup)"}`);
  if (m) console.log(`Fast:     ${config.fastModel ? `${config.fastModel.model} ${where(config.fastModel)}` : "the same model"}`);
  console.log(`At login: ${autostartInstalled() ? "starts automatically (tabellar autostart off to stop)" : "no (tabellar autostart on)"}`);
  if (up) {
    const headers = { Authorization: `Bearer ${accessToken()}` };
    const s = (await (await fetch(`${baseUrl()}/session`, { headers })).json()) as { user: { email: string } | null; accounts: number };
    console.log(`Accounts: ${s.user ? `${s.accounts} connected (${s.user.email})` : "none yet, sign in from the window"}`);
    if (s.user) {
      const e = (await (await fetch(`${baseUrl()}/api/engine/status`, { headers })).json()) as { level: string; paused: boolean; lastCycleAt: string | null; lastError: string | null };
      const last = e.lastCycleAt ? `last checked mail ${new Date(e.lastCycleAt).toLocaleTimeString()}` : "has not checked mail yet";
      console.log(`Engine:   ${e.paused ? "paused" : e.level}, ${last}${e.lastError ? ` (error: ${e.lastError})` : ""}`);
    }
  }
}

async function autostart() {
  const which = args[0];
  if (which === "on") {
    installAutostart();
    console.log("Tabellar now starts at login and keeps running in the background.");
    console.log(`Its log is ${join(HOME, "server.log")}. Open the window with \`tabellar open\`.`);
  } else if (which === "off") {
    removeAutostart();
    console.log("Tabellar no longer starts at login, and the background copy is stopped.");
  } else {
    console.log(autostartInstalled() ? "Tabellar starts at login." : "Tabellar does not start at login.");
    console.log("Usage: tabellar autostart on|off");
  }
}

// Runs check.ts against a throwaway data folder, carrying over only the model
// settings so the planted emails can also go through the real model.
function check() {
  const home = mkdtempSync(join(tmpdir(), "tabellar-check-"));
  try {
    const { model } = loadConfig();
    if (model) writeFileSync(join(home, "config.json"), JSON.stringify({ model }));
    const r = spawnSync(process.execPath, [sibling("check")], {
      stdio: "inherit",
      env: { ...process.env, TABELLAR_HOME: home },
    });
    process.exitCode = r.status ?? 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

try {
  if (command === "setup") await setup();
  else if (command === "start") await start();
  else if (command === "open") {
    if (!(await running())) throw new Error("Tabellar is not running. Start it with `tabellar start`.");
    await openWindow();
  } else if (command === "status") await status();
  else if (command === "autostart") await autostart();
  else if (command === "check") check();
  else {
    console.log("Usage: tabellar <setup|start|open|status|autostart|check>");
    process.exitCode = command === "help" ? 0 : 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
