#!/usr/bin/env node
// The `tabellar` command. The terminal is only for setting up, starting and
// opening Tabellar; everything else happens in the app window.
//
//   tabellar setup    The AI model, in the terminal (the window walks through
//                     the same steps on first start)
//   tabellar setup google   Sign in to Google through your own client
//   tabellar setup microsoft   The Azure app for Outlook and Microsoft 365
//   tabellar start    Run Tabellar and open its window (Ctrl-C stops it)
//   tabellar serve    Run it on a machine with no screen: no window, no menu
//                     bar, Telegram for what would be a notification
//   tabellar open     Open the window of a running Tabellar
//   tabellar status   Is it running, which accounts and model it uses
//   tabellar autostart on|off   Start Tabellar at login (on Linux, with the
//                     machine) and keep it running
//   tabellar move [file]   Write everything into one encrypted file and stop
//                     here for good; `start <file>` or `serve <file>` goes on
//                     from it elsewhere. `move back` if that place is gone
//   tabellar mcp      What Tabellar knows and may do, for Claude and other AI
//                     programs that start it themselves (it never sends)
//   tabellar check    Safety checks, with planted-instruction emails

import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig, saveConfig, modelKeyName, accessToken, googleClient, sibling, BUILT_IN_GOOGLE, BUILT_IN_MICROSOFT, HOME, KEYCHAIN, MAC, type Config, type ModelConfig, type Slot, secrets } from "./config.ts";
import { autostartHere, autostartInstalled, installAutostart, removeAutostart } from "./autostart.ts";
import { publicUrl } from "./access.ts";
import { lock, unlock } from "./place.ts";
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
  const pub = publicUrl();
  const link = `${pub?.origin ?? baseUrl()}/?code=${code}`;
  if (pub) return console.log(`Open this within 5 minutes and make a passkey:\n  ${link}`);
  if (MAC && !process.env.SSH_CONNECTION) return void spawnSync("open", [link]);
  const { port } = loadConfig();
  console.log(`Open this within 5 minutes:\n  ${link}`);
  console.log(`From another computer, first run this there and leave it running:\n  ssh -N -L ${port}:127.0.0.1:${port} ${existsSync("/.dockerenv") ? "you@your-server" : `${userInfo().username}@${hostname()}`}`);
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
  console.log(`   Saved. The client secret is now ${KEYCHAIN ? "in the Keychain" : "kept encrypted"}. An account connected through another client needs to sign in again.`);
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
    if (!names.includes(suggested)) options.push(`Download ${suggested}, recommended for this machine (${size}): ${about(suggested)}`);
    const fallback = current?.format === "ollama" && names.includes(current.model) ? names.indexOf(current.model) : Math.max(0, options.findIndex((o) => o === suggested || o.startsWith("Download")));
    const i = await choose("   Model:", options, fallback);
    model = i < names.length ? names[i] : suggested;
  } else {
    console.log(`   No local models yet. The recommended one for this machine is ${suggested} (${size}).`);
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
  const list = PROVIDERS.filter((x) => x.id !== "plus"); // its code goes in the window
  const p = list[await choose("   Provider:", list.map((x) => x.name), Math.max(0, list.findIndex((x) => x.id === current?.provider)))];
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
  secrets.set(modelKeyName(p.id), key);
  const model = await chooseModel(listed ?? [], same ? current!.model : (p.suggested ?? ""));
  return { provider: p.id, format: p.format, baseUrl: base, model };
}

async function pickModel(current: ModelConfig | undefined, slot: Slot): Promise<ModelConfig | undefined> {
  const ollamaUp = (await ollamaModels()) !== null;
  const fallback = current ? (current.format === "ollama" ? 0 : 1) : ollamaUp ? 0 : 1;
  const where = await choose(
    "   Where should it run?",
    [MAC ? "On this Mac, free and private (Ollama)" : "On this machine, free and private (Ollama; needs a GPU to be quick)", "In the cloud, with your own API key (billed by the provider)"],
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
  console.log(`\nSettings are in ${HOME}/config.json; secrets are ${KEYCHAIN ? "in the macOS Keychain" : `encrypted in ${HOME}/secrets`}.`);
  if (!config.model) console.log("No AI model is set up yet, so Tabellar can sync mail but not sort or draft it. Run `tabellar setup` again when ready.");
  console.log("Next: run `tabellar start`, then add your mail in the window that opens.");
  process.stdin.pause();
}

// A file `tabellar move` wrote, given to start or serve.
const moveFile = () => args.find((a) => !a.startsWith("-"));

async function start(headless: boolean) {
  const file = moveFile();
  const quiet = headless || args.includes("--no-open");
  if (await running()) {
    if (file) throw new Error("Tabellar is already running here.");
    // The login item was turned on while this one was already running: it
    // takes over the next time, and opens no window.
    if (quiet) return console.log("Tabellar is already running.");
    console.log("Tabellar is already running. Opening its window.");
    return openWindow();
  }
  if (!lock()) throw new Error(`Another Tabellar is running on ${HOME}.`);
  if (file && existsSync(file)) {
    const { unpack } = await import("./move.ts");
    const deleted = unpack(file, process.env.TABELLAR_MOVE_PASSPHRASE || (await askSecret("The passphrase the file was written with:")));
    process.stdin.pause();
    console.log(`Moved here. ${deleted ? "The file is deleted." : `Delete ${file}: it holds your mail and sign-ins.`}`);
  } else if (file && !existsSync(join(HOME, "tabellar.db"))) throw new Error(`No file at ${file}`);
  const moved = await (await import("./move.ts")).movedAway();
  // Ends well, so launchd and systemd do not start it again.
  if (moved) return console.log(moved);
  const { startServer } = await import("./server.ts");
  await (await import("./engine.ts")).pauseIfCopied();
  let ending = false;
  const stop = async () => {
    if (ending) return;
    ending = true;
    await close();
    process.exit(0);
  };
  const { port, close } = await startServer({ headless, stop: () => void stop() });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());
  console.log(`Tabellar is running at http://127.0.0.1:${port} (Ctrl-C to stop).`);
  if (!quiet) await openWindow();
  else if (headless) console.log("Its window: run `tabellar open` for a link.");
}

async function move() {
  if (args[0] === "back") {
    if (!(await yes("Only if Tabellar does not run in the other place any more, or never did. Make this its place again?", false))) return process.stdin.pause();
    process.stdin.pause();
    if (!lock()) throw new Error(`A Tabellar is running on ${HOME}.`);
    await (await import("./move.ts")).moveBack();
    return console.log("Done. It is paused: start it, look, then turn Pause off.");
  }
  const { pack, WORDS } = await import("./move.ts");
  const path = resolve(cleanPath(moveFile() ?? `tabellar-${new Date().toISOString().slice(0, 10)}.move`));
  let passphrase = process.env.TABELLAR_MOVE_PASSPHRASE ?? "";
  if (!passphrase) {
    console.log(`Everything goes into ${path}, encrypted, and Tabellar stops here for good. The file holds your mail and sign-ins.`);
    passphrase = await askSecret(`Choose a passphrase for it, at least ${WORDS} characters:`);
    const again = await askSecret("The same again:");
    process.stdin.pause();
    if (passphrase !== again) throw new Error("The two are not the same. Nothing was done.");
  }
  if (passphrase.length < WORDS) throw new Error(`The passphrase needs at least ${WORDS} characters. Nothing was done.`);
  if (existsSync(path)) throw new Error(`${path} is already there. Nothing was done.`);
  try {
    accessSync(dirname(path), constants.W_OK);
  } catch {
    throw new Error(`Nothing can be written to ${dirname(path)}. Nothing was done.`);
  }
  const up = await running();
  if (up) await fetch(`${baseUrl()}/stop`, { method: "POST", headers: { Authorization: `Bearer ${accessToken()}` } });
  for (let i = 0; !lock() || (up && (await running())); i++) {
    if (i > 40) throw new Error("Tabellar is running here and did not stop. Stop it (Ctrl-C, `docker stop`), then run this again.");
    await new Promise((r) => setTimeout(r, 500));
  }
  await pack(path, passphrase);
  unlock();
  if (autostartHere()) removeAutostart();
  console.log(`Written: ${path}\nOn the other machine, with Tabellar installed: tabellar ${MAC ? "serve" : "start"} <the file>\nIt is deleted there once Tabellar has begun from it. Delete this copy too.`);
}

async function status() {
  const config = loadConfig();
  const up = await running();
  console.log(`Running:  ${up ? `yes, http://127.0.0.1:${config.port}` : "no"}`);
  const client = googleClient();
  console.log(`Google:   ${client ? (client.own ? "your own sign-in client" : "built-in sign-in client") : "not set up (tabellar setup)"}`);
  console.log(`Outlook:  ${config.microsoftClientId ? `app ${config.microsoftClientId}` : BUILT_IN_MICROSOFT ? "built-in app" : "no Azure app yet (tabellar setup microsoft)"}`);
  const where = (m: ModelConfig) => (m.format === "ollama" ? "here (Ollama)" : `via ${PROVIDERS.find((p) => p.id === m.provider)?.name ?? m.baseUrl}`);
  const m = config.model;
  console.log(`Model:    ${m ? `${m.model} ${where(m)}` : "not set up (tabellar setup)"}`);
  if (m) console.log(`Fast:     ${config.fastModel ? `${config.fastModel.model} ${where(config.fastModel)}` : "the same model"}`);
  console.log(`${MAC ? "At login: " : "At boot:  "}${autostartInstalled() ? "starts automatically (tabellar autostart off to stop)" : "no (tabellar autostart on)"}`);
  if (up) {
    const headers = { Authorization: `Bearer ${accessToken()}` };
    const s = (await (await fetch(`${baseUrl()}/session`, { headers })).json()) as { user: { email: string } | null; accounts: number };
    console.log(`Accounts: ${s.user ? `${s.accounts} connected (${s.user.email})` : "none yet, sign in from the window"}`);
    if (s.user) {
      const e = (await (await fetch(`${baseUrl()}/api/engine/status`, { headers })).json()) as { level: string; paused: boolean; lastCycleAt: string | null; lastError: string | null };
      const last = e.lastCycleAt ? `last checked mail ${new Date(e.lastCycleAt).toLocaleTimeString()}` : "has not checked mail yet";
      console.log(`Engine:   ${e.paused ? "paused" : e.level}, ${last}${e.lastError ? ` (error: ${e.lastError})` : ""}`);
      const d = (await (await fetch(`${baseUrl()}/api/briefing/decisions`, { headers })).json()) as { asked: number; mail: number; per100: number | null };
      console.log(`Asked:    ${d.mail ? `${d.per100} decisions per 100 emails in the last 7 days (${d.asked} on ${d.mail})` : "no mail in the last 7 days"}`);
    }
  }
}

async function autostart() {
  const which = args[0];
  if (which === "on") {
    installAutostart();
    console.log(`Tabellar now starts ${MAC ? "at login" : "with this machine"} and keeps running in the background.`);
    console.log(`Its log is ${MAC ? join(HOME, "server.log") : "in `journalctl --user -u tabellar`"}. Open the window with \`tabellar open\`.`);
  } else if (which === "off") {
    removeAutostart();
    console.log("Tabellar no longer starts on its own, and the background copy is stopped.");
  } else {
    console.log(autostartInstalled() ? "Tabellar starts on its own." : "Tabellar does not start on its own.");
    console.log("Usage: tabellar autostart on|off");
  }
}

// Runs check.ts against a throwaway data folder, carrying over only the model
// settings so the planted emails can also go through the real model.
function check() {
  const home = mkdtempSync(join(tmpdir(), "tabellar-check-"));
  try {
    const { model, fastModel } = loadConfig();
    if (model) writeFileSync(join(home, "config.json"), JSON.stringify({ model, fastModel }));
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
  else if (command === "start" || command === "serve") await start(command === "serve" || !MAC);
  else if (command === "move") await move();
  else if (command === "open") {
    if (!(await running())) throw new Error("Tabellar is not running. Start it with `tabellar start`.");
    await openWindow();
  } else if (command === "status") await status();
  else if (command === "autostart") await autostart();
  else if (command === "mcp") await (await import("./mcp.ts")).serveMcp();
  else if (command === "check") check();
  else {
    console.log("Usage: tabellar <setup|start|serve|open|status|autostart|move|mcp|check>");
    process.exitCode = command === "help" ? 0 : 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
