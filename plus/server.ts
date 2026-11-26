// Tabellar+: the service behind a subscription. It keeps a list of codes and
// does two things for each: makes a model key with a monthly limit, and, for
// Always on, a server of the person's own that runs Tabellar. Mail never comes
// here. Everything it needs is in the environment (plus/README.md).
//
//   node plus/server.ts                    the service
//   node plus/server.ts invite <plan>      a code without paying (plus, always)
//   node plus/server.ts end <id>           end a subscription
//   node plus/server.ts list
//   node plus/server.ts update <image>     every server to a new image
//   node plus/server.ts check              asserts, against fakes

import { createServer, type IncomingMessage } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { checkoutPage, page, startPage } from "./pages.ts";

const env = (k: string, fallback = "") => process.env[k] || fallback;
const DAY = 86_400_000;
const LIMIT_USD = 2; // of model use a month, each
const KEEP_DAYS = 30; // after a subscription ends, until its server is deleted
const MAX_SERVERS = Number(env("MAX_SERVERS", "50"));
const MODELS = { careful: env("MODEL_CAREFUL", "google/gemma-4-31b-it"), fast: env("MODEL_FAST", "google/gemma-4-26b-a4b-it") };

type Plan = "plus" | "always";
type Person = {
  id: string; plan: Plan; code_hash: string; status: "active" | "ended"; key_hash: string | null; app: string | null; machine: string | null;
  subscription: string | null; seen_at: string | null; ends_at: string | null; error: string | null; created_at: string;
};

const db = new DatabaseSync(env("PLUS_DB", "/data/plus.db"));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, plan TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, key_hash TEXT, app TEXT, machine TEXT,
  subscription TEXT UNIQUE, seen_at TEXT, ends_at TEXT, error TEXT, created_at TEXT NOT NULL
)`);
const one = (where: string, ...v: string[]) => db.prepare(`SELECT * FROM people WHERE ${where}`).get(...v) as Person | undefined;
const many = (where: string, ...v: string[]) => db.prepare(`SELECT * FROM people WHERE ${where}`).all(...v) as Person[];
function set(id: string, fields: Partial<Person>): void {
  const names = Object.keys(fields);
  db.prepare(`UPDATE people SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(fields).map((v) => v ?? null), id);
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

// What a server's own secrets are made from, so none of them is kept.
const derive = (what: string, id: string) => createHmac("sha256", env("MASTER")).update(`${what}:${id}`).digest("base64url");

function add(plan: Plan, codeHash: string, subscription: string | null = null): Person {
  const id = randomBytes(5).toString("hex");
  db.prepare("INSERT INTO people (id, plan, code_hash, status, subscription, created_at) VALUES (?, ?, ?, 'active', ?, ?)").run(id, plan, codeHash, subscription, new Date().toISOString());
  return one("id = ?", id)!;
}

// Swapped by `check`.
const wire = { fetch: (url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }) };

async function call(base: string, token: string, method: string, path: string, body?: unknown, fine: number[] = []): Promise<any> {
  const r = await wire.fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok && !fine.includes(r.status)) throw Object.assign(new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`), { status: r.status });
  return r.ok && text ? JSON.parse(text) : null;
}

// ── Model keys ──────────────────────────────────────────────────────────────

const openRouter = (method: string, path: string, body?: unknown, fine?: number[]) => call("https://openrouter.ai/api/v1", env("OPENROUTER_MANAGEMENT_KEY"), method, path, body, fine);

// The key is shown once and kept only by its hash, so asking again makes a new
// one and deletes the last. What was spent this month goes with the old key,
// so the new one gets what is left of the limit.
// One at a time for each person, or two askings at once would leave two keys.
const asking = new Map<string, Promise<unknown>>();
function modelKey(id: string): Promise<string> {
  const run = (asking.get(id) ?? Promise.resolve()).catch(() => {}).then(() => newKey(one("id = ?", id)!));
  asking.set(id, run);
  return run;
}

async function newKey(p: Person): Promise<string> {
  if (p.status !== "active") throw new Error("This subscription has ended.");
  let left = LIMIT_USD;
  if (p.key_hash) {
    const old = await openRouter("GET", `/keys/${p.key_hash}`, undefined, [404]);
    if (old) left = Math.max(0, Math.min(LIMIT_USD, Number(old.data.limit ?? LIMIT_USD) - Number(old.data.usage_monthly ?? 0)));
    await openRouter("DELETE", `/keys/${p.key_hash}`, undefined, [404]);
  }
  const made = await openRouter("POST", "/keys", { name: `tabellar ${p.id}`, limit: left, limit_reset: "monthly", include_byok_in_limit: true });
  set(p.id, { key_hash: made.data.hash });
  return made.key;
}

// A key made in the middle of a month has the rest of that month's limit; from
// the first of the next it has the whole.
async function renewLimits(): Promise<void> {
  for (const p of many("status = 'active' AND key_hash IS NOT NULL")) await openRouter("PATCH", `/keys/${p.key_hash}`, { limit: LIMIT_USD }, [404]);
}

// ── Servers ─────────────────────────────────────────────────────────────────

const fly = (method: string, path: string, body?: unknown, fine?: number[]) => call("https://api.machines.dev/v1", env("FLY_API_TOKEN"), method, path, body, fine);
const hostOf = (p: Person) => `${p.app}.fly.dev`;

const machineConfig = (p: Person, volume: string, image: string) => ({
  image,
  env: {
    TABELLAR_HOME: "/data", HOME: "/home/node", TABELLAR_PUBLIC_URL: `https://${hostOf(p)}`, TABELLAR_PLUS_URL: env("PUBLIC_URL"),
    TABELLAR_MICROSOFT_RETURN: `${env("PUBLIC_URL")}/oauth/microsoft`,
  },
  guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
  mounts: [{ volume, path: "/data" }],
  restart: { policy: "always" },
  services: [{
    protocol: "tcp", internal_port: 4848, autostop: "off", autostart: true,
    ports: [{ port: 443, handlers: ["tls", "http"] }, { port: 80, handlers: ["http"], force_https: true }],
  }],
});

// Make what is missing, so a step that failed is taken up again. Each server is
// an app on a network of its own: none can reach another.
const making = new Set<string>();
async function makeServer(id: string): Promise<void> {
  if (making.has(id)) return;
  making.add(id);
  try {
    let p = one("id = ?", id)!;
    if (p.machine || p.status !== "active" || p.plan !== "always") return;
    if (!p.app) {
      set(id, { app: `tabellar-${id}` });
      p = one("id = ?", id)!;
    }
    const app = `/apps/${p.app}`;
    if (!(await fly("GET", app, undefined, [404]))) await fly("POST", "/apps", { name: p.app, org_slug: env("FLY_ORG", "personal"), network: p.app });
    const ips = await fly("GET", `${app}/ip_assignments`);
    if (!ips?.ips?.length) for (const type of ["shared_v4", "v6"]) await fly("POST", `${app}/ip_assignments`, { type });
    const secrets = await fly("POST", `${app}/secrets`, { values: { TABELLAR_PASSPHRASE: derive("passphrase", id), TABELLAR_FIRST_CODE: derive("first", id), TABELLAR_PLUS_CODE: derive("code", id) } });
    const volumes = (await fly("GET", `${app}/volumes`)) as { id: string; state?: string }[];
    const region = env("FLY_REGION", "fra");
    const volume = volumes.find((v) => v.state !== "destroyed")?.id ?? (await fly("POST", `${app}/volumes`, { name: "data", region, size_gb: 1, encrypted: true, snapshot_retention: 14 })).id;
    const there = (await fly("GET", `${app}/machines`)) as { id: string }[];
    const machine = there[0]?.id ?? (await fly("POST", `${app}/machines`, { region, min_secrets_version: secrets?.version, config: machineConfig(p, volume, env("IMAGE")) })).id;
    set(id, { machine, error: null });
  } catch (e) {
    console.error(`[server ${id}]`, (e as Error).message);
    set(id, { error: (e as Error).message.slice(0, 300) });
  } finally {
    making.delete(id);
  }
}

async function updateServers(image: string): Promise<void> {
  for (const p of many("machine IS NOT NULL")) {
    const m = await fly("GET", `/apps/${p.app}/machines/${p.machine}`);
    await fly("POST", `/apps/${p.app}/machines/${p.machine}`, { config: machineConfig(p, m.config.mounts[0].volume, image) });
    console.log(`${p.app}: updated`);
  }
}

// ── Beginning and ending ────────────────────────────────────────────────────

// The model stops at once. The server stays, to move out of, until ends_at.
async function end(p: Person): Promise<void> {
  if (p.status === "ended") return;
  set(p.id, { status: "ended", ends_at: new Date(Date.now() + KEEP_DAYS * DAY).toISOString() });
  if (p.key_hash) await openRouter("PATCH", `/keys/${p.key_hash}`, { disabled: true }, [404]);
}

async function resume(p: Person): Promise<void> {
  if (p.status === "active") return;
  set(p.id, { status: "active", ends_at: null });
  if (p.key_hash) await openRouter("PATCH", `/keys/${p.key_hash}`, { disabled: false }, [404]);
}

async function sweep(now = Date.now()): Promise<void> {
  for (const p of many("status = 'active' AND plan = 'always' AND machine IS NULL")) await makeServer(p.id);
  for (const p of many("status = 'ended' AND ends_at < ?", new Date(now).toISOString())) {
    if (p.app) await fly("DELETE", `/apps/${p.app}?force=true`, undefined, [404]);
    if (p.key_hash) await openRouter("DELETE", `/keys/${p.key_hash}`, undefined, [404]);
    db.prepare("DELETE FROM people WHERE id = ?").run(p.id);
  }
}

// The code a server was made with is its own, beside the one its owner holds.
function byCode(code: string): Person | undefined {
  if (code.length < 32) return undefined;
  const p = one("code_hash = ?", hash(code));
  if (p) return p;
  return many("plan = 'always'").find((x) => timingSafeEqual(createHash("sha256").update(derive("code", x.id)).digest(), createHash("sha256").update(code).digest()));
}

// ── Payments (Paddle) ───────────────────────────────────────────────────────

function signed(header: string, raw: Buffer, now = Date.now()): boolean {
  const parts = header.split(";").map((x) => x.split("="));
  const ts = parts.find(([k]) => k === "ts")?.[1] ?? "";
  if (!env("PADDLE_WEBHOOK_SECRET") || !/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const want = createHmac("sha256", env("PADDLE_WEBHOOK_SECRET")).update(`${ts}:`).update(raw).digest();
  return parts.some(([k, v]) => k === "h1" && v?.length === 64 && timingSafeEqual(Buffer.from(v, "hex"), want));
}

type Event = { event_type?: string; occurred_at?: string; data?: { id?: string; status?: string; items?: { price?: { id?: string } }[]; custom_data?: { code_hash?: string } | null } };

// Events can come twice and out of order: one older than what was seen is dropped.
async function paid(e: Event): Promise<void> {
  if (!e.event_type?.startsWith("subscription.") || !e.data?.id || !e.occurred_at) return;
  const price = e.data.items?.[0]?.price?.id;
  const plan: Plan | null = price && price === env("PADDLE_PRICE_ALWAYS") ? "always" : price && price === env("PADDLE_PRICE_PLUS") ? "plus" : null;
  const on = ["active", "trialing", "past_due"].includes(e.data.status ?? "");
  let p = one("subscription = ?", e.data.id);
  if (!p) {
    const codeHash = e.data.custom_data?.code_hash ?? "";
    if (!on || !plan || !/^[0-9a-f]{64}$/.test(codeHash)) return;
    if (one("code_hash = ?", codeHash)) throw new Error(`A second subscription for one code: ${e.data.id}`);
    p = add(plan, codeHash, e.data.id);
  }
  if (p.seen_at && p.seen_at > e.occurred_at) return;
  set(p.id, { seen_at: e.occurred_at, ...(plan && plan === "always" ? { plan } : {}) });
  if (on) await resume(one("id = ?", p.id)!);
  else await end(p);
  if (on) void makeServer(p.id);
}

// ── Telegram bots in one tap ────────────────────────────────────────────────

// Our bot manages the bots people make with one tap (Telegram's managed bots).
// A Tabellar says which username it will offer and the hash of a secret; once
// Telegram says that bot exists, the Tabellar with the secret gets its token,
// once. Nothing of it is written down, and what is not claimed in 15 minutes
// is forgotten.
const telegram = (method: string, body: unknown) => call(`https://api.telegram.org/bot${env("TELEGRAM_MANAGER_TOKEN")}`, "", "POST", `/${method}`, body).then((r) => r?.result);
const expected = new Map<string, { claim: string; until: number; bot?: number }>();
const BOT_NAME = /^tabellar_[0-9a-f]{10}_bot$/;

function forgetOld(): void {
  for (const [k, v] of expected) if (v.until < Date.now()) expected.delete(k);
}

function expect(username: string, claim: string): string {
  forgetOld();
  if (!env("TELEGRAM_MANAGER") || !BOT_NAME.test(username) || claim.length < 40 || expected.has(username) || expected.size > 2000) throw Object.assign(new Error("Not now"), { status: 400 });
  expected.set(username, { claim: hash(claim), until: Date.now() + 15 * 60_000 });
  return `https://t.me/newbot/${env("TELEGRAM_MANAGER")}/${username}?name=Tabellar`;
}

function made(update: { managed_bot?: { bot?: { id?: number; username?: string } } }): void {
  const bot = update.managed_bot?.bot;
  const e = expected.get(String(bot?.username ?? ""));
  if (e && bot?.id) e.bot = bot.id;
}

async function claimed(username: string, claim: string): Promise<string | null> {
  const e = expected.get(username);
  if (!e || e.until < Date.now() || !timingSafeEqual(Buffer.from(e.claim), Buffer.from(hash(claim)))) throw Object.assign(new Error("Unknown"), { status: 404 });
  if (!e.bot) return null;
  expected.delete(username);
  return telegram("getManagedBotToken", { user_id: e.bot });
}

// ── The service ─────────────────────────────────────────────────────────────

const full = () => many("plan = 'always'").length >= MAX_SERVERS;

async function bodyOf(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw Object.assign(new Error("Too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const HEADERS = { "Strict-Transport-Security": "max-age=31536000", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://plus");
  const send = (status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...HEADERS, "Content-Type": type, ...extra });
    res.end(body);
  };
  const json = (status: number, body: unknown) => send(status, JSON.stringify(body), "application/json");
  try {
    if (req.method === "POST" && url.pathname === "/paddle") {
      const raw = await bodyOf(req, 1_000_000);
      if (!signed(String(req.headers["paddle-signature"] ?? ""), raw)) return json(401, { error: "Wrong signature" });
      await paid(JSON.parse(raw.toString("utf8")) as Event);
      return json(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/telegram") {
      const secret = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
      const want = derive("telegram", "webhook");
      if (secret.length !== want.length || !timingSafeEqual(Buffer.from(secret), Buffer.from(want))) return json(401, { error: "No" });
      made(JSON.parse((await bodyOf(req, 100_000)).toString("utf8")));
      return json(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/telegram/")) {
      const b = JSON.parse((await bodyOf(req, 4096)).toString("utf8") || "{}");
      if (url.pathname === "/api/telegram/expect") return json(200, { link: expect(String(b.username ?? ""), String(b.claim ?? "")) });
      if (url.pathname === "/api/telegram/claim") {
        const token = await claimed(String(b.username ?? ""), String(b.claim ?? ""));
        return json(token ? 200 : 202, token ? { token } : { waiting: true });
      }
    }
    if (req.method === "POST" && (url.pathname === "/api/key" || url.pathname === "/api/status")) {
      const p = byCode(String(JSON.parse((await bodyOf(req, 4096)).toString("utf8") || "{}").code ?? ""));
      if (!p) return json(404, { error: "That is not a Tabellar+ code, or the payment has not arrived yet." });
      if (url.pathname === "/api/status") {
        return json(200, { plan: p.plan, status: p.status, ends_at: p.ends_at, link: p.status === "active" && p.machine ? `https://${hostOf(p)}/?code=${derive("first", p.id)}` : null });
      }
      if (p.status !== "active") return json(402, { error: "This subscription has ended." });
      return json(200, { key: await modelKey(p.id), ...MODELS });
    }
    if (url.pathname === "/api/models") return json(200, MODELS);
    if (url.pathname === "/oauth/microsoft") {
      // Back to the server that began the sign-in. It alone knows the rest of
      // what makes the code worth anything (PKCE).
      const host = (url.searchParams.get("state") ?? "").split(".").slice(2).join(".");
      if (!many("app IS NOT NULL").some((p) => hostOf(p) === host)) return send(400, page("Sign-in", "<h1>That sign-in did not begin here</h1>"));
      return send(302, "", "text/plain", { Location: `https://${host}/oauth/callback?${url.searchParams}` });
    }
    if (url.pathname === "/") {
      return send(200, checkoutPage({ open: env("OPEN") === "1", full: full(), token: env("PADDLE_CLIENT_TOKEN"), sandbox: env("PADDLE_SANDBOX") === "1", plus: env("PADDLE_PRICE_PLUS"), always: env("PADDLE_PRICE_ALWAYS") }));
    }
    if (url.pathname === "/start") {
      const nonce = randomBytes(16).toString("base64");
      return send(200, startPage(nonce), undefined, { "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'` });
    }
    return send(404, page("Not found", "<h1>Not found</h1>"));
  } catch (e) {
    const status = [400, 404, 413].includes((e as { status?: number }).status ?? 0) ? (e as { status: number }).status : 500;
    console.error(`[plus] ${req.method} ${url.pathname}:`, (e as Error).message);
    if (!res.headersSent) json(status, { error: "Something went wrong. Try again in a minute." });
  }
});

// ── Commands ────────────────────────────────────────────────────────────────

const [command, argument] = process.argv.slice(2);
if (command === "invite") {
  if (argument !== "plus" && argument !== "always") throw new Error("invite plus, or invite always");
  if (argument === "always" && full()) throw new Error("All servers are taken.");
  const code = randomBytes(32).toString("base64url");
  const p = add(argument, hash(code));
  if (p.plan === "always") await makeServer(p.id);
  console.log(`${p.id}\n${env("PUBLIC_URL")}/start#${code}`);
} else if (command === "list") {
  for (const { id, plan, status, app, ends_at, error } of many("1 = 1")) console.log([id, plan, status, app ?? "", ends_at ?? "", error ?? ""].join("\t"));
} else if (command === "end") {
  const p = one("id = ?", argument ?? "");
  if (!p) throw new Error("No such id.");
  await end(p);
} else if (command === "update") {
  await updateServers(argument ?? env("IMAGE"));
} else if (command === "check") {
  await (await import("./check.ts")).check({ add, byCode, derive, end, expected, hash, makeServer, modelKey, one, paid, resume, server, signed, sweep, updateServers, wire });
} else {
  if (env("MASTER").length < 32) throw new Error("MASTER has to be set, at least 32 characters.");
  server.listen(Number(env("PORT", "8080")), () => console.log("Tabellar+ is running."));
  if (env("TELEGRAM_MANAGER_TOKEN")) {
    telegram("setWebhook", { url: `${env("PUBLIC_URL")}/telegram`, secret_token: derive("telegram", "webhook"), allowed_updates: ["managed_bot"] }).catch((e) => console.error("[telegram]", (e as Error).message));
  }
  let month = new Date().getUTCMonth();
  setInterval(() => {
    const now = new Date().getUTCMonth();
    const renewed = now === month ? Promise.resolve() : renewLimits().then(() => void (month = now));
    renewed.then(() => sweep()).catch((e) => console.error("[sweep]", (e as Error).message));
  }, 60_000);
}
