/**
 * Gmail REST API helpers.
 * Uses fetch() + OAuth access tokens directly — no Python client library needed.
 */

import { loadTokens, saveTokens, refreshAccessToken, type TokenData } from "./google.ts";
import { calendarHeaders, parseIcs, type CalendarEvent } from "./rules.ts";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export type { TokenData };

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
  // Structural signals for smarter categorization
  has_list_unsubscribe: boolean;
  is_reply: boolean;
  reply_to_email?: string;
  cc_recipients?: string;
  precedence_header?: string;
  list_id?: string;
  is_calendar: boolean; // an invitation, an answer to one, a cancellation
  calendar_event: CalendarEvent | null; // its .ics, read
}


export async function loadTokensSafe(ref: string): Promise<TokenData | null> {
  try {
    return await loadTokens(ref);
  } catch (err) {
    console.error("[gmail] loadTokensSafe failed:", err);
    return null;
  }
}

export { loadTokens, saveTokens };

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

// Over quota, Gmail answers 429, or 403 with a rate limit reason.
async function overQuota(res: Response): Promise<boolean> {
  if (res.status === 429 || res.status >= 500) return true;
  if (res.status !== 403) return false;
  return /rateLimitExceeded|quota exceeded/i.test(await res.clone().text().catch(() => ""));
}

// One Gmail API call, paced, and asked again after a growing pause (up to
// about a minute in all) while Gmail says it is over quota or busy.
async function gmailRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
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
    if (attempt >= 6 || !(await overQuota(res))) return res;
    await res.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
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

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
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

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", zwnj: "", zwj: "", shy: "",
  ndash: "-", mdash: "-", hellip: "...", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"',
  bull: "*", middot: "*", copy: "(c)", reg: "(R)", trade: "(TM)", euro: "EUR", pound: "GBP",
};

// The readable text of an HTML email, for mail that has no plain-text part.
// Style, script, head and comments go with their contents; block tags become
// line breaks.
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|head|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|tr|table|tbody|thead|ul|ol|li|h[1-6]|blockquote|section|article|header|footer|center|hr|pre)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[​-‍͏﻿­]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeCodePoint(n: number): string {
  try {
    return n === 160 ? " " : String.fromCodePoint(n);
  } catch {
    return "";
  }
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
  bodyText: string;
  bodyHtml: string;
  hasAttachments: boolean;
  attachments: AttachmentInfo[];
  cidParts: {
    contentId: string;
    mimeType: string;
    data?: string;
    attachmentId?: string;
  }[];
  ics: { data?: string; attachmentId?: string } | null; // the first text/calendar part, with or without a filename
}

function extractBody(part: EmailPart, state: ExtractState) {
  const mime = part.mimeType ?? "";
  const contentId = part.headers
    ?.find((h) => h.name.toLowerCase() === "content-id")
    ?.value?.replace(/[<>]/g, "");

  if ((mime === "text/calendar" || mime === "application/ics") && !state.ics && (part.body?.data || part.body?.attachmentId)) {
    state.ics = { data: part.body.data, attachmentId: part.body.attachmentId };
  }

  if (mime === "text/plain" && part.body?.data) {
    state.bodyText = b64urlDecode(part.body.data);
  } else if (mime === "text/html" && part.body?.data) {
    state.bodyHtml = b64urlDecode(part.body.data);
  } else if (mime.startsWith("image/") && contentId) {
    // Inline image referenced by CID
    state.cidParts.push({
      contentId,
      mimeType: mime,
      data: part.body?.data,
      attachmentId: part.body?.attachmentId,
    });
  } else if (part.filename) {
    // Regular attachment — treat message/rfc822 (attached .eml) as an opaque
    // blob so we don't recurse into its nested parts and accidentally pull in
    // the nested email's own attachments as if they belong to the parent.
    state.hasAttachments = true;
    if (part.body?.attachmentId) {
      state.attachments.push({
        filename: part.filename,
        mime_type: mime || "application/octet-stream",
        size: part.body.size ?? 0,
        attachment_id: part.body.attachmentId,
      });
    }
    // Do not recurse into attached messages.
    if (mime.startsWith("message/")) return;
  }

  for (const sub of part.parts ?? []) {
    extractBody(sub as EmailPart, state);
  }
}

async function fetchMessageById(
  accessToken: string,
  messageId: string,
): Promise<EmailData | null> {
  try {
    const msgRes = await gmailRequest(
      accessToken,
      `/messages/${messageId}?format=full`,
    );
    if (!msgRes.ok) return null;
    const msg = await msgRes.json();

    const headers: Record<string, string> = {};
    for (const h of msg.payload?.headers ?? []) {
      headers[(h.name as string).toLowerCase()] = h.value as string;
    }

    const state: ExtractState = {
      bodyText: "",
      bodyHtml: "",
      hasAttachments: false,
      attachments: [],
      cidParts: [],
      ics: null,
    };
    extractBody(msg.payload ?? {}, state);

    // The event a calendar email is about, from its .ics.
    let icsText = state.ics?.data ? b64urlDecode(state.ics.data) : "";
    if (!icsText && state.ics?.attachmentId) {
      try {
        const res = await gmailRequest(accessToken, `/messages/${messageId}/attachments/${state.ics.attachmentId}`);
        if (res.ok) icsText = b64urlDecode(((await res.json()).data as string) ?? "");
      } catch {
        // Still calendar mail, without the event's details.
      }
    }

    // Replace CID inline image references with embedded data URIs
    for (const cid of state.cidParts) {
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
      if (imgData && state.bodyHtml) {
        const base64 = imgData.replace(/-/g, "+").replace(/_/g, "/");
        const dataUri = `data:${cid.mimeType};base64,${base64}`;
        const escaped = cid.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        state.bodyHtml = state.bodyHtml.replace(
          new RegExp(`cid:${escaped}`, "gi"),
          dataUri,
        );
      }
    }

    const from = headers["from"] ?? "";
    const replyTo = headers["reply-to"] ?? "";
    const replyToEmail = replyTo ? extractEmail(replyTo) : undefined;
    return {
      gmail_id: msg.id as string,
      thread_id: msg.threadId as string,
      subject: headers["subject"] ?? "",
      sender: from,
      sender_email: extractEmail(from),
      recipients: headers["to"] ?? "",
      snippet: decodeSnippet(msg.snippet as string),
      body_text: state.bodyText || htmlToText(state.bodyHtml),
      body_html: state.bodyHtml,
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
        replyToEmail && replyToEmail !== extractEmail(from)
          ? replyToEmail
          : undefined,
      cc_recipients: headers["cc"] ?? undefined,
      precedence_header: headers["precedence"] ?? undefined,
      list_id: headers["list-id"] ?? undefined,
      is_calendar: !!state.ics || calendarHeaders(headers),
      calendar_event: icsText ? parseIcs(icsText, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") : null,
    };
  } catch {
    return null;
  }
}

// Full messages by id, a few at a time, skipping any Gmail no longer has.
export async function fetchMessages(tokenRef: string, ids: string[]): Promise<EmailData[]> {
  const out: EmailData[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const { tokenData } = await resolveTokens(tokenRef);
    const got = await Promise.all(ids.slice(i, i + 20).map((id) => fetchMessageById(tokenData.token, id)));
    for (const e of got) if (e) out.push(e);
  }
  return out;
}

// Ids of the messages matching a Gmail search, newest first, at most `cap`.
export async function listMessageIds(tokenRef: string, q: string, cap: number): Promise<string[]> {
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

const INDEX_HEADERS = ["From", "To", "Cc", "List-Unsubscribe", "List-Id", "Precedence"];

// Headers only, for many messages: one small request each, ten at a time.
export async function fetchHeaderRows(tokenRef: string, ids: string[]): Promise<HeaderRow[]> {
  const q = INDEX_HEADERS.map((n) => `metadataHeaders=${n}`).join("&");
  const out: HeaderRow[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const { tokenData } = await resolveTokens(tokenRef);
    const got = await Promise.all(
      ids.slice(i, i + 10).map(async (id) => {
        const res = await gmailRequest(tokenData.token, `/messages/${id}?format=metadata&${q}&fields=id,threadId,labelIds,internalDate,payload/headers`);
        if (!res.ok) return null;
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

export async function fetchEmails(
  tokenRef: string,
  maxResults = 20,
  db?: { from: (t: string) => unknown },
  accountId?: string,
  paginate = false,
): Promise<{ emails: EmailData[]; updatedTokenRef?: string }> {
  let { tokenData, updatedTokenRef } = await resolveTokens(
    tokenRef,
    db,
    accountId,
  );

  const allMessages: { id: string }[] = [];
  let pageToken: string | undefined;
  const hardCap = paginate ? 500 : maxResults;
  const perPage = Math.min(maxResults, 100); // Gmail max per page is 100

  do {
    let url = `/messages?labelIds=INBOX&maxResults=${perPage}`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    let listRes = await gmailRequest(tokenData.token, url);
    // If 401, try refreshing the token once and retry
    if (listRes.status === 401 && tokenData.refresh_token) {
      const refreshed = await refreshAccessToken(tokenData.refresh_token);
      tokenData = { ...tokenData, ...refreshed };
      updatedTokenRef = await saveTokens(tokenData);
      if (db && accountId) {
        // deno-lint-ignore no-explicit-any
        await (db.from("accounts") as any)
          .update({ token_ref: updatedTokenRef })
          .eq("id", accountId);
      }
      listRes = await gmailRequest(tokenData.token, url);
    }
    if (!listRes.ok) {
      try {
        console.error(
          `[gmail] list failed status=${listRes.status} body=${await listRes.text()}`,
        );
      } catch {
        /* ignore */
      }
      throw new Error("Gmail list fetch failed");
    }
    const listData = await listRes.json();
    const messages: { id: string }[] = listData.messages ?? [];
    allMessages.push(...messages);

    pageToken = paginate ? listData.nextPageToken : undefined;
  } while (pageToken && allMessages.length < hardCap);

  // Trim to hard cap
  const messagesToFetch = allMessages.slice(0, hardCap);

  // Fetch individual messages in parallel. Gmail's user-level quota (250
  // units/s) comfortably allows a burst of 50 concurrent message.get calls
  // (5 units each), so for a typical initial fetch we do a single round trip.
  // For very large backlogs we still cap to avoid hammering the quota.
  const CONCURRENCY = 50;
  const emails: EmailData[] = [];

  for (let i = 0; i < messagesToFetch.length; i += CONCURRENCY) {
    const chunk = messagesToFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((stub) => fetchMessageById(tokenData.token, stub.id)),
    );
    for (const r of results) {
      if (r) emails.push(r);
    }
  }

  return { emails, updatedTokenRef };
}

// Where Gmail's change history currently stands for this mailbox.
export async function currentHistoryId(tokenRef: string): Promise<string> {
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
export type LabelChange = { id: string; add: string[]; remove: string[] };
export interface MailboxChanges {
  tooOld: boolean;
  historyId: string | null;
  added: string[];
  sentAdded: boolean;
  labels: LabelChange[];
  deleted: string[];
}

type HistoryMessage = { id: string; labelIds?: string[] };

export async function readHistory(tokenRef: string, startHistoryId: string): Promise<MailboxChanges> {
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
export async function ensureLabel(tokenRef: string, name: string): Promise<string> {
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
export async function userLabelNames(tokenRef: string): Promise<string[]> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, "/labels");
  if (!res.ok) throw new Error(`Gmail labels list failed (${res.status})`);
  return ((await res.json()).labels ?? []).filter((l: { type?: string }) => l.type === "user").map((l: { name: string }) => l.name);
}

// Add and remove labels on one message. Archiving is removing INBOX.
export async function modifyLabels(tokenRef: string, gmailId: string, add: string[], remove: string[]): Promise<string[]> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, `/messages/${encodeURIComponent(gmailId)}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  });
  if (!res.ok) throw new Error(`Gmail label change failed (${res.status}): ${await res.text().catch(() => "")}`);
  return ((await res.json()).labelIds ?? []) as string[];
}

// Change labels on many messages at once (archiving a whole sender).
export async function batchModifyLabels(tokenRef: string, gmailIds: string[], add: string[], drop: string[]): Promise<void> {
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
export async function messageHeaders(tokenRef: string, gmailId: string, names: string[]): Promise<Record<string, string>> {
  const { tokenData } = await resolveTokens(tokenRef);
  const q = names.map((n) => `metadataHeaders=${encodeURIComponent(n)}`).join("&");
  const res = await gmailRequest(tokenData.token, `/messages/${encodeURIComponent(gmailId)}?format=metadata&${q}`);
  if (!res.ok) throw new Error(`Gmail message lookup failed (${res.status})`);
  const headers: Record<string, string> = {};
  for (const h of ((await res.json()).payload?.headers ?? []) as { name: string; value: string }[]) headers[h.name.toLowerCase()] = h.value;
  return headers;
}

// The thread a message belongs to, or "" when Gmail no longer has it.
export async function threadIdOf(tokenRef: string, gmailId: string): Promise<string> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, `/messages/${encodeURIComponent(gmailId)}?format=minimal&fields=threadId`);
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`Gmail message lookup failed (${res.status})`);
  return ((await res.json()).threadId as string) ?? "";
}

// Has this mailbox ever sent mail to the address? Asks Gmail, since sync
// does not keep a copy of sent mail.
export async function hasSentTo(tokenRef: string, address: string): Promise<boolean> {
  const { tokenData } = await resolveTokens(tokenRef);
  const q = encodeURIComponent(`in:sent to:${address}`);
  const res = await gmailRequest(tokenData.token, `/messages?q=${q}&maxResults=1&fields=messages/id`);
  if (!res.ok) throw new Error(`Gmail search failed (${res.status})`);
  // With no match Gmail can answer with an empty body.
  const text = await res.text();
  return text ? (JSON.parse(text).messages ?? []).length > 0 : false;
}

// An event on the user's Google Calendar, as an email is linked to it.
export type LinkedEvent = { id: string | null; title: string; start: string | null; end: string | null; all_day: boolean; link: string | null; on_calendar: boolean; method?: string };

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
export async function findCalendarEvent(tokenRef: string, q: { uid?: string; start?: string | null; people?: string[] }): Promise<LinkedEvent | null> {
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

export type Outgoing = {
  from?: string; // a From header ("Name" <address>); Gmail's default send-as address when left out
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  inReplyTo?: string;
  attachments?: { name: string; contentType: string; data: string }[];
};

// A header value with anything outside ASCII as an RFC 2047 word.
function headerText(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

// The message as Gmail's API takes it: base64url of the whole MIME text.
function mimeRaw(m: Outgoing): string {
  // A draft may have no recipient yet.
  const headers = m.to.length ? [`To: ${m.to.join(", ")}`] : [];
  if (m.from) headers.unshift(`From: ${m.from}`);
  if (m.cc?.length) headers.push(`Cc: ${m.cc.join(", ")}`);
  // Gmail delivers to Bcc recipients and strips the header before sending.
  if (m.bcc?.length) headers.push(`Bcc: ${m.bcc.join(", ")}`);
  headers.push(`Subject: ${headerText(m.subject)}`, "MIME-Version: 1.0");
  if (m.inReplyTo) headers.push(`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`);

  let mime: string;
  if (m.attachments?.length) {
    const boundary = `tabellar_${crypto.randomUUID().replace(/-/g, "")}`;
    mime = headers.join("\r\n");
    mime += `\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n`;
    mime += `\r\n--${boundary}\r\n`;
    mime += `Content-Type: text/html; charset=UTF-8\r\n`;
    mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
    mime += Buffer.from(m.html, "utf8").toString("base64") + `\r\n`;
    for (const att of m.attachments) {
      mime += `\r\n--${boundary}\r\n`;
      mime += `Content-Type: ${att.contentType || "application/octet-stream"}; name="${att.name}"\r\n`;
      mime += `Content-Disposition: attachment; filename="${att.name}"\r\n`;
      mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
      mime += att.data + `\r\n`;
    }
    mime += `\r\n--${boundary}--`;
  } else {
    mime = `${[...headers, "Content-Type: text/html; charset=UTF-8"].join("\r\n")}\r\n\r\n${m.html}`;
  }
  return Buffer.from(mime, "utf8").toString("base64url");
}

export async function sendEmail(
  tokenRef: string,
  to: string[],
  subject: string,
  bodyHtml: string,
  inReplyTo?: string,
  threadId?: string,
  attachments?: { name: string; contentType: string; data: string }[],
  cc?: string[],
  bcc?: string[],
  from?: string,
): Promise<{ id: string }> {
  const { tokenData } = await resolveTokens(tokenRef);
  const body: Record<string, string> = { raw: mimeRaw({ from, to, cc, bcc, subject, html: bodyHtml, inReplyTo, attachments }) };
  if (threadId) body.threadId = threadId;

  const { result } = await withTokenRefresh(
    tokenData,
    async (token) => {
      const res = await gmailRequest(token, "/messages/send", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`[gmail] send failed status=${res.status} body=${await res.text().catch(() => "")}`);
        const err = new Error("Gmail send failed");
        (err as unknown as { status: number }).status = res.status;
        throw err;
      }
      return res.json();
    },
    tokenRef,
  );

  return result as { id: string };
}

// ── Drafts and send-as addresses ────────────────────────────────────────────
// Tabellar puts drafts into Gmail's Drafts and sends them from there; it never
// deletes one, so a draft discarded here stays in Gmail.

// Put a draft in the mailbox's Drafts, or replace the one already there.
// Returns the Gmail draft id. Nothing is sent.
export async function saveDraft(tokenRef: string, draftId: string | null, m: Outgoing, threadId?: string): Promise<string> {
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

// Send a draft that is in Gmail's Drafts, with its final text: Gmail sends
// it and takes it out of Drafts. One gone from Drafts meanwhile is made again.
export async function sendDraft(tokenRef: string, draftId: string, m: Outgoing, threadId?: string): Promise<{ id: string }> {
  const id = await saveDraft(tokenRef, draftId, m, threadId);
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, "/drafts/send", { method: "POST", body: JSON.stringify({ id }) });
  if (!res.ok) {
    console.error(`[gmail] draft send failed status=${res.status} body=${await res.text().catch(() => "")}`);
    throw Object.assign(new Error("Gmail send failed"), { status: res.status });
  }
  return { id: (await res.json()).id as string };
}

export type SendAs = { address: string; name: string; default: boolean };

// The addresses this mailbox may send from: its own and every alias Gmail
// has verified, from Settings, Accounts, "Send mail as".
export async function listSendAs(tokenRef: string): Promise<SendAs[]> {
  const { tokenData } = await resolveTokens(tokenRef);
  const res = await gmailRequest(tokenData.token, "/settings/sendAs");
  if (!res.ok) throw new Error(`Gmail send-as list failed (${res.status})`);
  const list = ((await res.json()).sendAs ?? []) as { sendAsEmail: string; displayName?: string; isDefault?: boolean; isPrimary?: boolean; verificationStatus?: string }[];
  return list
    .filter((s) => s.isPrimary || s.verificationStatus === "accepted")
    .map((s) => ({ address: s.sendAsEmail.toLowerCase(), name: s.displayName ?? "", default: !!s.isDefault }));
}

export async function fetchSentEmails(
  tokenRef: string,
  maxResults = 20,
): Promise<
  {
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
  }[]
> {
  const { tokenData } = await resolveTokens(tokenRef);

  const listRes = await gmailRequest(
    tokenData.token,
    `/messages?labelIds=SENT&maxResults=${maxResults}`,
  );
  if (!listRes.ok) return [];

  const data = await listRes.json();
  const messages: { id: string }[] = data.messages ?? [];
  const sent: {
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
  }[] = [];

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
          const state: ExtractState = {
            bodyText: "",
            bodyHtml: "",
            hasAttachments: false,
            attachments: [],
            cidParts: [],
            ics: null,
          };
          extractBody(msg.payload ?? {}, state);
          return {
            id: msg.id as string,
            thread_id: msg.threadId as string,
            subject: headers["subject"] ?? "",
            from: headers["from"] ?? "",
            to: headers["to"] ?? "",
            cc: headers["cc"] ?? "",
            date: headers["date"] ?? "",
            body_html: state.bodyHtml,
            body: state.bodyText || htmlToText(state.bodyHtml),
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

export async function fetchAttachment(
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

export async function fetchDrafts(
  tokenRef: string,
): Promise<{ id: string; subject: string; snippet: string }[]> {
  const { tokenData } = await resolveTokens(tokenRef);

  const listRes = await gmailRequest(tokenData.token, "/drafts");
  if (!listRes.ok) return [];

  const data = await listRes.json();
  const draftStubs: { id: string }[] = data.drafts ?? [];
  const drafts: { id: string; subject: string; snippet: string }[] = [];

  const CONCURRENCY = 5;
  for (let i = 0; i < draftStubs.length; i += CONCURRENCY) {
    const chunk = draftStubs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (d) => {
        try {
          const draftRes = await gmailRequest(
            tokenData.token,
            `/drafts/${d.id}`,
          );
          if (!draftRes.ok) return null;
          const draft = await draftRes.json();
          const msg = draft.message ?? {};
          const headers: Record<string, string> = {};
          for (const h of msg.payload?.headers ?? []) {
            headers[(h.name as string).toLowerCase()] = h.value as string;
          }
          return {
            id: d.id,
            subject: headers["subject"] ?? "",
            snippet: decodeSnippet(msg.snippet as string),
          };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) drafts.push(r);
    }
  }
  return drafts;
}

export async function fetchGoogleContacts(
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
  // This is what Gmail uses — auto-collected from email history, no explicit save needed
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

  // Extract contacts from Gmail sent mail — uses gmail.modify scope (always available).
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

  // Search "Other Contacts" — people Gmail auto-collected from email history
  // (contacts.other.readonly scope) — this is what Gmail uses for friend suggestions
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
