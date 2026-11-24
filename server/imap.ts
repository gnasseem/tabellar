// IMAP and SMTP, for iCloud, Fastmail, Yahoo and any other mailbox that
// takes an app password, on node:tls with no dependency. imapMailbox is the
// "imap" mailbox in providers.ts.
//
// The app password is in the Keychain (accounts.token_ref names the item);
// accounts.server holds the servers and the user name.
//
// How Gmail's terms map onto IMAP:
// - A message's id is its Message-ID, which stays the same when it moves
//   between folders. Its thread is the first Message-ID in References.
// - INBOX is being in the INBOX folder; archiving moves it to Archive (made
//   when missing) and back. UNREAD is the absence of \Seen, STARRED \Flagged.
// - Folders are labels: labelling copies the message into the folder, and
//   removing the label deletes that copy, but only while another copy is in
//   the Inbox or Archive; the last copy is moved to Archive instead. Nothing
//   else is ever deleted, apart from the older version of a draft Tabellar
//   saved itself when it saves a newer one.
// - There is no change history: a sync compares the Inbox of the last 31
//   days with what is stored. IDLE tells the engine at once when the Inbox
//   changes, and a STATUS every few seconds catches the rest.

import { connect as tlsConnect } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { keychainDelete, keychainGet, keychainSet } from "./config.ts";
import { calendarHeaders, parseIcs } from "./rules.ts";
import { addressOf as address, htmlToText, newMessageId, parseHeaders, partAt, readMessage, writeMessage } from "./mime.ts";
import type { ImapServer } from "./accounts.ts";
import type { Box, EmailData, HeaderRow, Mail, MailboxChanges, Outgoing, Sent } from "./providers.ts";
import { isReceipt, receiptOf } from "./receipts.ts";
import { addressesIn } from "./senders.ts";

// `tabellar check` swaps these so its fake mailbox needs no Keychain item.
export const secrets = { get: keychainGet, set: keychainSet, delete: keychainDelete };

const DAY = 86_400_000;
const TIMEOUT_MS = 60_000;
const loopback = (host: string) => /^(127\.|::1$|localhost$)/.test(host);

// ── The wire ────────────────────────────────────────────────────────────────

// A response token: an atom or string, a literal's bytes, NIL, or a list.
type Tok = string | Buffer | null | Tok[];

// One whole response from the front of the buffer: its line with each
// literal replaced by a marker, and the literals. Until all of it is in, how
// long the buffer has to get before it is worth looking again.
function takeResponse(buf: Buffer): { line: string; lits: Buffer[]; used: number } | number {
  let pos = 0;
  let line = "";
  const lits: Buffer[] = [];
  for (;;) {
    const nl = buf.indexOf("\r\n", pos);
    if (nl < 0) return buf.length + 1;
    const seg = buf.toString("utf8", pos, nl);
    const m = /\{(\d+)\+?\}$/.exec(seg);
    if (!m) return { line: line + seg, lits, used: nl + 2 };
    const start = nl + 2;
    const n = Number(m[1]);
    if (buf.length < start + n) return start + n;
    line += `${seg.slice(0, m.index)}\x00${lits.length}\x00`;
    lits.push(buf.subarray(start, start + n));
    pos = start + n;
  }
}

function tokens(line: string, lits: Buffer[]): Tok[] {
  const stack: Tok[][] = [[]];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const top = stack[stack.length - 1];
    if (c === " ") i++;
    else if (c === "(") {
      const list: Tok[] = [];
      top.push(list);
      stack.push(list);
      i++;
    } else if (c === ")") {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let v = "";
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\") j++;
        v += line[j++];
      }
      top.push(v);
      i = j + 1;
    } else if (c === "\x00") {
      const j = line.indexOf("\x00", i + 1);
      top.push(lits[Number(line.slice(i + 1, j))]);
      i = j + 1;
    } else {
      // An atom. Brackets keep what is inside them, as in BODY[HEADER.FIELDS (FROM)].
      let j = i;
      let depth = 0;
      while (j < line.length) {
        const d = line[j];
        if (d === "[") depth++;
        else if (d === "]") depth--;
        else if (depth <= 0 && (d === " " || d === "(" || d === ")")) break;
        j++;
      }
      const atom = line.slice(i, j);
      top.push(atom.toUpperCase() === "NIL" ? null : atom);
      i = j;
    }
  }
  return stack[0];
}

const str = (t: Tok | undefined) => (Buffer.isBuffer(t) ? t.toString("utf8") : typeof t === "string" ? t : "");
const quote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

// Folder names travel in modified UTF-7 (RFC 3501 5.1.3).
export function toImapName(s: string): string {
  return s.replace(/&/g, "&-").replace(/[^\x20-\x7e]+/g, (run) => `&${Buffer.from(run, "utf16le").swap16().toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`);
}
export function fromImapName(s: string): string {
  return s.replace(/&([^-]*)-/g, (_, b: string) => (b ? Buffer.from(b.replace(/,/g, "/"), "base64").swap16().toString("utf16le") : "&"));
}

// "17-Jul-1996 02:44:25 -0700"
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function internalDate(s: string): string {
  const m = /(\d+)-(\w{3})-(\d{4}) (\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)/.exec(s);
  if (!m) return new Date().toISOString();
  const offset = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  return new Date(Date.UTC(+m[3], MONTHS.indexOf(m[2]), +m[1], +m[4], +m[5], +m[6]) - offset * 60_000).toISOString();
}
const searchDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
};

// One IMAP connection. Commands run one at a time; LIT in a command's text
// marks where each literal goes.
const LIT = "\x01";

class Conn {
  caps = new Set<string>();
  closed = false;
  onUntagged: ((t: Tok[]) => void) | null = null;
  private sock: Socket;
  private chunks: Buffer[] = [];
  private size = 0;
  private need = 0;
  private n = 0;
  private alive: () => void = () => {}; // puts off the running command's timeout
  private queue: Promise<unknown> = Promise.resolve();
  private waiting: { tag: string; rows: Tok[][]; done: (e: Error | null) => void; more: () => void } | null = null;
  private greeted: (() => void) | null = null;
  private refused: (e: Error) => void = () => {};
  private ended: () => void = () => {};
  readonly ready: Promise<void>;
  readonly gone: Promise<void>;

  constructor(sock: Socket) {
    this.ready = new Promise((resolve, reject) => {
      this.greeted = resolve;
      this.refused = reject;
    });
    this.ready.catch(() => {});
    this.gone = new Promise((resolve) => (this.ended = resolve));
    this.sock = sock;
    this.attach(sock);
  }

  private attach(sock: Socket) {
    this.sock = sock;
    sock.setKeepAlive(true, 60_000);
    sock.on("data", (d: Buffer) => this.data(d));
    sock.on("error", () => this.close());
    sock.on("close", () => this.close());
  }

  async starttls(host: string) {
    await this.cmd("STARTTLS");
    const plain = this.sock;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    this.attach(await upgrade(plain, host));
    await this.cmd("CAPABILITY");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
    this.waiting?.done(new Error("The mail server closed the connection"));
    this.waiting = null;
    this.refused(new Error("The mail server closed the connection"));
    this.ended();
  }

  // In pieces, so a slow upload is seen to move.
  write(s: string | Buffer) {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8");
    for (let i = 0; i < b.length; i += 65_536) this.sock.write(b.subarray(i, i + 65_536), () => this.alive());
  }

  private data(d: Buffer) {
    this.alive();
    this.chunks.push(d);
    this.size += d.length;
    if (this.size < this.need) return;
    let buf = this.chunks.length > 1 ? Buffer.concat(this.chunks) : d;
    for (;;) {
      const r = takeResponse(buf);
      if (typeof r === "number") {
        this.chunks = buf.length ? [buf] : [];
        this.size = buf.length;
        this.need = r;
        return;
      }
      buf = buf.subarray(r.used);
      if (r.line.startsWith("+")) {
        this.waiting?.more();
        continue;
      }
      const t = tokens(r.line, r.lits);
      const caps = r.line.match(/\[CAPABILITY ([^\]]*)\]/i)?.[1] ?? (str(t[1]).toUpperCase() === "CAPABILITY" ? t.slice(2).map(str).join(" ") : null);
      if (caps !== null) this.caps = new Set(caps.toUpperCase().split(/\s+/));
      if (t[0] === "*") {
        if (this.greeted) {
          this.greeted();
          this.greeted = null;
          if (/^\* BYE/i.test(r.line)) {
            this.close();
            return;
          }
          continue;
        }
        this.waiting?.rows.push(t);
        this.onUntagged?.(t);
      } else if (this.waiting && t[0] === this.waiting.tag) {
        const w = this.waiting;
        this.waiting = null;
        w.done(str(t[1]).toUpperCase() === "OK" ? null : new Error(r.line.slice(w.tag.length + 1).replace(/^(NO|BAD)\s*/i, "") || "The mail server refused"));
      }
    }
  }

  cmd(text: string, lits: Buffer[] = [], timeout = TIMEOUT_MS): Promise<Tok[][]> {
    const run = () =>
      new Promise<Tok[][]>((resolve, reject) => {
        if (this.closed) return reject(new Error("The mail server closed the connection"));
        const tag = `T${++this.n}`;
        const pieces = text.split(LIT);
        let k = 0;
        const tail = (i: number) => (i < lits.length ? `{${lits[i].length}}\r\n` : "\r\n");
        const rows: Tok[][] = [];
        this.sock.ref();
        let timer: ReturnType<typeof setTimeout> | undefined;
        this.alive = () => {
          clearTimeout(timer);
          if (timeout) timer = setTimeout(() => this.close(), timeout);
        };
        this.alive();
        this.waiting = {
          tag,
          rows,
          done: (e) => {
            this.alive = () => {};
            clearTimeout(timer);
            this.sock.unref();
            if (e) reject(e);
            else resolve(rows);
          },
          more: () => {
            if (k >= lits.length) return;
            this.write(lits[k++]);
            this.write(pieces[k] + tail(k));
          },
        };
        this.write(`${tag} ${pieces[0]}${tail(0)}`);
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  // Select a folder unless it is selected. Returns its UIDVALIDITY and UIDNEXT.
  async select(name: string): Promise<{ validity: number; next: number }> {
    const rows = await this.cmd(`SELECT ${quote(toImapName(name))}`);
    const code = (k: string) => Number(rows.map((r) => r.map(str).join(" ")).join("\n").match(new RegExp(`\\[${k} (\\d+)\\]`, "i"))?.[1] ?? 0);
    return { validity: code("UIDVALIDITY"), next: code("UIDNEXT") };
  }

  async search(criteria: string): Promise<number[]> {
    const rows = await this.cmd(`UID SEARCH ${criteria}`);
    return rows.filter((r) => str(r[1]).toUpperCase() === "SEARCH").flatMap((r) => r.slice(2).map((x) => Number(str(x)))).filter((n) => n > 0);
  }

  async fetch(uids: number[], items: string): Promise<Fetched[]> {
    const out: Fetched[] = [];
    const step = items.includes("BODY.PEEK[]") ? 10 : 200;
    for (let i = 0; i < uids.length; i += step) {
      const want = new Set(uids.slice(i, i + step));
      const rows = await this.cmd(`UID FETCH ${[...want].join(",")} (UID ${items})`);
      for (const r of rows) {
        if (str(r[2]).toUpperCase() !== "FETCH" || !Array.isArray(r[3])) continue;
        const kv = r[3];
        const f: Fetched = { uid: 0, flags: [], date: "", head: null, body: null };
        for (let j = 0; j + 1 < kv.length; j += 2) {
          const key = str(kv[j]).toUpperCase();
          const v = kv[j + 1];
          if (key === "UID") f.uid = Number(str(v));
          else if (key === "FLAGS") f.flags = Array.isArray(v) ? v.map((x) => str(x).toLowerCase()) : [];
          else if (key === "INTERNALDATE") f.date = internalDate(str(v));
          else if (key.startsWith("BODY[HEADER")) f.head = Buffer.isBuffer(v) ? v : Buffer.from(str(v));
          else if (key.startsWith("BODY[")) f.body = Buffer.isBuffer(v) ? v : Buffer.from(str(v));
        }
        if (want.has(f.uid)) out.push(f);
      }
    }
    return out;
  }

  logout() {
    if (this.closed) return;
    this.cmd("LOGOUT", [], 5_000).catch(() => {}).finally(() => this.close());
  }
}

type Fetched = { uid: number; flags: string[]; date: string; head: Buffer | null; body: Buffer | null };

function socketTo(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tls = port === 993 || port === 465;
    const s = tls ? tlsConnect({ host, port, servername: host, rejectUnauthorized: !loopback(host) }) : netConnect({ host, port });
    s.setTimeout(TIMEOUT_MS, () => s.destroy(new Error(`${host} did not answer`)));
    s.once(tls ? "secureConnect" : "connect", () => {
      s.setTimeout(0);
      resolve(s);
    });
    s.once("error", (e) => reject(new Error(`Could not reach ${host} on port ${port} (${(e as NodeJS.ErrnoException).code ?? e.message})`)));
  });
}

// Upgrade a plain connection with STARTTLS.
function upgrade(sock: Socket, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    sock.removeAllListeners("data");
    const s = tlsConnect({ socket: sock, servername: host, rejectUnauthorized: !loopback(host) }, () => {
      clearTimeout(timer);
      resolve(s);
    });
    const timer = setTimeout(() => s.destroy(new Error(`${host} did not answer`)), TIMEOUT_MS);
    s.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.once("close", () => reject(new Error(`${host} closed the connection`)));
  });
}

async function open(server: ImapServer["imap"], user: string, password: string): Promise<Conn> {
  const c = new Conn(await socketTo(server.host, server.port));
  const slow = setTimeout(() => c.close(), 30_000);
  try {
    await c.ready;
  } catch {
    throw new Error(`${server.host} did not answer as a mail server on port ${server.port}`);
  } finally {
    clearTimeout(slow);
  }
  if (!c.caps.size) await c.cmd("CAPABILITY");
  if (server.port !== 993) {
    if (c.caps.has("STARTTLS")) await c.starttls(server.host);
    else if (!loopback(server.host)) {
      c.close();
      throw new Error(`${server.host} offers no encrypted connection on port ${server.port}`);
    }
  }
  try {
    await c.cmd(`LOGIN ${quote(user)} ${quote(password)}`);
  } catch (e) {
    c.close();
    throw Object.assign(new Error(`The mail server did not accept the sign-in: ${(e as Error).message}`), { status: 401 });
  }
  await c.cmd("CAPABILITY");
  return c;
}

function login(a: Box): Promise<Conn> {
  const s = a.server as ImapServer | null;
  const password = secrets.get(a.token_ref);
  if (!s?.imap || !password) throw Object.assign(new Error(`The app password for ${a.address} is not on this Mac. Add the account again.`), { status: 401 });
  return open(s.imap, s.user || a.address, password);
}

// One connection per account, kept a minute after its last use. Sessions run
// one after another, since each selects folders of its own.
const pool = new Map<string, { conn: Conn | null; tail: Promise<unknown>; timer?: ReturnType<typeof setTimeout> }>();

function session<T>(a: Box, fn: (c: Conn) => Promise<T>): Promise<T> {
  let slot = pool.get(a.id);
  if (!slot) pool.set(a.id, (slot = { conn: null, tail: Promise.resolve() }));
  const s = slot;
  const run = async () => {
    clearTimeout(s.timer);
    if (!s.conn || s.conn.closed) s.conn = await login(a);
    try {
      return await fn(s.conn);
    } finally {
      s.timer = setTimeout(() => {
        s.conn?.logout();
        s.conn = null;
      }, 60_000);
      s.timer.unref();
    }
  };
  const p = s.tail.then(run, run);
  s.tail = p.catch(() => {});
  return p;
}

// ── Folders ─────────────────────────────────────────────────────────────────

// `prefix` is what the server puts before every folder of the user's, such as
// "INBOX." where all folders sit under the Inbox.
type Folders = { delim: string; prefix: string; names: string[]; sent: string; drafts: string; archive: string | null; special: Set<string> };
const folderCache = new Map<string, Folders>();

async function folders(c: Conn, a: Box, fresh = false): Promise<Folders> {
  const cached = folderCache.get(a.id);
  if (cached && !fresh) return cached;
  const rows = await c.cmd('LIST "" "*"');
  const f: Folders = { delim: "/", prefix: "", names: [], sent: "", drafts: "", archive: null, special: new Set(["INBOX"]) };
  const byName = (re: RegExp) => f.names.find((n) => re.test(n.slice(n.startsWith(f.prefix) ? f.prefix.length : 0))) ?? "";
  for (const r of rows) {
    if (str(r[1]).toUpperCase() !== "LIST") continue;
    const attrs = (Array.isArray(r[2]) ? r[2] : []).map((x) => str(x).toLowerCase());
    if (str(r[3])) f.delim = str(r[3]);
    const name = fromImapName(str(r[4]));
    if (attrs.includes("\\noselect") || attrs.includes("\\nonexistent")) continue;
    f.names.push(name);
    if (attrs.includes("\\sent")) f.sent = name;
    if (attrs.includes("\\drafts")) f.drafts = name;
    if (attrs.includes("\\archive")) f.archive = name;
    if (attrs.some((x) => ["\\sent", "\\drafts", "\\archive", "\\trash", "\\junk", "\\all", "\\flagged"].includes(x))) f.special.add(name);
  }
  const under = f.names.filter((n) => n.toUpperCase() !== "INBOX");
  if (under.length && under.every((n) => n.toUpperCase().startsWith(`INBOX${f.delim}`))) f.prefix = under[0].slice(0, 5 + f.delim.length);
  f.sent ||= byName(/^(sent|sent messages|sent items|sent mail)$/i) || `${f.prefix}Sent`;
  f.drafts ||= byName(/^drafts?$/i) || `${f.prefix}Drafts`;
  f.archive ??= byName(/^(archive|archives)$/i) || null;
  for (const n of [f.sent, f.drafts, f.archive ?? "", ...f.names.filter((n) => /^(inbox[./])?(trash|deleted messages|deleted items|junk|spam|bulk mail)$/i.test(n))]) if (n) f.special.add(n);
  folderCache.set(a.id, f);
  return f;
}

// A label's folder: "Tabellar/Work" with the server's separator.
const folderOf = (f: Folders, label: string) => f.prefix + label.split("/").join(f.delim);
const labelOf = (f: Folders, folder: string) => (f.prefix && folder.startsWith(f.prefix) ? folder.slice(f.prefix.length) : folder).split(f.delim).join("/");

async function makeFolder(c: Conn, a: Box, name: string): Promise<Folders> {
  const f = await folders(c, a);
  const parts = name.split(f.delim);
  let refused = "";
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join(f.delim);
    if (f.names.includes(path) || path.toUpperCase() === "INBOX") continue;
    await c.cmd(`CREATE ${quote(toImapName(path))}`).catch((e) => (refused = (e as Error).message));
    await c.cmd(`SUBSCRIBE ${quote(toImapName(path))}`).catch(() => {});
  }
  const now = await folders(c, a, true);
  if (!now.names.includes(name)) throw new Error(`The mail server would not make the folder ${name}${refused ? `: ${refused}` : ""}`);
  return now;
}

async function archiveFolder(c: Conn, a: Box): Promise<string> {
  const f = await folders(c, a);
  if (f.archive) return f.archive;
  const name = `${f.prefix}Archive`;
  const now = await makeFolder(c, a, name);
  now.archive = f.archive = name;
  now.special.add(name);
  return name;
}

// ── Messages ────────────────────────────────────────────────────────────────

const HEAD = "MESSAGE-ID FROM TO CC SUBJECT DATE REFERENCES IN-REPLY-TO LIST-UNSUBSCRIBE LIST-ID PRECEDENCE";
const angle = (v: string | undefined) => [...String(v ?? "").matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);

// A message's id: its Message-ID, or where it sits when it has none.
const idOf = (h: Record<string, string>, folder: string, validity: number, uid: number) =>
  angle(h["message-id"])[0] ?? (h["message-id"]?.trim() || `uid:${validity}:${uid}:${folder}`);
const threadOf = (h: Record<string, string>, id: string) => angle(h.references)[0] ?? angle(h["in-reply-to"])[0] ?? id;

function labelsOf(f: Folders, folder: string, flags: string[]): string[] {
  const out: string[] = [];
  if (folder === "INBOX") out.push("INBOX");
  else if (folder === f.sent) out.push("SENT");
  else if (!f.special.has(folder)) out.push(labelOf(f, folder));
  if (!flags.includes("\\seen")) out.push("UNREAD");
  if (flags.includes("\\flagged")) out.push("STARRED");
  return out;
}

// Where each message was last seen, and the headers read for the first read.
const where = new Map<string, Map<string, { folder: string; uid: number }>>();
const seenRows = new Map<string, Map<string, HeaderRow>>();
const placeOf = (a: Box) => where.get(a.id) ?? where.set(a.id, new Map()).get(a.id)!;
// Other copies of a message in the Inbox: one sent to the user and through a list.
const copies = new Map<string, Map<string, Set<number>>>();
const copiesOf = (a: Box) => copies.get(a.id) ?? copies.set(a.id, new Map()).get(a.id)!;
const rowsOf = (a: Box) => seenRows.get(a.id) ?? seenRows.set(a.id, new Map()).get(a.id)!;

function headerRow(f: Folders, folder: string, id: string, x: Fetched, h: Record<string, string>): HeaderRow {
  return {
    gmail_id: id,
    thread_id: threadOf(h, id),
    at: x.date || new Date().toISOString(),
    labels: labelsOf(f, folder, x.flags),
    from: h.from ?? "",
    to: h.to ?? "",
    cc: h.cc ?? "",
    list_unsubscribe: !!h["list-unsubscribe"],
    list_id: h["list-id"] ?? "",
    precedence: h.precedence ?? "",
  };
}

// Headers of messages in one folder, remembered with where they are.
async function readHeads(c: Conn, a: Box, folder: string, uids: number[]): Promise<{ id: string; uid: number; flags: string[]; row: HeaderRow }[]> {
  const f = await folders(c, a);
  const { validity } = await c.select(folder);
  const out: { id: string; uid: number; flags: string[]; row: HeaderRow }[] = [];
  for (const x of await c.fetch(uids, `FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (${HEAD})]`)) {
    const h = parseHeaders(x.head?.toString("utf8") ?? "");
    const id = idOf(h, folder, validity, x.uid);
    const row = headerRow(f, folder, id, x, h);
    const before = placeOf(a).get(id);
    if (folder === "INBOX" && before?.folder === "INBOX" && before.uid !== x.uid) copiesOf(a).set(id, (copiesOf(a).get(id) ?? new Set()).add(before.uid).add(x.uid));
    placeOf(a).set(id, { folder, uid: x.uid });
    rowsOf(a).set(id, row);
    out.push({ id, uid: x.uid, flags: x.flags, row });
  }
  return out;
}

// Find messages by id in these folders (the Inbox and Archive by default):
// where they were last seen, else by searching for their Message-ID.
async function locate(c: Conn, a: Box, ids: string[], inFolders?: string[]): Promise<Map<string, { folder: string; uid: number }>> {
  const f = await folders(c, a);
  const look = inFolders ?? ["INBOX", ...(f.archive ? [f.archive] : [])];
  const out = new Map<string, { folder: string; uid: number }>();
  const missing: string[] = [];
  for (const id of ids) {
    const known = placeOf(a).get(id);
    if (known && look.includes(known.folder)) out.set(id, known);
    else missing.push(id);
  }
  for (const folder of look) {
    if (!missing.length) break;
    if (!f.names.includes(folder) && folder !== "INBOX") continue;
    await c.select(folder);
    for (const id of [...missing]) {
      const byUid = /^uid:\d+:(\d+):(.*)$/.exec(id);
      const uid = byUid ? (byUid[2] === folder ? Number(byUid[1]) : 0) : (await c.search(`HEADER MESSAGE-ID ${quote(id)}`))[0];
      if (!uid) continue;
      out.set(id, { folder, uid });
      placeOf(a).set(id, { folder, uid });
      missing.splice(missing.indexOf(id), 1);
    }
  }
  return out;
}

const byFolder = (m: Map<string, { folder: string; uid: number }>) => {
  const g = new Map<string, number[]>();
  for (const { folder, uid } of m.values()) g.set(folder, [...(g.get(folder) ?? []), uid]);
  return g;
};

function emailOf(f: Folders, folder: string, id: string, x: Fetched): EmailData {
  const r = readMessage(x.body ?? Buffer.alloc(0));
  const h = r.headers;
  const from = h.from ?? "";
  const replyTo = h["reply-to"] ? address(h["reply-to"]) : "";
  const text = r.text || htmlToText(r.html);
  const labels = labelsOf(f, folder, x.flags);
  return {
    gmail_id: id,
    thread_id: threadOf(h, id),
    subject: h.subject ?? "",
    sender: from,
    sender_email: address(from),
    recipients: h.to ?? "",
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
    body_text: text,
    body_html: r.html,
    received_at: x.date || (h.date ? new Date(h.date).toISOString() : new Date().toISOString()),
    is_read: !labels.includes("UNREAD"),
    label_ids: labels,
    has_attachments: r.attachments.length > 0,
    attachments: r.attachments,
    has_list_unsubscribe: !!(h["list-unsubscribe"] || h["list-unsubscribe-post"]),
    is_reply: !!(h["in-reply-to"] || h.references),
    reply_to_email: replyTo && replyTo !== address(from) ? replyTo : undefined,
    cc_recipients: h.cc || undefined,
    precedence_header: h.precedence || undefined,
    list_id: h["list-id"] || undefined,
    is_calendar: !!r.ics || calendarHeaders(h),
    calendar_event: r.ics ? parseIcs(r.ics, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") : null,
    is_receipt: isReceipt(h),
    receipt: isReceipt(h) ? receiptOf(h, r.report) : null,
  };
}

async function fetchFull(c: Conn, a: Box, ids: string[]): Promise<{ id: string; folder: string; x: Fetched }[]> {
  const f = await folders(c, a);
  const out: { id: string; folder: string; x: Fetched }[] = [];
  const all = [f.sent, ...f.names.filter((n) => !f.special.has(n))];
  let places = await locate(c, a, ids, ["INBOX", ...(f.archive ? [f.archive] : []), ...all]);
  for (let round = 0; round < 2; round++) {
    const gone: string[] = [];
    for (const [folder, uids] of byFolder(places)) {
      await c.select(folder);
      const got = new Map((await c.fetch(uids, "FLAGS INTERNALDATE BODY.PEEK[]")).map((x) => [x.uid, x]));
      for (const [id, p] of places) {
        if (p.folder !== folder) continue;
        const x = got.get(p.uid);
        if (x) out.push({ id, folder, x });
        else gone.push(id);
      }
    }
    // Moved since it was last seen: look again.
    if (!gone.length) break;
    for (const id of gone) placeOf(a).delete(id);
    places = await locate(c, a, gone, ["INBOX", ...(f.archive ? [f.archive] : []), ...all]);
  }
  return out;
}

async function removeUids(c: Conn, uids: number[]) {
  if (!uids.length) return;
  await c.cmd(`UID STORE ${uids.join(",")} +FLAGS.SILENT (\\Deleted)`);
  if (c.caps.has("UIDPLUS")) await c.cmd(`UID EXPUNGE ${uids.join(",")}`);
  // A plain EXPUNGE takes everything marked deleted, so only when that is
  // these and nothing another mail program marked.
  else if ((await c.search("DELETED")).every((u) => uids.includes(u))) await c.cmd("EXPUNGE");
}

async function move(c: Conn, uids: number[], to: string) {
  if (!uids.length) return;
  if (c.caps.has("MOVE")) {
    await c.cmd(`UID MOVE ${uids.join(",")} ${quote(toImapName(to))}`);
    return;
  }
  await c.cmd(`UID COPY ${uids.join(",")} ${quote(toImapName(to))}`);
  await removeUids(c, uids);
}

async function append(c: Conn, folder: string, flags: string, text: string) {
  await c.cmd(`APPEND ${quote(toImapName(folder))} (${flags}) ${LIT}`, [Buffer.from(text, "utf8")]);
}

// ── SMTP ────────────────────────────────────────────────────────────────────

// Send one message. `data` is the whole message without a Bcc header.
async function smtpSend(server: ImapServer["smtp"], user: string, password: string, from: string, rcpts: string[], data: string | null): Promise<void> {
  let sock = await socketTo(server.host, server.port);
  let buf = "";
  let wake: (() => void) | null = null;
  const listen = (s: Socket) => {
    s.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      wake?.();
    });
  };
  listen(sock);
  sock.on("error", () => wake?.());
  const reply = async (timeout = TIMEOUT_MS): Promise<{ code: number; text: string }> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(buf);
      if (m) {
        const all = buf.slice(0, m.index + m[0].length);
        buf = buf.slice(all.length);
        return { code: Number(m[1]), text: all.trim() };
      }
      if (sock.destroyed) throw new Error(`${server.host} closed the connection`);
      if (Date.now() > deadline) throw new Error(`${server.host} did not answer`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 1000).unref();
      });
      wake = null;
    }
  };
  const say = async (line: string | null, ok: number[], timeout?: number) => {
    if (line !== null) sock.write(`${line}\r\n`);
    const r = await reply(timeout);
    if (!ok.includes(r.code)) throw new Error(`The mail server refused it: ${r.text.replace(/^\d{3}[ -]/gm, "").replace(/\r\n/g, " ")}`);
    return r;
  };
  try {
    await say(null, [220]);
    let ehlo = await say("EHLO tabellar.local", [250]);
    if (server.port !== 465) {
      if (/STARTTLS/i.test(ehlo.text)) {
        await say("STARTTLS", [220]);
        sock = await upgrade(sock, server.host);
        listen(sock);
        sock.on("error", () => wake?.());
        ehlo = await say("EHLO tabellar.local", [250]);
      } else if (!loopback(server.host)) throw new Error(`${server.host} offers no encrypted connection on port ${server.port}`);
    }
    if (/AUTH[ =][^\r\n]*PLAIN/i.test(ehlo.text) || !/AUTH[ =][^\r\n]*LOGIN/i.test(ehlo.text)) {
      await say(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString("base64")}`, [235]).catch((e) => {
        throw Object.assign(new Error(`The mail server did not accept the sign-in: ${(e as Error).message}`), { status: 401 });
      });
    } else {
      await say("AUTH LOGIN", [334]);
      await say(Buffer.from(user).toString("base64"), [334]);
      await say(Buffer.from(password).toString("base64"), [235]);
    }
    if (data !== null) {
      await say(`MAIL FROM:<${from}>`, [250]);
      for (const r of rcpts) await say(`RCPT TO:<${r}>`, [250, 251]);
      await say("DATA", [354]);
      const body = data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
      // The upload takes as long as it takes, while it moves; the server then
      // has ten minutes to take the message in (RFC 5321).
      sock.setTimeout(TIMEOUT_MS, () => sock.destroy());
      await new Promise<void>((resolve, reject) => {
        sock.once("close", () => reject(new Error(`${server.host} closed the connection`)));
        sock.write(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`, (e) => (e ? reject(e) : resolve()));
      });
      sock.setTimeout(0);
      await say(null, [250], 600_000).catch((e) => {
        throw /closed the connection|did not answer/.test((e as Error).message) ? new Error(`${server.host} did not confirm it. It may have been sent: look in Sent before sending it again.`) : e;
      });
    }
    sock.write("QUIT\r\n");
  } finally {
    setTimeout(() => sock.destroy(), 1000).unref();
  }
}

function sendWith(a: Box, m: Outgoing): Promise<string> {
  const s = a.server as ImapServer;
  const password = secrets.get(a.token_ref);
  if (!s?.smtp || !password) throw Object.assign(new Error(`The app password for ${a.address} is not on this Mac. Add the account again.`), { status: 401 });
  const id = newMessageId(a.address);
  const date = `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`;
  const rcpts = [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map(address).filter(Boolean);
  const from = address(m.from || a.address);
  return smtpSend(s.smtp, s.smtp.user || s.user || a.address, password, from, rcpts, writeMessage({ ...m, bcc: undefined }, [date, `Message-ID: ${id}`])).then(() => writeMessage(m, [date, `Message-ID: ${id}`]));
}

// ── The mailbox ─────────────────────────────────────────────────────────────

type Cursor = { v: number; n: number; s: number };
const readCursor = (s: string | null): Cursor | null => {
  try {
    const c = JSON.parse(s ?? "");
    return typeof c?.v === "number" ? c : null;
  } catch {
    return null;
  }
};

async function cursorNow(c: Conn, a: Box): Promise<Cursor> {
  const f = await folders(c, a);
  const inbox = await c.select("INBOX");
  const sent = f.names.includes(f.sent) ? await c.select(f.sent) : { next: 0 };
  return { v: inbox.validity, n: inbox.next, s: sent.next };
}

// What STATUS said last, and whether IDLE saw something since.
const lastStatus = new Map<string, string>();
const dirty = new Set<string>();
const idlers = new Map<string, () => void>();

async function draftRemove(c: Conn, a: Box, draftId: string) {
  const f = await folders(c, a);
  if (!f.names.includes(f.drafts)) return;
  await c.select(f.drafts);
  await removeUids(c, await c.search(`HEADER MESSAGE-ID ${quote(draftId)}`));
}

const bare = (id: string) => id.replace(/^<|>$/g, "");

// A thread is named by the Message-ID that started it, which every answer has
// to carry first in its References to stay in it.
const rootOf = (threadId: string | undefined) => (threadId?.includes("@") && !threadId.startsWith("uid:") ? `<${bare(threadId)}>` : undefined);

export const imapMailbox: Mail = {
  cursor: (a) => session(a, async (c) => JSON.stringify(await cursorNow(c, a))),

  changes: (a, cursor) =>
    session(a, async (c): Promise<MailboxChanges> => {
      const before = readCursor(cursor);
      const out: MailboxChanges = { tooOld: false, historyId: null, added: [], sentAdded: false, labels: [], deleted: [] };
      const now = await cursorNow(c, a);
      if (!before || before.v !== now.v) {
        for (const [id, p] of placeOf(a)) if (p.folder === "INBOX") placeOf(a).delete(id);
        return { ...out, tooOld: true };
      }
      await c.select("INBOX");
      const uids = new Set(await c.search(`SINCE ${searchDate(Date.now() - 31 * DAY)}`));
      if (now.n > before.n) for (const u of await c.search(`UID ${before.n}:*`)) if (u >= before.n) uids.add(u);
      // Flags for all of them; headers only for messages not seen before.
      const flags = await c.fetch([...uids], "FLAGS");
      // What left the Inbox is looked for again when it is needed.
      const inboxUids = new Set(flags.map((x) => x.uid));
      for (const [id, p] of placeOf(a)) if (p.folder === "INBOX" && !inboxUids.has(p.uid)) placeOf(a).delete(id);
      const idAt = new Map([...placeOf(a)].filter(([, p]) => p.folder === "INBOX").map(([id, p]) => [p.uid, id]));
      for (const p of await readHeads(c, a, "INBOX", flags.filter((x) => !idAt.has(x.uid)).map((x) => x.uid))) idAt.set(p.uid, p.id);
      const present = flags.filter((x) => idAt.has(x.uid)).map((x) => ({ uid: x.uid, flags: x.flags, id: idAt.get(x.uid)! }));
      const ids = present.map((p) => p.id);
      const stored = new Set<string>();
      for (let i = 0; i < ids.length; i += 500) {
        const { data } = await db.from("emails").select("gmail_id").eq("account_id", a.id).in("gmail_id", ids.slice(i, i + 500));
        for (const r of data ?? []) stored.add(r.gmail_id as string);
      }
      for (const p of present) {
        if (p.uid >= before.n) out.added.push(p.id);
        if (!stored.has(p.id)) continue;
        const unread = !p.flags.includes("\\seen");
        const starred = p.flags.includes("\\flagged");
        out.labels.push({ id: p.id, add: ["INBOX", ...(unread ? ["UNREAD"] : []), ...(starred ? ["STARRED"] : [])], remove: [...(unread ? [] : ["UNREAD"]), ...(starred ? [] : ["STARRED"])] });
      }
      // Stored as in the Inbox, but no longer there: archived, moved or deleted elsewhere.
      const { data: inInbox } = await db
        .from("emails")
        .select("gmail_id")
        .eq("account_id", a.id)
        .contains("label_ids", ["INBOX"])
        .gte("received_at", new Date(Date.now() - 29 * DAY).toISOString())
        .limit(5000);
      const here = new Set(ids);
      for (const r of inInbox ?? []) if (!here.has(r.gmail_id as string)) out.labels.push({ id: r.gmail_id as string, add: [], remove: ["INBOX"] });
      out.sentAdded = now.s > before.s;
      out.historyId = JSON.stringify(now);
      lastStatus.delete(a.id);
      return out;
    }),

  moved: (a) =>
    session(a, async (c) => {
      const was = dirty.delete(a.id);
      const rows = await c.cmd("STATUS INBOX (UIDNEXT MESSAGES UNSEEN)");
      const status = rows
        .filter((r) => str(r[1]).toUpperCase() === "STATUS")
        .map((r) => r.map((t) => (Array.isArray(t) ? t.map(str).join(" ") : str(t))).join(" "))
        .join("|");
      const prev = lastStatus.get(a.id);
      lastStatus.set(a.id, status);
      const next = Number(status.match(/UIDNEXT (\d+)/i)?.[1] ?? 0);
      return was || (prev === undefined ? next !== readCursor(a.history_id)?.n : prev !== status);
    }),

  list: (a, q) =>
    session(a, async (c) => {
      const f = await folders(c, a);
      const look = q.inbox ? ["INBOX"] : ["INBOX", ...(f.archive ? [f.archive] : []), f.sent].filter((n) => n === "INBOX" || f.names.includes(n));
      const rows: HeaderRow[] = [];
      for (const folder of look) {
        await c.select(folder);
        const uids = await c.search(q.days ? `SINCE ${searchDate(Date.now() - q.days * DAY)}` : "ALL");
        rows.push(...(await readHeads(c, a, folder, uids.slice(-q.cap))).map((p) => p.row));
      }
      const ids = [...new Set(rows.sort((x, y) => y.at.localeCompare(x.at)).map((r) => r.gmail_id))];
      return ids.slice(0, q.cap);
    }),

  fetch: (a, ids) =>
    session(a, async (c) => {
      const f = await folders(c, a);
      return (await fetchFull(c, a, ids)).map(({ id, folder, x }) => {
        try {
          return emailOf(f, folder, id, x);
        } catch (e) {
          // A message that cannot be taken apart is kept with its headers alone.
          console.error(`[imap] ${a.address}: a message could not be read:`, (e as Error).message);
          const end = x.body?.indexOf("\r\n\r\n") ?? -1;
          return emailOf(f, folder, id, { ...x, body: Buffer.concat([x.body!.subarray(0, Math.max(0, end)), Buffer.from("\r\nContent-Type: text/plain\r\n\r\n")]) });
        }
      });
    }),

  headerRows: (a, ids) =>
    session(a, async (c) => {
      const known = rowsOf(a);
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length) {
        const f = await folders(c, a);
        for (const [folder, uids] of byFolder(await locate(c, a, missing, ["INBOX", ...(f.archive ? [f.archive] : []), f.sent]))) await readHeads(c, a, folder, uids);
      }
      return ids.map((id) => known.get(id)).filter((r): r is HeaderRow => !!r);
    }),

  sent: (a, max) =>
    session(a, async (c): Promise<Sent[]> => {
      const f = await folders(c, a);
      if (!f.names.includes(f.sent)) return [];
      const { validity } = await c.select(f.sent);
      const uids = (await c.search("ALL")).slice(-max);
      const got = await c.fetch(uids, "FLAGS INTERNALDATE BODY.PEEK[]");
      return got.reverse().flatMap((x) => {
        try {
          return [sentOf(x)];
        } catch (e) {
          console.error(`[imap] ${a.address}: a sent message could not be read:`, (e as Error).message);
          return [];
        }
      });
      function sentOf(x: Fetched): Sent {
        const r = readMessage(x.body ?? Buffer.alloc(0));
        const h = r.headers;
        const id = idOf(h, f.sent, validity, x.uid);
        placeOf(a).set(id, { folder: f.sent, uid: x.uid });
        const body = r.text || htmlToText(r.html);
        return {
          id, thread_id: threadOf(h, id), subject: h.subject ?? "", from: h.from ?? "", to: h.to ?? "", cc: h.cc ?? "", date: h.date || x.date,
          body_html: r.html, body, snippet: body.replace(/\s+/g, " ").trim().slice(0, 200), has_attachments: r.attachments.length > 0, attachments: r.attachments,
        };
      }
    }),

  headers: (a, id, names) =>
    session(a, async (c) => {
      const f = await folders(c, a);
      const p = (await locate(c, a, [id], ["INBOX", ...(f.archive ? [f.archive] : []), f.sent])).get(id);
      if (!p) throw new Error("The message is no longer in the mailbox");
      await c.select(p.folder);
      const [x] = await c.fetch([p.uid], `BODY.PEEK[HEADER.FIELDS (${names.map((n) => n.toUpperCase()).join(" ")})]`);
      return parseHeaders(x?.head?.toString("utf8") ?? "");
    }),

  threadOf: async (a, id) => (await imapMailbox.headerRows(a, [id]))[0]?.thread_id ?? "",

  async send(a, m, threadId) {
    const text = await sendWith(a, { ...m, root: rootOf(threadId) });
    const id = bare(text.match(/^Message-ID: (\S+)/m)![1]);
    // Keep a copy in Sent, unless the server already put one there.
    await session(a, async (c) => {
      const f = await folders(c, a);
      if (!f.names.includes(f.sent)) await makeFolder(c, a, f.sent);
      await c.select(f.sent);
      if (!(await c.search(`HEADER MESSAGE-ID ${quote(id)}`)).length) await append(c, f.sent, "\\Seen", text);
    }).catch((e) => console.error(`[imap] keeping a copy in Sent for ${a.address}:`, (e as Error).message));
    return { id };
  },

  drafts: (a) =>
    session(a, async (c) => {
      const f = await folders(c, a);
      if (!f.names.includes(f.drafts)) return [];
      const { validity } = await c.select(f.drafts);
      const uids = (await c.search("ALL")).slice(-500);
      const got = uids.length ? await c.fetch(uids, "BODY.PEEK[HEADER.FIELDS (MESSAGE-ID REFERENCES IN-REPLY-TO)]") : [];
      return got.map((x) => {
        const h = parseHeaders(x.head?.toString("utf8") ?? "");
        const id = idOf(h, f.drafts, validity, x.uid);
        return { id, threadId: threadOf(h, id), version: `${validity}:${x.uid}` };
      });
    }),

  readDraft: (a, draftId) =>
    session(a, async (c) => {
      const f = await folders(c, a);
      if (!f.names.includes(f.drafts)) return null;
      await c.select(f.drafts);
      const uid = (await c.search(`HEADER MESSAGE-ID ${quote(bare(draftId))}`)).at(-1);
      const [x] = uid ? await c.fetch([uid], "BODY.PEEK[]") : [];
      if (!x?.body) return null;
      const r = readMessage(x.body);
      const h = r.headers;
      return { text: r.text || htmlToText(r.html), html: r.html, subject: h.subject ?? "", to: h.to ?? "", cc: h.cc ?? "", bcc: h.bcc ?? "" };
    }),

  saveDraft: (a, draftId, m, threadId) =>
    session(a, async (c) => {
      const f = await folders(c, a);
      if (!f.names.includes(f.drafts)) await makeFolder(c, a, f.drafts);
      const id = newMessageId(a.address);
      await append(c, f.drafts, "\\Draft \\Seen", writeMessage({ ...m, root: rootOf(threadId) }, [`Date: ${new Date().toUTCString().replace("GMT", "+0000")}`, `Message-ID: ${id}`]));
      if (draftId) await draftRemove(c, a, bare(draftId));
      return bare(id);
    }),

  // By the Message-ID Tabellar gave it, in the Drafts folder only.
  discardDraft: (a, draftId) => session(a, (c) => draftRemove(c, a, bare(draftId))),

  async sendDraft(a, draftId, m, threadId) {
    const sent = await imapMailbox.send(a, m, threadId);
    await session(a, (c) => draftRemove(c, a, bare(draftId))).catch(() => {});
    return sent;
  },

  label: (a, name) =>
    session(a, async (c) => {
      const f = await folders(c, a);
      const folder = folderOf(f, name);
      if (!f.names.includes(folder)) await makeFolder(c, a, folder);
      return name;
    }),

  labelNames: (a) =>
    session(a, async (c) => {
      const f = await folders(c, a, true);
      return f.names.filter((n) => !f.special.has(n)).map((n) => labelOf(f, n));
    }),

  modify: (a, ids, add, remove) =>
    session(a, async (c) => {
      const f = await folders(c, a);
      const system = new Set(["INBOX", "UNREAD", "STARRED"]);
      const places = await locate(c, a, ids);
      const flag = (list: string[], label: string, imapFlag: string, on: boolean) => (list.includes(label) ? [`${on ? "+" : "-"}FLAGS.SILENT (${imapFlag})`] : []);
      const stores = [...flag(add, "UNREAD", "\\Seen", false), ...flag(remove, "UNREAD", "\\Seen", true), ...flag(add, "STARRED", "\\Flagged", true), ...flag(remove, "STARRED", "\\Flagged", false)];
      for (const [folder, uids] of byFolder(places)) {
        await c.select(folder);
        for (const s of stores) await c.cmd(`UID STORE ${uids.join(",")} ${s}`);
        for (const label of add.filter((l) => !system.has(l))) {
          const target = folderOf(f, label);
          if (!f.names.includes(target)) await makeFolder(c, a, target);
          await c.cmd(`UID COPY ${uids.join(",")} ${quote(toImapName(target))}`);
        }
      }
      // A label's copy goes, but the last copy of a message is moved to
      // Archive. Whether another copy exists is asked of the server now, never
      // taken from what was seen before.
      const labelsOff = remove.filter((l) => !system.has(l) && f.names.includes(folderOf(f, l)));
      const elsewhere = new Set<string>();
      if (labelsOff.length) {
        for (const folder of ["INBOX", ...(f.archive ? [f.archive] : [])]) {
          await c.select(folder);
          for (const id of ids) if ((await c.search(`HEADER MESSAGE-ID ${quote(id)}`)).length) elsewhere.add(id);
        }
      }
      for (const label of labelsOff) {
        const folder = folderOf(f, label);
        await c.select(folder);
        const drop: number[] = [];
        const keep: number[] = [];
        for (const id of ids) {
          for (const uid of await c.search(`HEADER MESSAGE-ID ${quote(id)}`)) (elsewhere.has(id) ? drop : keep).push(uid);
        }
        await removeUids(c, drop);
        if (keep.length) await move(c, keep, await archiveFolder(c, a));
      }
      if (remove.includes("INBOX")) {
        const inbox = [...places].filter(([, p]) => p.folder === "INBOX");
        const archive = await archiveFolder(c, a);
        await c.select("INBOX");
        await move(c, [...new Set(inbox.flatMap(([id, p]) => [p.uid, ...(copiesOf(a).get(id) ?? [])]))], archive);
        for (const [id] of inbox) {
          placeOf(a).delete(id);
          copiesOf(a).delete(id);
        }
      }
      if (add.includes("INBOX") && f.archive) {
        const archived = [...places].filter(([, p]) => p.folder === f.archive);
        await c.select(f.archive);
        await move(c, archived.map(([, p]) => p.uid), "INBOX");
        for (const [id] of archived) placeOf(a).delete(id);
      }
    }),

  sendAs: async (a) => [{ address: a.address.toLowerCase(), name: "", default: true }],

  hasSentTo: (a, to) =>
    session(a, async (c) => {
      const f = await folders(c, a);
      if (!f.names.includes(f.sent)) return false;
      await c.select(f.sent);
      // A search finds the text anywhere in the header ("am@x.com" in "sam@x.com").
      const uids = (await c.search(`TO ${quote(to)}`)).slice(-20);
      return (await readHeads(c, a, f.sent, uids)).some((p) => addressesIn(`${p.row.to}, ${p.row.cc}`).includes(to.toLowerCase()));
    }),

  // IMAP cannot ask for attachments, only for the message type that carries
  // them, and takes plain ASCII search words.
  files: (a, q, cap) =>
    session(a, async (c) => {
      if (!/^[\x20-\x7e]*$/.test(q.text + q.from)) return [];
      const f = await folders(c, a);
      const found: HeaderRow[] = [];
      for (const folder of ["INBOX", ...(f.archive ? [f.archive] : []), f.sent].filter((n) => n === "INBOX" || f.names.includes(n))) {
        await c.select(folder);
        const words = quote(q.text);
        const uids = await c.search(`HEADER CONTENT-TYPE "multipart/mixed"${q.from ? ` FROM ${quote(q.from)}` : ""}${q.text ? ` OR OR FROM ${words} TO ${words} OR SUBJECT ${words} BODY ${words}` : ""}`);
        found.push(...(await readHeads(c, a, folder, uids.slice(-cap))).map((p) => p.row));
      }
      return found.sort((x, y) => y.at.localeCompare(x.at)).map((r) => r.gmail_id).slice(0, cap);
    }),

  attachment: (a, id, attachmentId) =>
    session(a, async (c) => {
      const [m] = await fetchFull(c, a, [id]);
      const part = m?.x.body ? partAt(m.x.body, attachmentId) : null;
      return part ? { data: part.body.toString("base64url"), size: part.body.length } : null;
    }),

  // IDLE on a connection of its own; `wake` runs when the Inbox changes.
  watch(a, wake) {
    if (idlers.has(a.id)) return;
    let stop = false;
    let conn: Conn | null = null;
    idlers.set(a.id, () => {
      stop = true;
      conn?.close();
    });
    void (async () => {
      while (!stop) {
        try {
          conn = await login(a);
          if (!conn.caps.has("IDLE")) return conn.logout();
          await conn.select("INBOX");
          conn.onUntagged = (t) => {
            if (/^(EXISTS|EXPUNGE|FETCH)$/i.test(str(t[2]))) {
              dirty.add(a.id);
              wake();
            }
          };
          // Servers end IDLE after 30 minutes; it is renewed every 25.
          while (!stop && !conn.closed) {
            const done = conn.cmd("IDLE", [], 0);
            done.catch(() => {});
            await Promise.race([new Promise((r) => setTimeout(r, 25 * 60_000).unref()), conn.gone]);
            if (conn.closed) break;
            conn.write("DONE\r\n");
            const stuck = setTimeout(() => conn?.close(), 30_000);
            await done.finally(() => clearTimeout(stuck));
          }
        } catch {
          // A dropped connection or no network: try again in a minute.
        }
        conn?.close();
        if (!stop) await new Promise((r) => setTimeout(r, 60_000).unref());
      }
    })();
  },

  async disconnect(a) {
    idlers.get(a.id)?.();
    idlers.delete(a.id);
    pool.get(a.id)?.conn?.logout();
    pool.delete(a.id);
    for (const m of [folderCache, where, copies, seenRows, lastStatus]) m.delete(a.id);
    secrets.delete(a.token_ref);
  },
};

// ── Adding an account ───────────────────────────────────────────────────────

// Sign in to both servers with the address and app password, keep the
// password in the Keychain, and return what the account row needs. Nothing
// is sent. `users` are the user names to try, in order.
export async function connectImap(input: { address: string; password: string; imap: ImapServer["imap"]; smtp: ImapServer["smtp"]; users: string[]; choice: string }): Promise<{ server: ImapServer; tokenRef: string }> {
  let user = "";
  let lastError: Error | null = null;
  for (const u of input.users) {
    try {
      const c = await open(input.imap, u, input.password);
      c.logout();
      user = u;
      break;
    } catch (e) {
      lastError = e as Error;
    }
  }
  if (!user) throw lastError ?? new Error("The mail server did not accept the sign-in");
  // The SMTP server may want the other user name (iCloud: the whole address).
  let smtpUser = "";
  for (const u of [...new Set([user, input.address])]) {
    try {
      await smtpSend(input.smtp, u, input.password, "", [], null);
      smtpUser = u;
      break;
    } catch (e) {
      lastError = e as Error;
    }
  }
  if (!smtpUser) throw lastError!;
  const tokenRef = `imap:${createHash("sha256").update(`${input.address.toLowerCase()}|${input.imap.host}`).digest("hex").slice(0, 16)}`;
  secrets.set(tokenRef, input.password);
  return { server: { choice: input.choice, imap: input.imap, smtp: { ...input.smtp, ...(smtpUser !== user ? { user: smtpUser } : {}) }, user }, tokenRef };
}
