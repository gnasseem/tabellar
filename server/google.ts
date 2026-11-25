// Google sign-in and token storage.
//
// Sign-in uses the OAuth flow for installed apps: the browser goes to Google,
// and Google sends it back to this machine's loopback address with a one-time
// code, protected by PKCE. Refresh tokens are kept with the secrets (config.ts);
// the database only stores a reference to one. Access tokens live in
// memory and are refreshed when they expire.

import { createHash, randomBytes } from "node:crypto";
import { getEnv, secrets } from "./config.ts";

export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
];

export interface TokenData {
  token: string;
  refresh_token?: string;
  expiry?: string;
  scopes?: string[];
}

const accessTokens = new Map<string, { token: string; expiry: string }>();

// Store tokens and return the reference saved in accounts.token_ref.
// The reference is derived from the refresh token, so refreshing an access
// token keeps the same reference and touches only memory.
export async function saveTokens(t: TokenData): Promise<string> {
  if (!t.refresh_token) throw new Error("Google did not return a refresh token");
  const ref = "google:" + createHash("sha256").update(t.refresh_token).digest("hex").slice(0, 16);
  const stored = JSON.stringify({ refresh_token: t.refresh_token, scopes: t.scopes });
  if (secrets.get(ref) !== stored) secrets.set(ref, stored);
  if (t.token) accessTokens.set(ref, { token: t.token, expiry: t.expiry ?? new Date(Date.now() + 3000_000).toISOString() });
  return ref;
}

export async function loadTokens(ref: string): Promise<TokenData> {
  const stored = secrets.get(ref);
  if (!stored) throw Object.assign(new Error("This Google account is not connected here. Sign in again."), { status: 401 });
  const { refresh_token, scopes } = JSON.parse(stored) as { refresh_token: string; scopes?: string[] };
  const cached = accessTokens.get(ref);
  // No cached access token: report it as expired so callers refresh first.
  return { token: cached?.token ?? "", refresh_token, expiry: cached?.expiry ?? new Date(0).toISOString(), scopes };
}

export function forgetTokens(ref: string): void {
  accessTokens.delete(ref);
  secrets.delete(ref);
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenData> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: getEnv("GOOGLE_CLIENT_ID"),
      client_secret: getEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const said = (await res.text()).slice(0, 200);
    console.error(`[google] token refresh failed status=${res.status} ${said}`);
    // Taken back in the Google account, expired, or issued to another client.
    if (/invalid_grant|unauthorized_client|invalid_client/.test(said)) throw Object.assign(new Error("Google no longer accepts this sign-in. Sign in again."), { status: 401 });
    throw new Error(`Google did not renew the sign-in (${res.status})`);
  }
  const data = await res.json();
  return {
    token: data.access_token,
    refresh_token: refreshToken,
    expiry: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
  };
}


export async function revokeGoogleTokens(ref: string): Promise<void> {
  try {
    const t = await loadTokens(ref);
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t.refresh_token! }).toString(),
    });
  } catch (err) {
    console.error("[google] token revoke failed:", err);
  }
  forgetTokens(ref);
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

const pendingSignIns = new Map<string, { verifier: string; redirectUri: string; expires: number }>();

const b64url = (b: Buffer) => b.toString("base64url");

export function signInUrl(redirectUri: string): string {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  for (const [k, v] of pendingSignIns) if (v.expires < Date.now()) pendingSignIns.delete(k);
  pendingSignIns.set(state, { verifier, redirectUri, expires: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: getEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    // Always show consent so Google always returns a refresh token.
    prompt: "consent select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Finish sign-in: exchange the code, store the tokens, return the address.
export async function finishSignIn(code: string, state: string): Promise<{ email: string; name: string; picture: string | null; tokenRef: string }> {
  const pending = pendingSignIns.get(state);
  pendingSignIns.delete(state);
  if (!pending || pending.expires < Date.now()) throw new Error("This sign-in link has expired. Start again.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: getEnv("GOOGLE_CLIENT_ID"),
      client_secret: getEnv("GOOGLE_CLIENT_SECRET"),
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google refused the sign-in (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const info = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then((r) => r.json());
  if (!info.email) throw new Error("Google did not say which account signed in.");
  const tokenRef = await saveTokens({
    token: data.access_token,
    refresh_token: data.refresh_token,
    expiry: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    scopes: typeof data.scope === "string" ? data.scope.split(" ") : undefined,
  });
  return { email: info.email, name: info.name ?? info.email.split("@")[0], picture: info.picture ?? null, tokenRef };
}
