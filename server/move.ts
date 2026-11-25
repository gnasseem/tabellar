// Moving Tabellar to another machine: `tabellar move` writes the data folder
// and the secrets into one file, encrypted with a passphrase, and
// `tabellar start <file>` (or serve) begins from it elsewhere. A mailbox has
// one engine: the old place is closed before the file has its name, and the
// file is gone once it was started from.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { CONFIG_PATH, DB_PATH, HOME, loadConfig, modelKeyName, saveConfig, secrets, type Config } from "./config.ts";
import { place } from "./place.ts";
import { seal, unseal } from "./seal.ts";
import { PROVIDERS } from "./setup.ts";

export const WORDS = 12; // the shortest passphrase

type Header = { config: Config; secrets: Record<string, string>; timezone: string };

// The secrets a mailbox, a model, the bot or the user's own Google client needs.
// The access token is this machine's own.
function secretNames(refs: unknown[]): string[] {
  return [...new Set(["google-client-secret", ...[...PROVIDERS.map((p) => p.id), "custom", "plus"].map((id) => modelKeyName(id)), ...refs.map(String)])];
}

// Write everything into `path` and close this place. Called with the lock held.
export async function pack(path: string, passphrase: string): Promise<void> {
  if (passphrase.length < WORDS) throw new Error(`The passphrase needs at least ${WORDS} characters.`);
  if (existsSync(path)) throw new Error(`${path} is already there.`);
  if (!existsSync(DB_PATH)) throw new Error(`There is nothing in ${HOME} to move.`);
  const { db } = await import("./db.ts");
  const { data: me } = await db.from("profiles").select("id, moved_at").limit(1).maybeSingle();
  if (!me) throw new Error(`There is nothing in ${HOME} to move.`);
  if (me.moved_at) throw new Error(movedFrom(String(me.moved_at)));
  const [{ data: accounts }, { data: bot }] = await Promise.all([db.from("accounts").select("token_ref"), db.from("telegram").select("token_ref")]);
  const kept: Record<string, string> = {};
  for (const name of secretNames([...(accounts ?? []), ...(bot ?? [])].map((r) => r.token_ref))) {
    const value = secrets.get(name);
    if (value !== null) kept[name] = value;
  }
  const lost = (accounts ?? []).filter((a) => !kept[String(a.token_ref)]);
  if (lost.length) throw new Error("The sign-in of a mailbox could not be read. Run this where Tabellar runs, as the same user.");

  const copy = join(HOME, `moving-${randomUUID()}.db`);
  const part = `${path}.part`;
  try {
    const d = new DatabaseSync(DB_PATH);
    d.prepare("VACUUM INTO ?").run(copy);
    d.close();
    const header = Buffer.from(JSON.stringify({ config: loadConfig(), secrets: kept, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } satisfies Header), "utf8");
    const size = Buffer.alloc(4);
    size.writeUInt32BE(header.length);
    writeFileSync(part, seal(passphrase, gzipSync(Buffer.concat([size, header, readFileSync(copy)]))), { mode: 0o600 });
    // Closed here before the file can be started from.
    const now = new Date().toISOString();
    await db.from("scheduled_emails").update({ status: "failed", error_message: "Not sent from here: Tabellar moved to another place, which sends it." }).eq("status", "pending");
    await db.from("telegram").delete().eq("user_id", me.id);
    const { error } = await db.from("profiles").update({ moved_at: now, engine_paused: true }).eq("id", me.id);
    if (error) throw new Error(error.message);
    renameSync(part, path);
  } finally {
    for (const f of [copy, part]) rmSync(f, { force: true });
  }
}

// Begin from such a file. Called with the lock held, before the database is
// opened; what it finds here must be new. Returns whether the file could be deleted.
export function unpack(path: string, passphrase: string): boolean {
  if (hasProfile()) throw new Error(`There is a Tabellar in ${HOME} already. Set TABELLAR_HOME to an empty folder to start from the file.`);
  const bytes = gunzipSync(unseal(passphrase, readFileSync(path), "That is not the passphrase the file was written with."));
  const at = 4 + bytes.readUInt32BE(0);
  const header = JSON.parse(bytes.subarray(4, at).toString("utf8")) as Header;

  const part = `${DB_PATH}.part`;
  writeFileSync(part, bytes.subarray(at), { mode: 0o600 });
  const d = new DatabaseSync(part);
  const me = d.prepare("SELECT id, working_hours FROM profiles LIMIT 1").get() as { id: string; working_hours: string | null };
  // Their day stays the one it was: a server is often on another clock.
  const hours = { ...(JSON.parse(me.working_hours ?? "null") ?? {}) };
  hours.timezone ??= header.timezone;
  d.prepare("UPDATE profiles SET home = ?, moved_at = NULL, working_hours = ? WHERE id = ?").run(place(), JSON.stringify(hours), me.id);
  d.close();
  for (const [name, value] of Object.entries(header.secrets)) secrets.set(name, value);
  // The port is this machine's, where it has one.
  saveConfig({ ...header.config, ...(existsSync(CONFIG_PATH) ? { port: loadConfig().port } : {}) });
  for (const f of [`${DB_PATH}-wal`, `${DB_PATH}-shm`, `${part}-wal`, `${part}-shm`]) rmSync(f, { force: true });
  renameSync(part, DB_PATH);
  try {
    rmSync(path, { force: true });
  } catch {
    return false;
  }
  return true;
}

// Whether someone uses the database here.
function hasProfile(): boolean {
  if (!existsSync(DB_PATH)) return false;
  const d = new DatabaseSync(DB_PATH);
  try {
    return !!d.prepare("SELECT id FROM profiles LIMIT 1").get();
  } catch {
    return false; // made, and never used
  } finally {
    d.close();
  }
}

const movedFrom = (at: string) => `Tabellar moved from here on ${new Date(at).toLocaleDateString("en-US", { dateStyle: "medium" })} and runs in the other place. If that one is gone for good, \`tabellar move back\` makes this its place again.`;

// Why this place must not run, or null.
export async function movedAway(): Promise<string | null> {
  const { db } = await import("./db.ts");
  const { data: me } = await db.from("profiles").select("moved_at").limit(1).maybeSingle();
  return me?.moved_at ? movedFrom(String(me.moved_at)) : null;
}

// The other place is gone, or never was. It stays paused until the user says otherwise.
export async function moveBack(): Promise<void> {
  const { db } = await import("./db.ts");
  const { data: me } = await db.from("profiles").select("id, moved_at").limit(1).maybeSingle();
  if (!me?.moved_at) throw new Error("Tabellar has not moved from here.");
  await db.from("profiles").update({ moved_at: null }).eq("id", me.id);
}
