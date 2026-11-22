// Keyboard shortcut definitions, shared by the global handler in AppShell and
// the help overlay so the two can never drift apart.

export type Shortcut = {
  keys: string;
  description: string;
};

export type ShortcutGroup = {
  title: string;
  shortcuts: Shortcut[];
};

// "g" then a second key jumps to a view, the convention Gmail and Linear both
// use. Keeping navigation behind a prefix leaves the single letters free for
// actions on the selected email.
export const GO_TO_VIEWS: Record<string, string> = {
  i: "inbox",
  b: "briefing",
  t: "todos",
  m: "meetings",
  s: "sent",
  d: "drafts",
  f: "followups",
  c: "categories",
  ",": "settings",
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: "g i", description: "Go to inbox" },
      { keys: "g b", description: "Go to briefing" },
      { keys: "g t", description: "Go to todos" },
      { keys: "g m", description: "Go to meetings" },
      { keys: "g s", description: "Go to sent" },
      { keys: "g d", description: "Go to drafts" },
      { keys: "g f", description: "Go to follow-ups" },
      { keys: "g c", description: "Go to categories" },
      { keys: "g ,", description: "Go to settings" },
    ],
  },
  {
    title: "Anywhere",
    shortcuts: [
      { keys: "c", description: "Compose a new email" },
      { keys: "/", description: "Focus search" },
      { keys: "?", description: "Toggle this help" },
      { keys: "Esc", description: "Close overlay, email, or search" },
    ],
  },
  {
    title: "Inbox",
    shortcuts: [
      { keys: "j", description: "Next email" },
      { keys: "k", description: "Previous email" },
      { keys: "r", description: "Reply to selected" },
      { keys: "e", description: "Archive selected" },
      { keys: "s", description: "Star or unstar selected" },
      { keys: "y", description: "Resolve or unresolve selected" },
      { keys: "u", description: "Mark selected unread" },
    ],
  },
];

// True when a keystroke belongs to whatever the user is typing into, so a
// shortcut handler can bow out rather than hijacking the key.
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}
