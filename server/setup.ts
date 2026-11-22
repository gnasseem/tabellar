// First-run setup, shared by the window's onboarding and `tabellar setup`:
// the Google sign-in client, Ollama (install, start, download models) and the
// cloud providers. handleSetup serves it to the window under /api/setup/.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, createWriteStream, openSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, keychainGet, keychainSet, HOME, type ModelConfig } from "./config.ts";

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
  return !!loadConfig().googleClientId && !!keychainGet("google-client-secret");
}

// Check a client file's contents and save it: the id to config.json, the
// secret to the Keychain. Returns a warning when the client is the wrong type.
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
  keychainSet("google-client-secret", client.client_secret);
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

// ── Ollama ──────────────────────────────────────────────────────────────────

export const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_ZIP = "https://ollama.com/download/Ollama-darwin.zip";

export type LocalModel = { name: string; size: number };

// Models offered for download, smallest first, with their download size.
export const LOCAL_CHOICES: LocalModel[] = [
  { name: "qwen3:4b", size: 2_497_293_444 },
  { name: "qwen3:8b", size: 5_225_387_677 },
  { name: "qwen3:14b", size: 9_276_198_077 },
];

export function memoryGb(): number {
  return Math.round(totalmem() / 2 ** 30);
}

export function recommendedLocalModel(): string {
  const gb = memoryGb();
  return gb >= 48 ? "qwen3:14b" : gb >= 12 ? "qwen3:8b" : "qwen3:4b";
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

// Download Ollama.app from ollama.com, check Apple's signature on it, put it in
// Applications and start it.
export async function* installOllama(): AsyncGenerator<Progress> {
  const work = mkdtempSync(join(tmpdir(), "tabellar-ollama-"));
  try {
    const zip = join(work, "Ollama-darwin.zip");
    const r = await fetch(OLLAMA_ZIP);
    if (!r.ok || !r.body) throw new Error(`Could not download Ollama (${r.status}).`);
    const total = Number(r.headers.get("content-length")) || undefined;
    const out = createWriteStream(zip);
    let completed = 0;
    let last = 0;
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise<void>((done) => out.once("drain", () => done()));
      completed += chunk.length;
      if (Date.now() - last > 250) {
        last = Date.now();
        yield { status: "Downloading Ollama", completed, total };
      }
    }
    await new Promise<void>((done) => out.end(() => done()));

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
    const hash = createHash("sha256");
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((done) => out.once("drain", () => done()));
      completed += chunk.length;
      if (Date.now() - last > 250) {
        last = Date.now();
        yield { status: `pulling ${f.digest.slice(7, 19)}`, completed, total };
      }
    }
    await new Promise<void>((done) => out.end(() => done()));
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

// ── Cloud providers ─────────────────────────────────────────────────────────

export type Provider = { id: string; name: string; format: ModelConfig["format"]; baseUrl: string; keyUrl: string; suggested?: string };

export const PROVIDERS: Provider[] = [
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

// The key saved in the Keychain, if it belongs to this provider.
export function savedKeyFor(providerId: string): string | null {
  return loadConfig().model?.provider === providerId ? keychainGet("model-api-key") : null;
}

export function saveModel(model: ModelConfig, key?: string): void {
  if (key) keychainSet("model-api-key", key);
  const config = loadConfig();
  config.model = model;
  saveConfig(config);
}

// ── /api/setup/* for the window ─────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// Progress as one JSON object per line; a failure ends the stream with {error}.
function stream(steps: AsyncGenerator<Progress>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const p of steps) controller.enqueue(encoder.encode(JSON.stringify(p) + "\n"));
      } catch (e) {
        controller.enqueue(encoder.encode(JSON.stringify({ error: (e as Error).message }) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}

async function state() {
  const config = loadConfig();
  const file = (await findClientFiles())[0];
  const models = await ollamaModels();
  const m = config.model;
  const hasKey = !!keychainGet("model-api-key");
  return {
    google: {
      clientId: googleConfigured() ? config.googleClientId : null,
      file: file ? { path: file, name: basename(file), folder: dirname(file).replace(homedir(), "~"), modified: statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now() } : null,
    },
    model: m ? { ...m, ready: m.format === "ollama" || hasKey } : null,
    ollama: { installed: models !== null || ollamaInstalled(), running: models !== null, models: models ?? [] },
    local: { choices: LOCAL_CHOICES, recommended: recommendedLocalModel(), memoryGb: memoryGb() },
    providers: PROVIDERS.map(({ id, name, keyUrl, suggested }) => ({ id, name, keyUrl, suggested, hasKey: hasKey && m?.provider === id })),
  };
}

// `path` is the route without its /api/setup prefix.
export async function handleSetup(req: Request, path: string): Promise<Response> {
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, string | boolean | undefined>) : {};
  try {
    if (path === "/state" && req.method === "GET") return json(await state());

    if (path === "/google" && req.method === "POST") {
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

    if (path === "/ollama/install" && req.method === "POST") return stream(installOllama());
    if (path === "/ollama/start" && req.method === "POST") return json({ running: await startOllama() });
    if (path === "/ollama/pull" && req.method === "POST") {
      const model = String(body.model ?? "").trim();
      if (!/^[\w.:/-]+$/.test(model)) return json({ error: "That is not an Ollama model name." }, 400);
      return stream(pullOllamaModel(model));
    }

    if (path === "/cloud/models" && req.method === "POST") {
      const p = PROVIDERS.find((x) => x.id === body.provider);
      if (!p) return json({ error: "Unknown provider." }, 400);
      const base = String(p.id === "custom" ? body.baseUrl ?? "" : p.baseUrl).replace(/\/+$/, "");
      if (!/^https?:\/\//.test(base)) return json({ error: "Enter the endpoint's base URL, starting with https://." }, 400);
      const key = String(body.key ?? "").trim() || savedKeyFor(p.id) || "";
      if (!key) return json({ error: "Paste your API key." }, 400);
      const models = await listModels(p, base, key);
      if (models === "unauthorized") return json({ error: `${p.name} rejected that API key.` }, 400);
      return json({ models: models ?? [], suggested: savedKeyFor(p.id) ? loadConfig().model?.model : p.suggested });
    }

    if (path === "/model" && req.method === "POST") {
      const model = String(body.model ?? "").trim();
      if (!model) return json({ error: "Choose a model." }, 400);
      if (body.provider === "ollama") {
        saveModel({ provider: "ollama", format: "ollama", baseUrl: OLLAMA_URL, model });
        return json({ ok: true });
      }
      const p = PROVIDERS.find((x) => x.id === body.provider);
      if (!p) return json({ error: "Unknown provider." }, 400);
      const base = String(p.id === "custom" ? body.baseUrl ?? "" : p.baseUrl).replace(/\/+$/, "");
      const key = String(body.key ?? "").trim() || savedKeyFor(p.id) || "";
      if (!key) return json({ error: "Paste your API key." }, 400);
      saveModel({ provider: p.id, format: p.format, baseUrl: base, model }, key);
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}
