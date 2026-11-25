// The local database: one SQLite file, plus the executor that runs the
// supabase-js style queries recorded by query.ts.
//
// Column types are Tabellar's own: uuid, text, int, real, bool, json, time.
// Booleans are stored as 0/1, json (Postgres jsonb and text[] before) as JSON
// text, times as ISO-8601 UTC strings so they sort and compare as text.
// Defaults are filled in here on insert rather than by SQLite, so they get the
// same encoding as everything else.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Query, type QuerySpec, type Result, type Filter } from "./query.ts";
import { DB_PATH } from "./config.ts";

type ColType = "uuid" | "text" | "int" | "real" | "bool" | "json" | "time";
type Col = { name: string; type: ColType; pk: boolean; notnull: boolean; def?: unknown; ref?: string; onDelete?: string };
type Table = { name: string; cols: Map<string, Col>; unique: string[][] };

// Column spec: "<type> [pk] [!] [=default] [>table[:cascade|:null]]"
//   !  not null      =now  current time      =uuid  random id      =<json literal>
const SCHEMA: Record<string, { cols: Record<string, string>; unique?: string[][] }> = {
  profiles: {
    cols: {
      id: "uuid pk", email: "text", display_name: "text", avatar_url: "text",
      theme: 'text ! ="auto"', appearance: "json ! ={}", working_hours: "json",
      calendar_send_invites: "bool ! =true",
      // vip, needs or none (notify.ts); quiet outside the working hours.
      notification_level: 'text ! ="needs"', notification_preview: "bool ! =true", notification_quiet: "bool ! =false",
      // The Brief's settings and the paragraph written for today (brief.ts).
      brief: "json ! ={}", brief_summary: "json", brief_told: "text",
      // Before a meeting (prep.ts): whether to tell, and the events told about.
      notify_meetings: "bool ! =true", meetings_told: "json ! =[]",
      menu_bar: "bool ! =true",
      // Awake while plugged in, and the last time away, {from, to} (awake.ts).
      keep_awake: "bool ! =false", away: "json",
      // Reply drafts Tabellar makes are also in the mailbox's own Drafts (drafts.ts).
      mailbox_drafts: "bool ! =true",
      autonomy_level: 'text ! ="suggest"', engine_paused: "bool ! =false",
      autopilot_delay_min: "int ! =5", autopilot_daily_cap: "int ! =5", autopilot_known_only: "bool ! =true",
      first_read: "json", rules_version: "int ! =0", label_suggestions: "json",
      // The first-run step the window is on (onboarding.ts); "done" after it.
      onboarding: 'text ! ="done"',
      // The day the line on drafts sent unchanged was shown, "done" once answered (brief.ts).
      proof: "text",
      // Where this database was last started from (pauseIfCopied), and when it
      // moved elsewhere (move.ts).
      home: "text", moved_at: "time",
      created_at: "time ! =now", updated_at: "time ! =now",
    },
  },
  // One row per connected mailbox. provider names its implementation
  // (providers.ts); token_ref is the Keychain item with its sign-in or app
  // password; server holds an IMAP account's servers and user name. send_as
  // is the addresses it can send from ({address, name, default}); default_from
  // is the user's pick among them. See accounts.ts.
  accounts: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", provider: 'text ! ="gmail"', address: "text !", token_ref: "text !",
      history_id: "text", server: "json", send_as: "json ! =[]", send_as_at: "time", default_from: "text",
      is_default: "bool ! =false", paused: "bool ! =false", read_at: "time",
      // When its mail was last brought in (awake.ts).
      synced_at: "time", created_at: "time ! =now",
    },
    unique: [["user_id", "address"]],
  },
  emails: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", gmail_id: "text !", thread_id: "text",
      account_id: "uuid >accounts:cascade",
      subject: "text", sender: "text", sender_email: "text", recipients: "text",
      snippet: "text", body_text: "text", body_html: "text", received_at: "time",
      is_read: "bool ! =false", is_starred: "bool ! =false", is_archived: "bool ! =false",
      // Snoozed (snooze.ts): hidden until snooze_until, or until an answer
      // when that is empty. Once back, snooze_until is when it came back.
      is_snoozed: "bool ! =false", snooze_until: "time", label_ids: "json",
      has_attachments: "bool ! =false", attachments: "json ! =[]",
      has_list_unsubscribe: "bool ! =false", is_reply: "bool ! =false",
      reply_to_email: "text", cc_recipients: "text", precedence_header: "text", list_id: "text",
      is_calendar: "bool ! =false", calendar_event: "json", awaits_reply: "bool",
      // Sent mail that asked for a read receipt, and when it was read; mail
      // that is such a receipt (receipts.ts).
      receipt_asked: "bool ! =false", seen_at: "time", is_receipt: "bool ! =false",
      resolved_at: "time", created_at: "time ! =now",
    },
    unique: [["user_id", "gmail_id"]],
  },
  email_processed: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", email_id: "uuid ! >emails:cascade",
      category: 'text ! ="updates"', extra_labels: "json", summary: "text", urgency: "text",
      quick_actions: "json =[]", calendar: "json", processed_at: "time ! =now", engine_at: "time",
      brief: "text", // "first" in the Brief or "out" of it, by an automation
    },
    unique: [["email_id"]],
  },
  // The user's own labels: see labels.ts.
  categories: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", slug: "text !", display_name: "text !",
      color: 'text ="#8a857d"', description: 'text =""', examples: "json ! =[]",
      position: "int ! =0", gmail_label: "text", created_at: "time ! =now",
      // Made by an automation: until the user describes it, only that applies it.
      automatic: "bool ! =true",
    },
    unique: [["user_id", "slug"]],
  },
  todos: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", email_id: "uuid >emails:null", text: "text !",
      is_completed: "bool ! =false", source: 'text ="manual"', created_at: "time ! =now",
      due: "text", // "YYYY-MM-DD", when the email gave a day
    },
  },
  scheduled_emails: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", account_id: "uuid ! >accounts:cascade",
      to_addresses: "json !", cc_addresses: "json", bcc_addresses: "json", subject: "text !",
      from_address: "text", body_html: "text !", body_text: "text", in_reply_to: "text", thread_id: "text",
      send_at: "time !", status: 'text ! ="pending"', error_message: "text", created_at: "time ! =now",
      // "autopilot" rows are Tabellar's own replies, re-checked when they fall due.
      // One with an automation_id hands an email on.
      source: 'text ! ="user"', email_id: "uuid >emails:null", action_id: "uuid", automation_id: "uuid",
      gmail_draft_id: "text", // sent through Gmail's Drafts, which it then leaves
      // A forwarded email and the attachments left out: {email_id, without} (forward.ts).
      forward: "json", read_receipt: "bool ! =false",
      draft: "json", // the draft it was made from, put back when it is undone (drafts.ts)
    },
  },
  // Senders the user dealt with in Newsletters: kept, or unsubscribed from.
  newsletter_senders: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", sender_email: "text !", status: "text !",
      method: "text", created_at: "time ! =now", updated_at: "time ! =now",
    },
    unique: [["user_id", "sender_email"]],
  },
  meetings: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", email_id: "uuid >emails:null", title: "text !",
      description: "text", start_time: "time !", end_time: "time !", attendees: "json",
      location: "text", as_written: "text", quote: "text", calendar_event_id: "text", status: 'text ="proposed"', created_at: "time ! =now",
    },
  },
  email_memory: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", sender_email: "text !", sender_name: "text",
      interaction_count: "int ! =1", last_subject: "text", last_interaction_at: "time ! =now",
      relationship_notes: "text", avg_response_time: "real", created_at: "time ! =now",
    },
    unique: [["user_id", "sender_email"]],
  },
  contacts: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", account_id: "uuid >accounts:cascade",
      email: "text !", name: "text", source: "text", created_at: "time ! =now", updated_at: "time ! =now",
    },
    unique: [["user_id", "email"]],
  },
  email_templates: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", name: "text !", subject: "text", body_html: "text !",
      created_at: "time ! =now", updated_at: "time ! =now",
    },
  },
  knowledge_base: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", entity: "text !", entity_type: "text !", info: "text !",
      source: "text", confidence: "real =0.5", importance: 'text ! ="normal"', use_count: "int ! =0",
      last_used_at: "time", created_at: "time ! =now", updated_at: "time ! =now",
    },
    unique: [["user_id", "entity", "entity_type"]],
  },
  // How the user writes: see writing.ts.
  style_profiles: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", greeting_style: "text", closing_style: "text",
      tone: "text", avg_length: "text", kinds: "json ! ={}", avoid: "json ! =[]",
      edited: "json ! =[]", edits: "json ! =[]", sample_count: "int ! =0",
      last_learned_at: "time", created_at: "time ! =now", updated_at: "time ! =now",
    },
    unique: [["user_id"]],
  },
  draft_emails: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", account_id: "uuid >accounts:cascade", from_address: "text",
      to_addresses: "json ! =[]", subject: "text", body_html: "text", email_id: "uuid >emails:null", source: "text",
      cc_addresses: "json", bcc_addresses: "json",
      // The same draft in the mailbox's Drafts, how it stood there when last
      // looked at, and when the user changed it, here or there (drafts.ts).
      gmail_draft_id: "text", mailbox_version: "text", edited_at: "time",
      forward: "json", read_receipt: "bool ! =false",
      created_at: "time ! =now",
    },
  },
  // The headers of every message the first read and later syncs saw, inbox
  // and sent, and what they add up to per address. See senders.ts.
  mail_index: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", account_id: "uuid >accounts:cascade",
      gmail_id: "text !", thread_id: "text", at: "time !", from_addr: "text", from_name: "text",
      to_addrs: "json ! =[]", sent: "bool ! =false", inbox: "bool ! =false", unread: "bool ! =false",
      category: "text", list_unsubscribe: "bool ! =false", list_id: "text", precedence: "text",
    },
    unique: [["user_id", "gmail_id"]],
  },
  senders: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", address: "text !", name: "text", domain: "text",
      received: "int ! =0", opened: "int ! =0", replied: "int ! =0", wrote_first: "int ! =0",
      sent_to: "int ! =0", archived_unread: "int ! =0", list_unsubscribe: "bool ! =false",
      list_id: "text", precedence: "text", category: "text", first_at: "time", last_at: "time",
      updated_at: "time ! =now",
    },
    unique: [["user_id", "address"]],
  },
  // What Tabellar knows about the user, and the questions it asks instead of
  // guessing. See profile.ts.
  preferences: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", kind: "text !", subject: 'text ! =""', value: "text !",
      source: 'text ! ="user"', evidence: "text", created_at: "time ! =now", updated_at: "time ! =now",
    },
    unique: [["user_id", "kind", "subject", "value"]],
  },
  questions: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", text: "text !", detail: "text", options: "json ! =[]",
      about: "text !", email_id: "uuid >emails:null", status: 'text ! ="open"', answer: "text",
      created_at: "time ! =now", answered_at: "time",
    },
  },
  // What the user told Tabellar to do from now on, in one sentence each: see
  // automations.ts. spec is what the sentence was read as, trial what it would
  // have matched, state when it last ran and what it was told about, digest the
  // mail it last put in the Brief.
  automations: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", text: "text !", spec: "json ! ={}", mode: 'text ! ="own"',
      enabled: "bool ! =false", enabled_at: "time", tried_at: "time", trial: "json",
      runs: "int ! =0", last_run: "time", undone: "int ! =0", state: "json ! ={}", digest: "json",
      source: 'text ! ="user"', created_at: "time ! =now",
    },
  },
  // Everything Tabellar does or proposes on its own, and what the agent and
  // assistant do for the user. See policy.ts and actions.ts.
  action_log: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", kind: "text !", status: "text !", source: "text !",
      email_id: "uuid >emails:null", summary: "text !", detail: "json ! ={}", hash: "text",
      reason: "text", error: "text", created_at: "time ! =now", decided_at: "time", undone_at: "time",
      automation_id: "uuid >automations:null",
    },
  },
  email_signatures: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", account_id: "uuid >accounts:cascade",
      name: "text !", html: 'text ! =""', is_default: "bool ! =false", created_at: "time ! =now",
    },
  },
  follow_up_reminders: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", email_id: "uuid >emails:cascade", thread_id: "text !",
      recipient_email: "text !", recipient_name: "text", subject: "text !", remind_at: "time !",
      status: 'text ! ="waiting"', snooze_until: "time", created_at: "time ! =now",
    },
    unique: [["user_id", "thread_id"]],
  },
  // The user's own Telegram bot and the one chat it talks to (telegram.ts):
  // the code that pairs them, the next update to read, and the messages whose
  // buttons still answer something. The bot's token is in the Keychain.
  telegram: {
    cols: {
      user_id: "uuid pk", bot: "text !", token_ref: "text !", chat: "int", who: "text",
      code: "text", code_until: "time", next: "int ! =0", messages: "json ! =[]",
    },
  },
  // Ask: one row per conversation, its messages kept whole.
  conversations: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", title: "text !", messages: "json ! =[]",
      created_at: "time ! =now", updated_at: "time ! =now",
    },
  },
  agent_sessions: {
    cols: {
      id: "uuid pk =uuid", user_id: "uuid !", briefing_at: "time", status: 'text ! ="planning"',
      draft_actions: "json ! =[]", pending_question: "json", pending_questions: "json ! =[]",
      plan: "json", results: "json ! ={}", summary: "text", error: "text",
      parent_id: "uuid >agent_sessions:cascade", bucket: "text", next_turn_idx: "int ! =0",
      finalized_at: "time", created_at: "time ! =now", updated_at: "time ! =now",
    },
  },
  agent_turns: {
    cols: {
      id: "uuid pk =uuid", session_id: "uuid ! >agent_sessions:cascade", idx: "int !", role: "text !",
      content: "json !", tool_name: "text", tool_call_id: "text", reasoning: "text", bucket: "text",
      created_at: "time ! =now",
    },
    unique: [["session_id", "idx"]],
  },
};

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS emails_received ON emails(user_id, received_at DESC)",
  "CREATE INDEX IF NOT EXISTS emails_thread ON emails(user_id, thread_id)",
  "CREATE INDEX IF NOT EXISTS emails_sender ON emails(user_id, sender_email)",
  "CREATE INDEX IF NOT EXISTS emails_account ON emails(account_id)",
  "CREATE INDEX IF NOT EXISTS emails_snoozed ON emails(user_id, snooze_until) WHERE snooze_until IS NOT NULL OR is_snoozed = 1",
  "CREATE INDEX IF NOT EXISTS processed_category ON email_processed(user_id, category)",
  "CREATE INDEX IF NOT EXISTS todos_user ON todos(user_id, is_completed)",
  "CREATE INDEX IF NOT EXISTS meetings_start ON meetings(user_id, start_time)",
  "CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_emails(status, send_at)",
  "CREATE INDEX IF NOT EXISTS followups_status ON follow_up_reminders(user_id, status, remind_at)",
  "CREATE INDEX IF NOT EXISTS agent_sessions_user ON agent_sessions(user_id, status)",
  "CREATE INDEX IF NOT EXISTS agent_sessions_parent ON agent_sessions(parent_id)",
  "CREATE INDEX IF NOT EXISTS action_log_user ON action_log(user_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS action_log_status ON action_log(user_id, status)",
  "CREATE INDEX IF NOT EXISTS action_log_automation ON action_log(automation_id, created_at) WHERE automation_id IS NOT NULL",
  // At most one default signature per account (or per user, for global ones).
  "CREATE UNIQUE INDEX IF NOT EXISTS signatures_one_default ON email_signatures(user_id, coalesce(account_id, '')) WHERE is_default = 1",
];

function parseSchema(): Map<string, Table> {
  const tables = new Map<string, Table>();
  for (const [name, def] of Object.entries(SCHEMA)) {
    const cols = new Map<string, Col>();
    for (const [colName, spec] of Object.entries(def.cols)) {
      const parts = spec.split(" ");
      const col: Col = { name: colName, type: parts[0] as ColType, pk: false, notnull: false };
      for (const p of parts.slice(1)) {
        if (p === "pk") col.pk = true;
        else if (p === "!") col.notnull = true;
        else if (p.startsWith("=")) col.def = p === "=now" || p === "=uuid" ? p.slice(1) : JSON.parse(p.slice(1));
        else if (p.startsWith(">")) {
          const [ref, onDelete] = p.slice(1).split(":");
          col.ref = ref;
          col.onDelete = onDelete === "cascade" ? "CASCADE" : onDelete === "null" ? "SET NULL" : undefined;
        }
      }
      cols.set(colName, col);
    }
    tables.set(name, { name, cols, unique: def.unique ?? [] });
  }
  return tables;
}

const TABLES = parseSchema();

// Opening the database also upgrades it, so a script that imports this module
// has to say which data folder it means. Only the tabellar command gets the
// default one.
if (!process.env.TABELLAR_HOME && !/^tabellar(\.[jt]s)?$/.test(basename(process.argv[1] ?? ""))) {
  throw new Error("Set TABELLAR_HOME: only the tabellar command opens the default data folder.");
}

const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

function createSchema() {
  for (const t of TABLES.values()) {
    const sqlType = (c: Col) => (c.type === "int" || c.type === "bool" ? "INTEGER" : c.type === "real" ? "REAL" : "TEXT");
    const colDdl = (c: Col, adding = false) =>
      `"${c.name}" ${sqlType(c)}${c.pk ? " PRIMARY KEY" : ""}${c.notnull && !c.pk ? " NOT NULL" : ""}` +
      (adding && c.notnull ? " DEFAULT " + ddlDefault(c) : "") +
      (c.ref ? ` REFERENCES "${c.ref}"(id)${c.onDelete ? " ON DELETE " + c.onDelete : ""}` : "");
    const existing = sqlite.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[];
    if (existing.length === 0) {
      const lines = [...t.cols.values()].map((c) => colDdl(c));
      for (const u of t.unique) lines.push(`UNIQUE (${u.map((c) => `"${c}"`).join(", ")})`);
      sqlite.exec(`CREATE TABLE "${t.name}" (\n  ${lines.join(",\n  ")}\n)`);
    } else {
      // Forward-only migration: add columns that a newer schema introduced.
      const have = new Set(existing.map((r) => r.name));
      for (const c of t.cols.values()) {
        if (!have.has(c.name)) sqlite.exec(`ALTER TABLE "${t.name}" ADD COLUMN ${colDdl({ ...c, ref: undefined }, true)}`);
      }
    }
  }
  for (const sql of INDEXES) sqlite.exec(sql);
}

// SQLite needs a constant default to add a NOT NULL column to existing rows.
// Inserts always go through fillDefaults, so this only matters for ALTER TABLE.
function ddlDefault(c: Col): string {
  const v = c.def === "now" ? "1970-01-01T00:00:00.000Z" : c.def === "uuid" ? "" : encode(c, c.def ?? (c.type === "json" ? [] : c.type === "bool" || c.type === "int" || c.type === "real" ? 0 : ""));
  return typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
}

// Tables and columns a newer schema renamed or dropped, applied once each
// before createSchema. Mailboxes were Gmail only; they are accounts now.
const RENAMES: [string, string, string?][] = [
  ["gmail_accounts", "accounts"],
  ["accounts", "gmail_address", "address"],
  ...["emails", "scheduled_emails", "contacts", "mail_index", "email_signatures"].map((t): [string, string, string] => [t, "gmail_account_id", "account_id"]),
];

function migrate() {
  const cols = (t: string) => (sqlite.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((r) => r.name);
  for (const [t, from, to] of RENAMES) {
    if (to === undefined) {
      if (cols(t).length && !cols(from).length) sqlite.exec(`ALTER TABLE "${t}" RENAME TO "${from}"`);
    } else if (cols(t).includes(from) && !cols(t).includes(to)) sqlite.exec(`ALTER TABLE "${t}" RENAME COLUMN "${from}" TO "${to}"`);
  }
  // A removed account used to stay as is_active = 0; it is deleted now.
  if (cols("accounts").includes("is_active")) {
    sqlite.exec(`DELETE FROM accounts WHERE is_active = 0`);
    sqlite.exec(`ALTER TABLE accounts DROP COLUMN is_active`);
  }
}

// Columns and tables given up, once what they held has moved on.
function retire() {
  const cols = (t: string) => (sqlite.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((r) => r.name);
  // Notes for drafts became writing rules, one per line.
  if (cols("profiles").includes("style_notes")) {
    const now = new Date().toISOString();
    const add = sqlite.prepare(`INSERT OR IGNORE INTO preferences (id, user_id, kind, subject, value, source, created_at, updated_at) VALUES (?, ?, 'writing', '', ?, 'user', ?, ?)`);
    for (const p of sqlite.prepare(`SELECT id, style_notes FROM profiles WHERE style_notes IS NOT NULL`).all() as { id: string; style_notes: string }[]) {
      for (const line of p.style_notes.split("\n").map((l) => l.trim()).filter((l) => l.length > 4)) add.run(randomUUID(), p.id, line, now, now);
    }
    sqlite.exec(`ALTER TABLE profiles DROP COLUMN style_notes`);
    // What "What should change?" once kept, such as "Writing preference: nothing".
    sqlite.exec(`DELETE FROM knowledge_base WHERE entity_type = 'style_preference'`);
    sqlite.exec(`UPDATE profiles SET notification_level = 'needs' WHERE notification_level IN ('important', 'all')`);
  }
  if (cols("style_profiles").includes("patterns")) sqlite.exec(`ALTER TABLE style_profiles DROP COLUMN patterns`);
  // Addresses are kept in lower case, as they are compared.
  sqlite.exec(`UPDATE emails SET sender_email = lower(sender_email) WHERE sender_email <> lower(sender_email)`);
  // Forwarding rules only ever made a suggestion the window never showed.
  sqlite.exec(`DROP TABLE IF EXISTS delegation_rules`);
}

migrate();
createSchema();
retire();

// ── Encoding ────────────────────────────────────────────────────────────────

type SqlValue = string | number | null;

function normaliseTime(v: unknown): unknown {
  if (typeof v !== "string" && !(v instanceof Date)) return v;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? v : d.toISOString();
}

function encode(c: Col, v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  switch (c.type) {
    case "bool":
      return v === true || v === "true" || v === 1 || v === "1" || v === "t" ? 1 : 0;
    case "int":
    case "real":
      return typeof v === "number" ? v : Number(v);
    case "json":
      return JSON.stringify(v);
    case "time":
      return String(normaliseTime(v));
    default:
      return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

function decodeRow(t: Table, row: Record<string, SqlValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const c = t.cols.get(k);
    if (v === null || !c) out[k] = v;
    else if (c.type === "bool") out[k] = v === 1;
    else if (c.type === "json") out[k] = JSON.parse(v as string);
    else out[k] = v;
  }
  return out;
}

function fillDefaults(t: Table, row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const c of t.cols.values()) {
    if (out[c.name] !== undefined || c.def === undefined) continue;
    out[c.name] = c.def === "now" ? new Date().toISOString() : c.def === "uuid" ? randomUUID() : structuredClone(c.def);
  }
  return out;
}

// ── Errors ──────────────────────────────────────────────────────────────────

class DbError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function table(name: string): Table {
  const t = TABLES.get(name);
  if (!t) throw new DbError(`relation "${name}" does not exist`, "42P01");
  return t;
}

function column(t: Table, name: string): Col {
  const c = t.cols.get(name);
  if (!c) throw new DbError(`column ${t.name}.${name} does not exist`, "42703");
  return c;
}

function sqliteError(e: unknown): DbError {
  if (e instanceof DbError) return e;
  const msg = (e as Error).message ?? String(e);
  if (/UNIQUE constraint/.test(msg)) return new DbError(`duplicate key value violates unique constraint (${msg})`, "23505");
  if (/FOREIGN KEY constraint/.test(msg)) return new DbError(`violates foreign key constraint (${msg})`, "23503");
  if (/NOT NULL constraint/.test(msg)) return new DbError(`null value violates not-null constraint (${msg})`, "23502");
  return new DbError(msg, "XX000");
}

// ── Statements ──────────────────────────────────────────────────────────────

const statements = new Map<string, StatementSync>();
function prepare(sql: string): StatementSync {
  let s = statements.get(sql);
  if (!s) {
    if (statements.size > 500) statements.clear(); // IN lists make many one-off statements
    s = sqlite.prepare(sql);
    statements.set(sql, s);
  }
  return s;
}

function all(sql: string, params: SqlValue[]): Record<string, SqlValue>[] {
  return prepare(sql).all(...params) as Record<string, SqlValue>[];
}

const q = (id: string) => `"${id}"`;

// ── Select lists ────────────────────────────────────────────────────────────
// "id, subject, email_processed(summary, category)", "*, emails!inner(sender)"

type Embed = { alias: string; table: string; inner: boolean; select: SelectList };
type SelectList = { star: boolean; cols: { alias: string; name: string }[]; embeds: Embed[] };

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseSelect(t: Table, s: string): SelectList {
  const list: SelectList = { star: false, cols: [], embeds: [] };
  for (const item of splitTop(s.replace(/\s+/g, " "))) {
    const m = item.match(/^(?:([\w]+):)?([\w]+)(?:!([\w]+))?\s*\((.*)\)$/s);
    if (m) {
      const embedTable = table(m[2]);
      list.embeds.push({ alias: m[1] ?? m[2], table: m[2], inner: m[3] === "inner", select: parseSelect(embedTable, m[4]) });
      continue;
    }
    if (item === "*") {
      list.star = true;
      continue;
    }
    const c = item.match(/^(?:([\w]+):)?([\w]+)(?:::\w+)?$/);
    if (!c) throw new DbError(`cannot parse select item "${item}"`, "PGRST100");
    column(t, c[2]);
    list.cols.push({ alias: c[1] ?? c[2], name: c[2] });
  }
  return list;
}

// How table `from` reaches table `to`: through a column on `to` pointing back
// at `from` (one row or many), or a column on `from` pointing at `to` (one row).
function relation(from: Table, to: Table): { childSide: boolean; col: string; many: boolean } {
  for (const c of to.cols.values()) {
    if (c.ref === from.name) {
      const unique = to.unique.some((u) => u.length === 1 && u[0] === c.name);
      return { childSide: true, col: c.name, many: !unique };
    }
  }
  for (const c of from.cols.values()) {
    if (c.ref === to.name) return { childSide: false, col: c.name, many: false };
  }
  throw new DbError(`no relationship between ${from.name} and ${to.name}`, "PGRST200");
}

// ── Filters ─────────────────────────────────────────────────────────────────

type Where = { sql: string; params: SqlValue[] };

// Parse a PostgREST string value for operators that take a list:
// "(a,b,c)" for in, "{a,b}" or '["a","b"]' for contains/overlaps.
function parseList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  if (s.startsWith("[")) return JSON.parse(s);
  const inner = s.replace(/^[({]/, "").replace(/[)}]$/, "");
  if (!inner) return [];
  return splitTop(inner).map((x) => x.replace(/^"(.*)"$/, "$1"));
}

function rawScalar(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

// Searchable text for textSearch: Postgres used a generated tsvector on emails.
const SEARCH_COLUMNS: Record<string, string[]> = {
  emails: ["subject", "sender", "sender_email", "snippet", "body_text"],
};

function textSearch(t: Table, prefix: string, query: string): Where {
  const cols = SEARCH_COLUMNS[t.name] ?? [...t.cols.values()].filter((c) => c.type === "text").map((c) => c.name);
  const terms: { term: string; neg: boolean }[] = [];
  for (const m of query.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const term = m[2] ?? m[4];
    if (!term || /^(or|and)$/i.test(term)) continue;
    terms.push({ term: term.replace(/[&|!:*()']/g, ""), neg: !!(m[1] || m[3]) });
  }
  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const { term, neg } of terms) {
    if (!term) continue;
    const any = cols.map((c) => `${prefix}${q(c)} LIKE ? ESCAPE '\\'`).join(" OR ");
    parts.push(neg ? `NOT (${any})` : `(${any})`);
    for (const _ of cols) params.push(`%${term.replace(/[\\%_]/g, (x) => "\\" + x)}%`);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1", params };
}

function condition(t: Table, prefix: string, colName: string, op: string, rawVal: unknown, raw: boolean, neg: boolean): Where {
  if (op === "fts" || op === "plfts" || op === "phfts" || op === "wfts") {
    const w = textSearch(t, prefix, String(rawVal));
    return neg ? { sql: `NOT (${w.sql})`, params: w.params } : w;
  }
  const c = column(t, colName);
  const ref = `${prefix}${q(c.name)}`;
  const val = raw ? rawScalar(rawVal) : rawVal;
  let sql: string;
  let params: SqlValue[] = [];
  switch (op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const sym = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
      if (c.type === "json") {
        sql = `${ref} ${sym} json(?)`;
        params = [typeof val === "string" && raw ? val : JSON.stringify(val)];
      } else {
        sql = `${ref} ${sym} ?`;
        params = [encode(c, val)];
      }
      break;
    }
    case "like":
    case "ilike":
      sql = `${ref} LIKE ?`;
      params = [String(val).replace(/\*/g, "%")];
      break;
    case "is":
      sql = val === null ? `${ref} IS NULL` : `${ref} = ?`;
      if (val !== null) params = [val === true || val === "true" ? 1 : 0];
      break;
    case "in": {
      const list = raw ? parseList(rawVal) : (val as unknown[]);
      sql = `${ref} IN (${list.map(() => "?").join(", ")})`;
      params = list.map((v) => encode(c, v));
      break;
    }
    case "cs":
    case "cd":
    case "ov": {
      if (c.type !== "json") throw new DbError(`${op} needs an array column, ${t.name}.${c.name} is ${c.type}`, "42883");
      if (!Array.isArray(val) && typeof val === "object" && val !== null) {
        // jsonb object containment: every given key has the given value
        const entries = Object.entries(val);
        sql = entries.map(() => `json_extract(${ref}, ?) = json_extract(json(?), '$')`).join(" AND ") || "1";
        params = entries.flatMap(([k, v]) => [`$.${k}`, JSON.stringify(v)]);
        break;
      }
      const list = parseList(val);
      const marks = list.map(() => "?").join(", ");
      if (op === "cs") {
        sql = list.map(() => `EXISTS (SELECT 1 FROM json_each(${ref}) WHERE value = ?)`).join(" AND ") || "1";
      } else if (op === "cd") {
        sql = `NOT EXISTS (SELECT 1 FROM json_each(${ref}) WHERE value NOT IN (${marks}))`;
      } else {
        sql = `EXISTS (SELECT 1 FROM json_each(${ref}) WHERE value IN (${marks}))`;
      }
      params = list.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : (v as SqlValue)));
      break;
    }
    default:
      throw new DbError(`operator "${op}" is not supported`, "PGRST100");
  }
  // Postgres treats NOT on a null column as unknown, which drops the row.
  if (neg) return { sql: op === "is" ? `NOT (${sql})` : `(${ref} IS NOT NULL AND NOT (${sql}))`, params };
  return { sql, params };
}

// "a.eq.1,b.ilike.%x%,and(c.is.null,not.d.eq.2)"
function logicTree(t: Table, prefix: string, expr: string, joiner: "OR" | "AND"): Where {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const item of splitTop(expr)) {
    const group = item.match(/^(not\.)?(and|or)\((.*)\)$/s);
    let w: Where;
    if (group) {
      w = logicTree(t, prefix, group[3], group[2] === "and" ? "AND" : "OR");
      if (group[1]) w = { sql: `NOT (${w.sql})`, params: w.params };
    } else {
      const m = item.match(/^([\w]+)\.(not\.)?(\w+)\.(.*)$/s);
      if (!m) throw new DbError(`cannot parse filter "${item}"`, "PGRST100");
      w = condition(t, prefix, m[1], m[3], m[4].replace(/^"(.*)"$/s, "$1"), true, !!m[2]);
    }
    parts.push(`(${w.sql})`);
    params.push(...w.params);
  }
  return { sql: parts.join(` ${joiner} `) || "1", params };
}

// Filters on the table itself, plus filters on embedded tables written as
// "emails.received_at", which restrict the parent rows through EXISTS.
function whereClause(t: Table, filters: Filter[], embeds: Embed[]): Where {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  const embedFilters = new Map<string, Filter[]>();
  for (const f of filters) {
    if ("or" in f) {
      const w = logicTree(t, `${q(t.name)}.`, f.or, "OR");
      parts.push(`(${w.sql})`);
      params.push(...w.params);
      continue;
    }
    const dot = f.col.indexOf(".");
    if (dot > 0) {
      const alias = f.col.slice(0, dot);
      embedFilters.set(alias, [...(embedFilters.get(alias) ?? []), { ...f, col: f.col.slice(dot + 1) }]);
      continue;
    }
    const w = condition(t, `${q(t.name)}.`, f.col, f.op, f.val, !!f.raw, !!f.neg);
    parts.push(`(${w.sql})`);
    params.push(...w.params);
  }
  for (const e of embeds) {
    const own = embedFilters.get(e.alias) ?? [];
    if (!e.inner) continue;
    const et = table(e.table);
    const rel = relation(t, et);
    const join = rel.childSide ? `r.${q(rel.col)} = ${q(t.name)}.id` : `r.id = ${q(t.name)}.${q(rel.col)}`;
    const sub = whereClause(et, own, []);
    // Filters inside the subquery refer to the embedded table by its own name.
    parts.push(`EXISTS (SELECT 1 FROM ${q(et.name)} r WHERE ${join} AND (${sub.sql.replaceAll(`${q(et.name)}.`, "r.")}))`);
    params.push(...sub.params);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1", params };
}

// ── Select ──────────────────────────────────────────────────────────────────

function orderClause(t: Table, spec: QuerySpec): string {
  if (!spec.order.length) return "";
  return (
    " ORDER BY " +
    spec.order
      .map((o) => {
        column(t, o.col);
        return `${q(t.name)}.${q(o.col)} ${o.ascending ? "ASC" : "DESC"} NULLS ${o.nullsFirst ? "FIRST" : "LAST"}`;
      })
      .join(", ")
  );
}

function project(t: Table, rows: Record<string, unknown>[], list: SelectList, embedFilters: Filter[]): Record<string, unknown>[] {
  // Attach embedded rows first, while every parent column is still present.
  for (const e of list.embeds) {
    const et = table(e.table);
    const rel = relation(t, et);
    const keys = [...new Set(rows.map((r) => (rel.childSide ? r.id : r[rel.col])).filter((k) => k != null))] as SqlValue[];
    const own = embedFilters
      .filter((f) => "col" in f && f.col.startsWith(e.alias + "."))
      .map((f) => ({ ...(f as { col: string; op: string; val: unknown }), col: (f as { col: string }).col.slice(e.alias.length + 1) }));
    const matchCol = rel.childSide ? rel.col : "id";
    let related: Record<string, unknown>[] = [];
    if (keys.length) {
      const w = whereClause(et, own as Filter[], []);
      related = all(
        `SELECT * FROM ${q(et.name)} WHERE ${q(et.name)}.${q(matchCol)} IN (${keys.map(() => "?").join(", ")}) AND (${w.sql})`,
        [...keys, ...w.params],
      ).map((r) => decodeRow(et, r));
      related = project(et, related, { ...e.select, cols: [...e.select.cols, { alias: "\0key", name: matchCol }] }, []);
    }
    const byKey = new Map<unknown, Record<string, unknown>[]>();
    for (const r of related) {
      const k = r["\0key"];
      delete r["\0key"];
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
    for (const r of rows) {
      const found = byKey.get(rel.childSide ? r.id : r[rel.col]) ?? [];
      r["\0embed:" + e.alias] = rel.many ? found : (found[0] ?? null);
    }
    if (e.inner) rows = rows.filter((r) => (rel.many ? (r["\0embed:" + e.alias] as unknown[]).length : r["\0embed:" + e.alias]));
  }
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    if (list.star) for (const c of t.cols.keys()) out[c] = r[c];
    for (const c of list.cols) out[c.alias] = r[c.name];
    for (const e of list.embeds) out[e.alias] = r["\0embed:" + e.alias];
    return out;
  });
}

function runSelect(t: Table, spec: QuerySpec): Result {
  const list = parseSelect(t, spec.columns ?? "*");
  const w = whereClause(t, spec.filters, list.embeds);
  let count: number | null = null;
  if (spec.count) {
    const r = all(`SELECT COUNT(*) AS n FROM ${q(t.name)} WHERE ${w.sql}`, w.params);
    count = Number(r[0].n);
  }
  if (spec.head) return { data: null, error: null, count, status: 200 };
  let sql = `SELECT * FROM ${q(t.name)} WHERE ${w.sql}${orderClause(t, spec)}`;
  if (spec.limit !== undefined) sql += ` LIMIT ${Math.max(0, Math.floor(spec.limit))}`;
  if (spec.offset !== undefined) sql += `${spec.limit === undefined ? " LIMIT -1" : ""} OFFSET ${Math.max(0, Math.floor(spec.offset))}`;
  const rows = all(sql, w.params).map((r) => decodeRow(t, r));
  return finish(project(t, rows, list, spec.filters), spec, count);
}

function finish(rows: Record<string, unknown>[] | null, spec: QuerySpec, count: number | null): Result {
  if (spec.single && rows) {
    if (rows.length === 1) return { data: rows[0], error: null, count, status: 200 };
    if (rows.length === 0 && spec.single === "maybe") return { data: null, error: null, count, status: 200 };
    return {
      data: null,
      error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows` },
      count,
      status: 406,
    };
  }
  return { data: rows, error: null, count, status: 200 };
}

// ── Changes ─────────────────────────────────────────────────────────────────
// Every write is published here; the server turns it into the event stream the
// interface listens to, in the shape its realtime subscriptions expect.

export type Change = { table: string; eventType: "INSERT" | "UPDATE" | "DELETE"; new: Record<string, unknown>; old: Record<string, unknown> };
export const changes = new EventEmitter();
changes.setMaxListeners(100);

// Thousands of rows the window never shows: not worth an event each.
const UNPUBLISHED = new Set(["mail_index"]);

function publish(table: string, eventType: Change["eventType"], row: Record<string, unknown>, old: Record<string, unknown> = {}) {
  if (UNPUBLISHED.has(table)) return;
  changes.emit("change", { table, eventType, new: eventType === "DELETE" ? {} : row, old } satisfies Change);
}

// ── Writes ──────────────────────────────────────────────────────────────────

function encodeRow(t: Table, row: Record<string, unknown>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = encode(column(t, k), v);
  }
  return out;
}

function returning(t: Table, spec: QuerySpec, rows: Record<string, unknown>[], count: number | null): Result {
  if (spec.columns === null) return { data: null, error: null, count, status: 201 };
  return finish(project(t, rows, parseSelect(t, spec.columns), []), spec, count);
}

function runInsert(t: Table, spec: QuerySpec): Result {
  const input = (Array.isArray(spec.values) ? spec.values : [spec.values]) as Record<string, unknown>[];
  const conflict = spec.action === "upsert" ? (spec.onConflict ?? "id").split(",").map((s) => s.trim()) : null;
  if (conflict) for (const c of conflict) column(t, c);
  const written: Record<string, unknown>[] = [];
  sqlite.exec("BEGIN");
  try {
    for (const given of input) {
      const provided = encodeRow(t, given);
      const row = encodeRow(t, fillDefaults(t, given));
      const cols = Object.keys(row);
      let sql = `INSERT INTO ${q(t.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      let old: Record<string, unknown> | undefined;
      if (conflict) {
        const key = conflict.map((c) => row[c] ?? null);
        const prev = all(`SELECT * FROM ${q(t.name)} WHERE ${conflict.map((c) => `${q(c)} IS ?`).join(" AND ")}`, key);
        if (prev.length) old = decodeRow(t, prev[0]);
        const updates = Object.keys(provided).filter((c) => !conflict.includes(c));
        if (spec.ignoreDuplicates || updates.length === 0) sql += ` ON CONFLICT (${conflict.map(q).join(", ")}) DO NOTHING`;
        else {
          if (t.cols.has("updated_at") && !("updated_at" in provided)) updates.push("updated_at");
          sql += ` ON CONFLICT (${conflict.map(q).join(", ")}) DO UPDATE SET ${updates.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`;
        }
      }
      const res = all(sql + " RETURNING *", Object.values(row));
      if (!res.length) {
        if (old) written.push(old); // ignored duplicate: the existing row
        continue;
      }
      const saved = decodeRow(t, res[0]);
      written.push(saved);
      publish(t.name, old ? "UPDATE" : "INSERT", saved, old);
    }
    sqlite.exec("COMMIT");
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
  return returning(t, spec, written, spec.count ? written.length : null);
}

function runUpdate(t: Table, spec: QuerySpec): Result {
  const values = { ...(spec.values as Record<string, unknown>) };
  if (t.cols.has("updated_at") && values.updated_at === undefined) values.updated_at = new Date().toISOString();
  const set = encodeRow(t, values);
  const w = whereClause(t, spec.filters, []);
  const before = all(`SELECT * FROM ${q(t.name)} WHERE ${w.sql}`, w.params).map((r) => decodeRow(t, r));
  if (!before.length || !Object.keys(set).length) return returning(t, spec, [], spec.count ? 0 : null);
  const cols = Object.keys(set);
  const rows = all(
    `UPDATE ${q(t.name)} SET ${cols.map((c) => `${q(c)} = ?`).join(", ")} WHERE ${w.sql} RETURNING *`,
    [...Object.values(set), ...w.params],
  ).map((r) => decodeRow(t, r));
  const oldById = new Map(before.map((r) => [r.id, r]));
  for (const r of rows) publish(t.name, "UPDATE", r, oldById.get(r.id));
  return returning(t, spec, rows, spec.count ? rows.length : null);
}

function runDelete(t: Table, spec: QuerySpec): Result {
  const w = whereClause(t, spec.filters, []);
  const rows = all(`DELETE FROM ${q(t.name)} WHERE ${w.sql} RETURNING *`, w.params).map((r) => decodeRow(t, r));
  for (const r of rows) publish(t.name, "DELETE", {}, r);
  return returning(t, spec, rows, spec.count ? rows.length : null);
}

export function execute(spec: QuerySpec): Result {
  try {
    const t = table(spec.table);
    switch (spec.action) {
      case "select":
        return runSelect(t, spec);
      case "insert":
      case "upsert":
        return runInsert(t, spec);
      case "update":
        return runUpdate(t, spec);
      case "delete":
        return runDelete(t, spec);
    }
  } catch (e) {
    const err = sqliteError(e);
    console.error(`[db] ${spec.action} ${spec.table}: ${err.message}`);
    return { data: null, error: { message: err.message, code: err.code }, count: null, status: 400 };
  }
}

// The newest mail, sent mail aside, that has not been sorted yet.
export function unprocessedIds(userId: string, limit: number): string[] {
  return all(
    `SELECT id FROM emails WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM json_each(emails.label_ids) WHERE value = 'SENT')
     AND NOT EXISTS (SELECT 1 FROM email_processed p WHERE p.email_id = emails.id) ORDER BY received_at DESC LIMIT ?`,
    [userId, limit],
  ).map((r) => String(r.id));
}

// ── Stored procedures the old database provided ─────────────────────────────

const RPC: Record<string, (args: Record<string, unknown>) => unknown> = {
  // Reserve `p_count` consecutive turn numbers for an agent session.
  alloc_agent_turn_idx({ p_session_id, p_count }) {
    const n = Math.max(Number(p_count ?? 1) || 1, 1);
    const r = all(`UPDATE agent_sessions SET next_turn_idx = next_turn_idx + ? WHERE id = ? RETURNING next_turn_idx - ? AS start`, [n, p_session_id as string, n]);
    if (!r.length) throw new DbError("session not found", "P0002");
    return Number(r[0].start);
  },
  // Append draft actions to an agent session.
  merge_bucket_draft_actions({ p_session_id, p_actions }) {
    const t = table("agent_sessions");
    const r = all(`SELECT * FROM agent_sessions WHERE id = ?`, [p_session_id as string]);
    if (!r.length) throw new DbError("session not found", "P0002");
    const old = decodeRow(t, r[0]);
    const merged = [...((old.draft_actions as unknown[]) ?? []), ...((p_actions as unknown[]) ?? [])];
    const saved = all(`UPDATE agent_sessions SET draft_actions = ?, updated_at = ? WHERE id = ? RETURNING *`, [
      JSON.stringify(merged), new Date().toISOString(), p_session_id as string,
    ]).map((x) => decodeRow(t, x));
    publish("agent_sessions", "UPDATE", saved[0], old);
    return null;
  },
  increment_knowledge_use_count({ row_id, used_at }) {
    all(`UPDATE knowledge_base SET use_count = coalesce(use_count, 0) + 1, last_used_at = ? WHERE id = ? RETURNING id`, [
      String(normaliseTime(used_at ?? new Date().toISOString())), row_id as string,
    ]);
    return null;
  },
};

export function callRpc(fn: string, args: Record<string, unknown> = {}): Result {
  try {
    const f = RPC[fn];
    if (!f) throw new DbError(`function ${fn} does not exist`, "42883");
    return { data: f(args), error: null, count: null, status: 200 };
  } catch (e) {
    const err = sqliteError(e);
    return { data: null, error: { message: err.message, code: err.code }, count: null, status: 400 };
  }
}

// The client the backend code uses, shaped like a supabase-js client.
const run = (spec: QuerySpec) => Promise.resolve(execute(spec));
export const db = {
  from: (tableName: string) => new Query(run, tableName),
  rpc: (fn: string, args?: Record<string, unknown>) => Promise.resolve(callRpc(fn, args)),
};
export type Db = typeof db;

export const TABLE_NAMES = new Set(TABLES.keys());
