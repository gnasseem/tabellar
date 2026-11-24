// Newsletter cleanup: the senders of bulk mail, how much of the inbox each
// fills, and unsubscribing from them or archiving all they sent.
//
// Everything here is done because the user clicked in the window; the engine
// never unsubscribes (policy.ts refuses it). Unsubscribing follows the
// sender's List-Unsubscribe header, read fresh from the mailbox each time:
//   one-click  RFC 8058: a POST to the sender's https link, done here
//   mailto     an email to the address in the header, only after the user has
//              seen and confirmed that exact address (the header is written by
//              the sender, so it could name anyone)
//   web        a page the user has to finish on; the window opens it

import { db } from "./db.ts";
import { mail } from "./providers.ts";
import { fromLine, replyFrom, type Account } from "./accounts.ts";
import { act, engineSettings, record } from "./actions.ts";
import { decide } from "./policy.ts";
import { allPrefs, pick, stops } from "./profile.ts";
import { bulkHeaders, jobSystem, ownAddresses, writtenTo } from "./senders.ts";

type Sender = {
  sender_email: string;
  name: string;
  total: number;
  opened: number;
  inbox: number;
  unread: number;
  last_at: string;
  can_unsubscribe: boolean;
  reason: string;
  status: "kept" | "unsubscribed" | null;
  method: string | null;
};

type Stat = { address: string; name: string | null; domain: string; received: number; opened: number; list_unsubscribe: boolean; list_id: string | null; precedence: string | null; category: string | null; last_at: string };

// Senders of bulk mail, noisiest in the inbox first. Bulk by the headers of
// the mail they send (senders.isBulk's rule: promotions, or List-Unsubscribe
// with List-Id or Precedence bulk, and not a post to a discussion list),
// never what the model called it; never a job application system; never
// someone or a company the user wrote to; at least two emails; an address on
// the user's own domain only when its mail carries List-Unsubscribe.
export async function listNewsletters(userId: string): Promise<Sender[]> {
  const [{ data: stats }, { data: marks }, prefs, written, own] = await Promise.all([
    db.from("senders").select("address, name, domain, received, opened, list_unsubscribe, list_id, precedence, category, last_at").eq("user_id", userId).gte("received", 2).limit(20_000),
    db.from("newsletter_senders").select("sender_email, status, method").eq("user_id", userId),
    allPrefs(userId),
    writtenTo(userId),
    ownAddresses(userId),
  ]);
  const ownDomains = new Set([...own].map((a) => a.split("@")[1]));
  const marked = new Map<string, { status?: unknown; method?: unknown }>((marks ?? []).map((m: Record<string, unknown>) => [String(m.sender_email), m]));
  const listed = ((stats ?? []) as Stat[]).filter((s) => {
    const bulk = s.category === "promotions" || bulkHeaders(s.list_unsubscribe, s.list_id, s.precedence);
    if (!bulk || jobSystem(s.address, s.name) || stops(pick(prefs, s.address, ""), "newsletter")) return false;
    if (written.addresses.has(s.address) || [...written.domains].some((d) => s.domain === d || s.domain.endsWith(`.${d}`))) return false;
    return !ownDomains.has(s.domain) || s.list_unsubscribe;
  });
  if (!listed.length) return [];

  // Why a sender is listed, in the words of the header that made it bulk.
  const reason = (s: Stat) => {
    const opened = s.opened ? `${s.opened.toLocaleString()} opened` : "none opened";
    const why = s.category === "promotions" ? "Gmail Promotions" : s.list_id ? "Mailing list" : "Sent in bulk";
    return `${why}, ${s.received.toLocaleString()} emails, ${opened}`;
  };

  // What is still in the inbox here, which is what Archive moves.
  const inbox = new Map<string, { inbox: number; unread: number }>();
  const addresses = listed.map((s) => s.address);
  for (let i = 0; i < addresses.length; i += 300) {
    const { data } = await db.from("emails").select("sender_email, is_read, is_archived, label_ids").eq("user_id", userId).in("sender_email", addresses.slice(i, i + 300)).limit(50_000);
    for (const e of data ?? []) {
      const c = inbox.get(String(e.sender_email).toLowerCase()) ?? { inbox: 0, unread: 0 };
      if (!e.is_archived && ((e.label_ids as string[] | null) ?? []).includes("INBOX")) c.inbox++;
      if (!e.is_read) c.unread++;
      inbox.set(String(e.sender_email).toLowerCase(), c);
    }
  }
  return listed
    .map((s) => {
      const m = marked.get(s.address);
      return {
        sender_email: s.address,
        name: s.name || s.address,
        total: s.received,
        opened: s.opened,
        inbox: inbox.get(s.address)?.inbox ?? 0,
        unread: inbox.get(s.address)?.unread ?? 0,
        last_at: s.last_at,
        can_unsubscribe: s.list_unsubscribe,
        reason: reason(s),
        status: (m?.status as Sender["status"]) ?? null,
        method: (m?.method as string) ?? null,
      };
    })
    .sort((a, b) => b.inbox - a.inbox || b.total - a.total)
    .slice(0, 300);
}

async function mailFrom(userId: string, sender: string, inboxOnly: boolean) {
  let q = db
    .from("emails")
    .select("id, gmail_id, has_list_unsubscribe, label_ids, is_archived, accounts(*)")
    .eq("user_id", userId)
    .ilike("sender_email", sender.replace(/[%_]/g, ""))
    .order("received_at", { ascending: false });
  if (inboxOnly) q = q.eq("is_archived", false).contains("label_ids", ["INBOX"]);
  const { data } = await q.limit(5000);
  return data ?? [];
}

async function mark(userId: string, sender: string, status: "kept" | "unsubscribed", method: string | null) {
  await db
    .from("newsletter_senders")
    .upsert({ user_id: userId, sender_email: sender, status, method, updated_at: new Date().toISOString() }, { onConflict: "user_id,sender_email" });
}

export async function keepSender(userId: string, sender: string, keep: boolean): Promise<void> {
  if (keep) await mark(userId, sender, "kept", null);
  else await db.from("newsletter_senders").delete().eq("user_id", userId).eq("sender_email", sender);
}

// Archive everything from one sender still in the inbox, as one action that
// undo returns to the inbox in one go.
export async function archiveSender(userId: string, sender: string): Promise<{ archived: number; result: string }> {
  const mail = await mailFrom(userId, sender, true);
  if (!mail.length) return { archived: 0, result: "done" };
  const settings = await engineSettings(userId);
  const result = await act(
    userId,
    { kind: "archive", emailId: null, summary: `Archive ${mail.length} email${mail.length === 1 ? "" : "s"} from ${sender}`, detail: { emailIds: mail.map((e) => e.id), sender } },
    { ...settings, source: "user" },
  );
  if (result === "refused") throw Object.assign(new Error("Tabellar is paused"), { status: 409 });
  if (result === "failed") throw new Error("The mailbox did not archive them; see History in Settings");
  return { archived: mail.length, result };
}

type Target = { method: "one-click" | "mailto" | "web"; url?: string; to?: string; subject?: string; body?: string };

export function parseListUnsubscribe(header: string, post: string): Target | null {
  const links = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const https = links.find((l) => /^https:\/\//i.test(l));
  if (https && /List-Unsubscribe=One-Click/i.test(post)) return { method: "one-click", url: https };
  const mailto = links.find((l) => /^mailto:/i.test(l));
  if (mailto) {
    const u = new URL(mailto);
    const to = decodeURIComponent(u.pathname).trim();
    if (/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to)) {
      return { method: "mailto", to, subject: u.searchParams.get("subject") || "unsubscribe", body: u.searchParams.get("body") || "unsubscribe" };
    }
  }
  const web = https ?? links.find((l) => /^http:\/\//i.test(l));
  return web ? { method: "web", url: web } : null;
}

// The one-click POST goes to a link from the email's header, so it must be a
// public https host, never this machine or the local network.
export function publicHttps(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !h.includes(".")) return false;
  if (/^\[|^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h);
}

function textToHtml(text: string): string {
  return `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`;
}

export type UnsubscribeResult =
  | { done: true; method: string }
  | { confirm: { to: string; subject: string } }
  | { open: string };

// Unsubscribe from one sender. A mailto unsubscribe first comes back asking
// for confirmation; the window repeats the call with `confirm` set to the
// address it showed, and only an exact match sends.
export async function unsubscribe(userId: string, sender: string, confirm?: string): Promise<UnsubscribeResult> {
  const { paused } = await engineSettings(userId);
  const decision = decide({ kind: "unsubscribe", source: "user", level: "suggest", paused });
  if (decision.verdict !== "do") throw Object.assign(new Error(decision.reason), { status: 409 });

  // The newest of their emails with List-Unsubscribe: stored here, or else
  // only indexed by the first read.
  let latest: { id: string | null; gmail_id: string; account: Account | null } | null = null;
  const stored = (await mailFrom(userId, sender, false)).find((e) => e.has_list_unsubscribe);
  if (stored) latest = { id: stored.id as string, gmail_id: stored.gmail_id as string, account: stored.accounts as unknown as Account | null };
  else {
    const { data: seen } = await db.from("mail_index").select("gmail_id, accounts(*)").eq("user_id", userId).eq("from_addr", sender.toLowerCase()).eq("list_unsubscribe", true).order("at", { ascending: false }).limit(1).maybeSingle();
    if (seen) latest = { id: null, gmail_id: seen.gmail_id as string, account: seen.accounts as unknown as Account | null };
  }
  const account = latest?.account;
  if (!latest || !account?.token_ref) throw Object.assign(new Error("This sender gives no way to unsubscribe. Archive their mail instead."), { status: 422 });
  const h = await mail(account).headers(account, latest.gmail_id, ["List-Unsubscribe", "List-Unsubscribe-Post", "To", "Cc"]);
  const target = parseListUnsubscribe(h["list-unsubscribe"] ?? "", h["list-unsubscribe-post"] ?? "");
  if (!target) throw Object.assign(new Error("This sender gives no usable way to unsubscribe. Archive their mail instead."), { status: 422 });
  const log = (how: string) =>
    record(userId, { kind: "unsubscribe", emailId: latest.id, summary: `Unsubscribe from ${sender} (${how})`, detail: { sender, ...target } }, "user");

  if (target.method === "one-click") {
    if (!publicHttps(target.url!)) throw Object.assign(new Error("The unsubscribe link points somewhere Tabellar will not post to"), { status: 422 });
    const res = await fetch(target.url!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 400) throw new Error(`The sender's unsubscribe link answered ${res.status}`);
    await mark(userId, sender, "unsubscribed", "one-click");
    await log("one click");
    return { done: true, method: "one-click" };
  }
  if (target.method === "mailto") {
    if (!confirm || confirm.toLowerCase() !== target.to!.toLowerCase()) return { confirm: { to: target.to!, subject: target.subject! } };
    // From the address that is subscribed, so the list takes that one off.
    const from = await fromLine(userId, account, replyFrom(account, { recipients: h.to, cc_recipients: h.cc }));
    await mail(account).send(account, { from, to: [target.to!], subject: target.subject!, html: textToHtml(target.body!) });
    await mark(userId, sender, "unsubscribed", "mailto");
    await log(`email to ${target.to}`);
    return { done: true, method: "mailto" };
  }
  await mark(userId, sender, "unsubscribed", "web");
  await log("their web page");
  return { open: target.url! };
}
