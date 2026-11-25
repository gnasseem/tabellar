// Gmail, Google Calendar and Google Contacts through their REST APIs, with
// the account's OAuth tokens (google.ts). gmailMailbox is the "gmail"
// mailbox in providers.ts; the rest of Tabellar reaches it through
// mail(account).

import { loadTokens, saveTokens, refreshAccessToken, revokeGoogleTokens, type TokenData } from "./google.ts";
import { calendarHeaders, parseIcs } from "./rules.ts";
import { addressOf, bodyOf, htmlToText, writeMessage, type BodyNode } from "./mime.ts";
import type { AttachmentInfo, Calendar, CalEvent, DraftStub, DraftText, EmailData, HeaderRow, LinkedEvent, Mail, MailboxChanges, NewEvent, Outgoing, Sent, SendAs } from "./providers.ts";
import { isReceipt, receiptOf } from "./receipts.ts";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// Gmail allows each user about 250 quota units a second (a message read
// costs 5), so calls start at most 40 a second across the whole server.
const SPACING_MS = 25;
let nextStart = 0;
async function pace(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextStart);
  nextStart = at + SPACING_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

// Over quota, Gmail answers 429, or 403 with a rate limit reason; busy, 5xx.
// A send or a new draft is not asked again after a 5xx: it may have happened.
async function overQuota(res: Response, once: boolean): Promise<boolean> {
  if (res.status === 429 || (res.status >= 500 && !once)) return true;
  if (res.status !== 403) return false;
  return /rateLimitExceeded|quota exceeded/i.test(await res.clone().text().catch(() => ""));
}

// One Gmail API call, paced, and asked again after a growing pause (over a
// minute in all, as the quota is per minute) while Gmail says it is over
// quota or busy. Every other call waits a moment too: more of them would
// only be refused.
async function gmailRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const once = init.method === "POST" && /\/(send|drafts)$/.test(path);
  for (let attempt = 0; ; attempt++) {
    await pace();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(`${GMAIL_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (attempt >= 8 || !(await overQuota(res, once))) return res;
    await res.body?.cancel().catch(() => {});
    nextStart = Math.max(nextStart, Date.now() + 1500);
    await new Promise((r) => setTimeout(r, Math.min(12_000, 1500 * 2 ** attempt) + Math.random() * 500));
  }
}

async function resolveTokens(
  tokenRef: string,
  db?: { from: (t: string) => unknown },
  accountId?: string,
): Promise<{ tokenData: TokenData; updatedTokenRef?: string }> {
  let tokenData = await loadTokens(tokenRef);
  let updatedTokenRef: string | undefined;

  const isExpired =
    tokenData.expiry &&
    new Date(tokenData.expiry) < new Date(Date.now() + 60_000);

  if (isExpired && tokenData.refresh_token) {
    const refreshed = await refreshAccessToken(tokenData.refresh_token);
    tokenData = { ...tokenData, ...refreshed };
    updatedTokenRef = await saveTokens(tokenData);
    if (db && accountId) {
      // deno-lint-ignore no-explicit-any
      await (db.from("accounts") as any)
        .update({ token_ref: updatedTokenRef })
        .eq("id", accountId);
    }
  }

  return { tokenData, updatedTokenRef };
}

async function withTokenRefresh<T>(
  tokenData: TokenData,
  fn: (token: string) => Promise<T>,
  tokenRef: string,
): Promise<{ result: T; updatedTokenRef?: string }> {
  let result: T;
  let updated: string | undefined;

  try {
    result = await fn(tokenData.token);
  } catch (e) {
    // If the error looks like a 401, try refreshing
    if (tokenData.refresh_token && (e as { status?: number }).status === 401) {
      const refreshed = await refreshAccessToken(tokenData.refresh_token);
      const newTokenData = { ...tokenData, ...refreshed };
      updated = await saveTokens(newTokenData);
      result = await fn(newTokenData.token);
    } else {
      throw e;
    }
  }

  return { result, updatedTokenRef: updated };
}

// Gmail returns snippets HTML-escaped ("I&#39;m", "&lt;a@b.c&gt;").
function decodeSnippet(s: string | undefined): string {
  return (s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function b64urlDecode(s: string): string {
  try {
    const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

interface EmailPart {
  mimeType?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: unknown[];
  filename?: string;
  headers?: { name: string; value: string }[];
}

interface ExtractState {
  hasAttachments: boolean;
  attachments: AttachmentInfo[];
  cidParts: {
    contentId: string;
    mimeType: string;
    filename: string;
    size: number;
    data?: string;
    attachmentId?: string;
  }[];
  ics: { data?: string; attachmentId?: string } | null; // the first text/calendar part, with or without a filename
  report?: { data?: string; attachmentId?: string }; // a read receipt's own part
}

const newState = (): ExtractState => ({ hasAttachments: false, attachments: [], cidParts: [], ics: null });

// Sorts a message's parts into the state, and returns the tree of its text.
function extractParts(part: EmailPart, state: ExtractState): BodyNode {
  const mime = part.mimeType ?? "";
  const node: BodyNode = { type: mime, parts: [] };
  const contentId = part.headers
    ?.find((h) => h.name.toLowerCase() === "content-id")
    ?.value?.replace(/[<>]/g, "").trim();
  const attached = /^attachment/i.test(part.headers?.find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? "");

  if ((mime === "text/calendar" || mime === "application/ics") && !state.ics && (part.body?.data || part.body?.attachmentId)) {
    state.ics = { data: part.body.data, attachmentId: part.body.attachmentId };
  }

  if (mime === "message/disposition-notification") {
    state.report ??= { data: part.body?.data, attachmentId: part.body?.attachmentId };
    return node;
  }

  if ((mime === "text/plain" || mime === "text/html") && part.body?.data && !part.filename) {
    node.content = b64urlDecode(part.body.data);
  } else if (mime.startsWith("image/") && contentId && !attached) {
    // Inline image referenced by CID
    state.cidParts.push({ contentId, mimeType: mime, filename: part.filename ?? "", size: part.body?.size ?? 0, data: part.body?.data, attachmentId: part.body?.attachmentId });
  } else if (part.filename) {
    state.hasAttachments = true;
    if (part.body?.attachmentId) {
      state.attachments.push({
        filename: part.filename,
        mime_type: mime || "application/octet-stream",
        size: part.body.size ?? 0,
        attachment_id: part.body.attachmentId,
      });
    }
  }
  // An attached message's own text and files are not this message's.
  if (mime.startsWith("message/")) return node;
  node.parts = (part.parts ?? []).map((sub) => extractParts(sub as EmailPart, state));
  return node;
}

// An image the HTML does not show is a file like any other.
function listUnshown(state: ExtractState, html: string): void {
  for (const c of state.cidParts) {
    if (!c.attachmentId || html.includes(`cid:${c.contentId}`)) continue;
    state.hasAttachments = true;
    state.attachments.push({ filename: c.filename || "image", mime_type: c.mimeType, size: c.size, attachment_id: c.attachmentId });
  }
}

// Gmail has no such message, as against not answering for it now.
const gone = (status: number) => status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);

// One message, or null when Gmail no longer has it. Any other failure throws,
// so the sync that asked is tried again instead of going on without it.
async function fetchMessageById(
  accessToken: string,
  messageId: string,
): Promise<EmailData | null> {
  const msgRes = await gmailRequest(accessToken, `/messages/${messageId}?format=full`);
  if (gone(msgRes.status)) return null;
  if (!msgRes.ok) throw new Error(`Gmail message fetch failed (${msgRes.status})`);
  const msg = await msgRes.json();
  try {
    const headers: Record<string, string> = {};
    for (const h of msg.payload?.headers ?? []) {
      headers[(h.name as string).toLowerCase()] = h.value as string;
    }

    const state = newState();
    const body = bodyOf(extractParts(msg.payload ?? {}, state));
    listUnshown(state, body.html);

    // The event a calendar email is about, from its .ics; what a read receipt
    // is about, from its report. Gmail hands a longer part over separately.
    const partText = async (p: { data?: string; attachmentId?: string } | null | undefined): Promise<string> => {
      if (p?.data) return b64urlDecode(p.data);
      if (!p?.attachmentId) return "";
      try {
        const res = await gmailRequest(accessToken, `/messages/${messageId}/attachments/${p.attachmentId}`);
        return res.ok ? b64urlDecode(((await res.json()).data as string) ?? "") : "";
      } catch {
        return ""; // still calendar mail, or a receipt, without its details
      }
    };
    const icsText = await partText(state.ics);
    const receipt = isReceipt(headers) ? receiptOf(headers, await partText(state.report)) : null;

    // Replace CID inline image references with embedded data URIs
    for (const cid of state.cidParts) {
      if (!body.html.includes(`cid:${cid.contentId}`)) continue;
      let imgData = cid.data;
      if (!imgData && cid.attachmentId) {
        try {
          const attRes = await gmailRequest(
            accessToken,
            `/messages/${messageId}/attachments/${cid.attachmentId}`,
          );
          if (attRes.ok) {
            const attJson = await attRes.json();
            imgData = attJson.data as string | undefined;
          }
        } catch {
          /* skip on error */
        }
      }
      if (imgData && body.html) {
        const base64 = imgData.replace(/-/g, "+").replace(/_/g, "/");
        const dataUri = `data:${cid.mimeType};base64,${base64}`;
        const escaped = cid.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        body.html = body.html.replace(
          new RegExp(`cid:${escaped}`, "gi"),
          dataUri,
        );
      }
    }

    const from = headers["from"] ?? "";
    const replyTo = headers["reply-to"] ?? "";
    const replyToEmail = replyTo ? addressOf(replyTo) : undefined;
    return {
      gmail_id: msg.id as string,
      thread_id: msg.threadId as string,
      subject: headers["subject"] ?? "",
      sender: from,
      sender_email: addressOf(from),
      recipients: headers["to"] ?? "",
      snippet: decodeSnippet(msg.snippet as string),
      body_text: body.text || htmlToText(body.html),
      body_html: body.html,
      received_at: msg.internalDate
        ? new Date(parseInt(msg.internalDate as string, 10)).toISOString()
        : (headers["date"] ?? new Date().toISOString()),
      is_read: !((msg.labelIds as string[]) ?? []).includes("UNREAD"),
      label_ids: (msg.labelIds as string[]) ?? [],
      has_attachments: state.hasAttachments,
      attachments: state.attachments,
      has_list_unsubscribe: !!(
        headers["list-unsubscribe"] || headers["list-unsubscribe-post"]
      ),
      is_reply: !!(headers["in-reply-to"] || headers["references"]),
      reply_to_email:
        replyToEmail && replyToEmail !== addressOf(from)
          ? replyToEmail
          : undefined,
      cc_recipients: headers["cc"] ?? undefined,
      precedence_header: headers["precedence"] ?? undefined,
      list_id: headers["list-id"] ?? undefined,
      is_calendar: !!state.ics || calendarHeaders(headers),
      calendar_event: icsText ? parseIcs(icsText, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") : null,
      is_receipt: isReceipt(headers),
      receipt,
    };
  } catch (e) {
    console.error(`[gmail] message ${messageId} could not be read:`, (e as Error).message);
    return null;
  }
}

// Full messages by id, a few at a time, skipping any Gmail no longer has.
async function fetchMessages(tokenRef: string, ids: string[]): Promise<EmailData[]> {
  const out: EmailData[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const { tokenData } = await resolveTokens(tokenRef);
    const got = await Promise.all(ids.slice(i, i + 20).map((id) => fetchMessageById(tokenData.token, id)));
    for (const e of got) if (e) out.push(e);
  }
  return out;
}

// Ids of the messages matching a Gmail search, newest first, at most `cap`.
async function listMessageIds(tokenRef: string, q: string, cap: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = "";
  while (ids.length < cap) {
    const { tokenData } = await resolveTokens(tokenRef);
    const page = pageToken ? `&pageToken=${pageToken}` : "";
    const res = await gmailRequest(tokenData.token, `/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(500, cap - ids.length)}&fields=messages/id,nextPageToken${page}`);
    if (!res.ok) throw new Error(`Gmail search failed (${res.status})`);
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    for (const m of (data.messages ?? []) as { id: string }[]) ids.push(m.id);
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return ids.slice(0, cap);
}

const INDEX_HEADERS = ["From", "To", "Cc", "List-Unsubscribe", "List-Id", "Precedence"];

// Headers only, for many messages: one small request each, ten at a time.
async function fetchHeaderRows(tokenRef: string, ids: string[]): Promise<HeaderRow[]> {
  const q = INDEX_HEADERS.map((n) => `metadataHeaders=${n}`).join("&");
  const out: HeaderRow[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const { tokenData } = await resolveTokens(tokenRef);
    const got = await Promise.all(
      ids.slice(i, i + 10).map(async (id) => {
        const res = await gmailRequest(tokenData.token, `/messages/${id}?format=metadata&${q}&fields=id,threadId,labelIds,internalDate,payload/headers`);
        if (gone(res.status)) return null;
        if (!res.ok) throw new Error(`Gmail header fetch failed (${res.status})`);
        const msg = await res.json();
        const h: Record<string, string> = {};
        for (const x of (msg.payload?.headers ?? []) as { name: string; value: string }[]) h[x.name.toLowerCase()] = x.value;
        return {
          gmail_id: msg.id as string,
          thread_id: (msg.threadId as string) ?? "",
          at: new Date(parseInt(msg.internalDate as string, 10) || Date.now()).toISOString(),
          labels: (msg.labelIds as string[]) ?? [],
          from: h["from"] ?? "",
          to: h["to"] ?? "",
          cc: h["cc"] ?? "",
          list_unsubscribe: !!h["list-unsubscribe"],
          list_id: h["list-id"] ?? "",
          precedence: h["precedence"] ?? "",
        } satisfies HeaderRow;
      }),
    );
    for (const r of got) if (r) out.push(r);
  }
  return out;
}


// Where Gmail's change history currently stands for this mailbox.
async function currentHistoryId(tokenRef: string): Promise<string> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, "/profile");
  if (!res.ok) throw new Error(`Gmail profile fetch failed (${res.status})`);
  return (await res.json()).historyId as string;
}

// What changed in a mailbox since a point in its history: messages that
// arrived (in the inbox, or of unknown place), whether any sent mail arrived,
// label changes in order, and deleted messages. tooOld when Gmail no longer
// keeps history that far back, or when there was more than one read can take;
// the caller then starts over from the inbox itself.
type HistoryMessage = { id: string; labelIds?: string[] };

async function readHistory(tokenRef: string, startHistoryId: string): Promise<MailboxChanges> {
  const { tokenData } = await resolveTokens(tokenRef);
  const out: MailboxChanges = { tooOld: false, historyId: null, added: [], sentAdded: false, labels: [], deleted: [] };
  const added = new Set<string>();
  const types = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"].map((t) => `&historyTypes=${t}`).join("");
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const res = await gmailRequest(tokenData.token, `/history?startHistoryId=${startHistoryId}${types}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`);
    if (res.status === 404) return { ...out, tooOld: true };
    if (!res.ok) throw new Error(`Gmail history fetch failed (${res.status})`);
    const data = await res.json();
    out.historyId = (data.historyId as string) ?? out.historyId;
    for (const record of (data.history ?? []) as {
      messagesAdded?: { message: HistoryMessage }[];
      messagesDeleted?: { message: HistoryMessage }[];
      labelsAdded?: { message: HistoryMessage; labelIds: string[] }[];
      labelsRemoved?: { message: HistoryMessage; labelIds: string[] }[];
    }[]) {
      for (const { message: m } of record.messagesAdded ?? []) {
        const labels = m.labelIds ?? [];
        if (labels.includes("DRAFT")) continue;
        if (labels.includes("SENT")) out.sentAdded = true;
        if (!labels.length || labels.includes("INBOX")) added.add(m.id);
      }
      for (const { message: m } of record.messagesDeleted ?? []) out.deleted.push(m.id);
      for (const { message: m, labelIds } of record.labelsAdded ?? []) out.labels.push({ id: m.id, add: labelIds, remove: [] });
      for (const { message: m, labelIds } of record.labelsRemoved ?? []) out.labels.push({ id: m.id, add: [], remove: labelIds });
    }
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  if (pageToken) return { ...out, tooOld: true };
  out.added = [...added];
  return out;
}

// ── Labels ──────────────────────────────────────────────────────────────────
// Tabellar only adds and removes labels. There is deliberately no function
// here that deletes or trashes a message.

const labelCache = new Map<string, string>(); // `${tokenRef}|${name}` -> label id

// The id of the user label with this name, created if it does not exist.
async function ensureLabel(tokenRef: string, name: string): Promise<string> {
  const key = `${tokenRef}|${name}`;
  const cached = labelCache.get(key);
  if (cached) return cached;
  const { tokenData } = await resolveTokens(tokenRef);
  const list = await gmailRequest(tokenData.token, "/labels");
  if (!list.ok) throw new Error(`Gmail labels list failed (${list.status})`);
  const found = ((await list.json()).labels ?? []).find((l: { name: string }) => l.name === name) as { id: string } | undefined;
  let id = found?.id;
  if (!id) {
    const res = await gmailRequest(tokenData.token, "/labels", {
      method: "POST",
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
    if (!res.ok) throw new Error(`Gmail label create failed (${res.status}): ${await res.text().catch(() => "")}`);
    id = (await res.json()).id as string;
  }
  labelCache.set(key, id);
  return id;
}

// The names of the user's own Gmail labels, for mapping a Tabellar label to one.
async function userLabelNames(tokenRef: string): Promise<string[]> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, "/labels");
  if (!res.ok) throw new Error(`Gmail labels list failed (${res.status})`);
  return ((await res.json()).labels ?? []).filter((l: { type?: string }) => l.type === "user").map((l: { name: string }) => l.name);
}

// Add and remove labels on messages. Archiving is removing INBOX.
async function batchModifyLabels(tokenRef: string, gmailIds: string[], add: string[], drop: string[]): Promise<void> {
  const { tokenData } = await resolveTokens(tokenRef);
  for (let i = 0; i < gmailIds.length; i += 1000) {
    const res = await gmailRequest(tokenData.token, "/messages/batchModify", {
      method: "POST",
      body: JSON.stringify({ ids: gmailIds.slice(i, i + 1000), addLabelIds: add, removeLabelIds: drop }),
    });
    if (!res.ok) throw new Error(`Gmail label change failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
}

// A few headers of one message, keyed by lower-case name. Used for the
// Message-ID an automatic reply points at and for List-Unsubscribe.
async function messageHeaders(tokenRef: string, gmailId: string, names: string[]): Promise<Record<string, string>> {
  const { tokenData } = await resolveTokens(tokenRef);
  const q = names.map((n) => `metadataHeaders=${encodeURIComponent(n)}`).join("&");
  const res = await gmailRequest(tokenData.token, `/messages/${encodeURIComponent(gmailId)}?format=metadata&${q}`);
  if (!res.ok) throw new Error(`Gmail message lookup failed (${res.status})`);
  const headers: Record<string, string> = {};
  for (const h of ((await res.json()).payload?.headers ?? []) as { name: string; value: string }[]) headers[h.name.toLowerCase()] = h.value;
  return headers;
}

// The thread a message belongs to, or "" when Gmail no longer has it.
async function threadIdOf(tokenRef: string, gmailId: string): Promise<string> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, `/messages/${encodeURIComponent(gmailId)}?format=minimal&fields=threadId`);
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`Gmail message lookup failed (${res.status})`);
  return ((await res.json()).threadId as string) ?? "";
}

// Has this mailbox ever sent mail to the address? Asks Gmail, since sync
// does not keep a copy of sent mail.
async function hasSentTo(tokenRef: string, address: string): Promise<boolean> {
  const { tokenData } = await resolveTokens(tokenRef);
  const q = encodeURIComponent(`in:sent to:${address}`);
  const res = await gmailRequest(tokenData.token, `/messages?q=${q}&maxResults=1&fields=messages/id`);
  if (!res.ok) throw new Error(`Gmail search failed (${res.status})`);
  // With no match Gmail can answer with an empty body.
  const text = await res.text();
  return text ? (JSON.parse(text).messages ?? []).length > 0 : false;
}

type GEvent = { id: string; summary?: string; status?: string; htmlLink?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: { email?: string }[]; organizer?: { email?: string } };

const linked = (e: GEvent): LinkedEvent => ({
  id: e.id,
  title: e.summary ?? "",
  start: e.start?.dateTime ?? e.start?.date ?? null,
  end: e.end?.dateTime ?? e.end?.date ?? null,
  all_day: !e.start?.dateTime,
  link: e.htmlLink ?? null,
  on_calendar: true,
});

// Is this event already on the user's calendar? By its iCalendar UID when an
// .ics gave one; otherwise an event a day either side of `start` that starts
// at the same moment or has one of `people` as a guest or organiser.
async function findCalendarEvent(tokenRef: string, q: { uid?: string; start?: string | null; people?: string[] }): Promise<LinkedEvent | null> {
  const { tokenData } = await resolveTokens(tokenRef);
  const get = async (params: Record<string, string>): Promise<GEvent[]> => {
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({ ...params, fields: "items(id,summary,status,htmlLink,start,end,attendees(email),organizer(email))" })}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tokenData.token}` } });
    if (!res.ok) throw new Error(`Calendar lookup failed (${res.status})`);
    return (((await res.json()).items ?? []) as GEvent[]).filter((e) => e.status !== "cancelled");
  };
  if (q.uid) {
    const [byUid] = await get({ iCalUID: q.uid, maxResults: "1" });
    if (byUid) return linked(byUid);
  }
  const at = q.start ? new Date(q.start).getTime() : NaN;
  if (isNaN(at)) return null;
  const day = 86_400_000;
  const near = await get({ timeMin: new Date(at - day).toISOString(), timeMax: new Date(at + day).toISOString(), singleEvents: "true", maxResults: "100" });
  const people = new Set((q.people ?? []).map((p) => p.toLowerCase()));
  const sameStart = near.find((e) => Math.abs(new Date(e.start?.dateTime ?? e.start?.date ?? 0).getTime() - at) < 60_000);
  const samePeople = near.find((e) => [...(e.attendees ?? []), e.organizer ?? {}].some((a) => a.email && people.has(a.email.toLowerCase())));
  const hit = sameStart ?? samePeople;
  return hit ? linked(hit) : null;
}

// The message as Gmail's API takes it: base64url of the whole MIME text.
const mimeRaw = (m: Outgoing) => Buffer.from(writeMessage(m), "utf8").toString("base64url");

async function sendEmail(tokenRef: string, m: Outgoing, threadId?: string): Promise<{ id: string }> {
  const { tokenData } = await resolveTokens(tokenRef);
  const body: Record<string, string> = { raw: mimeRaw(m) };
  if (threadId) body.threadId = threadId;
  const { result } = await withTokenRefresh(
    tokenData,
    async (token) => {
      const res = await gmailRequest(token, "/messages/send", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) {
        console.error(`[gmail] send failed status=${res.status} body=${await res.text().catch(() => "")}`);
        throw Object.assign(new Error("Gmail send failed"), { status: res.status });
      }
      return res.json();
    },
    tokenRef,
  );
  return result as { id: string };
}

// ── Drafts and send-as addresses ────────────────────────────────────────────
// Tabellar puts drafts into Gmail's Drafts, sends them from there, and takes
// out the ones it put there when they are discarded. That is the only thing
// this file can remove.

// Put a draft in the mailbox's Drafts, or replace the one already there.
// Returns the Gmail draft id. Nothing is sent.
async function saveDraft(tokenRef: string, draftId: string | null, m: Outgoing, threadId?: string): Promise<string> {
  const { tokenData } = await resolveTokens(tokenRef);
  const message: Record<string, string> = { raw: mimeRaw(m) };
  if (threadId) message.threadId = threadId;
  let res = draftId
    ? await gmailRequest(tokenData.token, `/drafts/${encodeURIComponent(draftId)}`, { method: "PUT", body: JSON.stringify({ id: draftId, message }) })
    : null;
  // A draft sent or deleted in Gmail meanwhile is made again.
  if (!res || res.status === 404) res = await gmailRequest(tokenData.token, "/drafts", { method: "POST", body: JSON.stringify({ message }) });
  if (!res.ok) throw new Error(`Gmail draft save failed (${res.status}): ${await res.text().catch(() => "")}`);
  return (await res.json()).id as string;
}

async function listDrafts(tokenRef: string): Promise<DraftStub[]> {
  const { tokenData } = await resolveTokens(tokenRef);
  const out: DraftStub[] = [];
  for (let page = ""; ; ) {
    const res = await gmailRequest(tokenData.token, `/drafts?maxResults=500&fields=nextPageToken,drafts(id,message(id,threadId))${page ? `&pageToken=${page}` : ""}`);
    if (!res.ok) throw new Error(`Gmail drafts list failed (${res.status})`);
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as { drafts?: { id: string; message: { id: string; threadId: string } }[]; nextPageToken?: string };
    // Every save gives the draft a new message.
    for (const d of data.drafts ?? []) out.push({ id: d.id, threadId: d.message.threadId, version: d.message.id });
    page = data.nextPageToken ?? "";
    if (!page) return out;
  }
}

async function readDraft(tokenRef: string, draftId: string): Promise<DraftText | null> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, `/drafts/${encodeURIComponent(draftId)}?format=full`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gmail draft lookup failed (${res.status})`);
  const msg = (await res.json()).message;
  const headers: Record<string, string> = {};
  for (const h of (msg?.payload?.headers ?? []) as { name: string; value: string }[]) headers[h.name.toLowerCase()] = h.value;
  const body = bodyOf(extractParts(msg?.payload ?? {}, newState()));
  return { text: body.text || htmlToText(body.html), html: body.html, subject: headers.subject ?? "", to: headers.to ?? "", cc: headers.cc ?? "", bcc: headers.bcc ?? "" };
}

// Take out a draft Tabellar put there. The id is a draft's, which no message
// has; one sent or discarded in Gmail meanwhile is gone already.
async function discardDraft(tokenRef: string, draftId: string): Promise<void> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, `/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Gmail kept the draft (${res.status})`);
}

// Send a draft that is in Gmail's Drafts, with its final text: Gmail sends
// it and takes it out of Drafts. One gone from Drafts meanwhile is made again.
async function sendDraft(tokenRef: string, draftId: string, m: Outgoing, threadId?: string): Promise<{ id: string }> {
  const id = await saveDraft(tokenRef, draftId, m, threadId);
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, "/drafts/send", { method: "POST", body: JSON.stringify({ id }) });
  if (!res.ok) {
    console.error(`[gmail] draft send failed status=${res.status} body=${await res.text().catch(() => "")}`);
    throw Object.assign(new Error("Gmail send failed"), { status: res.status });
  }
  return { id: (await res.json()).id as string };
}

// The addresses this mailbox may send from: its own and every alias Gmail
// has verified, from Settings, Accounts, "Send mail as".
async function listSendAs(tokenRef: string): Promise<SendAs[]> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, "/settings/sendAs");
  if (!res.ok) throw new Error(`Gmail send-as list failed (${res.status})`);
  const list = ((await res.json()).sendAs ?? []) as { sendAsEmail: string; displayName?: string; isDefault?: boolean; isPrimary?: boolean; verificationStatus?: string }[];
  return list
    .filter((s) => s.isPrimary || s.verificationStatus === "accepted")
    .map((s) => ({ address: s.sendAsEmail.toLowerCase(), name: s.displayName ?? "", default: !!s.isDefault }));
}

async function fetchSentEmails(tokenRef: string, maxResults = 20): Promise<Sent[]> {
  const { tokenData } = await resolveTokens(tokenRef);

  const listRes = await gmailRequest(
    tokenData.token,
    `/messages?labelIds=SENT&maxResults=${maxResults}`,
  );
  if (!listRes.ok) return [];

  const data = await listRes.json();
  const messages: { id: string }[] = data.messages ?? [];
  const sent: Sent[] = [];

  const CONCURRENCY = 10;
  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    const chunk = messages.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (stub) => {
        try {
          const msgRes = await gmailRequest(
            tokenData.token,
            `/messages/${stub.id}?format=full`,
          );
          if (!msgRes.ok) return null;
          const msg = await msgRes.json();
          const headers: Record<string, string> = {};
          for (const h of msg.payload?.headers ?? []) {
            headers[(h.name as string).toLowerCase()] = h.value as string;
          }
          const state = newState();
          const body = bodyOf(extractParts(msg.payload ?? {}, state));
          listUnshown(state, body.html);
          return {
            id: msg.id as string,
            thread_id: msg.threadId as string,
            subject: headers["subject"] ?? "",
            from: headers["from"] ?? "",
            to: headers["to"] ?? "",
            cc: headers["cc"] ?? "",
            date: headers["date"] ?? "",
            body_html: body.html,
            body: body.text || htmlToText(body.html),
            snippet: decodeSnippet(msg.snippet as string),
            has_attachments: state.hasAttachments,
            attachments: state.attachments,
          };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) sent.push(r);
    }
  }
  return sent;
}

async function fetchAttachment(
  tokenRef: string,
  messageId: string,
  attachmentId: string,
): Promise<{ data: string; size: number } | null> {
  const { tokenData } = await resolveTokens(tokenRef);
  try {
    const res = await gmailRequest(
      tokenData.token,
      `/messages/${messageId}/attachments/${attachmentId}`,
    );
    if (!res.ok) return null;
    const json = await res.json();
    return { data: json.data as string, size: json.size as number };
  } catch {
    return null;
  }
}

async function fetchGoogleContacts(
  tokenRef: string,
): Promise<{ name: string; email: string }[]> {
  const { tokenData } = await resolveTokens(tokenRef);
  const contacts: { name: string; email: string }[] = [];
  let pageToken: string | undefined;

  do {
    const url = `https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tokenData.token}` },
    });
    if (!res.ok) break;
    const data = await res.json();
    const connections: Array<{
      names?: Array<{ displayName: string }>;
      emailAddresses?: Array<{ value: string }>;
    }> = data.connections ?? [];
    for (const c of connections) {
      const name = c.names?.[0]?.displayName;
      const email = c.emailAddresses?.[0]?.value?.toLowerCase();
      if (name && email) contacts.push({ name, email });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return contacts;
}

/** Fetches ALL Google Contacts + Workspace directory people for a given account.
 *  Returns up to ~2000 contacts (paginated) for bulk caching. */
export async function listAllGoogleContacts(
  tokenRef: string,
): Promise<{ name: string; email: string; source: "directory" | "contact" }[]> {
  const { tokenData } = await resolveTokens(tokenRef);
  const results: { name: string; email: string; source: "directory" | "contact" }[] = [];
  const seen = new Set<string>();

  // Personal contacts via connections.list (paginated)
  try {
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        readMask: "names,emailAddresses",
        pageSize: "1000",
        ...(pageToken ? { pageToken } : {}),
      });
      const res = await fetch(
        `https://people.googleapis.com/v1/people/me/connections?${params}`,
        { headers: { Authorization: `Bearer ${tokenData.token}` } },
      );
      if (!res.ok) break;
      const data = await res.json();
      for (const p of data.connections ?? []) {
        const name = p.names?.[0]?.displayName ?? "";
        const email = p.emailAddresses?.[0]?.value?.toLowerCase();
        if (email && !seen.has(email)) {
          seen.add(email);
          results.push({ name, email, source: "contact" });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken && results.length < 2000);
  } catch {
    /* contacts.readonly scope not granted */
  }

  // Other Contacts via otherContacts.list (contacts.other.readonly)
  // This is what Gmail uses, auto-collected from email history, no explicit save needed
  try {
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        readMask: "names,emailAddresses",
        pageSize: "1000",
        ...(pageToken ? { pageToken } : {}),
      });
      const res = await fetch(
        `https://people.googleapis.com/v1/otherContacts?${params}`,
        { headers: { Authorization: `Bearer ${tokenData.token}` } },
      );
      if (!res.ok) break;
      const data = await res.json();
      for (const p of data.otherContacts ?? []) {
        const name = p.names?.[0]?.displayName ?? "";
        const email = p.emailAddresses?.[0]?.value?.toLowerCase();
        if (email && !seen.has(email)) {
          seen.add(email);
          results.push({ name, email, source: "contact" });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken && results.length < 3000);
  } catch {
    /* contacts.other.readonly scope not granted */
  }

  // Workspace directory via listDirectoryPeople (paginated)
  try {
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        readMask: "names,emailAddresses",
        sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
        pageSize: "1000",
        ...(pageToken ? { pageToken } : {}),
      });
      const res = await fetch(
        `https://people.googleapis.com/v1/people:listDirectoryPeople?${params}`,
        { headers: { Authorization: `Bearer ${tokenData.token}` } },
      );
      if (!res.ok) break;
      const data = await res.json();
      for (const p of data.people ?? []) {
        const name = p.names?.[0]?.displayName ?? "";
        const email = p.emailAddresses?.[0]?.value?.toLowerCase();
        if (email && !seen.has(email)) {
          seen.add(email);
          results.push({ name, email, source: "directory" });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken && results.length < 5000);
  } catch {
    /* directory.readonly scope not granted or admin restricted */
  }

  // Extract contacts from Gmail sent mail, uses gmail.modify scope (always available).
  // This finds every person the user has ever emailed, covering friends not in other lists.
  try {
    const sentListRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:sent&maxResults=500&fields=messages/id`,
      { headers: { Authorization: `Bearer ${tokenData.token}` } },
    );
    if (sentListRes.ok) {
      const sentData = await sentListRes.json();
      const messageIds: string[] = (sentData.messages ?? []).map((m: { id: string }) => m.id);

      // Fetch headers in concurrent batches of 25
      const batchSize = 25;
      for (let i = 0; i < messageIds.length; i += batchSize) {
        const batch = messageIds.slice(i, i + batchSize);
        const headerResults = await Promise.all(
          batch.map((id) =>
            fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&fields=payload/headers`,
              { headers: { Authorization: `Bearer ${tokenData.token}` } },
            ).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          ),
        );

        for (const msg of headerResults) {
          if (!msg) continue;
          for (const header of msg.payload?.headers ?? []) {
            if (header.name !== "To" && header.name !== "Cc") continue;
            for (const part of (header.value as string).split(",")) {
              const angleMatch = part.match(/^(.*?)<([^>]+)>\s*$/);
              const email = (angleMatch ? angleMatch[2] : part).trim().toLowerCase();
              const name = angleMatch ? angleMatch[1].trim().replace(/^"|"$/g, "").trim() : "";
              if (email && email.includes("@") && !seen.has(email)) {
                seen.add(email);
                results.push({ name, email, source: "contact" });
              }
            }
          }
        }
      }
    }
  } catch {
    /* ignore */
  }

  return results;
}

/** Search Google contacts and Workspace directory by name or email query. */
export async function searchGoogleContacts(
  tokenRef: string,
  query: string,
): Promise<{ name: string; email: string; source?: "directory" | "contact" }[]> {
  const { tokenData } = await resolveTokens(tokenRef);
  const results: { name: string; email: string; source?: "directory" | "contact" }[] = [];
  const seen = new Set<string>();

  // Try Workspace directory search first (works for Workspace accounts like @nyu.edu)
  try {
    const dirRes = await fetch(
      `https://people.googleapis.com/v1/people:searchDirectoryPeople?query=${encodeURIComponent(query)}&readMask=names,emailAddresses&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE&pageSize=10`,
      { headers: { Authorization: `Bearer ${tokenData.token}` } },
    );
    if (dirRes.ok) {
      const data = await dirRes.json();
      for (const p of data.people ?? []) {
        const name = p.names?.[0]?.displayName;
        const email = p.emailAddresses?.[0]?.value?.toLowerCase();
        if (name && email && !seen.has(email)) {
          seen.add(email);
          results.push({ name, email, source: "directory" });
        }
      }
    }
  } catch {
    /* not a Workspace account or scope not granted */
  }

  // Search personal contacts (contacts.readonly)
  try {
    const contRes = await fetch(
      `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(query)}&readMask=names,emailAddresses&pageSize=10`,
      { headers: { Authorization: `Bearer ${tokenData.token}` } },
    );
    if (contRes.ok) {
      const data = await contRes.json();
      for (const r of data.results ?? []) {
        const p = r.person;
        const name = p.names?.[0]?.displayName;
        const email = p.emailAddresses?.[0]?.value?.toLowerCase();
        if (name && email && !seen.has(email)) {
          seen.add(email);
          results.push({ name, email, source: "contact" });
        }
      }
    }
  } catch {
    /* ignore */
  }

  // Search "Other Contacts", people Gmail auto-collected from email history
  // (contacts.other.readonly scope), this is what Gmail uses for friend suggestions
  try {
    const otherRes = await fetch(
      `https://people.googleapis.com/v1/otherContacts:search?query=${encodeURIComponent(query)}&readMask=names,emailAddresses&pageSize=10`,
      { headers: { Authorization: `Bearer ${tokenData.token}` } },
    );
    if (otherRes.ok) {
      const data = await otherRes.json();
      for (const r of data.results ?? []) {
        const p = r.person;
        const name = p.names?.[0]?.displayName ?? "";
        const email = p.emailAddresses?.[0]?.value?.toLowerCase();
        if (email && !seen.has(email)) {
          seen.add(email);
          results.push({ name, email, source: "contact" });
        }
      }
    }
  } catch {
    /* contacts.other.readonly scope not granted */
  }

  return results;
}

// ── Google Calendar ─────────────────────────────────────────────────────────

const CALENDAR = "https://www.googleapis.com/calendar/v3";

async function calendarRequest(tokenRef: string, path: string, init: RequestInit = {}): Promise<any> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await fetch(`${CALENDAR}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tokenData.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    console.error(`[calendar] google error status=${res.status} body=${await res.text().catch(() => "")}`);
    throw Object.assign(new Error("Google Calendar did not accept it"), { status: 502 });
  }
  return res.json();
}

const gTime = (dateTime: string, timeZone?: string) => (timeZone ? { dateTime, timeZone } : { dateTime });

function gEvent(e: NewEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (e.title !== undefined) out.summary = e.title;
  if (e.description !== undefined) out.description = e.description;
  if (e.start) out.start = gTime(e.start, e.timeZone);
  if (e.end) out.end = gTime(e.end, e.timeZone);
  if (e.location !== undefined) out.location = e.location;
  if (e.attendees) out.attendees = e.attendees.map((email) => ({ email }));
  return out;
}

const googleCalendar: Calendar = {
  async busy(a, from, to) {
    const data = await calendarRequest(a.token_ref, "/freeBusy", {
      method: "POST",
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] }),
    });
    return data.calendars?.primary?.busy ?? [];
  },
  async events(a, from, to, max) {
    const q = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(max),
      fields: "items(id,summary,start,end,attendees,location,hangoutLink,conferenceData,htmlLink,status,description)",
    });
    const data = await calendarRequest(a.token_ref, `/calendars/primary/events?${q}`);
    return ((data.items ?? []) as any[])
      .filter((ev) => ev.status !== "cancelled")
      .map((ev): CalEvent => ({
        id: ev.id,
        title: ev.summary ?? "(No title)",
        start: ev.start?.dateTime ?? ev.start?.date ?? null,
        end: ev.end?.dateTime ?? ev.end?.date ?? null,
        allDay: !ev.start?.dateTime,
        // The other people: not the user, not a room.
        attendees: (ev.attendees ?? []).filter((x: any) => !x.self && !x.resource).map((x: any) => x.displayName || x.email).filter(Boolean),
        people: (ev.attendees ?? []).filter((x: any) => !x.self && !x.resource && x.email).map((x: any) => String(x.email).toLowerCase()),
        location: ev.location ?? null,
        meetingLink: ev.hangoutLink ?? ev.conferenceData?.entryPoints?.[0]?.uri ?? null,
        htmlLink: ev.htmlLink ?? null,
        status: ev.status ?? "confirmed",
        source: "google_calendar",
      }));
  },
  async create(a, e, invite) {
    const ev = await calendarRequest(a.token_ref, `/calendars/primary/events?sendUpdates=${invite ? "all" : "none"}`, { method: "POST", body: JSON.stringify(gEvent(e)) });
    return { id: ev.id as string, link: (ev.htmlLink as string) ?? null };
  },
  async update(a, id, e, invite) {
    const ev = await calendarRequest(a.token_ref, `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=${invite ? "all" : "none"}`, { method: "PATCH", body: JSON.stringify(gEvent(e)) });
    return { id: ev.id as string, link: (ev.htmlLink as string) ?? null };
  },
  async cancel(a, id, invite) {
    await calendarRequest(a.token_ref, `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=${invite ? "all" : "none"}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
  },
  find: (a, q) => findCalendarEvent(a.token_ref, q),
};

// ── The mailbox ─────────────────────────────────────────────────────────────

export const gmailMailbox: Mail = {
  cursor: (a) => currentHistoryId(a.token_ref),
  changes: (a, cursor) => readHistory(a.token_ref, cursor),
  moved: async (a) => !!a.history_id && (await currentHistoryId(a.token_ref)) !== a.history_id,
  list: (a, q) => listMessageIds(a.token_ref, `${q.inbox ? "in:inbox" : "-in:chats -in:drafts"}${q.days ? ` newer_than:${q.days}d` : ""}`, q.cap),
  fetch: (a, ids) => fetchMessages(a.token_ref, ids),
  headerRows: (a, ids) => fetchHeaderRows(a.token_ref, ids),
  sent: (a, max) => fetchSentEmails(a.token_ref, max),
  headers: (a, id, names) => messageHeaders(a.token_ref, id, names),
  threadOf: (a, id) => threadIdOf(a.token_ref, id),
  send: (a, m, threadId) => sendEmail(a.token_ref, m, threadId),
  drafts: (a) => listDrafts(a.token_ref),
  readDraft: (a, draftId) => readDraft(a.token_ref, draftId),
  saveDraft: (a, draftId, m, threadId) => saveDraft(a.token_ref, draftId, m, threadId),
  discardDraft: (a, draftId) => discardDraft(a.token_ref, draftId),
  sendDraft: (a, draftId, m, threadId) => sendDraft(a.token_ref, draftId, m, threadId),
  label: (a, name) => ensureLabel(a.token_ref, name),
  labelNames: (a) => userLabelNames(a.token_ref),
  modify: (a, ids, add, remove) => batchModifyLabels(a.token_ref, ids, add, remove),
  sendAs: (a) => listSendAs(a.token_ref),
  hasSentTo: (a, address) => hasSentTo(a.token_ref, address),
  files: (a, q, cap) => listMessageIds(a.token_ref, `has:attachment -in:trash -in:spam ${q.from ? `from:(${q.from.replace(/[()"]/g, " ")}) ` : ""}${q.text.replace(/[(){}"]/g, " ")}`.trim(), cap),
  attachment: (a, id, attachmentId) => fetchAttachment(a.token_ref, id, attachmentId),
  contacts: (a) => fetchGoogleContacts(a.token_ref),
  disconnect: (a) => revokeGoogleTokens(a.token_ref),
  calendar: googleCalendar,
};
