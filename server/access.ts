// Reaching the window over the internet, for a Tabellar started with
// TABELLAR_PUBLIC_URL (a Tabellar+ server). Without it nothing here runs and
// the window answers on this machine only (server.ts).
//
// Over the public name nobody has the machine's own access token. A browser
// signs in with a passkey and gets a session of its own, kept as a hash, for
// 30 days. A passkey is added with a one-time code: the one the server was
// made with (TABELLAR_FIRST_CODE, until there is a passkey), or one from
// `tabellar open` on the server. A code alone opens nothing, so a link that a
// mail scanner follows is not spent.

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { secrets } from "./config.ts";

const DAY = 86_400_000;
const SESSION_DAYS = 30;

export const publicUrl = (): URL | null => (process.env.TABELLAR_PUBLIC_URL ? new URL(process.env.TABELLAR_PUBLIC_URL) : null);

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest();
const hex = (s: string) => sha(s).toString("hex");
const bytes = (s: unknown) => Buffer.from(String(s ?? ""), "base64url");
const refuse = (why: string) => Object.assign(new Error(why), { status: 401 });

type Passkey = { id: string; key: string; alg: number; count: number; added: string };

const passkeys = (): Passkey[] => JSON.parse(secrets.get("passkeys") ?? "[]");
export const hasPasskey = () => passkeys().length > 0;

// ── Sessions ────────────────────────────────────────────────────────────────

const sessions = (): Record<string, number> => JSON.parse(secrets.get("sessions") ?? "{}");
const keepSessions = (all: Record<string, number>) => secrets.set("sessions", JSON.stringify(Object.fromEntries(Object.entries(all).filter(([, until]) => until > Date.now()))));

export function startSession(): string {
  const token = randomBytes(32).toString("base64url");
  keepSessions({ ...sessions(), [hex(token)]: Date.now() + SESSION_DAYS * DAY });
  return token;
}

export function isSession(token: string | undefined): boolean {
  if (!token) return false;
  return (sessions()[hex(token)] ?? 0) > Date.now();
}

// This browser, or every one.
export function endSession(token: string, all: boolean): void {
  const { [hex(token)]: gone, ...rest } = sessions();
  keepSessions(all ? {} : rest);
}

export const SESSION_COOKIE = "__Host-tabellar";
export const cookieFor = (token: string) => `${SESSION_COOKIE}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? (SESSION_DAYS * DAY) / 1000 : 0}`;

// ── Codes ───────────────────────────────────────────────────────────────────

export function isFirstCode(code: string): boolean {
  const first = process.env.TABELLAR_FIRST_CODE ?? "";
  if (first.length < 32 || hasPasskey()) return false;
  return timingSafeEqual(sha(code), sha(first));
}

// ── Passkeys ────────────────────────────────────────────────────────────────

// Challenges given out, each good once, for five minutes. Anyone can ask for
// one, so only the latest are kept.
const challenges = new Map<string, number>();

export function challenge(): string {
  const c = randomBytes(32).toString("base64url");
  challenges.set(c, Date.now() + 5 * 60_000);
  if (challenges.size > 500) challenges.delete(challenges.keys().next().value!);
  return c;
}

// What the browser says it signed is for this page and one of our challenges.
function clientData(raw: Buffer, type: string): void {
  const c = JSON.parse(raw.toString("utf8")) as { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  const until = challenges.get(c.challenge ?? "") ?? 0;
  challenges.delete(c.challenge ?? "");
  if (c.type !== type || until < Date.now() || c.origin !== publicUrl()?.origin || c.crossOrigin) throw refuse("That passkey answer is not for this page. Try again.");
}

// The authenticator's own part: for this name, with the user there and checked.
function authenticator(data: Buffer): { flags: number; count: number } {
  const flags = data[32] ?? 0;
  if (data.length < 37 || !data.subarray(0, 32).equals(sha(publicUrl()!.hostname)) || (flags & 5) !== 5) throw refuse("The passkey did not check that it was you.");
  return { flags, count: data.readUInt32BE(33) };
}

type Registration = { id?: string; clientDataJSON?: string; authenticatorData?: string; publicKey?: string; alg?: number };

// Keep a new passkey. The caller has checked the code.
export function addPasskey(r: Registration): void {
  clientData(bytes(r.clientDataJSON), "webauthn.create");
  const data = bytes(r.authenticatorData);
  const { flags, count } = authenticator(data);
  const id = data.length > 55 ? data.subarray(55, 55 + data.readUInt16BE(53)).toString("base64url") : "";
  if (!(flags & 64) || !id || id !== r.id) throw refuse("That is not a new passkey.");
  const alg = Number(r.alg);
  const key = createPublicKey({ key: bytes(r.publicKey), format: "der", type: "spki" });
  if (({ "-7": "ec", "-257": "rsa", "-8": "ed25519" } as Record<string, string>)[alg] !== key.asymmetricKeyType) throw refuse("That kind of passkey is not supported.");
  secrets.set("passkeys", JSON.stringify([...passkeys().filter((p) => p.id !== id), { id, key: bytes(r.publicKey).toString("base64url"), alg, count, added: new Date().toISOString() }]));
}

type Assertion = { id?: string; clientDataJSON?: string; authenticatorData?: string; signature?: string };

export function checkPasskey(a: Assertion): void {
  const all = passkeys();
  const p = all.find((x) => x.id === a.id);
  if (!p) throw refuse("This passkey is not known here.");
  const client = bytes(a.clientDataJSON);
  clientData(client, "webauthn.get");
  const data = bytes(a.authenticatorData);
  const { count } = authenticator(data);
  const key = createPublicKey({ key: bytes(p.key), format: "der", type: "spki" });
  if (!verify(p.alg === -8 ? null : "sha256", Buffer.concat([data, sha(client)]), key, bytes(a.signature))) throw refuse("The passkey's signature is wrong.");
  // Passkeys that are synced between devices do not count.
  if (p.count && count && count <= p.count) throw refuse("This passkey was copied. Use another one.");
  if (count !== p.count) secrets.set("passkeys", JSON.stringify(all.map((x) => (x === p ? { ...p, count } : x))));
}

// ── The sign-in page ────────────────────────────────────────────────────────

// Everything the page needs is in it; `nonce` is the only script it runs.
export function signInPage(code: string | null, nonce: string): string {
  const adding = code !== null;
  const ready = adding || hasPasskey();
  const title = adding ? "Make your key" : "Open your Tabellar";
  const text = adding
    ? "A passkey opens this Tabellar from now on: your fingerprint, face or device code. It stays with your device or password manager."
    : ready
      ? "Use the passkey you made for this Tabellar."
      : "Open the link you were given when this Tabellar was made.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tabellar</title>
<style nonce="${nonce}">body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:26rem;margin:22vh auto 0;padding:0 1.25rem;color:#202124;background:#fff}h1{font-size:1.6rem;margin:0 0 .5rem}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:.65rem 1.1rem;background:#a33a24;color:#fff;cursor:pointer}button:disabled{opacity:.5}#said{color:#a33a24;min-height:1.5em}
@media (prefers-color-scheme:dark){body{color:#e8eaed;background:#202124}#said{color:#f0a08c}}</style></head>
<body><h1>${title}</h1><p>${text}</p>${ready ? `<p><button id="go">${adding ? "Make a passkey" : "Sign in"}</button></p>` : ""}<p id="said" role="alert"></p>
<script nonce="${nonce}">
const code = ${JSON.stringify(code).replace(/</g, "\\u003c")};
const enc = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const post = async (path, body) => {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Tabellar answered " + r.status);
  return d;
};
const go = document.getElementById("go"), said = document.getElementById("said");
if (go) go.onclick = async () => {
  go.disabled = true; said.textContent = "";
  try {
    const { challenge } = await post("/auth/challenge", {});
    if (code !== null) {
      const c = await navigator.credentials.create({ publicKey: {
        challenge: dec(challenge), rp: { id: location.hostname, name: "Tabellar" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: location.hostname, displayName: "Tabellar" },
        pubKeyCredParams: [-7, -257, -8].map((alg) => ({ type: "public-key", alg })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" }, attestation: "none" } });
      const r = c.response;
      await post("/auth/passkey", { code, id: c.id, clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.getAuthenticatorData()), publicKey: enc(r.getPublicKey()), alg: r.getPublicKeyAlgorithm() });
    } else {
      const c = await navigator.credentials.get({ publicKey: { challenge: dec(challenge), rpId: location.hostname, userVerification: "required" } });
      const r = c.response;
      await post("/auth/sign-in", { id: c.id, clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature) });
    }
    location.replace("/");
  } catch (e) {
    said.textContent = e.name === "NotAllowedError" ? "Nothing was chosen. Try again." : e.message;
    go.disabled = false;
  }
};
</script></body></html>`;
}

// Sent with everything over the public name.
export const PUBLIC_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};
