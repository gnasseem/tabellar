// Outlook.com and Microsoft 365 through Microsoft Graph: mail, the calendar,
// and delta queries for what changed. microsoftMailbox is the "microsoft"
// mailbox in providers.ts.
//
// Sign-in is OAuth for installed apps with PKCE against the app the user
// registered in Microsoft's Azure portal (config.json microsoftClientId; a
// public client, so there is no secret). Microsoft sends the browser back to
// http://localhost:<port>/oauth/callback. The refresh token is kept in the
// Keychain under accounts.token_ref and replaced whenever Microsoft issues
// a new one; access tokens stay in memory.
//
// Gmail's terms in Outlook's: ids are immutable ids, so they survive a move;
// a thread is a conversationId; INBOX is being in the Inbox folder and
// archiving moves to Archive; UNREAD is isRead false, STARRED a flag; other
// labels are Outlook categories.

import { createHash, randomBytes } from "node:crypto";
import { keychainDelete, keychainGet, keychainSet, loadConfig } from "./config.ts";
import { calendarHeaders, type CalendarEvent } from "./rules.ts";
import { htmlToText } from "./mime.ts";
import type { Box, CalEvent, Calendar, EmailData, HeaderRow, LabelChange, LinkedEvent, Mail, NewEvent, Outgoing, Sent } from "./providers.ts";

const LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["offline_access", "openid", "email", "profile", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite", "MailboxSettings.Read"];
const DAY = 86_400_000;

export const microsoftClientId = () => loadConfig().microsoftClientId ?? "";

// ── Tokens ──────────────────────────────────────────────────────────────────

const accessTokens = new Map<string, { token: string; expires: number }>();
const refreshing = new Map<string, Promise<string>>();

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch(`${LOGIN}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: microsoftClientId(), scope: SCOPES.join(" "), ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Microsoft refused the sign-in: ${data.error_description ?? data.error ?? res.status}`), { status: 401 });
  return data;
}

function keep(ref: string, t: { access_token: string; refresh_token?: string; expires_in?: number }) {
  if (t.refresh_token) keychainSet(ref, JSON.stringify({ refresh_token: t.refresh_token }));
  accessTokens.set(ref, { token: t.access_token, expires: Date.now() + ((t.expires_in ?? 3600) - 120) * 1000 });
}

function accessToken(ref: string, renew = false): Promise<string> {
  const cached = accessTokens.get(ref);
  if (cached && !renew && cached.expires > Date.now()) return Promise.resolve(cached.token);
  const inFlight = refreshing.get(ref);
  if (inFlight) return inFlight;
  const run = (async () => {
    const stored = keychainGet(ref);
    if (!stored) throw Object.assign(new Error("This Microsoft account is not connected on this Mac. Sign in again."), { status: 401 });
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: JSON.parse(stored).refresh_token });
    keep(ref, t);
    return t.access_token;
  })().finally(() => refreshing.delete(ref));
  refreshing.set(ref, run);
  return run;
}

const pending = new Map<string, { verifier: string; redirectUri: string; expires: number }>();

export function microsoftSignInUrl(redirectUri: string): string {
  const state = `ms.${randomBytes(24).toString("base64url")}`;
  const verifier = randomBytes(48).toString("base64url");
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  pending.set(state, { verifier, redirectUri, expires: Date.now() + 10 * 60_000 });
  const q = new URLSearchParams({
    client_id: microsoftClientId(),
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${LOGIN}/authorize?${q}`;
}

export const isMicrosoftState = (state: string) => pending.has(state);

export async function finishMicrosoftSignIn(code: string, state: string): Promise<{ email: string; name: string; tokenRef: string }> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.expires < Date.now()) throw new Error("This sign-in link has expired. Start again.");
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
  const me = await (await fetch(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
  const email = String(me.mail || me.userPrincipalName || "").toLowerCase();
  if (!email) throw new Error("Microsoft did not say which account signed in.");
  const tokenRef = `microsoft:${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
  keep(tokenRef, t);
  return { email, name: String(me.displayName || email.split("@")[0]), tokenRef };
}

// ── Graph ───────────────────────────────────────────────────────────────────

// One Graph call: ids that survive moves, bodies as HTML, times in UTC,
// waiting out throttling and renewing the token once on a 401.
async function graph(a: Box, path: string, init: RequestInit = {}): Promise<any> {
  let renew = false;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path.startsWith("https://") ? path : `${GRAPH}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${await accessToken(a.token_ref, renew)}`,
        "Content-Type": "application/json",
        Prefer: 'IdType="ImmutableId", outlook.body-content-type="html", outlook.timezone="UTC", odata.maxpagesize=200',
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 401 && !renew) {
      renew = true;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 2 ** attempt) * 1000));
      continue;
    }
    if (res.status === 202 || res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`Microsoft Graph: ${data?.error?.message ?? res.status}`), { status: res.status, code: data?.error?.code });
    return data;
  }
}

// Every page of a list, up to `cap` items.
async function pages(a: Box, path: string, cap = Infinity): Promise<any[]> {
  const out: any[] = [];
  for (let url: string | undefined = path; url && out.length < cap; ) {
    const data = await graph(a, url);
    out.push(...(data?.value ?? []));
    url = data?.["@odata.nextLink"];
  }
  return out.slice(0, cap);
}

const folderIds = new Map<string, Record<string, string>>();
async function folderId(a: Box, wellKnown: "inbox" | "sentitems" | "archive" | "drafts"): Promise<string> {
  const known = folderIds.get(a.id) ?? folderIds.set(a.id, {}).get(a.id)!;
  if (!known[wellKnown]) known[wellKnown] = (await graph(a, `/me/mailFolders/${wellKnown}?$select=id`)).id;
  return known[wellKnown];
}

type Who = { emailAddress?: { name?: string; address?: string } };
const who = (w: Who | undefined) => {
  const addr = w?.emailAddress?.address ?? "";
  const name = (w?.emailAddress?.name ?? "").replace(/"/g, "");
  return name && name !== addr ? `"${name}" <${addr}>` : addr;
};
const whoList = (l: Who[] | undefined) => (l ?? []).map(who).filter(Boolean).join(", ");
const recipients = (list: string[] | undefined) => (list ?? []).map((s) => ({ emailAddress: { address: (s.match(/<([^>]+)>/)?.[1] ?? s).trim() } }));
const utc = (t: { dateTime?: string } | undefined) => (t?.dateTime ? new Date(`${t.dateTime.replace(/\.\d+$/, "")}Z`).toISOString() : null);

const STATE = "id,isRead,flag,categories,parentFolderId";
const BRIEF = `${STATE},conversationId,receivedDateTime,from,toRecipients,ccRecipients,internetMessageHeaders`;
const FULL = `${BRIEF},subject,sender,replyTo,hasAttachments,bodyPreview,body,internetMessageId,sentDateTime`;

function headersOf(m: any): Record<string, string> {
  const h: Record<string, string> = {};
  for (const x of (m.internetMessageHeaders ?? []) as { name: string; value: string }[]) h[x.name.toLowerCase()] ??= x.value;
  return h;
}

async function labelsOf(a: Box, m: any): Promise<string[]> {
  const out: string[] = [];
  if (m.parentFolderId === (await folderId(a, "inbox"))) out.push("INBOX");
  else if (m.parentFolderId === (await folderId(a, "sentitems").catch(() => ""))) out.push("SENT");
  if (m.isRead === false) out.push("UNREAD");
  if (m.flag?.flagStatus === "flagged") out.push("STARRED");
  return [...out, ...((m.categories ?? []) as string[])];
}

async function rowOf(a: Box, m: any): Promise<HeaderRow> {
  const h = headersOf(m);
  return {
    gmail_id: m.id,
    thread_id: m.conversationId ?? "",
    at: m.receivedDateTime ?? new Date().toISOString(),
    labels: await labelsOf(a, m),
    from: who(m.from),
    to: whoList(m.toRecipients),
    cc: whoList(m.ccRecipients),
    list_unsubscribe: !!h["list-unsubscribe"],
    list_id: h["list-id"] ?? "",
    precedence: h.precedence ?? "",
  };
}

const METHODS: Record<string, string> = { meetingRequest: "REQUEST", meetingCancelled: "CANCEL", meetingAccepted: "REPLY", meetingTenativelyAccepted: "REPLY", meetingDeclined: "REPLY" };

async function emailOf(a: Box, m: any): Promise<EmailData> {
  const h = headersOf(m);
  let html = m.body?.contentType === "html" ? String(m.body?.content ?? "") : "";
  const text = m.body?.contentType === "text" ? String(m.body?.content ?? "") : htmlToText(html);
  // Inline images as data URIs, as Gmail's are.
  if (html.includes("cid:")) {
    for (const x of await pages(a, `/me/messages/${m.id}/attachments?$filter=isInline eq true`).catch(() => [])) {
      if (x.contentId && x.contentBytes) html = html.split(`cid:${String(x.contentId).replace(/[<>]/g, "")}`).join(`data:${x.contentType};base64,${x.contentBytes}`);
    }
  }
  const attachments = m.hasAttachments
    ? (await pages(a, `/me/messages/${m.id}/attachments?$select=id,name,contentType,size,isInline`).catch(() => []))
        .filter((x) => !x.isInline)
        .map((x) => ({ filename: x.name ?? "attachment", mime_type: x.contentType ?? "application/octet-stream", size: x.size ?? 0, attachment_id: x.id }))
    : [];
  const isEvent = m["@odata.type"] === "#microsoft.graph.eventMessage";
  let calendar_event: CalendarEvent | null = null;
  if (isEvent) {
    try {
      const e = (await graph(a, `/me/messages/${m.id}?$select=meetingMessageType&$expand=microsoft.graph.eventMessage/event`)).event;
      if (e) calendar_event = { method: METHODS[m.meetingMessageType] ?? "REQUEST", uid: e.iCalUId ?? "", title: e.subject ?? "", start: utc(e.start), end: utc(e.end), all_day: !!e.isAllDay, recurring: !!e.recurrence };
    } catch {
      // Still calendar mail, without the event's details.
    }
  }
  const from = who(m.from);
  const replyTo = m.replyTo?.[0]?.emailAddress?.address?.toLowerCase();
  const sender = (m.from?.emailAddress?.address ?? "").toLowerCase();
  const labels = await labelsOf(a, m);
  return {
    gmail_id: m.id,
    thread_id: m.conversationId,
    subject: m.subject ?? "",
    sender: from,
    sender_email: sender,
    recipients: whoList(m.toRecipients),
    snippet: m.bodyPreview ?? "",
    body_text: text,
    body_html: html,
    received_at: m.receivedDateTime ?? new Date().toISOString(),
    is_read: !!m.isRead,
    label_ids: labels,
    has_attachments: attachments.length > 0,
    attachments,
    has_list_unsubscribe: !!(h["list-unsubscribe"] || h["list-unsubscribe-post"]),
    is_reply: !!(h["in-reply-to"] || h.references),
    reply_to_email: replyTo && replyTo !== sender ? replyTo : undefined,
    cc_recipients: whoList(m.ccRecipients) || undefined,
    precedence_header: h.precedence || undefined,
    list_id: h["list-id"] || undefined,
    is_calendar: isEvent || calendarHeaders(h),
    calendar_event,
  };
}

async function each<T, R>(items: T[], fn: (t: T) => Promise<R | null>, at = 8): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += at) for (const r of await Promise.all(items.slice(i, i + at).map((x) => fn(x).catch(() => null)))) if (r) out.push(r);
  return out;
}

// ── Sending ─────────────────────────────────────────────────────────────────

const bodyOf = (m: Outgoing) => ({
  subject: m.subject,
  body: { contentType: "HTML", content: m.html },
  toRecipients: recipients(m.to),
  ccRecipients: recipients(m.cc),
  bccRecipients: recipients(m.bcc),
});

// The message being answered, by Message-ID or else the newest in the thread.
async function original(a: Box, inReplyTo?: string, threadId?: string): Promise<string | null> {
  const mid = inReplyTo?.match(/<[^>]+>/)?.[0];
  if (mid) {
    const [hit] = await pages(a, `/me/messages?$filter=internetMessageId eq '${mid.replace(/'/g, "''")}'&$select=id`, 1).catch(() => []);
    if (hit) return hit.id;
  }
  if (!threadId) return null;
  const list = await pages(a, `/me/messages?$filter=conversationId eq '${threadId.replace(/'/g, "''")}'&$select=id,receivedDateTime&$top=50`, 50).catch(() => []);
  return list.sort((x, y) => String(y.receivedDateTime).localeCompare(String(x.receivedDateTime)))[0]?.id ?? null;
}

// A new draft: a reply in the thread when it answers a message.
async function newDraft(a: Box, m: Outgoing, threadId?: string): Promise<string> {
  const replyTo = await original(a, m.inReplyTo, threadId);
  const draft = replyTo
    ? await graph(a, `/me/messages/${replyTo}/createReply`, { method: "POST", body: "{}" }).then((d) => graph(a, `/me/messages/${d.id}`, { method: "PATCH", body: JSON.stringify(bodyOf(m)) }))
    : await graph(a, "/me/messages", { method: "POST", body: JSON.stringify(bodyOf(m)) });
  for (const att of m.attachments ?? []) {
    await graph(a, `/me/messages/${draft.id}/attachments`, {
      method: "POST",
      body: JSON.stringify({ "@odata.type": "#microsoft.graph.fileAttachment", name: att.name, contentType: att.contentType, contentBytes: att.data }),
    });
  }
  return draft.id;
}

async function saveDraft(a: Box, draftId: string | null, m: Outgoing, threadId?: string): Promise<string> {
  if (draftId) {
    try {
      await graph(a, `/me/messages/${draftId}`, { method: "PATCH", body: JSON.stringify(bodyOf(m)) });
      return draftId;
    } catch (e) {
      // Sent or deleted in Outlook meanwhile: made again.
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }
  return newDraft(a, m, threadId);
}

// ── Calendar ────────────────────────────────────────────────────────────────

// A wall-clock time in an IANA zone as UTC.
function zonedToUtc(local: string, tz: string): string {
  const guess = new Date(`${local.slice(0, 19)}Z`);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hour12: false })
      .formatToParts(guess)
      .map((x) => [x.type, x.value]),
  );
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return new Date(guess.getTime() * 2 - shown).toISOString();
}

const graphTime = (t: string, tz?: string) => {
  const hasZone = /(z|[+-]\d\d:?\d\d)$/i.test(t);
  const iso = hasZone || !tz ? new Date(hasZone ? t : `${t}Z`).toISOString() : zonedToUtc(t, tz);
  return { dateTime: iso.slice(0, 19), timeZone: "UTC" };
};

function graphEvent(e: NewEvent, invite: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (e.title !== undefined) out.subject = e.title;
  if (e.description !== undefined) out.body = { contentType: "text", content: e.description };
  if (e.start) out.start = graphTime(e.start, e.timeZone);
  if (e.end) out.end = graphTime(e.end, e.timeZone);
  if (e.location !== undefined) out.location = { displayName: e.location };
  // Outlook invites every attendee it is given; without invites, nobody is added.
  if (e.attendees && invite) out.attendees = e.attendees.map((address) => ({ emailAddress: { address }, type: "required" }));
  return out;
}

const linked = (e: any): LinkedEvent => ({ id: e.id, title: e.subject ?? "", start: utc(e.start), end: utc(e.end), all_day: !!e.isAllDay, link: e.webLink ?? null, on_calendar: true });
const EVENT = "id,subject,start,end,isAllDay,attendees,organizer,location,onlineMeeting,webLink,isCancelled,showAs";
const view = (a: Box, from: Date, to: Date, max: number) =>
  pages(a, `/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$select=${EVENT}&$orderby=start/dateTime&$top=${Math.min(max, 200)}`, max);

const outlookCalendar: Calendar = {
  async busy(a, from, to) {
    return (await view(a, from, to, 500)).filter((e) => !e.isCancelled && e.showAs !== "free").map((e) => ({ start: utc(e.start)!, end: utc(e.end)! }));
  },
  async events(a, from, to, max) {
    return (await view(a, from, to, max))
      .filter((e) => !e.isCancelled)
      .map((e): CalEvent => ({
        id: e.id,
        title: e.subject || "(No title)",
        start: utc(e.start),
        end: utc(e.end),
        allDay: !!e.isAllDay,
        attendees: ((e.attendees ?? []) as (Who & { type?: string })[])
          .filter((x) => x.type !== "resource" && x.emailAddress?.address?.toLowerCase() !== a.address.toLowerCase())
          .map((x) => x.emailAddress?.name || x.emailAddress?.address || "")
          .filter(Boolean),
        location: e.location?.displayName || null,
        meetingLink: e.onlineMeeting?.joinUrl ?? null,
        htmlLink: e.webLink ?? null,
        status: "confirmed",
        source: "outlook_calendar",
      }));
  },
  async create(a, e, invite) {
    const ev = await graph(a, "/me/events", { method: "POST", body: JSON.stringify(graphEvent(e, invite)) });
    return { id: ev.id, link: ev.webLink ?? null };
  },
  async update(a, id, e, invite) {
    const ev = await graph(a, `/me/events/${id}`, { method: "PATCH", body: JSON.stringify(graphEvent(e, invite)) });
    return { id: ev.id, link: ev.webLink ?? null };
  },
  async find(a, q) {
    if (q.uid) {
      const [hit] = await pages(a, `/me/events?$filter=iCalUId eq '${q.uid.replace(/'/g, "''")}'&$select=${EVENT}`, 1);
      if (hit) return linked(hit);
    }
    const at = q.start ? new Date(q.start).getTime() : NaN;
    if (isNaN(at)) return null;
    const near = (await view(a, new Date(at - DAY), new Date(at + DAY), 100)).filter((e) => !e.isCancelled);
    const people = new Set((q.people ?? []).map((p) => p.toLowerCase()));
    const hit =
      near.find((e) => Math.abs(new Date(utc(e.start) ?? 0).getTime() - at) < 60_000) ??
      near.find((e) => [...(e.attendees ?? []), e.organizer ?? {}].some((x: Who) => people.has(String(x.emailAddress?.address ?? "").toLowerCase())));
    return hit ? linked(hit) : null;
  },
};

// ── The mailbox ─────────────────────────────────────────────────────────────

// The cursor: the Inbox's delta link (the last 30 days of it) and how many
// messages Sent Items holds.
type Cursor = { d: string; s: number };
const readCursor = (s: string | null): Cursor | null => {
  try {
    const c = JSON.parse(s ?? "");
    return typeof c?.d === "string" ? c : null;
  } catch {
    return null;
  }
};
const sentCount = async (a: Box) => Number((await graph(a, "/me/mailFolders/sentitems?$select=totalItemCount"))?.totalItemCount ?? 0);
const expired = (e: unknown) => [404, 410].includes((e as { status?: number }).status ?? 0) || /syncState|resync/i.test(String((e as { code?: string }).code));

// Walk a delta query to its end: the items and the next delta link.
async function delta(a: Box, start: string): Promise<{ items: any[]; link: string }> {
  const items: any[] = [];
  for (let url = start; ; ) {
    const data = await graph(a, url);
    items.push(...(data?.value ?? []));
    if (data?.["@odata.deltaLink"]) return { items, link: data["@odata.deltaLink"] };
    url = data?.["@odata.nextLink"];
    if (!url) throw Object.assign(new Error("Microsoft Graph ended a delta query early"), { status: 410 });
  }
}

const rows = new Map<string, Map<string, HeaderRow>>();
const rowsOf = (a: Box) => rows.get(a.id) ?? rows.set(a.id, new Map()).get(a.id)!;

export const microsoftMailbox: Mail = {
  async cursor(a) {
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const { link } = await delta(a, `/me/mailFolders/inbox/messages/delta?$select=${STATE}&$filter=receivedDateTime ge ${since}`);
    return JSON.stringify({ d: link, s: await sentCount(a) } satisfies Cursor);
  },

  async changes(a, cursor) {
    const c = readCursor(cursor);
    const out = { tooOld: false, historyId: null as string | null, added: [] as string[], sentAdded: false, labels: [] as LabelChange[], deleted: [] as string[] };
    if (!c) return { ...out, tooOld: true };
    let got: { items: any[]; link: string };
    try {
      got = await delta(a, c.d);
    } catch (e) {
      if (expired(e)) return { ...out, tooOld: true };
      throw e;
    }
    const inbox = await folderId(a, "inbox");
    for (const m of got.items) {
      if (m["@removed"]) out.labels.push({ id: m.id, add: [], remove: ["INBOX"] });
      else {
        // A delta item has the fields the first query asked for; an older link may not.
        const state = m.isRead === undefined ? await graph(a, `/me/messages/${m.id}?$select=${STATE}`).catch(() => null) : m;
        if (!state) continue;
        out.labels.push({ id: m.id, add: await labelsOf(a, state), remove: [], exact: state.parentFolderId === inbox });
        if (state.parentFolderId === inbox) out.added.push(m.id);
      }
    }
    const s = await sentCount(a);
    out.sentAdded = s !== c.s;
    out.historyId = JSON.stringify({ d: got.link, s } satisfies Cursor);
    return out;
  },

  async moved(a) {
    const c = readCursor(a.history_id);
    if (!c) return false;
    try {
      const data = await graph(a, c.d);
      return !!(data?.value?.length || data?.["@odata.nextLink"]) || (await sentCount(a)) !== c.s;
    } catch (e) {
      if (expired(e)) return true;
      throw e;
    }
  },

  async list(a, q) {
    const since = q.days ? `&$filter=receivedDateTime ge ${new Date(Date.now() - q.days * DAY).toISOString()}` : "";
    const folders = q.inbox ? ["inbox"] : ["inbox", "archive", "sentitems"];
    const found: HeaderRow[] = [];
    for (const f of folders) {
      const list = await pages(a, `/me/mailFolders/${f}/messages?$select=${BRIEF}&$orderby=receivedDateTime desc&$top=200${since}`, q.cap).catch((e) => {
        if (f === "archive" && (e as { status?: number }).status === 404) return [];
        throw e;
      });
      for (const m of list) {
        const row = await rowOf(a, m);
        rowsOf(a).set(m.id, row);
        found.push(row);
      }
    }
    return found.sort((x, y) => y.at.localeCompare(x.at)).map((r) => r.gmail_id).slice(0, q.cap);
  },

  fetch: (a, ids) => each(ids, async (id) => emailOf(a, await graph(a, `/me/messages/${id}?$select=${FULL}`))),

  headerRows: (a, ids) => each(ids, async (id) => rowsOf(a).get(id) ?? rowOf(a, await graph(a, `/me/messages/${id}?$select=${BRIEF}`))),

  async sent(a, max) {
    const list = await pages(a, `/me/mailFolders/sentitems/messages?$select=${FULL}&$orderby=sentDateTime desc&$top=${Math.min(max, 200)}`, max);
    return each(list, async (m): Promise<Sent> => {
      const e = await emailOf(a, m);
      return {
        id: m.id, thread_id: m.conversationId, subject: e.subject, from: e.sender, to: e.recipients, cc: e.cc_recipients ?? "", date: m.sentDateTime ?? e.received_at,
        body_html: e.body_html, body: e.body_text, snippet: e.snippet, has_attachments: e.has_attachments, attachments: e.attachments,
      };
    });
  },

  async headers(a, id, names) {
    const m = await graph(a, `/me/messages/${id}?$select=internetMessageHeaders,internetMessageId`);
    const h = headersOf(m);
    const want = new Set(names.map((n) => n.toLowerCase()));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) if (want.has(k)) out[k] = v;
    if (want.has("message-id") && m.internetMessageId) out["message-id"] = m.internetMessageId;
    return out;
  },

  threadOf: async (a, id) => (await graph(a, `/me/messages/${id}?$select=conversationId`).catch(() => null))?.conversationId ?? "",

  async send(a, m, threadId) {
    const id = await newDraft(a, m, threadId);
    await graph(a, `/me/messages/${id}/send`, { method: "POST" });
    return { id };
  },

  saveDraft,

  async sendDraft(a, draftId, m, threadId) {
    const id = await saveDraft(a, draftId, m, threadId);
    await graph(a, `/me/messages/${id}/send`, { method: "POST" });
    return { id };
  },

  label: async (_a, name) => name,

  labelNames: async (a) => (await pages(a, "/me/outlook/masterCategories").catch(() => [])).map((c) => String(c.displayName)),

  async modify(a, ids, add, remove) {
    const system = new Set(["INBOX", "UNREAD", "STARRED"]);
    const addCats = add.filter((l) => !system.has(l));
    const dropCats = remove.filter((l) => !system.has(l));
    await each(
      ids,
      async (id) => {
        const patch: Record<string, unknown> = {};
        if (add.includes("UNREAD")) patch.isRead = false;
        if (remove.includes("UNREAD")) patch.isRead = true;
        if (add.includes("STARRED")) patch.flag = { flagStatus: "flagged" };
        if (remove.includes("STARRED")) patch.flag = { flagStatus: "notFlagged" };
        if (addCats.length || dropCats.length) {
          const now = ((await graph(a, `/me/messages/${id}?$select=categories`)).categories ?? []) as string[];
          patch.categories = [...new Set([...now.filter((c) => !dropCats.includes(c)), ...addCats])];
        }
        if (Object.keys(patch).length) await graph(a, `/me/messages/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
        if (remove.includes("INBOX")) await graph(a, `/me/messages/${id}/move`, { method: "POST", body: JSON.stringify({ destinationId: "archive" }) });
        if (add.includes("INBOX")) await graph(a, `/me/messages/${id}/move`, { method: "POST", body: JSON.stringify({ destinationId: "inbox" }) });
        return true;
      },
      4,
    ).then((done) => {
      if (done.length < ids.length) throw new Error(`Outlook did not take the change for ${ids.length - done.length} of ${ids.length} emails`);
    });
  },

  async sendAs(a) {
    const me = await graph(a, "/me?$select=displayName,mail");
    return [{ address: a.address.toLowerCase(), name: String(me?.displayName ?? ""), default: true }];
  },

  async hasSentTo(a, address) {
    const list = await pages(a, `/me/mailFolders/sentitems/messages?$search=${encodeURIComponent(`"to:${address.replace(/"/g, "")}"`)}&$select=id&$top=1`, 1);
    return list.length > 0;
  },

  async attachment(a, id, attachmentId) {
    const x = await graph(a, `/me/messages/${id}/attachments/${attachmentId}`).catch(() => null);
    return x?.contentBytes ? { data: Buffer.from(x.contentBytes, "base64").toString("base64url"), size: x.size ?? 0 } : null;
  },

  async disconnect(a) {
    accessTokens.delete(a.token_ref);
    keychainDelete(a.token_ref);
  },

  calendar: outlookCalendar,
};
