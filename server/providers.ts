// The mailboxes Tabellar can connect to, behind one interface.
//
// An account's `provider` names its implementation in MAILBOXES: Gmail
// (gmail.ts), Microsoft through Graph (microsoft.ts), or any IMAP and SMTP
// server (imap.ts). Everything that reads or changes a mailbox (sync, the
// outbox, actions, newsletters, drafts, the calendar routes) goes through
// mail(account), never through one provider's module.
//
// CHOICES is what the window and `tabellar setup` offer when adding an
// account: one row per choice, so a new one shows up everywhere. Several
// choices share the IMAP implementation with different servers.
//
// Mail is described in Gmail's terms, which the rest of Tabellar was written
// in: a message has an id, a thread id and label ids, among them INBOX,
// UNREAD, STARRED and SENT. Archiving is removing INBOX. Each provider maps
// these onto what it has (IMAP folders and flags, Outlook folders and
// categories).

import type { Account } from "./accounts.ts";
import type { CalendarEvent } from "./rules.ts";
import { googleClient, loadConfig } from "./config.ts";
import { db } from "./db.ts";
import { gmailMailbox } from "./gmail.ts";
import { imapMailbox } from "./imap.ts";
import { microsoftMailbox } from "./microsoft.ts";

export interface AttachmentInfo {
  filename: string;
  mime_type: string;
  size: number;
  attachment_id: string;
}

export interface EmailData {
  gmail_id: string;
  thread_id?: string;
  subject: string;
  sender: string;
  sender_email: string;
  recipients: string;
  snippet: string;
  body_text: string;
  body_html: string;
  received_at: string;
  is_read: boolean;
  label_ids: string[];
  has_attachments: boolean;
  attachments: AttachmentInfo[];
  has_list_unsubscribe: boolean;
  is_reply: boolean;
  reply_to_email?: string;
  cc_recipients?: string;
  precedence_header?: string;
  list_id?: string;
  is_calendar: boolean; // an invitation, an answer to one, a cancellation
  calendar_event: CalendarEvent | null; // its .ics, read
  receipt?: Receipt | null; // a read receipt: what it is about (receipts.ts)
  is_receipt?: boolean;
}

// The Message-ID of the sent email a read receipt is about, and who read it.
export type Receipt = { message_id: string; reader: string };

// Sent mail as Follow-ups, the Sent view and the style read keep it.
export type Sent = {
  id: string;
  thread_id: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  body_html: string;
  body: string;
  snippet: string;
  has_attachments: boolean;
  attachments: AttachmentInfo[];
};

// What the first read keeps of a message: who, when, where it sits, and the
// headers that tell a person from a mailing list.
export type HeaderRow = {
  gmail_id: string;
  thread_id: string;
  at: string;
  labels: string[];
  from: string;
  to: string;
  cc: string;
  list_unsubscribe: boolean;
  list_id: string;
  precedence: string;
};

export function headerRowOf(e: EmailData): HeaderRow {
  return {
    gmail_id: e.gmail_id,
    thread_id: e.thread_id ?? "",
    at: e.received_at,
    labels: e.label_ids,
    from: e.sender,
    to: e.recipients,
    cc: e.cc_recipients ?? "",
    list_unsubscribe: e.has_list_unsubscribe,
    list_id: e.list_id ?? "",
    precedence: e.precedence_header ?? "",
  };
}

// What changed in a mailbox since a cursor: messages that arrived, whether
// sent mail arrived, label changes in order, deleted messages. tooOld when
// the provider no longer has history that far back; the caller then starts
// over. A change with `exact` gives a message's whole label set (SENT aside).
export type LabelChange = { id: string; add: string[]; remove: string[]; exact?: boolean };
export interface MailboxChanges {
  tooOld: boolean;
  historyId: string | null; // the cursor to keep
  added: string[];
  sentAdded: boolean;
  labels: LabelChange[];
  deleted: string[];
}

export type Outgoing = {
  from?: string; // a From header ("Name" <address>); the mailbox's default when left out
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  inReplyTo?: string;
  root?: string; // the Message-ID that started the thread, where threads go by References (IMAP)
  attachments?: { name: string; contentType: string; data: string }[];
  receipt?: boolean; // ask for a read receipt, sent to the From address
};

// A draft in the mailbox's Drafts: the thread it is in, and something that
// changes whenever the draft does. And what it says.
export type DraftStub = { id: string; threadId: string; version: string };
export type DraftText = { text: string; html: string; subject: string; to: string; cc: string; bcc: string };

export type SendAs = { address: string; name: string; default: boolean };

// An event on the user's calendar, as an email is linked to it.
export type LinkedEvent = { id: string | null; title: string; start: string | null; end: string | null; all_day: boolean; link: string | null; on_calendar: boolean; method?: string };

export type CalEvent = {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  attendees: string[]; // the other people, by name where there is one
  people: string[]; // their addresses
  location: string | null;
  meetingLink: string | null;
  htmlLink: string | null;
  status: string;
  source: string;
};

// Times as ISO date-times; with timeZone, a wall-clock time in that zone.
export type NewEvent = { title?: string; description?: string; start?: string; end?: string; timeZone?: string; location?: string; attendees?: string[] };

export type Calendar = {
  busy(a: Box, from: Date, to: Date): Promise<{ start: string; end: string }[]>;
  events(a: Box, from: Date, to: Date, max: number): Promise<CalEvent[]>;
  create(a: Box, e: NewEvent, invite: boolean): Promise<{ id: string; link: string | null }>;
  update(a: Box, id: string, e: NewEvent, invite: boolean): Promise<{ id: string; link: string | null }>;
  // Takes back an event just made here; with invite, the people on it are told.
  cancel(a: Box, id: string, invite: boolean): Promise<void>;
  // Is this event already on the calendar? By iCalendar UID, else an event
  // a day either side that starts then or has one of `people` on it.
  find(a: Box, q: { uid?: string; start?: string | null; people?: string[] }): Promise<LinkedEvent | null>;
};

export type Box = Pick<Account, "id" | "user_id" | "address" | "token_ref" | "history_id" | "server">;

export type Mail = {
  // Where the mailbox's changes stand now, kept in accounts.history_id.
  cursor(a: Box): Promise<string>;
  changes(a: Box, cursor: string): Promise<MailboxChanges>;
  // Has anything changed since a.history_id? Asked every few seconds.
  moved(a: Box): Promise<boolean>;
  // Ids of messages of the last `days` days (all of them without), newest
  // first: in the inbox, or anywhere but drafts and trash.
  list(a: Box, q: { days?: number; cap: number; inbox: boolean }): Promise<string[]>;
  fetch(a: Box, ids: string[]): Promise<EmailData[]>;
  headerRows(a: Box, ids: string[]): Promise<HeaderRow[]>;
  sent(a: Box, max: number): Promise<Sent[]>;
  // A few headers of one message, keyed by lower-case name.
  headers(a: Box, id: string, names: string[]): Promise<Record<string, string>>;
  threadOf(a: Box, id: string): Promise<string>;
  send(a: Box, m: Outgoing, threadId?: string): Promise<{ id: string }>;
  // Every draft in the mailbox's Drafts, and one of them in full (null when it
  // is no longer there).
  drafts(a: Box): Promise<DraftStub[]>;
  readDraft(a: Box, draftId: string): Promise<DraftText | null>;
  // Put a draft in the mailbox's Drafts, replacing `draftId`. Returns its id.
  saveDraft(a: Box, draftId: string | null, m: Outgoing, threadId?: string): Promise<string>;
  // Take one draft out of Drafts: only a draft, and only one whose id
  // saveDraft returned (drafts.ts). One already gone is fine.
  discardDraft(a: Box, draftId: string): Promise<void>;
  // Send a draft that is in Drafts, with its final text; it leaves Drafts.
  sendDraft(a: Box, draftId: string, m: Outgoing, threadId?: string): Promise<{ id: string }>;
  // The id of the label with this name, made when missing.
  label(a: Box, name: string): Promise<string>;
  labelNames(a: Box): Promise<string[]>;
  // Add and remove label ids (INBOX, UNREAD, STARRED or a label's id).
  modify(a: Box, ids: string[], add: string[], remove: string[]): Promise<void>;
  sendAs(a: Box): Promise<SendAs[]>;
  hasSentTo(a: Box, address: string): Promise<boolean>;
  // Ids of messages with attachments that match a search, newest first.
  files?(a: Box, q: { text: string; from: string }, cap: number): Promise<string[]>;
  // An attachment as base64url.
  attachment(a: Box, id: string, attachmentId: string): Promise<{ data: string; size: number } | null>;
  contacts?(a: Box): Promise<{ email: string; name: string }[]>;
  // Call `wake` when the mailbox changes, for providers that can push.
  watch?(a: Box, wake: () => void): void;
  // Forget the account's sign-in on this Mac.
  disconnect(a: Box): Promise<void>;
  calendar?: Calendar;
};

// `tabellar check` adds a recorder. The three are filled in on first use, as
// their modules import ones that import this one.
export const MAILBOXES: Record<string, Mail> = {};
function registry(): Record<string, Mail> {
  MAILBOXES.gmail ??= gmailMailbox;
  MAILBOXES.imap ??= imapMailbox;
  MAILBOXES.microsoft ??= microsoftMailbox;
  return MAILBOXES;
}

export function mail(a: { provider?: string | null }): Mail {
  const m = registry()[a.provider || "gmail"];
  if (!m) throw new Error(`Tabellar cannot reach ${a.provider} mailboxes`);
  return m;
}

// The calendar Tabellar uses: the default account's, else the first
// account that has one. IMAP mailboxes have none.
export function calendarAccount(accounts: Account[]): { account: Account; calendar: Calendar } | null {
  const ordered = [...accounts.filter((a) => a.is_default), ...accounts.filter((a) => !a.is_default)];
  for (const account of ordered) {
    const calendar = registry()[account.provider || "gmail"]?.calendar;
    if (calendar) return { account, calendar };
  }
  return null;
}

// The user's calendar, and whether new events invite their guests
// (profiles.calendar_send_invites).
export async function userCalendar(userId: string): Promise<{ account: Account; calendar: Calendar; invite: boolean } | null> {
  const [{ data: accounts }, { data: profile }] = await Promise.all([
    db.from("accounts").select("*").eq("user_id", userId).order("created_at", { ascending: true }),
    db.from("profiles").select("calendar_send_invites").eq("id", userId).maybeSingle(),
  ]);
  const found = calendarAccount((accounts ?? []) as unknown as Account[]);
  return found ? { ...found, invite: profile?.calendar_send_invites !== false } : null;
}

// ── Choices for adding an account ───────────────────────────────────────────

type Server = { host: string; port: number };
export type Choice = {
  id: string;
  name: string;
  provider: "gmail" | "microsoft" | "imap";
  imap?: Server;
  smtp?: Server;
  passwordUrl?: string; // where the provider makes app passwords
  calendar: boolean;
};

export const CHOICES: Choice[] = [
  { id: "gmail", name: "Google", provider: "gmail", calendar: true },
  { id: "microsoft", name: "Outlook", provider: "microsoft", calendar: true },
  {
    id: "icloud", name: "iCloud", provider: "imap", calendar: false,
    imap: { host: "imap.mail.me.com", port: 993 }, smtp: { host: "smtp.mail.me.com", port: 587 },
    passwordUrl: "https://account.apple.com/account/manage",
  },
  {
    id: "fastmail", name: "Fastmail", provider: "imap", calendar: false,
    imap: { host: "imap.fastmail.com", port: 993 }, smtp: { host: "smtp.fastmail.com", port: 465 },
    passwordUrl: "https://app.fastmail.com/settings/security/apps",
  },
  {
    id: "yahoo", name: "Yahoo", provider: "imap", calendar: false,
    imap: { host: "imap.mail.yahoo.com", port: 993 }, smtp: { host: "smtp.mail.yahoo.com", port: 465 },
    passwordUrl: "https://login.yahoo.com/account/security/app-passwords",
  },
  {
    id: "gmail-password", name: "Gmail", provider: "imap", calendar: false,
    imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 },
    passwordUrl: "https://myaccount.google.com/apppasswords",
  },
  {
    id: "aol", name: "AOL", provider: "imap", calendar: false,
    imap: { host: "imap.aol.com", port: 993 }, smtp: { host: "smtp.aol.com", port: 465 },
    passwordUrl: "https://login.aol.com/account/security/app-passwords",
  },
  {
    id: "zoho", name: "Zoho", provider: "imap", calendar: false,
    imap: { host: "imap.zoho.com", port: 993 }, smtp: { host: "smtp.zoho.com", port: 465 },
    passwordUrl: "https://accounts.zoho.com/home#security/app_password",
  },
  {
    id: "gmx", name: "GMX", provider: "imap", calendar: false,
    imap: { host: "imap.gmx.com", port: 993 }, smtp: { host: "mail.gmx.com", port: 465 },
    passwordUrl: "https://support.gmx.com/security/2fa/application-specific-passwords.html",
  },
  { id: "imap", name: "Other", provider: "imap", calendar: false },
];

// Whether a choice can be used now: Google with a client, Microsoft once an
// app is registered (config.json microsoftClientId).
export function choicesForWindow() {
  const config = loadConfig();
  return CHOICES.map((c) => ({
    ...c,
    ready: c.provider === "gmail" ? !!googleClient() : c.provider === "microsoft" ? !!config.microsoftClientId : true,
  }));
}
