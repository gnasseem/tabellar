// First-run setup, shared by the window's onboarding and `tabellar setup`:
// the Google sign-in client, the Microsoft app, mailboxes signed in to with
// an app password, Ollama (install, start, download models) and the cloud
// providers. handleSetup serves it to the window under /api/setup/.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, createWriteStream, openSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAC, loadConfig, saveConfig, googleClient, BUILT_IN_GOOGLE, PLUS_URL, modelKey, modelKeyName, HOME, type ModelConfig, type Slot, secrets } from "./config.ts";
// providers.ts, imap.ts and accounts.ts open the database, so they are
// imported only when used: `tabellar setup`, `status` and `check` must not
// touch it.

// ── Google sign-in client ───────────────────────────────────────────────────

// Google Cloud's "Download JSON" saves client_secret_<id>.json. Look wherever
// it is likely to be: here, the Tabellar folder, Downloads, Desktop, Documents.
const INSTALL_DIR = fileURLToPath(new URL("..", import.meta.url));

// Reading Downloads, Desktop or Documents can wait on macOS asking the user
// for permission, so read them off the main thread and give each a moment: a
// folder still waiting is left out of this answer, and read again next time.
const reading = new Map<string, Promise<string[]>>();
function listDir(dir: string): Promise<string[]> {
  let p = reading.get(dir);
  if (!p) {
    p = readdir(dir)
      .catch(() => [])
      .finally(() => reading.delete(dir));
    reading.set(dir, p);
  }
  return Promise.race([p, new Promise<string[]>((done) => setTimeout(() => done([]), 1500))]);
}

export async function findClientFiles(): Promise<string[]> {
  const home = homedir();
  const dirs = [...new Set([process.cwd(), INSTALL_DIR.replace(/\/$/, ""), join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents")])];
  const found: { path: string; mtime: number }[] = [];
  await Promise.all(
    dirs.map(async (dir) => {
      for (const f of await listDir(dir)) {
        if (!/^client_secret.*\.json$/i.test(f)) continue;
        const path = join(dir, f);
        const st = await stat(path).catch(() => null);
        if (st) found.push({ path, mtime: st.mtimeMs });
      }
    }),
  );
  return found.sort((x, y) => y.mtime - x.mtime).map((f) => f.path);
}

export function googleConfigured(): boolean {
  return !!googleClient();
}

// Forget the user's own client, so sign-in goes back to the built-in one.
export function useBuiltInGoogleClient(): void {
  const config = loadConfig();
  delete config.googleClientId;
  saveConfig(config);
  secrets.delete("google-client-secret");
}

// Check a client file's contents and save it: the id to config.json, the
// secret among the secrets. Returns a warning when the client is the wrong type.
export function saveGoogleClient(text: string): { clientId: string; warning?: string } {
  let json: { installed?: { client_id?: string; client_secret?: string }; web?: { client_id?: string; client_secret?: string } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("That file is not JSON. Download the client again from Google Cloud.");
  }
  const client = json.installed ?? json.web;
  if (!client?.client_id || !client?.client_secret) throw new Error("That is not a Google OAuth client file.");
  const config = loadConfig();
  config.googleClientId = client.client_id;
  secrets.set("google-client-secret", client.client_secret);
  saveConfig(config);
  return {
    clientId: client.client_id,
    warning: json.installed ? undefined : "This is a Web application client. Tabellar needs a Desktop app client, so sign-in may fail.",
  };
}

export function moveToTrash(path: string): boolean {
  try {
    renameSync(path, join(homedir(), ".Trash", `${Date.now()}-${basename(path)}`));
    return true;
  } catch {
    return false;
  }
}

// ── Other mailboxes ─────────────────────────────────────────────────────────

// The Application (client) ID of the app registered in Azure, a GUID.
export function saveMicrosoftClient(id: string): void {
  const clientId = id.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clientId)) throw new Error("That is not an Application (client) ID. Copy it from the app's Overview page in the Azure portal.");
  saveConfig({ ...loadConfig(), microsoftClientId: clientId });
}

// Add a mailbox that signs in with an app password: one of CHOICES with
// its servers, or "imap" with the servers given. Returns whether nothing is
// stored yet (the first mailbox).
export async function addPasswordAccount(b: Record<string, unknown>): Promise<boolean> {
  const [{ CHOICES }, { connectImap }, { connectAccount }] = await Promise.all([import("./providers.ts"), import("./imap.ts"), import("./accounts.ts")]);
  const choice = CHOICES.find((c) => c.id === b.choice && c.provider === "imap");
  if (!choice) throw new Error("Choose a mailbox.");
  const address = String(b.address ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("Enter the email address.");
  // App passwords are shown in groups; the spaces are not part of them.
  const password = choice.id === "imap" ? String(b.password ?? "").trim() : String(b.password ?? "").replace(/\s+/g, "");
  if (!password) throw new Error("Paste the app password.");
  const server = (host: unknown, port: unknown, fallback?: { host: string; port: number }) => {
    const h = String(host ?? "").trim() || fallback?.host || "";
    const p = Number(port) || fallback?.port || 0;
    if (!/^[a-z0-9.-]+$/i.test(h) || !p) throw new Error("Enter the IMAP and SMTP servers and ports.");
    return { host: h, port: p };
  };
  const imap = server(b.imapHost, b.imapPort, choice.imap);
  const smtp = server(b.smtpHost, b.smtpPort, choice.smtp);
  const user = String(b.user ?? "").trim();
  const users = [...new Set([user || address, ...(choice.id === "icloud" ? [address.split("@")[0]] : [])])];
  const { server: saved, tokenRef } = await connectImap({ address, password, imap, smtp, users, choice: choice.id });
  return connectAccount({ provider: "imap", address, name: address.split("@")[0], tokenRef, server: saved });
}

// ── Ollama ──────────────────────────────────────────────────────────────────

export const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_ZIP = "https://ollama.com/download/Ollama-darwin.zip";

// firstRead: minutes to read the first 300 emails, where it was timed.
export type LocalModel = { name: string; size: number; about?: string; firstRead?: number };

// Models offered for download, smallest first, with their download size.
// Chosen by running sorting, drafting and the assistant on 50 real emails
// (2026-11): qwen3.5:4b sorted as well as models twice its size in half the
// time; the gemma4 models were the only ones that always drafted in the
// user's voice. qwen3:8b, qwen3.5:9b and granite4.2:3b did worse on both.
// What to expect from each, timed on an M1 Pro with 32 GB (2026-11): reading
// an email with qwen3.5:4b, drafting a reply with gemma4:12b.
export const LOCAL_CHOICES: LocalModel[] = [
  { name: "qwen3.5:4b", size: 3_324_173_934, about: "Small and quick: reads an email in about 4 seconds, the first 300 in about 15 minutes. Plainer drafts", firstRead: 15 },
  { name: "gemma4:12b", size: 8_021_618_941, about: "Drafts in your voice, 10 to 30 seconds a reply. Wants 24 GB of memory" },
  { name: "gemma4:26b", size: 18_731_025_629, about: "The best local drafts, slower than gemma4:12b. Wants 48 GB of memory" },
];

// Below this much memory one small model does every job, and a cloud model
// for drafts is the better choice.
export const SMALL_MAC_GB = 24;

export function memoryGb(): number {
  return Math.round(totalmem() / 2 ** 30);
}

// Below 24 GB there is room for one model, so the small one does both jobs.
export function recommendedLocalModel(slot: Slot = "careful"): string {
  const gb = memoryGb();
  if (slot === "fast" || gb < SMALL_MAC_GB) return "qwen3.5:4b";
  return gb >= 48 ? "gemma4:26b" : "gemma4:12b";
}

function ollamaApp(): string | null {
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    if (existsSync(join(dir, "Ollama.app"))) return join(dir, "Ollama.app");
  }
  return null;
}

export function ollamaInstalled(): boolean {
  return !!ollamaApp() || spawnSync("which", ["ollama"]).status === 0;
}

// The models Ollama has, or null when Ollama is not running.
export async function ollamaModels(): Promise<LocalModel[] | null> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const { models = [] } = (await r.json()) as { models?: LocalModel[] };
    return models.map((m) => ({ name: m.name, size: m.size }));
  } catch {
    return null;
  }
}

// The offered models already downloaded, for when Ollama is not running to say.
function modelsOnDisk(): LocalModel[] {
  const root = join(process.env.OLLAMA_MODELS || join(homedir(), ".ollama", "models"), "manifests", "registry.ollama.ai", "library");
  return LOCAL_CHOICES.filter((m) => existsSync(join(root, ...m.name.split(":")))).map(({ name, size }) => ({ name, size }));
}

async function waitForOllama(seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if ((await ollamaModels()) !== null) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Run Ollama's server on its own rather than opening its menu bar app, whose
// first launch stops on an administrator prompt to link its command-line tool.
export async function startOllama(): Promise<boolean> {
  if ((await ollamaModels()) !== null) return true;
  const app = ollamaApp();
  const log = openSync(join(HOME, "ollama.log"), "a");
  const child = spawn(app ? join(app, "Contents/Resources/ollama") : "ollama", ["serve"], { detached: true, stdio: ["ignore", log, log] });
  child.on("error", () => {});
  child.unref();
  closeSync(log);
  return waitForOllama(30);
}

export type Progress = { status: string; completed?: number; total?: number };

// A command run without blocking the server; true when it succeeds.
function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

// Rejects when the file cannot be written (the disk is full), which would
// otherwise end the server.
function failure(out: ReturnType<typeof createWriteStream>): Promise<never> {
  const p = new Promise<never>((_, reject) => out.on("error", (e) => reject(new Error((e as NodeJS.ErrnoException).code === "ENOSPC" ? "The disk is full. Free some space and try again." : `Could not write the download: ${e.message}`))));
  p.catch(() => {});
  return p;
}

// Download Ollama.app from ollama.com, check Apple's signature on it, put it in
// Applications and start it.
export async function* installOllama(): AsyncGenerator<Progress> {
  if (!MAC) throw new Error("Install Ollama on this machine first (ollama.com/download/linux), or use a cloud model.");
  const work = mkdtempSync(join(tmpdir(), "tabellar-ollama-"));
  try {
    const zip = join(work, "Ollama-darwin.zip");
    const r = await fetch(OLLAMA_ZIP);
    if (!r.ok || !r.body) throw new Error(`Could not download Ollama (${r.status}).`);
    const total = Number(r.headers.get("content-length")) || undefined;
    const out = createWriteStream(zip);
    const failed = failure(out);
    let completed = 0;
    let last = 0;
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await Promise.race([new Promise<void>((done) => out.once("drain", () => done())), failed]);
      completed += chunk.length;
      if (Date.now() - last > 250) {
        last = Date.now();
        yield { status: "Downloading Ollama", completed, total };
      }
    }
    await Promise.race([new Promise<void>((done) => out.end(() => done())), failed]);

    yield { status: "Installing Ollama" };
    const unpacked = join(work, "unpacked");
    if (!(await run("ditto", ["-x", "-k", zip, unpacked]))) throw new Error("Could not unpack the Ollama download.");
    const app = join(unpacked, "Ollama.app");
    if (!(await run("codesign", ["--verify", "--deep", "--strict", app]))) {
      throw new Error("The Ollama download failed its signature check, so it was not installed.");
    }
    let target = "/Applications";
    try {
      accessSync(target, constants.W_OK);
    } catch {
      target = join(homedir(), "Applications");
      mkdirSync(target, { recursive: true });
    }
    if (!(await run("ditto", [app, join(target, "Ollama.app")]))) throw new Error(`Could not copy Ollama to ${target}.`);

    yield { status: "Starting Ollama" };
    if (!(await startOllama())) throw new Error("Ollama is installed but did not start. Open it from Applications.");
    yield { status: "success" };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Download a model through Ollama, passing on its progress. When Ollama can't
// reach its registry (it does not fall back to IPv4 on a network whose IPv6 is
// broken), fetch the files ourselves instead.
export async function* pullOllamaModel(model: string): AsyncGenerator<Progress> {
  try {
    yield* ollamaPull(model);
  } catch (e) {
    const msg = (e as Error).message;
    if (/file does not exist|not found/i.test(msg)) throw new Error(`Ollama has no model called ${model}.`);
    if (!/tcp|dial|socket|timeout|connection|network|EOF|unreachable/i.test(msg)) throw e;
    yield* fetchModelFiles(model);
  }
}

async function* ollamaPull(model: string): AsyncGenerator<Progress> {
  const r = await fetch(`${OLLAMA_URL}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: true }) });
  if (!r.ok || !r.body) throw new Error(`Ollama could not download ${model} (${r.status}).`);
  let buffer = "";
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += Buffer.from(chunk).toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const e = JSON.parse(line) as Progress & { error?: string };
      if (e.error) throw new Error(`Ollama: ${e.error}`);
      yield { status: e.status, completed: e.completed, total: e.total };
    }
  }
}

// Store a model the way `ollama pull` does: each layer as blobs/sha256-<hex>,
// checked against its digest, and the manifest under manifests/<registry>/.
async function* fetchModelFiles(model: string): AsyncGenerator<Progress> {
  const [name, tag = "latest"] = model.split(":");
  const repo = name.includes("/") ? name : `library/${name}`;
  const registry = "https://registry.ollama.ai/v2";
  const root = process.env.OLLAMA_MODELS || join(homedir(), ".ollama", "models");

  const r = await fetch(`${registry}/${repo}/manifests/${tag}`, { headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" } });
  if (r.status === 404) throw new Error(`Ollama has no model called ${model}.`);
  if (!r.ok) throw new Error(`Could not reach Ollama's model library (${r.status}). Check the internet connection and try again.`);
  const manifest = await r.text();
  const { config, layers } = JSON.parse(manifest) as { config: { digest: string; size: number }; layers: { digest: string; size: number }[] };
  const files = [config, ...layers];
  const total = files.reduce((n, f) => n + f.size, 0);
  let completed = 0;
  let last = 0;

  mkdirSync(join(root, "blobs"), { recursive: true });
  for (const f of files) {
    const blob = join(root, "blobs", f.digest.replace(":", "-"));
    if (statSync(blob, { throwIfNoEntry: false })?.size === f.size) {
      completed += f.size;
      continue;
    }
    const res = await fetch(`${registry}/${repo}/blobs/${f.digest}`);
    if (!res.ok || !res.body) throw new Error(`Could not download ${model} (${res.status}). Try again.`);
    const part = `${blob}-tabellar-partial`;
    const out = createWriteStream(part);
    const failed = failure(out);
    const hash = createHash("sha256");
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await Promise.race([new Promise<void>((done) => out.once("drain", () => done())), failed]);
      completed += chunk.length;
      if (Date.now() - last > 250) {
        last = Date.now();
        yield { status: `pulling ${f.digest.slice(7, 19)}`, completed, total };
      }
    }
    await Promise.race([new Promise<void>((done) => out.end(() => done())), failed]);
    if (`sha256:${hash.digest("hex")}` !== f.digest) {
      rmSync(part, { force: true });
      throw new Error(`A file of ${model} arrived damaged. Try again.`);
    }
    renameSync(part, blob);
  }

  const dir = join(root, "manifests", "registry.ollama.ai", ...repo.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, tag), manifest);
  yield { status: "success" };
}

// ── Setting up local models in the background ───────────────────────────────

// The window starts this and moves on: the download can take a while, and the
// first-run steps after the model are answered meanwhile. Ollama is installed
// and started when needed, each model downloaded, and only then saved to its
// slot, which lets the first read carry on. `fast` null puts the fast slot
// back to following the careful model; a slot left out is not changed.
export type LocalJob = { careful?: string; fast?: string | null; label: string; completed?: number; total?: number; done: boolean; error: string | null };
let localJob: LocalJob | null = null;

export const localJobState = () => localJob;

// Ollama's pull statuses ("pulling 3a2f...", "verifying sha256 digest") in plain words.
function pullLabel(model: string, status: string): string {
  if (status === "pulling manifest") return `Preparing ${model}`;
  if (status.startsWith("pulling")) return `Downloading ${model}`;
  if (status.startsWith("verifying")) return `Checking ${model}`;
  return `Finishing ${model}`;
}

export function startLocalModels(models: { careful?: string; fast?: string | null }): LocalJob {
  if (localJob && !localJob.done) return localJob;
  const job: LocalJob = { ...models, label: "Starting", done: false, error: null };
  localJob = job;
  const set = (patch: Partial<LocalJob>) => Object.assign(job, { completed: undefined, total: undefined }, patch);
  void (async () => {
    try {
      if ((await ollamaModels()) === null) {
        if (!ollamaInstalled()) {
          for await (const p of installOllama()) set({ label: p.status === "success" ? "Ollama is ready" : p.status, completed: p.completed, total: p.total });
        }
        set({ label: "Starting Ollama" });
        if (!(await startOllama())) throw new Error("Ollama did not start. Open it from your Applications folder, then try again.");
      }
      const have = new Set(((await ollamaModels()) ?? []).map((m) => m.name));
      for (const name of new Set([models.careful, models.fast])) {
        if (!name || have.has(name)) continue;
        for await (const p of pullOllamaModel(name)) set({ label: pullLabel(name, p.status), completed: p.completed, total: p.total });
      }
      const local = (model: string): ModelConfig => ({ provider: "ollama", format: "ollama", baseUrl: OLLAMA_URL, model });
      if (models.careful) saveModel("careful", local(models.careful));
      if (models.fast !== undefined) saveModel("fast", models.fast ? local(models.fast) : null);
      set({ label: "Ready", done: true });
      await modelChosen();
    } catch (e) {
      set({ done: true, error: (e as Error).message });
    }
  })();
  return job;
}

// A model was saved: the first read can go past the headers now.
async function modelChosen(): Promise<void> {
  const { db } = await import("./db.ts");
  const { data } = await db.from("profiles").select("id").limit(1).maybeSingle();
  if (data) (await import("./engine.ts")).readNow(data.id as string);
}

// ── Cloud providers ─────────────────────────────────────────────────────────

export type Provider = { id: string; name: string; format: ModelConfig["format"]; baseUrl: string; keyUrl: string; suggested?: string };

// Tabellar+ is first where it is offered: its code is exchanged for a model
// key of the person's own (activatePlus), and the rest is OpenRouter.
const PLUS: Provider = { id: "plus", name: "Tabellar+", format: "openai", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "" };

export const PROVIDERS: Provider[] = [
  ...(PLUS_URL ? [PLUS] : []),
  { id: "openrouter", name: "OpenRouter", format: "openai", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/settings/keys" },
  { id: "anthropic", name: "Anthropic", format: "anthropic", baseUrl: "https://api.anthropic.com/v1", keyUrl: "https://console.anthropic.com/settings/keys", suggested: "claude-opus-5-5" },
  { id: "openai", name: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "gemini", name: "Google Gemini", format: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "groq", name: "Groq", format: "openai", baseUrl: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys" },
  { id: "mistral", name: "Mistral", format: "openai", baseUrl: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "deepseek", name: "DeepSeek", format: "openai", baseUrl: "https://api.deepseek.com/v1", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "xai", name: "xAI", format: "openai", baseUrl: "https://api.x.ai/v1", keyUrl: "https://console.x.ai" },
  { id: "together", name: "Together AI", format: "openai", baseUrl: "https://api.together.xyz/v1", keyUrl: "https://api.together.ai/settings/api-keys" },
  { id: "cerebras", name: "Cerebras", format: "openai", baseUrl: "https://api.cerebras.ai/v1", keyUrl: "https://cloud.cerebras.ai" },
  { id: "custom", name: "Other (OpenAI-compatible)", format: "openai", baseUrl: "", keyUrl: "" },
];

// Models that are not for chat, left out of the lists.
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|audio|realtime|transcri|image|rerank|guard|babbage|davinci/i;

// The provider's chat models, which also checks the key. Listing models is free.
export async function listModels(p: Provider, base: string, key: string): Promise<string[] | "unauthorized" | null> {
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
    return (data.data ?? data.models ?? []).map((m) => m.id ?? m.name ?? "").filter((id) => id && !NOT_CHAT.test(id));
  } catch {
    return null;
  }
}

// Exchange a Tabellar+ code for a model key with a monthly limit, and use it
// for both slots. Mail goes from here to the model, never through Tabellar+.
export async function activatePlus(code: string): Promise<void> {
  const r = await fetch(`${PLUS_URL}/api/key`, { method: "POST", signal: AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim() }) });
  const d = (await r.json().catch(() => ({}))) as { key?: string; careful?: string; fast?: string; error?: string };
  if (!r.ok || !d.key || !d.careful || !d.fast) throw new Error(d.error ?? "Tabellar+ could not be reached. Try again in a minute.");
  const slot = (model: string): ModelConfig => ({ provider: "plus", format: PLUS.format, baseUrl: PLUS.baseUrl, model });
  saveModel("careful", slot(d.careful), d.key);
  saveModel("fast", slot(d.fast));
}

// At each start: a Tabellar+ server takes up its model, and the models are
// those Tabellar+ uses now.
export async function refreshPlus(): Promise<void> {
  if (!PLUS_URL) return;
  if (process.env.TABELLAR_PLUS_CODE && !loadConfig().model) return activatePlus(process.env.TABELLAR_PLUS_CODE);
  const config = loadConfig();
  if (config.model?.provider !== "plus" && config.fastModel?.provider !== "plus") return;
  const d = (await (await fetch(`${PLUS_URL}/api/models`, { signal: AbortSignal.timeout(30_000) })).json()) as { careful?: string; fast?: string };
  if (config.model?.provider === "plus" && d.careful) saveModel("careful", { ...config.model, model: d.careful });
  if (config.fastModel?.provider === "plus" && d.fast) saveModel("fast", { ...config.fastModel, model: d.fast });
}

// The key saved for this provider.
export function savedKeyFor(providerId: string): string | null {
  return secrets.get(modelKeyName(providerId));
}

// Save a slot. The careful model is chosen first and the fast slot follows
// it until it is set on its own; `sameAsCareful` puts it back to following.
export function saveModel(slot: Slot, model: ModelConfig | null, key?: string): void {
  if (key && model) secrets.set(modelKeyName(model.provider), key);
  const config = loadConfig();
  if (slot === "careful" && model) config.model = model;
  else if (slot === "fast") {
    if (!model || sameModel(model, config.model)) delete config.fastModel;
    else config.fastModel = model;
  }
  saveConfig(config);
}

function sameModel(a: ModelConfig, b?: ModelConfig): boolean {
  return !!b && a.format === b.format && a.baseUrl === b.baseUrl && a.model === b.model;
}

// ── /api/setup/* for the window ─────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function state() {
  const config = loadConfig();
  const file = (await findClientFiles())[0];
  const models = await ollamaModels();
  const withReady = (m?: ModelConfig) => (m ? { ...m, ready: m.format === "ollama" || !!modelKey(m) } : null);
  return {
    google: {
      // The user's own client, when they saved one.
      clientId: googleClient()?.own ? config.googleClientId : null,
      // Whether this copy of Tabellar ships with a sign-in client.
      builtIn: !!BUILT_IN_GOOGLE.clientId,
      file: file ? { path: file, name: basename(file), folder: dirname(file).replace(homedir(), "~"), modified: statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now() } : null,
    },
    model: withReady(config.model),
    // null when the fast slot uses the careful model.
    fastModel: withReady(config.fastModel),
    ollama: { installed: models !== null || ollamaInstalled(), running: models !== null, models: models ?? modelsOnDisk() },
    local: { choices: LOCAL_CHOICES, recommended: recommendedLocalModel("careful"), recommendedFast: recommendedLocalModel("fast"), memoryGb: memoryGb(), small: memoryGb() < SMALL_MAC_GB },
    providers: PROVIDERS.map(({ id, name, keyUrl, suggested }) => ({ id, name, keyUrl, suggested, hasKey: !!savedKeyFor(id) })),
    // What can be added as a mailbox, and whether it can be now.
    mailboxes: (await import("./providers.ts")).choicesForWindow(),
    microsoft: { clientId: config.microsoftClientId ?? null },
  };
}

// `path` is the route without its /api/setup prefix.
export async function handleSetup(req: Request, path: string): Promise<Response> {
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, string | boolean | undefined>) : {};
  try {
    if (path === "/state" && req.method === "GET") return json(await state());

    if (path === "/google" && req.method === "POST") {
      if (body.builtIn) {
        if (!BUILT_IN_GOOGLE.clientId) return json({ error: "This copy of Tabellar has no built-in Google client." }, 400);
        useBuiltInGoogleClient();
        return json({ ok: true });
      }
      // Either the file the window found (only a path findClientFiles returns
      // is accepted) or the contents of a file the user dropped in.
      let text = typeof body.text === "string" ? body.text : "";
      const file = typeof body.path === "string" ? body.path : "";
      if (file) {
        if (!(await findClientFiles()).includes(file)) return json({ error: "That file is no longer there." }, 400);
        text = readFileSync(file, "utf8");
      }
      const saved = saveGoogleClient(text);
      const trashed = file && body.trash ? moveToTrash(file) : false;
      return json({ ...saved, trashed });
    }

    if (path === "/microsoft" && req.method === "POST") {
      saveMicrosoftClient(String(body.clientId ?? ""));
      return json({ ok: true });
    }
    if (path === "/mailbox" && req.method === "POST") return json({ first: await addPasswordAccount(body) });

    // POST /local {careful?, fast?}: download and use local models, in the
    // background. GET /local: how far it is.
    if (path === "/local" && req.method === "POST") {
      const name = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
      const careful = name(body.careful) ?? undefined;
      const fast = "fast" in body ? name(body.fast) : undefined;
      if (!careful && fast === undefined) return json({ error: "Choose a model." }, 400);
      if ([careful, fast].some((n) => n && !/^[\w.:/-]+$/.test(n))) return json({ error: "That is not an Ollama model name." }, 400);
      return json(startLocalModels({ careful, fast }));
    }
    if (path === "/local" && req.method === "GET") return json(localJob);

    if (path === "/cloud/models" && req.method === "POST") {
      const p = PROVIDERS.find((x) => x.id === body.provider);
      if (!p) return json({ error: "Unknown provider." }, 400);
      const base = String(p.id === "custom" ? body.baseUrl ?? "" : p.baseUrl).replace(/\/+$/, "");
      if (!/^https?:\/\//.test(base)) return json({ error: "Enter the endpoint's base URL, starting with https://." }, 400);
      const key = String(body.key ?? "").trim() || savedKeyFor(p.id) || "";
      if (!key) return json({ error: "Paste your API key." }, 400);
      const models = await listModels(p, base, key);
      if (models === "unauthorized") return json({ error: `${p.name} rejected that API key.` }, 400);
      const config = loadConfig();
      const current = [config.model, config.fastModel].find((m) => m?.provider === p.id)?.model;
      return json({ models: models ?? [], suggested: current ?? p.suggested });
    }

    if (path === "/plus" && req.method === "POST") {
      if (!PLUS_URL) return json({ error: "Tabellar+ is not offered here." }, 400);
      await activatePlus(String(body.code ?? ""));
      await modelChosen();
      return json({ ok: true });
    }

    if (path === "/model" && req.method === "POST") {
      const slot: Slot = body.slot === "fast" ? "fast" : "careful";
      if (slot === "fast" && body.same) {
        saveModel("fast", null);
        return json({ ok: true });
      }
      const model = String(body.model ?? "").trim();
      if (!model) return json({ error: "Choose a model." }, 400);
      if (body.provider === "ollama") {
        saveModel(slot, { provider: "ollama", format: "ollama", baseUrl: OLLAMA_URL, model });
        if (slot === "careful") await modelChosen();
        return json({ ok: true });
      }
      const p = PROVIDERS.find((x) => x.id === body.provider);
      if (!p) return json({ error: "Unknown provider." }, 400);
      const base = String(p.id === "custom" ? body.baseUrl ?? "" : p.baseUrl).replace(/\/+$/, "");
      const key = String(body.key ?? "").trim() || savedKeyFor(p.id) || "";
      if (!key) return json({ error: "Paste your API key." }, 400);
      saveModel(slot, { provider: p.id, format: p.format, baseUrl: base, model }, key);
      if (slot === "careful") await modelChosen();
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}
