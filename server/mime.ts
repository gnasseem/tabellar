// Raw email, read and written: RFC 5322 headers and MIME parts. Gmail and
// Microsoft hand Tabellar messages already taken apart; an IMAP server hands
// over the raw text, which is read here. Outgoing mail is written here for
// every provider.

import { randomUUID } from "node:crypto";
import type { AttachmentInfo, Outgoing } from "./providers.ts";

export type Part = {
  headers: Record<string, string>;
  type: string; // lower case, "text/plain"
  params: Record<string, string>;
  filename: string;
  body: Buffer; // decoded
  parts: Part[];
  path: string; // "", "1", "1.2": an attachment's id
};

// ── Headers ─────────────────────────────────────────────────────────────────

// The text of a header value: RFC 2047 encoded words decoded, folding undone.
export function decodeWords(s: string): string {
  return s
    .replace(/\r?\n[ \t]+/g, " ")
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?[^?]+\?[bq]\?[^?]*\?=)/gi, "$1")
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes = enc.toLowerCase() === "b" ? Buffer.from(data, "base64") : qp(data.replace(/_/g, " "));
        return decodeText(bytes, charset.replace(/\*.*$/, ""));
      } catch {
        return whole;
      }
    });
}

// Header names in lower case; the first of a repeated header wins.
export function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (!(name in out)) out[name] = decodeWords(line.slice(at + 1).trim());
  }
  return out;
}

// "text/plain; charset=utf-8; name*=utf-8''r%C3%A9sum%C3%A9.pdf"
function valueAndParams(v: string): { value: string; params: Record<string, string> } {
  const [value, ...rest] = v.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  const continued: Record<string, string[]> = {};
  for (const p of rest) {
    const at = p.indexOf("=");
    if (at < 0) continue;
    let key = p.slice(0, at).trim().toLowerCase();
    let val = p.slice(at + 1).trim().replace(/^"(.*)"$/s, "$1").replace(/\\(.)/g, "$1");
    const star = key.endsWith("*");
    if (star) {
      key = key.slice(0, -1);
      const m = val.match(/^([^']*)'[^']*'(.*)$/);
      try {
        val = m ? decodeText(Buffer.from(decodeURIComponent(m[2]).split("").map((c) => c.charCodeAt(0) & 255)), m[1] || "utf-8") : decodeURIComponent(val);
      } catch {
        // kept as written
      }
    }
    const piece = key.match(/^(.*)\*(\d+)$/);
    if (piece) (continued[piece[1]] ??= [])[Number(piece[2])] = val;
    else params[key] = val;
  }
  for (const [k, pieces] of Object.entries(continued)) params[k] ??= pieces.join("");
  return { value: value.trim().toLowerCase(), params };
}

// ── Text ────────

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

// ── Bodies ──────────────────────────────────────────────────────────────────

function qp(s: string): Buffer {
  const bin = s.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bin, "latin1");
}

function decodeBody(raw: Buffer, encoding: string): Buffer {
  const e = encoding.toLowerCase();
  if (e === "base64") return Buffer.from(raw.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e === "quoted-printable") return qp(raw.toString("latin1"));
  return raw;
}

export function decodeText(bytes: Buffer, charset = "utf-8"): string {
  const cs = charset.trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

// Split a message or part into its header block and body.
function split(raw: Buffer): [string, Buffer] {
  const text = raw.toString("latin1");
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return [raw.toString("utf8"), Buffer.alloc(0)];
  return [raw.subarray(0, m.index).toString("utf8"), raw.subarray(m.index + m[0].length)];
}

export function parsePart(raw: Buffer, path = ""): Part {
  const [block, rawBody] = split(raw);
  const headers = parseHeaders(block);
  const ct = valueAndParams(headers["content-type"] ?? "text/plain");
  const cd = valueAndParams(headers["content-disposition"] ?? "");
  const filename = cd.params.filename ?? ct.params.name ?? "";
  const part: Part = { headers, type: ct.value || "text/plain", params: ct.params, filename, body: Buffer.alloc(0), parts: [], path };
  if (part.type.startsWith("multipart/") && ct.params.boundary) {
    const text = rawBody.toString("latin1");
    const marker = `--${ct.params.boundary}`;
    const pieces = text.split(new RegExp(`(?:^|\\r?\\n)${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    // The first piece is the preamble, the last after the closing marker the epilogue.
    const kids = pieces.slice(1, text.includes(`${marker}--`) ? -1 : undefined);
    kids.forEach((p, i) => part.parts.push(parsePart(Buffer.from(p, "latin1"), path ? `${path}.${i + 1}` : String(i + 1))));
  } else {
    part.body = decodeBody(rawBody, headers["content-transfer-encoding"] ?? "7bit");
  }
  return part;
}

// What a message holds: its text, its HTML with inline images as data URIs,
// its attachments, and the first calendar part.
// `report` is a read receipt's own part.
export type Read = { headers: Record<string, string>; text: string; html: string; attachments: AttachmentInfo[]; ics: string; report: string };

export function readMessage(raw: Buffer): Read {
  const top = parsePart(raw);
  const out: Read = { headers: top.headers, text: "", html: "", attachments: [], ics: "", report: "" };
  const inline: Part[] = [];
  const walk = (p: Part) => {
    const disposition = (p.headers["content-disposition"] ?? "").toLowerCase();
    if ((p.type === "text/calendar" || p.type === "application/ics") && !out.ics) out.ics = decodeText(p.body, p.params.charset);
    if (p.type === "message/disposition-notification") {
      out.report ||= decodeText(p.body, p.params.charset);
      return;
    }
    if (p.type === "message/rfc822" || (p.filename && !p.type.startsWith("multipart/"))) {
      if (p.type.startsWith("image/") && p.headers["content-id"] && !disposition.startsWith("attachment")) inline.push(p);
      else out.attachments.push({ filename: p.filename || "message.eml", mime_type: p.type, size: p.body.length, attachment_id: p.path });
      return;
    }
    if (p.type === "text/plain" && !out.text && !disposition.startsWith("attachment")) out.text = decodeText(p.body, p.params.charset);
    else if (p.type === "text/html" && !out.html && !disposition.startsWith("attachment")) out.html = decodeText(p.body, p.params.charset);
    else if (p.type.startsWith("image/") && p.headers["content-id"]) inline.push(p);
    for (const c of p.parts) walk(c);
  };
  walk(top);
  for (const p of inline) {
    const cid = p.headers["content-id"].replace(/[<>]/g, "").trim();
    if (!cid || !out.html) continue;
    out.html = out.html.split(`cid:${cid}`).join(`data:${p.type};base64,${p.body.toString("base64")}`);
  }
  return out;
}

// One part's bytes by its path, for an attachment.
export function partAt(raw: Buffer, path: string): Part | null {
  const find = (p: Part): Part | null => (p.path === path && !p.parts.length ? p : p.parts.map(find).find(Boolean) ?? null);
  return find(parsePart(raw));
}

// ── Writing ─────────────────────────────────────────────────────────────────

// A header value with anything outside ASCII as an RFC 2047 word.
export function headerText(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const wrap = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");

export const newMessageId = (address: string) => `<${randomUUID()}@${address.split("@")[1] || "tabellar.local"}>`;

// The whole message as MIME text. `extra` adds headers (Date, Message-ID)
// that Gmail fills in on its own and an SMTP server does not.
export function writeMessage(m: Outgoing, extra: string[] = []): string {
  // A draft may have no recipient yet.
  const headers = m.to.length ? [`To: ${m.to.join(", ")}`] : [];
  if (m.from) headers.unshift(`From: ${m.from}`);
  if (m.cc?.length) headers.push(`Cc: ${m.cc.join(", ")}`);
  // Gmail delivers to Bcc recipients and strips the header before sending;
  // SMTP sends leave it out (smtpSend).
  if (m.bcc?.length) headers.push(`Bcc: ${m.bcc.join(", ")}`);
  if (m.receipt && m.from) headers.push(`Disposition-Notification-To: ${m.from}`);
  headers.push(...extra, `Subject: ${headerText(m.subject)}`, "MIME-Version: 1.0");
  if (m.inReplyTo) {
    const ref = m.inReplyTo.includes("<") ? m.inReplyTo : `<${m.inReplyTo}>`;
    headers.push(`In-Reply-To: ${ref}`, `References: ${ref}`);
  }
  const html = ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(Buffer.from(m.html, "utf8").toString("base64"))].join("\r\n");
  if (!m.attachments?.length) return `${headers.join("\r\n")}\r\n${html}\r\n`;
  const boundary = `tabellar_${randomUUID().replace(/-/g, "")}`;
  let mime = `${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${html}\r\n`;
  for (const att of m.attachments) {
    const name = headerText(att.name.replace(/["\r\n]/g, ""));
    mime += `--${boundary}\r\nContent-Type: ${att.contentType || "application/octet-stream"}; name="${name}"\r\n`;
    mime += `Content-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(att.data.replace(/\s/g, ""))}\r\n`;
  }
  return `${mime}--${boundary}--\r\n`;
}
