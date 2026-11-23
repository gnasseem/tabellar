import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { emailFrameThemeCss, measureEmailIframeBodyHeight } from "@/lib/emailIframe";
import { useApp } from "./AppShell";

// One email's own words, as the details panel and the reader show them: its
// HTML sanitised in a sandboxed frame (remote images only on request), else
// its text. Quoted earlier messages are cut, with a way to show them.

function fixMojibake(str: string): string {
  if (!/[\x80-\xFF]/.test(str)) return str;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(escape(s));
    } catch {
      return s;
    }
  };
  if (!/[^\x00-\xFF]/.test(str)) return decode(str);
  // Mixed: fix only the runs of byte-range characters.
  return str.replace(/[\x00-\xFF]+/g, decode);
}

const FORWARD = /Forwarded message|Begin forwarded message/i;

// Removes an element and everything after it, up to the body: Outlook puts
// the quoted message after its marker rather than inside it.
function cutFrom(el: Element) {
  let node: Element | null = el;
  while (node && node.tagName !== "BODY") {
    while (node.nextSibling) node.nextSibling.remove();
    const parent: Element | null = node.parentElement;
    if (node === el) node.remove();
    node = parent;
  }
}

function stripQuotedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const keep = (el: Element) => FORWARD.test(el.textContent || "");
  doc.querySelectorAll("blockquote, .gmail_quote, .gmail_attr, .moz-cite-prefix, .yahoo_quoted, [class*='quote']").forEach((el) => {
    if (!keep(el)) el.remove();
  });
  // Outlook: a marker element, or a top-bordered block that opens "From: ... Sent:".
  const outlook =
    doc.querySelector("#divRplyFwdMsg, #appendonsend") ||
    [...doc.querySelectorAll("div[style*='border-top']")].find((el) => /^\s*From:[\s\S]{0,300}?(Sent|Date):/.test(el.textContent || ""));
  if (outlook && !keep(outlook)) cutFrom(outlook);
  doc.querySelectorAll("div, p, span").forEach((el) => {
    const t = el.textContent || "";
    if (/On .{5,120}wrote:/i.test(t) && t.trim().length < 400 && !el.querySelector("blockquote")) el.remove();
  });
  let last = doc.body.lastChild;
  while (last && (last.nodeName === "BR" || last.nodeName === "HR" || (last.nodeType === 3 && !(last.textContent || "").trim()))) {
    const prev = last.previousSibling;
    last.remove();
    last = prev;
  }
  return doc.body.innerHTML.trim();
}

function stripQuotedText(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const ahead = lines.slice(i, i + 4).join(" ");
    if (/^>/.test(line)) break;
    if (/^On /i.test(line) && /wrote:/.test(ahead)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^From:\s/.test(line) && /\s(Sent|Date):\s/.test(ahead)) break;
    out.push(lines[i]);
  }
  return out.join("\n").trimEnd();
}

function hasVisibleContent(html: string): boolean {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return !!body.querySelector("img, picture, video, table, svg") || !!(body.textContent || "").trim();
}

function looksLikeCss(s: string): boolean {
  const lines = s.trim().split("\n").filter((l) => l.trim());
  if (s.length < 80 || lines.length < 2) return false;
  const cssy = lines.filter((l) => /[{}:;]/.test(l) && /\b(color|background|border|padding|margin|@media|font-|display|!important)\b|^\s*[a-z#.][^{]*\{/i.test(l));
  return cssy.length / lines.length > 0.45;
}

type Body = { kind: "html" | "text"; short: string; full: string } | { kind: "empty" };

export type EmailContent = { body_html?: string | null; body_text?: string | null; snippet?: string | null };

// The body to show: HTML when it has anything visible, else the text, else
// the snippet. `short` has the quoted messages cut; `full` keeps them.
export function resolveBody(e: EmailContent): Body {
  const html = e.body_html?.trim() ? DOMPurify.sanitize(fixMojibake(e.body_html), { USE_PROFILES: { html: true } }) : "";
  if (html && hasVisibleContent(html)) {
    const short = stripQuotedHtml(html);
    return { kind: "html", short: hasVisibleContent(short) ? short : html, full: html };
  }
  for (const text of [e.body_text, e.snippet]) {
    const t = (text || "").replace(/\n{3,}/g, "\n\n").trim();
    if (t && !looksLikeCss(t)) return { kind: "text", short: stripQuotedText(t) || t, full: t };
  }
  return { kind: "empty" };
}

// ── Dark theme: lighten dark text the email sets, drop near-white grounds ──

function parseRgb(color: string): [number, number, number] | null {
  const s = color.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16)];
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  const named: Record<string, [number, number, number]> = { black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], grey: [128, 128, 128], navy: [0, 0, 128], maroon: [128, 0, 0], blue: [0, 0, 255], red: [255, 0, 0], green: [0, 128, 0], purple: [128, 0, 128], teal: [0, 128, 128], olive: [128, 128, 0], silver: [192, 192, 192] };
  return named[s] ?? null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// A light version of a dark colour; greys give "" so the theme's ink shows.
function lighten([r, g, b]: [number, number, number]): string {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (!d || d / (1 - Math.abs(2 * l - 1)) < 0.05) return "";
  const s = Math.min(d / (1 - Math.abs(2 * l - 1)), 0.65);
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const h = max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6 : max === gn ? ((bn - rn) / d + 2) / 6 : ((rn - gn) / d + 4) / 6;
  return `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% 82%)`;
}

function darken(doc: Document) {
  for (const el of doc.body.querySelectorAll<HTMLElement>("*")) {
    const color = el.style.color && parseRgb(el.style.color);
    if (color && luminance(color) < 0.25) el.style.color = lighten(color);
    const attr = !el.style.color && el.getAttribute("color");
    const attrRgb = attr && parseRgb(attr);
    if (attrRgb && luminance(attrRgb) < 0.25) {
      const light = lighten(attrRgb);
      if (light) el.setAttribute("color", light);
      else el.removeAttribute("color");
    }
    const bg = el.style.backgroundColor && parseRgb(el.style.backgroundColor);
    if (bg && luminance(bg) > 0.7) el.style.backgroundColor = "transparent";
    const bgAttr = el.getAttribute("bgcolor");
    const bgRgb = bgAttr && parseRgb(bgAttr);
    if (bgRgb && luminance(bgRgb) > 0.7) el.removeAttribute("bgcolor");
  }
}

const REMOTE = /url\(\s*['"]?https?:|^https?:/i;

function hasRemoteImages(html: string): boolean {
  if (/url\(\s*['"]?https?:/i.test(html)) return true;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("img, [background]")].some((el) => REMOTE.test(el.getAttribute("src") || el.getAttribute("background") || ""));
}

function frameDoc(html: string, dark: boolean, images: boolean): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const a of doc.querySelectorAll("a[href]")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  if (dark) darken(doc);
  // A blocked image would draw the browser's broken-image mark: it gives way to its alt text.
  if (!images)
    for (const img of doc.querySelectorAll("img")) {
      if (!REMOTE.test(img.getAttribute("src") || "")) continue;
      const alt = (img.getAttribute("alt") || "").trim();
      if (alt) img.replaceWith(Object.assign(doc.createElement("span"), { textContent: alt }));
      else img.remove();
    }
  // The frame runs no script; the policy only decides where images and fonts may come from.
  const csp = images ? "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline' *; font-src * data:" : "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";
  return (
    `<meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">` +
    emailFrameThemeCss() +
    "<style>html,body{margin:0;padding:0;min-height:0!important;height:auto!important;overflow-x:hidden}" +
    "body{font:14px/1.6 system-ui,-apple-system,'Helvetica Neue',sans-serif;word-break:break-word}" +
    "img,table{max-width:100%!important}img{height:auto!important}</style>" +
    doc.body.innerHTML
  );
}

// The email's HTML in a sandboxed frame whose height follows its content.
// Mail laid out wider than the frame is scaled down to fit it.
function EmailFrame({ html, images }: { html: string; images: boolean }) {
  const { theme } = useApp();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [srcDoc, setSrcDoc] = useState("");

  // The theme class changes on the root after this renders, so its colours are read a frame later.
  useEffect(() => {
    const id = requestAnimationFrame(() => setSrcDoc(frameDoc(html, theme === "dark", images)));
    return () => cancelAnimationFrame(id);
  }, [html, theme, images]);

  useLayoutEffect(() => {
    const iframe = frame.current;
    if (!iframe || !srcDoc) return;
    let width = 0;
    const fit = () => {
      const doc = iframe.contentDocument;
      if (!doc?.body) return;
      width = iframe.clientWidth;
      doc.body.style.zoom = "";
      const wide = Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth);
      if (wide > width + 2) doc.body.style.zoom = String(Math.max(0.5, width / wide));
      setHeight(measureEmailIframeBodyHeight(doc.body));
    };
    const measure = () => {
      const body = iframe.contentDocument?.body;
      if (body) setHeight(measureEmailIframeBodyHeight(body));
    };
    const timers: number[] = [];
    let inner: ResizeObserver | undefined;
    const onLoad = () => {
      fit();
      timers.push(window.setTimeout(fit, 80), window.setTimeout(fit, 400));
      const body = iframe.contentDocument?.body;
      if (!body) return;
      inner = new ResizeObserver(measure);
      inner.observe(body);
      for (const img of body.querySelectorAll("img")) img.addEventListener("load", fit);
    };
    const outer = new ResizeObserver(() => iframe.clientWidth !== width && fit());
    outer.observe(iframe);
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      outer.disconnect();
      inner?.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [srcDoc]);

  return <iframe ref={frame} srcDoc={srcDoc} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Email" className="block w-full border-0" style={{ height }} />;
}

function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    i % 2 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="break-all underline decoration-ink4 underline-offset-2 hover:text-ink2">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export default function EmailBody({ email, size = "md" }: { email: EmailContent; size?: "sm" | "md" }) {
  const body = useMemo(() => resolveBody(email), [email.body_html, email.body_text, email.snippet]);
  const [full, setFull] = useState(false);
  const [images, setImages] = useState(false);
  if (body.kind === "empty") return <p className="text-ink3">No content</p>;
  const shown = full ? body.full : body.short;
  const cut = body.short !== body.full;
  const remote = body.kind === "html" && !images && hasRemoteImages(shown);
  return (
    <div>
      {remote && (
        <button className="link mb-2" onClick={() => setImages(true)}>
          Show images
        </button>
      )}
      {body.kind === "html" ? (
        <EmailFrame html={shown} images={images} />
      ) : (
        <p className={`whitespace-pre-wrap break-words text-ink ${size === "sm" ? "text-[13px] leading-[1.6]" : "text-sm leading-[1.65]"}`}>{linkify(shown)}</p>
      )}
      {cut && (
        <button className="link mt-2" onClick={() => setFull(!full)} aria-expanded={full}>
          {full ? "Hide quoted text" : "Show quoted text"}
        </button>
      )}
    </div>
  );
}
