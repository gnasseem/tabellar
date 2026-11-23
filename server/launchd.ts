// Starting Tabellar at login and keeping it running, through a launchd agent
// in ~/Library/LaunchAgents. launchd restarts the server if it crashes, but
// not after a clean exit, so `tabellar autostart off` and a deliberate stop
// stay stopped.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HOME, sibling } from "./config.ts";

const LABEL = "com.tabellar.server";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const CLI = sibling("tabellar");
const DOMAIN = `gui/${userInfo().uid}`;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function autostartInstalled(): boolean {
  return existsSync(PLIST);
}

export function installAutostart(): void {
  const env: Record<string, string> = {
    // launchd starts with a bare PATH; osascript, security and Ollama live here.
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
  };
  if (process.env.TABELLAR_HOME) env.TABELLAR_HOME = process.env.TABELLAR_HOME;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(CLI)}</string>
    <string>start</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(HOME, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(HOME, "server.log"))}</string>
</dict>
</plist>
`;
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(PLIST, plist);
  spawnSync("launchctl", ["bootout", `${DOMAIN}/${LABEL}`], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["bootstrap", DOMAIN, PLIST], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`launchctl could not load the login item: ${r.stderr.trim() || r.status}`);
}

// Unloading the agent stops the server it started, which may be the very
// process handling this request, so the unload waits a moment for the reply
// to go out.
export function removeAutostart(): void {
  if (existsSync(PLIST)) unlinkSync(PLIST);
  setTimeout(() => spawnSync("launchctl", ["bootout", `${DOMAIN}/${LABEL}`], { stdio: "ignore" }), 500);
}
