// Telling the user something happened. One small interface with a list of
// channels; macOS Notification Center is the first, and another channel can be
// added to CHANNELS without touching the callers.

import { spawn } from "node:child_process";

export type Note = { title: string; subtitle?: string; body: string };

type Channel = (n: Note) => void;

// Title and text are passed as arguments to an AppleScript run handler, never
// spliced into the script, so nothing in an email can inject AppleScript.
const macos: Channel = (n) => {
  if (process.platform !== "darwin") return;
  const script = [
    "on run argv",
    "display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)",
    "end run",
  ];
  const args = script.flatMap((l) => ["-e", l]);
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const child = spawn("osascript", [...args, clip(n.title, 80), clip(n.subtitle ?? "", 100), clip(n.body, 240)], { stdio: "ignore" });
  child.on("error", () => {});
};

const CHANNELS: Channel[] = [macos];

export function notify(n: Note): void {
  for (const send of CHANNELS) {
    try {
      send(n);
    } catch (e) {
      console.error("[notify]", e);
    }
  }
}
