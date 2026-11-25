// Where this Tabellar is: the machine and the data folder. A mailbox has one
// engine, so a data folder found somewhere else than where it was last started
// is a copy (pauseIfCopied), and one data folder is run by one process.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOME, MAC } from "./config.ts";

// What tells this machine from another. A container is made anew at each
// update, so there it is only the folder.
function machine(): string {
  try {
    if (MAC) return spawnSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" }).stdout.match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? "";
    if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return "";
    return readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    return "";
  }
}

let here: string | undefined;
export const place = (): string => (here ??= `${machine()} ${HOME}`.trim());

// Held by the process that runs on this data folder for as long as it lives. A
// database lock, so it is gone with the process however that ended, and also
// seen by another container on the same volume.
let held: DatabaseSync | null = null;
export function lock(): boolean {
  if (held) return true;
  const d = new DatabaseSync(join(HOME, "lock"));
  try {
    d.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    held = d;
    return true;
  } catch {
    d.close();
    return false;
  }
}
export function unlock(): void {
  held?.close();
  held = null;
}
