// Who the user deals with, from headers alone.
//
// mail_index keeps one row per message the first read or a later sync saw:
// who sent it, to whom, in which thread, whether it is still unread or in the
// inbox, and the headers that mark a mailing list. senders adds that up per
// address, with no model call:
//   received         messages from them
//   opened           of those, read
//   replied          threads where the user wrote after they did
//   wrote_first      threads the user started with them in To or Cc
//   sent_to          messages the user sent them
//   archived_unread  their mail the user archived without reading
// plus whether their mail carries List-Unsubscribe, its List-Id and
// Precedence, and Gmail's usual category for it.
//
// profile.ts asks it whether the user knows a sender; isBulk() decides from
// headers whether mail is bulk, so the model never reads it.

import { db } from "./db.ts";
import { addressOf } from "./mime.ts";
import type { HeaderRow } from "./providers.ts";

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const ADDRESS = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[a-z]{2,}/gi;

export const addressesIn = (header: string): string[] => [...new Set([...String(header ?? "").matchAll(ADDRESS)].map((m) => lc(m[0])))];

function nameIn(from: string): string {
  const name = String(from ?? "").split("<")[0].replace(/"/g, "").trim();
  return name.includes("@") ? "" : name;
}

const CATEGORY: Record<string, string> = {
  CATEGORY_PERSONAL: "primary",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
};

// The user's own addresses: every connected account, every address it can
// send as (Gmail's "Send mail as" list), and every address their sent mail
// went out from.
export async function ownAddresses(userId: string): Promise<Set<string>> {
  const [{ data }, { data: from }] = await Promise.all([
    db.from("accounts").select("address, send_as").eq("user_id", userId),
    db.from("mail_index").select("from_addr").eq("user_id", userId).eq("sent", true).limit(10_000),
  ]);
  const aliases = (data ?? []).flatMap((a) => ((a.send_as as { address: string }[] | null) ?? []).map((s) => lc(s.address)));
  return new Set([...(data ?? []).map((a) => lc(a.address)), ...aliases, ...(from ?? []).map((r) => lc(r.from_addr))].filter(Boolean));
}

// Someone the mailbox or the address book has seen. Models make up an address
// for a name they were given, and an invitation must not go to one.
export async function metAddress(userId: string, address: string): Promise<boolean> {
  const a = lc(address);
  const [{ count: seen }, { count: contact }] = await Promise.all([
    db.from("senders").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("address", a),
    db.from("contacts").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("email", a),
  ]);
  return !!seen || !!contact;
}

// Of these, the ones that are real: met before, or written out in the text.
export async function realAttendees(userId: string, given: unknown, text: string): Promise<string[]> {
  const out: string[] = [];
  for (const x of Array.isArray(given) ? given : []) {
    const a = lc(addressOf(String(x)));
    if (a.includes("@") && !out.includes(a) && (lc(text).includes(a) || (await metAddress(userId, a)))) out.push(a);
  }
  return out;
}

// Add messages to mail_index; a message seen again updates its row.
export async function indexMail(userId: string, accountId: string, rows: HeaderRow[], own: Set<string>): Promise<void> {
  const out = rows.map((r) => {
    const from = addressesIn(addressOf(r.from))[0] ?? "";
    const category = r.labels.map((l) => CATEGORY[l]).find(Boolean) ?? null;
    return {
      user_id: userId,
      account_id: accountId,
      gmail_id: r.gmail_id,
      thread_id: r.thread_id || null,
      at: r.at,
      from_addr: from,
      from_name: nameIn(r.from),
      to_addrs: addressesIn(`${r.to}, ${r.cc}`),
      sent: r.labels.includes("SENT") || own.has(from),
      inbox: r.labels.includes("INBOX"),
      unread: r.labels.includes("UNREAD"),
      category,
      list_unsubscribe: r.list_unsubscribe,
      list_id: r.list_id || null,
      precedence: r.precedence || null,
    };
  });
  for (let i = 0; i < out.length; i += 500) {
    await db.from("mail_index").upsert(out.slice(i, i + 500), { onConflict: "user_id,gmail_id" });
  }
}

type Stat = {
  address: string;
  name: string;
  received: number;
  opened: number;
  replied: number;
  wrote_first: number;
  sent_to: number;
  archived_unread: number;
  list_unsubscribe: boolean;
  list_id: string | null;
  precedence: string | null;
  categories: Record<string, number>;
  first_at: string;
  last_at: string;
};

type IndexRow = {
  thread_id: string | null;
  at: string;
  from_addr: string;
  from_name: string | null;
  to_addrs: string[];
  sent: boolean;
  inbox: boolean;
  unread: boolean;
  category: string | null;
  list_unsubscribe: boolean;
  list_id: string | null;
  precedence: string | null;
};

// Add mail_index up into senders. With `only`, just those addresses are
// written. Returns how many senders there are.
export async function rebuildSenders(userId: string, only?: Set<string>): Promise<number> {
  const own = await ownAddresses(userId);
  const { data } = await db
    .from("mail_index")
    .select("thread_id, at, from_addr, from_name, to_addrs, sent, inbox, unread, category, list_unsubscribe, list_id, precedence")
    .eq("user_id", userId)
    .order("at", { ascending: true })
    .limit(50_000);
  const rows = (data ?? []) as IndexRow[];

  const stats = new Map<string, Stat>();
  const stat = (address: string, at: string): Stat => {
    let s = stats.get(address);
    if (!s) {
      s = { address, name: "", received: 0, opened: 0, replied: 0, wrote_first: 0, sent_to: 0, archived_unread: 0, list_unsubscribe: false, list_id: null, precedence: null, categories: {}, first_at: at, last_at: at };
      stats.set(address, s);
    }
    s.last_at = at;
    return s;
  };

  const threads = new Map<string, IndexRow[]>();
  for (const r of rows) {
    const key = r.thread_id || `${r.at}|${r.from_addr}`;
    const t = threads.get(key) ?? [];
    t.push(r);
    threads.set(key, t);
  }

  for (const thread of threads.values()) {
    const startedByUser = thread[0].sent;
    const lastSentAt = thread.filter((r) => r.sent).at(-1)?.at ?? "";
    const counted = new Set<string>();
    for (const r of thread) {
      if (r.sent) {
        for (const a of r.to_addrs) {
          if (own.has(a)) continue;
          const s = stat(a, r.at);
          s.sent_to++;
          if (startedByUser && !counted.has(`first:${a}`)) {
            s.wrote_first++;
            counted.add(`first:${a}`);
          }
        }
        continue;
      }
      if (!r.from_addr || own.has(r.from_addr)) continue;
      const s = stat(r.from_addr, r.at);
      if (r.from_name) s.name = r.from_name;
      s.received++;
      if (!r.unread) s.opened++;
      if (r.unread && !r.inbox) s.archived_unread++;
      if (r.list_unsubscribe) s.list_unsubscribe = true;
      if (r.list_id) s.list_id = r.list_id;
      if (r.precedence) s.precedence = r.precedence;
      if (r.category) s.categories[r.category] = (s.categories[r.category] ?? 0) + 1;
      if (lastSentAt > r.at && !counted.has(`reply:${r.from_addr}`)) {
        s.replied++;
        counted.add(`reply:${r.from_addr}`);
      }
    }
  }

  const now = new Date().toISOString();
  const out = [...stats.values()]
    .filter((s) => !only || only.has(s.address))
    .map(({ categories, ...s }) => ({
      ...s,
      user_id: userId,
      name: s.name || null,
      domain: s.address.split("@")[1] ?? "",
      category: Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      updated_at: now,
    }));
  for (let i = 0; i < out.length; i += 200) {
    await db.from("senders").upsert(out.slice(i, i + 200), { onConflict: "user_id,address" });
  }
  return stats.size;
}

// ── Bulk mail ───────────────────────────────────────────────────────────────

// Addresses at these domains are people, not one company.
const SHARED_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com"]);

export type Written = { addresses: Set<string>; domains: Set<string> };

// Who the user has written to: the addresses, and the company domains (not
// shared mail services, not the user's own domain).
export async function writtenTo(userId: string): Promise<Written> {
  const [{ data }, own] = await Promise.all([
    db.from("senders").select("address, domain").eq("user_id", userId).gt("sent_to", 0).limit(20_000),
    ownAddresses(userId),
  ]);
  const ownDomains = new Set([...own].map((a) => a.split("@")[1]));
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const r of data ?? []) {
    addresses.add(lc(r.address));
    const d = lc(r.domain);
    if (d && !SHARED_DOMAINS.has(d) && !ownDomains.has(d)) domains.add(d);
  }
  return { addresses, domains };
}

// Bulk mail, from headers alone: Gmail's promotions category, or
// List-Unsubscribe together with List-Id or Precedence: bulk. Never mail from
// someone the user wrote to, or from a company they wrote to (the job
// application system they applied through), and never a post to a discussion
// list (Precedence: list), which is a person writing to a group.
type Headers = { sender_email?: string | null; sender?: string | null; label_ids?: string[] | null; has_list_unsubscribe?: boolean | null; list_id?: string | null; precedence_header?: string | null };

// Someone the user wrote to, a company they wrote to, or a job application
// system: never bulk, never sorted without the model.
function personal(m: Headers, written: Written): boolean {
  const address = lc(m.sender_email);
  const domain = address.split("@")[1] ?? "";
  if (written.addresses.has(address) || [...written.domains].some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return jobSystem(address, m.sender);
}

export function isBulk(m: Headers, written: Written): boolean {
  if (personal(m, written)) return false;
  if ((m.label_ids ?? []).includes("CATEGORY_PROMOTIONS")) return true;
  return bulkHeaders(!!m.has_list_unsubscribe, m.list_id, m.precedence_header);
}

// Mail the model need not read: bulk, or mail with List-Unsubscribe that Gmail
// kept out of Primary (Updates, Forums, Social), from no one the user wrote to
// and not a post to a discussion list. A mailbox without a Promotions tab (a
// university or company Google account) gets its mass mail this way: on one
// such mailbox the model called every one of these 82 emails promotions.
// With `old` (mail too old for anything to be made from it, which the model
// would only summarise), anything Gmail kept out of Primary from a stranger.
// Broader than isBulk, which decides what the Newsletters page offers to
// unsubscribe from.
export function readWithoutModel(m: Headers, written: Written, old = false): boolean {
  if (isBulk(m, written)) return true;
  if (personal(m, written) || /^\s*list\s*$/i.test(m.precedence_header ?? "")) return false;
  if (!m.has_list_unsubscribe && !old) return false;
  const labels = m.label_ids ?? [];
  return labels.some((l) => l.startsWith("CATEGORY_") && l !== "CATEGORY_PERSONAL");
}

// Job application systems and recruiting teams. Mail about an application
// is never bulk, however it is sent: the model reads it.
const ATS = /(^|[.@])(greenhouse|greenhouse-mail|lever|hire\.lever|myworkday|workday|smartrecruiters|ashbyhq|icims|jobvite|taleo|successfactors|bamboohr|breezy|rippling|workable|teamtailor|recruitee|personio|hackerrank|codesignal)\.|(^|[.@])ats\./i;
const RECRUITING = /recruit|careers?\b|earlycareers|talent acquisition|hiring|\bjobs?\b/i;
export function jobSystem(address: string, name?: string | null): boolean {
  const local = address.split("@")[0] ?? "";
  return ATS.test(address) || RECRUITING.test(local) || RECRUITING.test(String(name ?? "").split("<")[0]);
}

// The header half of isBulk, for one email or a sender's usual headers.
export function bulkHeaders(listUnsubscribe: boolean, listId: string | null | undefined, precedence: string | null | undefined): boolean {
  if (/^\s*list\s*$/i.test(precedence ?? "")) return false;
  return listUnsubscribe && (!!listId || /bulk/i.test(precedence ?? ""));
}
