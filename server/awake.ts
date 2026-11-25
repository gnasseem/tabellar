// Being away (asleep, off, without a network) and coming back.
//
// A timer that did not run for a minute means the machine slept. What fell due
// meanwhile waits until the mailbox was read again: an Autopilot reply the user
// already gave from their phone does not go out, and the Brief and the
// automations that run at a time are about this morning's mail. When a mailbox
// answered last is kept, so the next time one does tells how long Tabellar was
// away, across a restart too; the Brief says it.
//
// Also keeps the Mac awake while it is plugged in, for who asked for that.

import { spawn, type ChildProcess } from "node:child_process";
import { changes, db, type Change } from "./db.ts";
import { MAC } from "./config.ts";

const SLEPT_MS = 60_000;
const AWAY_MS = 3600_000; // shorter is not worth a word
const BLINK_MS = 30 * 60_000; // a sleeping Mac wakes for a moment now and then
const HOLD_MS = 30 * 60_000; // what is due waits this long for mail at most
const KEEP_EVERY_MS = 5 * 60_000;

let wokeAt = 0;
let beaten = 0;
const listeners = new Set<() => void>();
export function onWake(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

// Called first by everything that runs on a timer.
export function beat(): void {
  const now = Date.now();
  const slept = beaten > 0 && now - beaten > SLEPT_MS;
  beaten = now;
  if (slept) {
    woke();
    for (const f of listeners) f();
  }
}

// The server started, or the machine is awake again.
export function woke(): void {
  wokeAt = Date.now();
}

export const sinceWoke = () => Date.now() - wokeAt;

// When each mailbox was last brought in.
const syncedAt = new Map<string, number>();
export const caughtUp = (accountId: string) => (syncedAt.get(accountId) ?? 0) >= wokeAt;
export const anyCaughtUp = () => !wokeAt || [...syncedAt.values()].some((at) => at >= wokeAt);

// Whether something that fell due while away still waits for this mailbox.
export const waitsForMail = (accountId: string | null | undefined, dueAt: string) => !!accountId && Date.parse(dueAt) < wokeAt && !caughtUp(accountId) && sinceWoke() < HOLD_MS;

// A mailbox answered; `synced`: all that is in it is stored here.
const answeredAt = new Map<string, number>();
const keptAt = new Map<string, number>();
export async function answered(a: { id: string; user_id: string }, synced = false, now = Date.now()): Promise<void> {
  if (synced) syncedAt.set(a.id, now);
  const first = !answeredAt.size;
  let last = Math.max(0, ...answeredAt.values());
  answeredAt.set(a.id, now);
  if (first) {
    const { data } = await db.from("accounts").select("synced_at").eq("user_id", a.user_id);
    last = Math.max(0, ...(data ?? []).map((r) => Date.parse(String(r.synced_at ?? "")) || 0));
  }
  if (last && now - last > AWAY_MS) {
    const { data: me } = await db.from("profiles").select("away").eq("id", a.user_id).maybeSingle();
    const before = me?.away as Away | null;
    const from = before && last - Date.parse(before.to) < BLINK_MS ? before.from : new Date(last).toISOString();
    await db.from("profiles").update({ away: { from, to: new Date(now).toISOString() } }).eq("id", a.user_id);
  }
  if (synced && now - (keptAt.get(a.id) ?? 0) > KEEP_EVERY_MS) {
    keptAt.set(a.id, now);
    await db.from("accounts").update({ synced_at: new Date(now).toISOString() }).eq("id", a.id);
  }
}

export type Away = { from: string; to: string };

// ── Keeping awake ───────────────────────────────────────────────────────────

// `caffeinate -s` holds only on power, and -w ends it with this process.
export function startKeepAwake(): () => void {
  if (!MAC) return () => {};
  let child: ChildProcess | null = null;
  let over = false;
  const refresh = async () => {
    const { data: me } = await db.from("profiles").select("keep_awake, engine_paused").limit(1).maybeSingle();
    const on = !over && !!me?.keep_awake && !me.engine_paused;
    if (on && !child) {
      const c = (child = spawn("caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" }));
      c.on("error", () => {});
      c.on("exit", () => child === c && (child = null));
    } else if (!on && child) {
      child.kill();
      child = null;
    }
  };
  const look = () => void refresh().catch((e) => console.error("[awake]", (e as Error).message));
  const onChange = (c: Change) => c.table === "profiles" && look();
  changes.on("change", onChange);
  look();
  return () => {
    over = true;
    changes.off("change", onChange);
    child?.kill();
  };
}
