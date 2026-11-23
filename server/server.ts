// The Tabellar server: serves the interface, the local API, the database
// bridge and the live event stream, on 127.0.0.1 only, and runs the
// background engine (engine.ts) and the timer for scheduled sends.
//
// Access: every request must name this machine as its Host (which defeats DNS
// rebinding) and, when a browser sends an Origin, come from Tabellar's own
// page. API calls carry the access token in an Authorization header, which a
// cross-site page cannot set. The browser gets the token inside index.html,
// which is only served with a session cookie, and the cookie is only handed out
// in exchange for a one-time code minted by `tabellar open`.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, accessToken, googleClient } from "./config.ts";
import { db, execute, callRpc, changes, type Change } from "./db.ts";
import type { QuerySpec } from "./query.ts";
import { handleApi } from "./api.ts";
import { handleSetup, startOllama } from "./setup.ts";
import { signInUrl, finishSignIn, forgetTokens } from "./google.ts";
import { sendDueEmails } from "./outbox.ts";
import { modelConfigured } from "./llm.ts";
import { startEngine } from "./engine.ts";

const DIST = fileURLToPath(new URL("../frontend/dist/", import.meta.url));
const MAX_BODY = 50 * 1024 * 1024; // attachments arrive base64-encoded in JSON
const COOKIE = "tabellar_session";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function sameSecret(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8", extra: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(data), "application/json");
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem;color:#202124;background:#fff}
code{background:#f1f3f4;padding:.15em .4em;border-radius:4px}@media (prefers-color-scheme:dark){body{color:#e8eaed;background:#202124}code{background:#35363a}}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// ── One-time login codes for `tabellar open` ────────────────────────────────

const loginCodes = new Map<string, number>();

function mintLoginCode(): string {
  const code = randomBytes(24).toString("base64url");
  loginCodes.set(code, Date.now() + 60_000);
  return code;
}

function useLoginCode(code: string): boolean {
  const expires = loginCodes.get(code);
  loginCodes.delete(code);
  return !!expires && expires > Date.now();
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

async function completeSignIn(code: string, state: string): Promise<boolean> {
  const g = await finishSignIn(code, state);
  let { data: profile } = await db.from("profiles").select("id").limit(1).maybeSingle();
  if (!profile) {
    const created = await db
      .from("profiles")
      .insert({ id: randomUUID(), email: g.email, display_name: g.name, avatar_url: g.picture })
      .select("id")
      .single();
    if (created.error) throw new Error(created.error.message);
    profile = created.data;
  }
  const userId = profile.id as string;
  const { data: existing } = await db
    .from("gmail_accounts")
    .select("id, token_ref")
    .eq("user_id", userId)
    .eq("gmail_address", g.email)
    .maybeSingle();
  if (existing && existing.token_ref !== g.tokenRef) forgetTokens(existing.token_ref as string);
  const saved = await db
    .from("gmail_accounts")
    .upsert({ user_id: userId, gmail_address: g.email, token_ref: g.tokenRef, is_active: true }, { onConflict: "user_id,gmail_address" });
  if (saved.error) throw new Error(saved.error.message);
  const { count } = await db.from("emails").select("id", { count: "exact", head: true }).eq("user_id", userId);
  return (count ?? 0) === 0;
}

// ── Server ──────────────────────────────────────────────────────────────────

export function startServer(): Promise<{ port: number; close: () => void }> {
  const { port } = loadConfig();
  const token = accessToken();
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const sessionCookie = `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;
    try {
      if (!hosts.has(req.headers.host ?? "")) return send(res, 421, "Wrong host");
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) return send(res, 403, "Cross-origin requests are not allowed");

      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const hasToken = sameSecret(bearer, token);
      const hasCookie = sameSecret(cookie(req, COOKIE), token);

      // Token-only endpoints: the API, the database bridge, the CLI.
      if (path.startsWith("/api/") || path === "/db" || path === "/db/rpc" || path === "/session" || path === "/auth/login-code") {
        if (!hasToken) return sendJson(res, 401, { error: "Missing or wrong access token" });
        if (path === "/auth/login-code" && req.method === "POST") return sendJson(res, 200, { code: mintLoginCode() });
        if (path === "/session" && req.method === "GET") return sendJson(res, 200, await sessionInfo());
        if (path === "/db" && req.method === "POST") {
          const spec = JSON.parse((await readBody(req)).toString("utf8")) as QuerySpec;
          return sendJson(res, 200, execute(spec));
        }
        if (path === "/db/rpc" && req.method === "POST") {
          const { fn, args } = JSON.parse((await readBody(req)).toString("utf8"));
          return sendJson(res, 200, callRpc(fn, args));
        }
        if (path.startsWith("/api/")) {
          const method = req.method ?? "GET";
          const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string" && !["host", "connection", "content-length", "transfer-encoding", "keep-alive"].includes(k)) headers.set(k, v);
          }
          const request = new Request(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
          const response = path.startsWith("/api/setup/") ? await handleSetup(request, path.slice(10)) : await handleApi(request, path.slice(4));
          const out: Record<string, string> = {};
          response.headers.forEach((v, k) => (out[k] = v));
          res.writeHead(response.status, out);
          // Streamed, so progress (model downloads) reaches the window as it happens.
          if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
          return res.end();
        }
        return sendJson(res, 404, { error: "Not found" });
      }

      if (path === "/events") {
        if (!hasCookie && !sameSecret(url.searchParams.get("token") ?? undefined, token)) return send(res, 401, "Not signed in");
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(": connected\n\n");
        const onChange = (c: Change) => res.write(`data: ${JSON.stringify(c)}\n\n`);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        changes.on("change", onChange);
        req.on("close", () => {
          clearInterval(ping);
          changes.off("change", onChange);
        });
        return;
      }

      if (path === "/oauth/start") {
        if (!hasCookie) return send(res, 401, page("Not signed in", "<p>Open Tabellar from the terminal with <code>tabellar open</code>.</p>"), "text/html; charset=utf-8");
        if (!googleClient()) {
          return send(res, 400, page("Google sign-in is not set up", "<p>Add your Google client first. <a href=\"/\">Back to Tabellar</a></p>"), "text/html; charset=utf-8");
        }
        res.writeHead(302, { Location: signInUrl(redirectUri) });
        return res.end();
      }

      if (path === "/oauth/callback") {
        // Reached from Google, so it is authenticated by the one-time state
        // that only this server knows, not by the cookie.
        const err = url.searchParams.get("error");
        if (err) return send(res, 400, page("Sign-in cancelled", `<p>Google said: ${err.replace(/[<>&]/g, "")}. <a href="/">Back to Tabellar</a></p>`), "text/html; charset=utf-8");
        let first: boolean;
        try {
          first = await completeSignIn(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
        } catch (e) {
          const msg = (e as Error).message.replace(/[<>&]/g, "");
          return send(res, 400, page("Sign-in failed", `<p>${msg}</p><p><a href="/">Back to Tabellar</a></p>`), "text/html; charset=utf-8");
        }
        res.writeHead(302, { Location: first ? "/?initial=1" : "/" });
        return res.end();
      }

      // Static files of the built interface.
      const file = normalize(join(DIST, decodeURIComponent(path)));
      if (file.startsWith(DIST) && extname(file) && existsSync(file)) {
        const immutable = path.startsWith("/assets/");
        return send(res, 200, await readFile(file), MIME[extname(file)] ?? "application/octet-stream", {
          "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        });
      }

      // Everything else is the app itself.
      const code = url.searchParams.get("code");
      if (code && path === "/") {
        if (!useLoginCode(code)) return send(res, 401, page("Link expired", "<p>Run <code>tabellar open</code> again.</p>"), "text/html; charset=utf-8");
        res.writeHead(302, { Location: "/", "Set-Cookie": sessionCookie });
        return res.end();
      }
      if (!hasCookie) {
        return send(res, 401, page("Tabellar", "<p>To open Tabellar, run <code>tabellar open</code> in the terminal.</p>"), "text/html; charset=utf-8");
      }
      const index = join(DIST, "index.html");
      if (!existsSync(index)) return send(res, 503, page("Interface not built", "<p>Run <code>npm run build</code> in the Tabellar folder.</p>"), "text/html; charset=utf-8");
      const html = (await readFile(index, "utf8")).replace("<head>", `<head><script>window.__TABELLAR_TOKEN__=${JSON.stringify(token)}</script>`);
      return send(res, 200, html, "text/html; charset=utf-8");
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      console.error(`[server] ${req.method} ${path}:`, e);
      if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
      else res.end();
    }
  });

  const timer = setInterval(() => sendDueEmails().catch((e) => console.error("[scheduled]", e)), 10_000);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      // A local model needs Ollama running; start it if it is not.
      if ([loadConfig().model, loadConfig().fastModel].some((m) => m?.format === "ollama")) startOllama().catch(() => {});
      const stopEngine = startEngine();
      resolve({
        port,
        close: () => {
          stopEngine();
          clearInterval(timer);
          server.close();
        },
      });
    });
  });
}

// What the interface needs to know before it can show the inbox.
async function sessionInfo() {
  const { data: profile } = await db.from("profiles").select("*").limit(1).maybeSingle();
  const { count } = profile
    ? await db.from("gmail_accounts").select("id", { count: "exact", head: true }).eq("user_id", profile.id).eq("is_active", true)
    : { count: 0 };
  return {
    user: profile ? { id: profile.id, email: profile.email } : null,
    profile,
    accounts: count ?? 0,
    googleConfigured: !!googleClient(),
    modelConfigured: modelConfigured(),
  };
}
