// The user's mailboxes and the addresses each one sends from.
//
// An account is one connected mailbox (Gmail for now; `provider` says which).
// Gmail keeps a "Send mail as" list per mailbox: its own address and every
// alias the user added there. Tabellar reads it at sign-in and once a day
// into accounts.send_as, so the compose From menu lists every address, a
// reply goes out from the address the email was sent to, and every "is this
// me" check knows all of them (senders.ownAddresses).
//
// One account is the default: new mail goes out from it, and the calendar is
// its calendar. A paused account is not synced and its mail is not read; what
// is already in Tabellar stays.

import { db } from "./db.ts";
import { listSendAs, type SendAs } from "./gmail.ts";
import { addressesIn } from "./senders.ts";
import { forgetTokens, revokeGoogleTokens } from "./google.ts";

export type { SendAs };
export type Account = {
  id: string;
  user_id: string;
  provider: string;
  address: string;
  token_ref: string;
  history_id: string | null;
  send_as: SendAs[];
  send_as_at: string | null;
  default_from: string | null;
  is_default: boolean;
  paused: boolean;
  read_at: string | null;
  created_at: string;
};

const DAY = 86_400_000;
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

export async function listAccounts(userId: string): Promise<Account[]> {
  const { data } = await db.from("accounts").select("*").eq("user_id", userId).order("created_at", { ascending: true });
  return (data ?? []) as unknown as Account[];
}

export async function accountById(userId: string, id: string | null | undefined): Promise<Account | null> {
  if (!id) return null;
  const { data } = await db.from("accounts").select("*").eq("user_id", userId).eq("id", id).maybeSingle();
  return (data as unknown as Account) ?? null;
}

// The default account, or the oldest when none is marked.
export async function defaultAccount(userId: string): Promise<Account | null> {
  const all = await listAccounts(userId);
  return all.find((a) => a.is_default) ?? all[0] ?? null;
}

// The account that owns an address: its own, or one of its aliases.
export function accountFor(accounts: Account[], address: string | null | undefined): Account | null {
  const a = lc(address);
  if (!a) return null;
  return accounts.find((x) => lc(x.address) === a) ?? accounts.find((x) => addressesOf(x).some((s) => s.address === a)) ?? null;
}

// The addresses an account sends from: Gmail's list, or its own address
// until that list has been read.
export function addressesOf(a: Pick<Account, "address" | "send_as">): SendAs[] {
  return a.send_as?.length ? a.send_as : [{ address: lc(a.address), name: "", default: true }];
}

// Where new mail from this account goes out from: the user's pick, then
// Gmail's default, then the account's own address.
export function defaultFrom(a: Pick<Account, "address" | "send_as" | "default_from">): string {
  const list = addressesOf(a);
  return list.find((s) => s.address === lc(a.default_from))?.address ?? list.find((s) => s.default)?.address ?? lc(a.address);
}

// A reply goes out from the address the email was sent to, when the account
// has it; otherwise from its default.
export function replyFrom(a: Account, email: { recipients?: string | null; cc_recipients?: string | null }): string {
  const to = addressesIn(`${email.recipients ?? ""}, ${email.cc_recipients ?? ""}`);
  return addressesOf(a).find((s) => to.includes(s.address))?.address ?? defaultFrom(a);
}

// The From header for one of the account's addresses, with its name (Gmail's
// display name for it, else the user's own). Throws for an address the
// account cannot send from, so nothing goes out under a wrong name.
export function fromHeader(a: Account, address: string | null | undefined, fallbackName = ""): string {
  const want = lc(address) || defaultFrom(a);
  const s = addressesOf(a).find((x) => x.address === want);
  if (!s) throw Object.assign(new Error(`${want} is not an address ${a.address} can send from`), { status: 400 });
  const name = (s.name || fallbackName).replace(/["\r\n]/g, "").trim();
  if (!name) return s.address;
  return /^[\x20-\x7e]*$/.test(name) ? `"${name}" <${s.address}>` : `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?= <${s.address}>`;
}

// fromHeader with the user's own name when Gmail has none for the address.
export async function fromLine(userId: string, a: Account, address: string | null | undefined): Promise<string> {
  const { data } = await db.from("profiles").select("display_name").eq("id", userId).maybeSingle();
  return fromHeader(a, address, String(data?.display_name ?? ""));
}

// Read the account's send-as list from Gmail now.
export async function refreshSendAs(a: Account): Promise<SendAs[]> {
  const list = await listSendAs(a.token_ref);
  await db.from("accounts").update({ send_as: list, send_as_at: new Date().toISOString() }).eq("id", a.id);
  return list;
}

// Read it again for every account whose list is a day old or was never read.
export async function refreshStaleSendAs(userId: string): Promise<void> {
  for (const a of await listAccounts(userId)) {
    if (a.send_as_at && Date.now() - new Date(a.send_as_at).getTime() < DAY) continue;
    try {
      await refreshSendAs(a);
    } catch (e) {
      console.error(`[accounts] send-as list for ${a.address}:`, (e as Error).message);
    }
  }
}

// What the window shows and changes. token_ref stays on the server.
export async function accountsForWindow(userId: string) {
  const all = await listAccounts(userId);
  const def = all.find((a) => a.is_default) ?? all[0];
  return all.map((a) => ({
    id: a.id,
    provider: a.provider,
    address: a.address,
    is_default: a.id === def?.id,
    paused: a.paused,
    from: addressesOf(a).map((s) => ({ address: s.address, name: s.name })),
    default_from: defaultFrom(a),
  }));
}

export async function updateAccount(userId: string, id: string, patch: { paused?: unknown; is_default?: unknown; default_from?: unknown }): Promise<void> {
  const a = await accountById(userId, id);
  if (!a) throw Object.assign(new Error("No such account"), { status: 404 });
  const out: Record<string, unknown> = {};
  if (typeof patch.paused === "boolean") out.paused = patch.paused;
  if (typeof patch.default_from === "string") {
    if (!addressesOf(a).some((s) => s.address === lc(patch.default_from))) throw Object.assign(new Error("That address is not one this account sends from"), { status: 400 });
    out.default_from = lc(patch.default_from);
  }
  if (patch.is_default === true) {
    await db.from("accounts").update({ is_default: false }).eq("user_id", userId);
    out.is_default = true;
  }
  if (Object.keys(out).length) await db.from("accounts").update(out).eq("id", id);
}

// Disconnect an account: its Google sign-in is revoked and its mail, drafts
// and signatures leave Tabellar. Gmail itself is not changed.
export async function removeAccount(userId: string, id: string): Promise<void> {
  const a = await accountById(userId, id);
  if (!a) return;
  try {
    await revokeGoogleTokens(a.token_ref);
  } catch (e) {
    console.error("[accounts] revoke:", (e as Error).message);
    forgetTokens(a.token_ref);
  }
  await db.from("accounts").delete().eq("id", id);
  if (a.is_default) {
    const next = (await listAccounts(userId))[0];
    if (next) await db.from("accounts").update({ is_default: true }).eq("id", next.id);
  }
}
