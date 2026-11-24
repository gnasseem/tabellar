// The menu bar item: the mark with the number of emails that need the user
// beside it, and a menu to open the window and to pause. macOS only. It is a
// small JavaScript for Automation script run by osascript, so there is
// nothing to install or compile.
//
// The server tells it what to show, a line of JSON on its stdin at a time, and
// it answers on stdout with the menu line that was chosen. When the server
// goes away its stdin closes and it goes too. profiles.menu_bar turns it off.

import { spawn, type ChildProcess } from "node:child_process";
import { db, changes, type Change } from "./db.ts";
import { needCount } from "./brief.ts";

const SCRIPT = `
ObjC.import("AppKit");
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
const say = (s) => stdout.writeData($(s + "\\n").dataUsingEncoding($.NSUTF8StringEncoding));

// The mark: a tablet across the top, two below it.
const mark = $.NSImage.alloc.initWithSize($.NSMakeSize(18, 18));
mark.lockFocus;
$.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(2, 2, 14, 14), 4, 4).addClip;
$.NSColor.blackColor.set;
$.NSBezierPath.fillRect($.NSMakeRect(2, 11, 14, 5));
$.NSBezierPath.fillRect($.NSMakeRect(2, 2, 6.25, 7.5));
$.NSBezierPath.fillRect($.NSMakeRect(9.75, 2, 6.25, 7.5));
mark.unlockFocus;
mark.setTemplate(true);

const item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
item.button.setImage(mark);
item.button.setImagePosition($.NSImageLeft);

let buffer = "";
function show(s) {
  item.button.setTitle(s.need ? " " + s.need : "");
  item.button.setToolTip("Tabellar");
  item.button.setAppearsDisabled(s.paused);
  const menu = $.NSMenu.alloc.init;
  menu.setAutoenablesItems(false);
  const add = (title, action) => {
    const line = menu.addItemWithTitleActionKeyEquivalent(title, action || null, "");
    if (action) line.setTarget(target);
    line.setEnabled(!!action);
  };
  add(s.need ? (s.need === 1 ? "1 email needs you" : s.need + " emails need you") : "Nothing needs you", s.need ? "open:" : "");
  menu.addItem($.NSMenuItem.separatorItem);
  add("Open Tabellar", "open:");
  add(s.paused ? "Resume" : "Pause", "pause:");
  item.setMenu(menu);
}

ObjC.registerSubclass({
  name: "TabellarMenuBar",
  superclass: "NSObject",
  methods: {
    "open:": { types: ["void", ["id"]], implementation: () => say("open") },
    "pause:": { types: ["void", ["id"]], implementation: () => say("pause") },
    "read:": {
      types: ["void", ["id"]],
      implementation: () => {
        const data = stdin.availableData;
        if (Number(data.length) === 0) return app.terminate(null);
        buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || "";
        const lines = buffer.split("\\n");
        buffer = lines.pop();
        const last = lines.filter(Boolean).pop();
        if (last) show(JSON.parse(last));
        stdin.waitForDataInBackgroundAndNotify;
      },
    },
  },
});
const target = $.TabellarMenuBar.alloc.init;
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(target, "read:", $.NSFileHandleDataAvailableNotification, stdin);
stdin.waitForDataInBackgroundAndNotify;
app.run;
`;

const WATCHED = new Set(["profiles", "draft_emails", "action_log", "meetings", "emails", "scheduled_emails"]);
const REFRESH_MS = 60_000;
const MAX_STARTS = 3; // it ends at once where there is no menu bar (no one logged in)

export function startMenuBar(open: () => void): () => void {
  if (process.platform !== "darwin") return () => {};
  let child: ChildProcess | null = null;
  let starts = 0;
  let shown = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    const c = child;
    child = null;
    shown = "";
    c?.stdin?.end();
    c?.kill();
  };

  const start = () => {
    starts++;
    const c = spawn("osascript", ["-l", "JavaScript", "-e", SCRIPT], { stdio: ["pipe", "pipe", "ignore"] });
    child = c;
    c.stdin!.on("error", () => {});
    c.on("error", () => {});
    c.on("exit", () => {
      if (child !== c) return;
      child = null;
      shown = "";
    });
    c.stdout!.setEncoding("utf8").on("data", (text: string) => {
      for (const line of text.split("\n")) {
        if (line === "open") open();
        else if (line === "pause") void togglePause();
      }
    });
  };

  const togglePause = async () => {
    const { data: me } = await db.from("profiles").select("id, engine_paused").limit(1).maybeSingle();
    if (me) await db.from("profiles").update({ engine_paused: !me.engine_paused }).eq("id", me.id);
  };

  const refresh = async () => {
    const { data: me } = await db.from("profiles").select("id, menu_bar, engine_paused, onboarding").limit(1).maybeSingle();
    if (!me || me.menu_bar === false || me.onboarding !== "done") {
      starts = 0;
      return stop();
    }
    if (!child && starts < MAX_STARTS) start();
    const state = JSON.stringify({ need: await needCount(me.id as string), paused: !!me.engine_paused });
    if (!child || state === shown) return;
    shown = state;
    child.stdin!.write(`${state}\n`);
  };

  // Soon after something it counts changes, and once a minute.
  let over = false;
  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (over) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh()
        .catch((e) => console.error("[menubar]", (e as Error).message))
        .finally(() => timer === undefined && schedule(REFRESH_MS));
    }, ms);
  };
  let soon = false;
  const onChange = (c: Change) => {
    if (soon || !WATCHED.has(c.table)) return;
    soon = true;
    setTimeout(() => {
      soon = false;
      schedule(0);
    }, 1000);
  };
  changes.on("change", onChange);
  schedule(0);

  return () => {
    over = true;
    changes.off("change", onChange);
    clearTimeout(timer);
    stop();
  };
}
