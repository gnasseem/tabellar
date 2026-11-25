// Starting Tabellar on its own and keeping it running: at login on a Mac,
// through a launchd agent in ~/Library/LaunchAgents, and with the machine on
// Linux, through a systemd user service. Either restarts the server if it
// crashes, but not after a clean exit, so `tabellar autostart off` and a
// deliberate stop stay stopped.

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_HOME, ENV_FILE, HOME, MAC, sibling } from "./config.ts";

const LABEL = "com.tabellar.server";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT = join(homedir(), ".config", "systemd", "user", "tabellar.service");
const CLI = sibling("tabellar");

// Node by a path that survives an update. Homebrew's own path names the
// version (/opt/homebrew/Cellar/node/25.8.1/bin/node) and is deleted with it;
// the link in its bin folder stays.
function nodePath(): string {
  for (const link of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try {
      if (realpathSync(link) === realpathSync(process.execPath)) return link;
    } catch {
      // not there
    }
  }
  return process.execPath;
}
const DOMAIN = `gui/${userInfo().uid}`;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function autostartInstalled(): boolean {
  return existsSync(MAC ? PLIST : UNIT);
}

// Whether what starts on its own is this data folder's.
export function autostartHere(): boolean {
  if (!autostartInstalled()) return false;
  const file = MAC ? PLIST : ENV_FILE;
  const set = (existsSync(file) ? readFileSync(file, "utf8") : "").match(MAC ? /<key>TABELLAR_HOME<\/key><string>(.*?)<\/string>/ : /^TABELLAR_HOME='(.*)'$/m)?.[1];
  return HOME === (set ?? DEFAULT_HOME) || xml(HOME) === set;
}

// The launch agent's property list.
export function autostartPlist(): string {
  const env: Record<string, string> = {
    // launchd starts with a bare PATH; osascript, security and Ollama live here.
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
  };
  for (const name of ["TABELLAR_HOME", "TABELLAR_PASSPHRASE"]) if (process.env[name]) env[name] = process.env[name]!;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath())}</string>
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
}

// The systemd unit. What it needs to know is in ENV_FILE.
export function autostartUnit(): string {
  const arg = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
  return `[Unit]
Description=Tabellar
After=network-online.target

[Service]
ExecStart=${arg(process.execPath)} ${arg(CLI)} serve
EnvironmentFile=-%h/.config/tabellar.env
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

// In single quotes, systemd and Node read a value the same way, as it is.
export function environmentFile(env: Record<string, string | undefined>): string {
  return ["TABELLAR_PASSPHRASE", "TABELLAR_HOME", "TZ"]
    .filter((name) => env[name])
    .map((name) => {
      if (/['\r\n]/.test(env[name]!)) throw new Error(`${name} cannot contain a single quote or a line break.`);
      return `${name}='${env[name]}'\n`;
    })
    .join("");
}

function installUnit(): void {
  const run = (...args: string[]) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (run("show-environment").status !== 0) throw new Error("There is no systemd here to start Tabellar. In a container, let its restart policy keep `tabellar serve` running.");
  mkdirSync(dirname(UNIT), { recursive: true });
  writeFileSync(ENV_FILE, environmentFile(process.env), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  writeFileSync(UNIT, autostartUnit());
  run("daemon-reload");
  const r = run("enable", "--now", "tabellar.service");
  if (r.status !== 0) throw new Error(`systemctl could not start Tabellar: ${r.stderr.trim() || r.status}`);
  // Without this a user's services end when they log out.
  if (spawnSync("loginctl", ["enable-linger"]).status !== 0) throw new Error("Tabellar runs, but would stop when you log out. Run: sudo loginctl enable-linger $USER");
}

export function installAutostart(): void {
  if (!MAC) return installUnit();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(PLIST, autostartPlist(), { mode: 0o600 });
  chmodSync(PLIST, 0o600);
  spawnSync("launchctl", ["bootout", `${DOMAIN}/${LABEL}`], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["bootstrap", DOMAIN, PLIST], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`launchctl could not load the login item: ${r.stderr.trim() || r.status}`);
}

// Unloading the agent stops the server it started, which may be the very
// process handling this request, so the unload waits a moment for the reply
// to go out.
export function removeAutostart(): void {
  if (!MAC) {
    spawnSync("systemctl", ["--user", "disable", "--now", "tabellar.service"], { stdio: "ignore" });
    if (existsSync(UNIT)) unlinkSync(UNIT);
    return;
  }
  if (existsSync(PLIST)) unlinkSync(PLIST);
  setTimeout(() => spawnSync("launchctl", ["bootout", `${DOMAIN}/${LABEL}`], { stdio: "ignore" }), 500);
}
