// `node plus/server.ts check`: codes, keys, servers and payments against a fake
// OpenRouter and Fly, in memory (PLUS_DB=:memory:).

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

type Parts = Record<string, any>;
type Call = { method: string; path: string; body: any };

export async function check(t: Parts): Promise<void> {
  assert.equal(process.env.PLUS_DB, ":memory:", "Run this with PLUS_DB=:memory:");
  Object.assign(process.env, { MASTER: "m".repeat(40), PADDLE_WEBHOOK_SECRET: "whsec", PADDLE_PRICE_PLUS: "pri_plus", PADDLE_PRICE_ALWAYS: "pri_always", PUBLIC_URL: "https://plus.example", IMAGE: "image:1" });
  const calls: Call[] = [];
  const keys = new Map<string, { limit: number; usage_monthly: number; disabled: boolean }>();
  const apps = new Map<string, { ips: string[]; volumes: { id: string }[]; machines: { id: string; config: any }[]; secrets: Record<string, string>; network: string }>();
  let refuse = "";
  let n = 0;
  t.wire.fetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/(api\/)?v1/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const method = init.method!;
    calls.push({ method, path, body });
    await new Promise((r) => setTimeout(r, 1));
    const say = (status: number, data?: unknown) => new Response(data === undefined ? null : JSON.stringify(data), { status });
    if (refuse && path.endsWith(refuse)) return say(500, { error: "down" });
    const id = path.split("/")[2];
    if (u.host === "openrouter.ai") {
      if (method === "POST") {
        const hash = `h${++n}`;
        keys.set(hash, { limit: body.limit, usage_monthly: 0, disabled: false });
        return say(201, { key: `sk-${hash}`, data: { hash } });
      }
      const k = keys.get(id);
      if (!k) return say(404, {});
      if (method === "DELETE") keys.delete(id);
      if (method === "PATCH") Object.assign(k, body);
      return say(200, { data: k });
    }
    if (path === "/apps" && method === "POST") return apps.set(body.name, { ips: [], volumes: [], machines: [], secrets: {}, network: body.network }) && say(201, {});
    const app = apps.get(id);
    if (!app) return say(404, {});
    if (method === "DELETE") return apps.delete(id) && say(202, {});
    const [, , , what, mid] = path.split("/");
    if (!what) return say(200, {});
    if (what === "ip_assignments") return method === "POST" ? (app.ips.push(body.type), say(200, {})) : say(200, { ips: app.ips });
    if (what === "secrets") return Object.assign(app.secrets, body.values) && say(200, { version: 3 });
    if (what === "volumes") return method === "POST" ? (app.volumes.push({ id: "vol_1" }), say(200, { id: "vol_1" })) : say(200, app.volumes);
    if (mid) return method === "POST" ? ((app.machines[0].config = body.config), say(200, {})) : say(200, app.machines[0]);
    return method === "POST" ? (app.machines.push({ id: "m1", config: body.config }), say(200, { id: "m1" })) : say(200, app.machines);
  };
  let passed = 0;
  const ok = (name: string, fn: () => void) => (fn(), passed++, console.log(`  ok  ${name}`));
  await new Promise<void>((r) => t.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${t.server.address().port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const newCode = () => randomBytes(32).toString("base64url");

  const code = newCode();
  const plus = t.add("plus", t.hash(code));
  const none = [await post("/api/key", { code: newCode() }), await post("/api/key", { code: "" }), await post("/api/key", { code: t.hash(code) }), await post("/api/key", {})];
  const got = await post("/api/key", { code });
  ok("a code gets a capped key and the models; anything else gets nothing", () => {
    assert.deepEqual(none.map((r) => r.status), [404, 404, 404, 404]);
    assert.equal(got.status, 200);
    assert.deepEqual(Object.keys(got.body).sort(), ["careful", "fast", "key"]);
    assert.deepEqual([...keys.values()], [{ limit: 2, usage_monthly: 0, disabled: false }]);
  });
  [...keys.values()][0].usage_monthly = 1.5;
  const many = await Promise.all([1, 2, 3, 4].map(() => post("/api/key", { code })));
  ok("asking again, even four times at once, leaves one key with what was left", () => {
    assert.deepEqual(many.map((r) => r.status), [200, 200, 200, 200]);
    assert.deepEqual([...keys.values()].map((k) => k.limit), [0.5]);
  });

  const price = { plus: "pri_plus", always: "pri_always" } as Record<string, string>;
  const event = (sub: string, status: string, at: number, plan = "always", codeHash?: string) =>
    JSON.stringify({ event_type: "subscription.updated", occurred_at: new Date(at).toISOString(), data: { id: sub, status, items: [{ price: { id: price[plan] ?? plan } }], custom_data: codeHash ? { code_hash: codeHash } : null } });
  const sign = (raw: string, secret = "whsec", ts = Math.floor(Date.now() / 1000)) => ({ "paddle-signature": `ts=${ts};h1=${createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex")}` });
  const now = Date.now();
  const paidCode = newCode();
  const raw = event("sub_1", "active", now, "always", t.hash(paidCode));
  const bad = [await post("/paddle", raw), await post("/paddle", raw, sign(raw, "other")), await post("/paddle", raw, sign(raw, "whsec", Math.floor(now / 1000) - 3600)), await post("/paddle", raw.replace("sub_1", "sub_2"), sign(raw))];
  const unknown = event("sub_9", "active", now, "pri_else", t.hash(newCode()));
  await post("/paddle", unknown, sign(unknown));
  ok("a payment counts only with Paddle's signature, made now, over these bytes, for a price of ours", () => {
    assert.deepEqual(bad.map((r) => r.status), [401, 401, 401, 401]);
    assert.equal(t.one("subscription = ?", "sub_2"), undefined);
    assert.equal(t.one("subscription = ?", "sub_9"), undefined);
  });
  refuse = "/volumes";
  await post("/paddle", raw, sign(raw));
  await new Promise((r) => setTimeout(r, 100));
  const p1 = t.one("subscription = ?", "sub_1");
  const waiting = await post("/api/status", { code: paidCode });
  refuse = "";
  await post("/paddle", raw, sign(raw));
  await new Promise((r) => setTimeout(r, 100));
  await t.sweep();
  const p2 = t.one("subscription = ?", "sub_1");
  const app = apps.get(p2.app)!;
  const ready = await post("/api/status", { code: paidCode });
  ok("paying for Always on makes one server on its own network, taken up again after a failure", () => {
    assert.ok(p1.error && !p1.machine && waiting.body.link === null);
    assert.ok(p2.machine === "m1" && !p2.error);
    assert.deepEqual([app.ips, app.volumes.length, app.machines.length, app.network, apps.size], [["shared_v4", "v6"], 1, 1, p2.app, 1]);
    const c = app.machines[0].config;
    assert.equal(c.env.TABELLAR_PUBLIC_URL, `https://${p2.app}.fly.dev`);
    assert.ok(!JSON.stringify(c).includes(app.secrets.TABELLAR_PASSPHRASE) && c.services[0].ports[1].force_https);
    assert.equal(ready.body.link, `https://${p2.app}.fly.dev/?code=${app.secrets.TABELLAR_FIRST_CODE}`);
    assert.equal(new Set(Object.values(app.secrets)).size, 3);
  });
  const own = await post("/api/key", { code: app.secrets.TABELLAR_PLUS_CODE });
  const notFirst = await post("/api/key", { code: app.secrets.TABELLAR_FIRST_CODE });
  const back = (state: string) => fetch(`${base}/oauth/microsoft?code=c&state=${state}`, { redirect: "manual" });
  const [toIt, toEvil] = [await back(`ms.abc.${p2.app}.fly.dev`), await back("ms.abc.evil.example")];
  ok("the server's own code gets its key, its first code does not, and a sign-in goes back only to a server of ours", () => {
    assert.deepEqual([own.status, notFirst.status], [200, 404]);
    assert.equal(toIt.status, 302);
    assert.ok(toIt.headers.get("location")!.startsWith(`https://${p2.app}.fly.dev/oauth/callback?code=c&state=ms.abc.`));
    assert.equal(toEvil.status, 400);
  });
  await t.updateServers("image:2");
  ok("an update changes the image and keeps the volume", () => {
    assert.equal(app.machines[0].config.image, "image:2");
    assert.equal(app.machines[0].config.mounts[0].volume, "vol_1");
  });

  const cancelled = event("sub_1", "canceled", now + 2000);
  await post("/paddle", cancelled, sign(cancelled));
  const late = event("sub_1", "active", now + 1000);
  await post("/paddle", late, sign(late));
  const ended = t.one("subscription = ?", "sub_1");
  const refused = await post("/api/key", { code: paidCode });
  await t.sweep();
  const kept = apps.size;
  await t.sweep(Date.now() + 31 * 86_400_000);
  ok("cancelling ends the model at once and the server after 30 days; a late event does not bring it back", () => {
    assert.equal(ended.status, "ended");
    assert.equal(refused.status, 402);
    assert.deepEqual([kept, apps.size, t.one("subscription = ?", "sub_1")], [1, 0, undefined]);
    assert.ok(t.one("id = ?", plus.id), "the other subscription is untouched");
    assert.equal(keys.size, 1);
  });
  const pages = [await fetch(`${base}/`), await fetch(`${base}/start`), await fetch(`${base}/nothing`)];
  const front = await pages[0].text();
  ok("until it is opened, nobody can pay", () => {
    assert.deepEqual(pages.map((r) => r.status), [200, 200, 404]);
    assert.ok(!front.includes("paddle.js") && front.includes("By invitation for now"));
  });
  t.server.close();
  t.server.closeAllConnections();
  console.log(`\n${passed} checks passed.`);
}
