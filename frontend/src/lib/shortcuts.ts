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
  r: "replies",
  a: "activity",
  f: "followups",
  c: "categories",
  ",": "settings",
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: "g i", description: "Go to inbox" },
      { keys: "g b", description: "Go to brief" },
      { keys: "g t", description: "Go to todos" },
      { keys: "g m", description: "Go to meetings" },
      { keys: "g s", description: "Go to sent" },
      { keys: "g r", description: "Go to replies" },
      { keys: "g a", description: "Go to history" },
      { keys: "g f", description: "Go to follow-ups" },
      { keys: "g c", description: "Go to labels" },
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
      { keys: "x", description: "Select (Shift for a range)" },
      { keys: "Space", description: "Show or hide details" },
      { keys: "Enter", description: "Do what the email is waiting for" },
      { keys: "o", description: "Open the email" },
      { keys: "a", description: "Approve" },
      { keys: "e", description: "Archive" },
      { keys: "r", description: "Reply" },
      { keys: "u", description: "Mark unread" },
      { keys: "z", description: "Undo the last change" },
    ],
  },
  {
    title: "Replies",
    shortcuts: [
      { keys: "j", description: "Next reply" },
      { keys: "k", description: "Previous reply" },
      { keys: "x", description: "Select (Shift for a range)" },
      { keys: "Cmd Enter", description: "Send" },
      { keys: "e", description: "Edit" },
      { keys: "Backspace", description: "Discard" },
    ],
  },
  {
    title: "Todos",
    shortcuts: [
      { keys: "j k", description: "Move" },
      { keys: "Space", description: "Done, reopen, or add a suggested one" },
      { keys: "n", description: "New todo" },
      { keys: "Backspace", description: "Delete one you added" },
    ],
  },
  {
    title: "Meetings",
    shortcuts: [
      { keys: "j k", description: "Move" },
      { keys: "Enter", description: "Add to calendar" },
      { keys: "e", description: "Change time" },
      { keys: "n", description: "New meeting" },
    ],
  },
  {
    title: "Follow-ups",
    shortcuts: [
      { keys: "j k", description: "Move" },
      { keys: "Enter", description: "Nudge" },
      { keys: "l", description: "Later" },
    ],
  },
  {
    title: "Newsletters",
    shortcuts: [
      { keys: "j k", description: "Move" },
      { keys: "x", description: "Select" },
      { keys: "u", description: "Unsubscribe" },
      { keys: "e", description: "Archive all" },
      { keys: "y", description: "Keep" },
      { keys: "z", description: "Undo archive" },
    ],
  },
  {
    title: "Sent and Scheduled",
    shortcuts: [
      { keys: "j k", description: "Move" },
      { keys: "Enter", description: "Open" },
      { keys: "e", description: "Edit scheduled mail" },
      { keys: "Backspace", description: "Cancel scheduled mail" },
    ],
  },
  {
    title: "History",
    shortcuts: [
      { keys: "j k", description: "Move" },
      { keys: "x", description: "Select" },
      { keys: "a", description: "Approve" },
      { keys: "Enter", description: "Details" },
      { keys: "z", description: "Undo approval" },
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
