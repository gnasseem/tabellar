
import { useState, useRef, useEffect, useMemo, Fragment } from "react";
import Icon from "@/components/Icon";
import DOMPurify from "dompurify";
import { emailFrameThemeCss, measureEmailIframeBodyHeight } from "@/lib/emailIframe";
import { Glyph, shortWhen } from "./ui";

// Module-level attachment blob cache -- survives across email navigations.
//
// Bounded on purpose: entries hold both the decoded Blob and an object URL,
// and an object URL keeps its Blob alive until it is explicitly revoked. An
// unbounded cache meant every attachment opened or prefetched in a session
// stayed in memory for the lifetime of the tab.
type CachedAttachment = {
  blobUrl: string;
  blob: Blob;
  text: string | null;
};

const ATTACHMENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const ATTACHMENT_CACHE_MAX_ENTRIES = 24;

// Map preserves insertion order, so the first key is the least recently added.
const attachmentBlobCache = new Map<string, CachedAttachment>();
let attachmentCacheBytes = 0;

function evictAttachment(key: string): void {
  const entry = attachmentBlobCache.get(key);
  if (!entry) return;
  URL.revokeObjectURL(entry.blobUrl);
  attachmentCacheBytes -= entry.blob.size;
  attachmentBlobCache.delete(key);
}

function cacheAttachment(key: string, entry: CachedAttachment): void {
  if (attachmentBlobCache.has(key)) evictAttachment(key);
  attachmentBlobCache.set(key, entry);
  attachmentCacheBytes += entry.blob.size;
  while (
    attachmentBlobCache.size > 1 &&
    (attachmentCacheBytes > ATTACHMENT_CACHE_MAX_BYTES ||
      attachmentBlobCache.size > ATTACHMENT_CACHE_MAX_ENTRIES)
  ) {
    const oldest = attachmentBlobCache.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    evictAttachment(oldest);
  }
}

// Re-inserting on read keeps the eviction order least-recently-used rather
// than least-recently-added, so the attachment being viewed is not dropped.
function touchAttachment(key: string): CachedAttachment | undefined {
  const entry = attachmentBlobCache.get(key);
  if (!entry) return undefined;
  attachmentBlobCache.delete(key);
  attachmentBlobCache.set(key, entry);
  return entry;
}

import { createClient } from "@/lib/db";
import { setMailState } from "@/lib/outcomes";
import { assessSuspicion, type SuspicionVerdict } from "@/lib/suspicion";
import { useApp } from "./AppShell";
import DateTimePicker from "./DateTimePicker";

type EmailDetailProps = {
  email: any;
  onBack: () => void;
  onArchive: () => void;
  onReply: () => void;
  onMarkUnread?: () => void;
  onSnooze?: () => void;
  onRethink?: (updated: any) => void;
  onResolvedChange?: (emailId: string, resolvedAt: string | null) => void;
  showBack?: boolean;
};

const CATEGORIES = [
  "important",
  "action-required",
  "promotions",
  "updates",
];

const CATEGORY_NAMES: Record<string, string> = {
  important: "Important",
  "action-required": "Action required",
  promotions: "Promotions",
  updates: "Updates",
};

const SNOOZE_OPTIONS = [
  { label: "1 hour", hours: 1 },
  { label: "3 hours", hours: 3 },
  { label: "Tomorrow morning", hours: 16 },
  { label: "Next week", hours: 168 },
];

function fixMojibake(str: string): string {
  // No high bytes  -  nothing to fix
  if (!/[\x80-\xFF]/.test(str)) return str;

  // If all chars are in byte range (≤0xFF), convert the whole string at once
  if (!/[^\x00-\xFF]/.test(str)) {
    try {
      return decodeURIComponent(escape(str));
    } catch {
      return str;
    }
  }

  // Mixed: some chars are already proper Unicode (>0xFF), some are mojibake bytes.
  // Fix only the byte-range segments so we don't corrupt the already-correct chars.
  let result = "";
  let byteSegment = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0xff) {
      byteSegment += str[i];
    } else {
      if (byteSegment) {
        try {
          result += decodeURIComponent(escape(byteSegment));
        } catch {
          result += byteSegment;
        }
        byteSegment = "";
      }
      result += str[i];
    }
  }
  if (byteSegment) {
    try {
      result += decodeURIComponent(escape(byteSegment));
    } catch {
      result += byteSegment;
    }
  }
  return result;
}

// ── Strip quoted reply chains ────────────────────────────────────────────────

function stripQuotedHtml(html: string): string {
  if (typeof window === "undefined") return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Remove blockquotes (quoted previous messages)
    doc.querySelectorAll("blockquote").forEach((el) => el.remove());

    // Remove Gmail quote divs
    doc
      .querySelectorAll(".gmail_quote, .gmail_attr, [class*='quote']")
      .forEach((el) => el.remove());

    // Remove "On [date], [person] wrote:" attribution lines that precede quotes.
    // These are usually the last <div> or <p> containing that pattern.
    const attributionRe = /On .{5,80}wrote:/i;
    doc.querySelectorAll("div, p, span").forEach((el) => {
      if (
        attributionRe.test(el.textContent || "") &&
        !el.querySelector("blockquote")
      ) {
        // Only remove leaf-level or near-leaf attributions
        if ((el.textContent || "").trim().length < 400) el.remove();
      }
    });

    // Trim trailing <br>/<hr> left over
    const body = doc.body;
    let last = body.lastChild;
    while (
      last &&
      (last.nodeName === "BR" ||
        last.nodeName === "HR" ||
        (last.nodeType === 3 && !(last.textContent || "").trim()))
    ) {
      const prev = last.previousSibling;
      body.removeChild(last);
      last = prev;
    }

    return body.innerHTML.trim();
  } catch {
    return html;
  }
}

function stripQuotedText(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^>/.test(line)) break;
    // Attribution lines can span 1-3 lines (Gmail wraps long email addresses mid-line).
    // Join a window of up to 4 lines and check if "wrote:" appears anywhere in it.
    if (/^On /i.test(line.trim())) {
      const chunk = lines.slice(i, Math.min(i + 4, lines.length)).join(" ");
      if (/wrote:/.test(chunk)) break;
    }
    result.push(line);
  }
  return result.join("\n").trimEnd();
}

// ── Plain-text linkifier ─────────────────────────────────────────────────────

function linkify(text: string) {
  const URL_RE = /(https?:\/\/\S+)/g;
  const parts = text.split(URL_RE);
  return parts.map((part, i) =>
    URL_RE.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all underline decoration-ink4 underline-offset-2 hover:text-ink2"
      >
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

const PURIFY_HTML = { USE_PROFILES: { html: true } } as const;

function looksLikeCssOnlyPlainText(s: string): boolean {
  const t = s.trim();
  if (t.length < 80) return false;
  if (!/[{};]/.test(t)) return false;
  const lines = t.split("\n").filter((l) => l.trim().length);
  if (lines.length < 2) return false;
  const cssy = lines.filter(
    (l) =>
      /[{}:;]/.test(l) &&
      (/\b(color|background|border|padding|margin|table\.|@media|font-|display|!important)\b/i.test(
        l,
      ) ||
        /^\s*[a-z#.][^{]*\{/i.test(l)),
  );
  return cssy.length / lines.length > 0.45;
}

function hasVisibleContentFromHtml(safeHtml: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const doc = new DOMParser().parseFromString(safeHtml, "text/html");
    const b = doc.body;
    if (!b) return false;
    if (b.querySelector("img, picture, video, table, svg, canvas")) return true;
    return (b.textContent || "").replace(/\s+/g, " ").trim().length > 0;
  } catch {
    return true;
  }
}

function safeEmailHtml(html: string | null | undefined): string {
  if (!html || !String(html).trim()) return "";
  return stripQuotedHtml(DOMPurify.sanitize(html, PURIFY_HTML));
}

type ResolvedBody =
  | { kind: "html"; html: string }
  | { kind: "text"; text: string }
  | { kind: "snippet"; text: string }
  | { kind: "empty" };

function resolveEmailBodyDisplay(p: {
  body_html: string | null | undefined;
  body_text: string | null | undefined;
  snippet: string | null | undefined;
}): ResolvedBody {
  const safe = safeEmailHtml(p.body_html ?? null);
  if (safe && hasVisibleContentFromHtml(safe)) {
    return { kind: "html", html: safe };
  }
  const stripped = p.body_text ? stripQuotedText(p.body_text) : "";
  if (stripped && !looksLikeCssOnlyPlainText(stripped)) {
    return { kind: "text", text: stripped };
  }
  const sn = (p.snippet || "").trim();
  if (sn && !looksLikeCssOnlyPlainText(sn)) {
    return { kind: "snippet", text: sn };
  }
  if (safe) {
    return { kind: "html", html: safe };
  }
  return { kind: "empty" };
}

// ── Dark-mode email color adaptation ────────────────────────────────────────

function parseRgb(color: string): [number, number, number] | null {
  const s = color.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)))
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  if ((m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)))
    return [
      parseInt(m[1] + m[1], 16),
      parseInt(m[2] + m[2], 16),
      parseInt(m[3] + m[3], 16),
    ];
  if ((m = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i)))
    return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [255, 255, 255],
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    yellow: [255, 255, 0],
    orange: [255, 165, 0],
    purple: [128, 0, 128],
    pink: [255, 192, 203],
    gray: [128, 128, 128],
    grey: [128, 128, 128],
    silver: [192, 192, 192],
    gold: [255, 215, 0],
    cyan: [0, 255, 255],
    lime: [0, 255, 0],
    teal: [0, 128, 128],
    navy: [0, 0, 128],
    maroon: [128, 0, 0],
    olive: [128, 128, 0],
  };
  return named[s.toLowerCase()] ?? null;
}

function relLum([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function toHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return Math.round((l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// A light version of a dark colour, for the dark theme. Greys return "" so the
// email's text takes the theme's ink instead.
function lightenColor([r, g, b]: [number, number, number]): string {
  const [h, s] = toHsl([r, g, b]);
  if (s < 0.05) return "";
  return hslToHex(h, Math.min(s, 0.65), 0.82);
}

// Links open outside the window. In the dark theme, dark text the email sets
// is lightened and near-white grounds are dropped so the theme's ground shows
// through; colours the email does not set come from emailFrameThemeCss.
function prepareEmailHtml(html: string, dark: boolean): string {
  if (typeof window === "undefined") return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("a[href]").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
    if (!dark) return doc.body.innerHTML;
    const walk = (el: Element): void => {
      if (el instanceof HTMLElement) {
        if (el.style.color) {
          const rgb = parseRgb(el.style.color);
          if (rgb && relLum(rgb) < 0.25) el.style.color = lightenColor(rgb);
        }
        const cAttr = el.getAttribute("color");
        if (cAttr && !el.style.color) {
          const rgb = parseRgb(cAttr);
          if (rgb && relLum(rgb) < 0.25) {
            const light = lightenColor(rgb);
            if (light) el.setAttribute("color", light);
            else el.removeAttribute("color");
          }
        }
        if (el.style.backgroundColor) {
          const rgb = parseRgb(el.style.backgroundColor);
          if (rgb && relLum(rgb) > 0.7) el.style.backgroundColor = "transparent";
        }
        const bgAttr = el.getAttribute("bgcolor");
        if (bgAttr) {
          const rgb = parseRgb(bgAttr);
          if (rgb && relLum(rgb) > 0.7) el.removeAttribute("bgcolor");
        }
      }
      for (const child of el.children) walk(child);
    };
    if (doc.body) walk(doc.body);
    return doc.body.innerHTML;
  } catch {
    return html;
  }
}

const FRAME_BASE_CSS =
  "<style>html,body{margin:0;padding:0;min-height:0!important;height:auto!important;overflow-x:hidden}" +
  "body{font:14px/1.6 system-ui,-apple-system,'Helvetica Neue',sans-serif;word-break:break-word}" +
  "img,table{max-width:100%!important;height:auto!important}</style>";

// The email itself, in a sandboxed frame of its own so its markup and styles
// cannot touch the window. Its height follows its content.
function EmailFrame({ html }: { html: string }) {
  const { theme } = useApp() as any;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const build = () =>
    `<base target="_blank">` + emailFrameThemeCss() + FRAME_BASE_CSS + prepareEmailHtml(fixMojibake(html), theme === "dark");
  const [srcDoc, setSrcDoc] = useState(build);

  // The theme class changes on the root after this renders, so the theme's
  // colours are read a frame later.
  useEffect(() => {
    const id = requestAnimationFrame(() => setSrcDoc(build()));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, theme]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let detach: (() => void) | undefined;
    const bind = () => {
      const doc = iframe.contentDocument;
      const body = doc?.body;
      if (!doc || !body) return;
      const measure = () => {
        const b = iframe.contentDocument?.body;
        if (b) setHeight(measureEmailIframeBodyHeight(b));
      };
      measure();
      requestAnimationFrame(measure);
      const t1 = window.setTimeout(measure, 60);
      const t2 = window.setTimeout(measure, 280);
      const ro = new ResizeObserver(() => requestAnimationFrame(measure));
      ro.observe(body);
      const imgs = [...body.querySelectorAll("img")];
      imgs.forEach((img) => img.addEventListener("load", measure));
      detach = () => {
        window.clearTimeout(t1);
        window.clearTimeout(t2);
        ro.disconnect();
        imgs.forEach((img) => img.removeEventListener("load", measure));
      };
    };
    const onLoad = () => {
      detach?.();
      bind();
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      detach?.();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      title="Email content"
      className="block w-full border-0"
      style={{ height }}
    />
  );
}

// One message's body: the email's own HTML in a frame, else its text.
function MessageBody({ body }: { body: ResolvedBody }) {
  if (body.kind === "html") return <EmailFrame html={body.html} />;
  if (body.kind === "text")
    return <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-[1.6] text-ink">{linkify(body.text)}</pre>;
  if (body.kind === "snippet") return <p className="text-sm leading-[1.6] text-ink2">{body.text}</p>;
  return <p className="text-ink3">This email has no content.</p>;
}

// A caution about the sender or its links, on one line. Details open below it.
function SuspicionBanner({ verdict }: { verdict: SuspicionVerdict }) {
  const [open, setOpen] = useState(false);
  if (verdict.level === "none") return null;
  const danger = verdict.level === "danger";
  return (
    <div className={`mt-4 rounded-[9px] px-3 py-2 ${danger ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"}`} role="alert">
      <div className="flex items-center gap-2">
        <Glyph state={danger ? "failed" : "held"} />
        <span className="min-w-0 flex-1 font-medium">
          {danger ? "This looks like phishing." : "Something about this email looks off."} Do not enter passwords or payment details from its links.
        </span>
        <button className="link flex-none" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide why" : "Why"}
        </button>
      </div>
      {open && (
        <ul className="mt-1.5 space-y-1 pb-0.5 pl-6 text-xs leading-normal text-ink2">
          {verdict.signals.map((s) => (
            <li key={s.id}>
              <span className="font-medium text-ink">{s.label}.</span> {s.detail}
            </li>
          ))}
          <li>If it claims to be from a service you use, open that service directly instead.</li>
        </ul>
      )}
    </div>
  );
}

type Att = { filename: string; mime_type: string; size: number; attachment_id: string };

const fileSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);
const fileIcon = (mime: string | undefined) => (mime?.startsWith("image/") ? "image" : mime?.includes("pdf") ? "picture_as_pdf" : "description");

// Attachments as quiet rows: the name opens a preview, Download saves it.
function AttachmentList({ atts, onPreview, onDownload }: { atts: Att[]; onPreview: (a: Att) => void; onDownload: (a: Att) => void }) {
  if (!atts.length) return null;
  return (
    <div className="mt-5 border-t border-line-soft pt-3">
      <p className="label mb-1">{atts.length === 1 ? "1 attachment" : `${atts.length} attachments`}</p>
      {atts.map((att) => (
        <div key={att.attachment_id} className="-mx-2 flex h-8 items-center gap-2 rounded-md px-2 hover:bg-hover">
          <Icon name={fileIcon(att.mime_type)} size={14} className="flex-none text-ink3" />
          <button className="min-w-0 truncate text-left text-ink hover:underline" onClick={() => onPreview(att)} title="Preview">
            {att.filename}
          </button>
          {att.size > 0 && <span className="flex-none text-xs text-ink3">{fileSize(att.size)}</span>}
          <span className="flex-1" />
          <button className="btn btn-plain btn-sm" onClick={() => onDownload(att)} aria-label={`Download ${att.filename}`}>
            Download
          </button>
        </div>
      ))}
    </div>
  );
}

const nameOf = (sender: string | null | undefined, address: string | null | undefined) =>
  (sender ?? "").replace(/<.*>/, "").replace(/"/g, "").trim() || address || "Unknown sender";

const fullWhen = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default function EmailDetail({
  email,
  onBack,
  onArchive,
  onReply,
  onMarkUnread,
  onSnooze,
  onRethink,
  onResolvedChange,
  showBack = false,
}: EmailDetailProps) {
  const { user, openCompose, addToast, setView, setPendingMeetingSchedule, mail, setViewCache } =
    useApp() as any;
  const supabase = createClient();

  const senderEmailAddr = email.sender_email || "";

  const [proc, setProc] = useState<any>(
    Array.isArray(email.email_processed)
      ? email.email_processed[0]
      : email.email_processed,
  );
  const [categoryOverride, setCategoryOverride] = useState("");
  // The open popover in the bar, if any.
  const [menu, setMenu] = useState<"" | "sort" | "snooze" | "more" | "track">("");
  const barRef = useRef<HTMLElement>(null);
  const [userTags, setUserTags] = useState<
    { slug: string; display_name: string; color: string }[]
  >([]);
  const [emailTags, setEmailTags] = useState<string[]>(
    Array.isArray(proc?.extra_labels) ? proc.extra_labels : [],
  );
  const [bodyHtml, setBodyHtml] = useState<string | null | undefined>(
    email.body_html,
  );
  const suspicion = useMemo(() => assessSuspicion(email), [email]);
  const [resolvedAt, setResolvedAt] = useState<string | null>(
    email.resolved_at ?? null,
  );
  const [resolvingEmail, setResolvingEmail] = useState(false);
  useEffect(() => {
    setResolvedAt(email.resolved_at ?? null);
  }, [email.id, email.resolved_at]);
  // Follow-up tracking
  const [isTracked, setIsTracked] = useState(false);
  const [trackRemindAt, setTrackRemindAt] = useState<string>(() => {
    const d = new Date(Date.now() + 3 * 86_400_000);
    d.setHours(9, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
  });
  const [trackingSaving, setTrackingSaving] = useState(false);

  useEffect(() => {
    if (!email.thread_id) return;
    supabase
      .from("follow_up_reminders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("thread_id", email.thread_id)
      .then(({ count }) => setIsTracked((count ?? 0) > 0));
  }, [email.thread_id, user.id]);

  // Lazy-load body_html if it wasn't included in the inbox list query
  useEffect(() => {
    setBodyHtml(email.body_html);
    if (email.body_html !== undefined) return;
    supabase
      .from("emails")
      .select("body_html")
      .eq("id", email.id)
      .single()
      .then(({ data }) => {
        if (data) setBodyHtml(data.body_html);
      });
  }, [email.id, email.body_html]);

  // Preload attachments into the module-level cache so preview opens instantly.
  // Fires after mount; errors are silently swallowed  -  this is best-effort only.
  //
  // Speculative work, so it stays deliberately small: a few of the smaller
  // files, fetched one at a time, and abandoned when the user navigates away.
  // Previously this fired every attachment up to 10 MB in parallel, so a mail
  // with a dozen big files pulled hundreds of MB nobody had asked to see.
  useEffect(() => {
    const atts = Array.isArray(email.attachments) ? email.attachments : [];
    if (atts.length === 0) return;
    let cancelled = false;
    const PREFETCH_MAX_FILE_BYTES = 5 * 1024 * 1024;
    const PREFETCH_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
    const PREFETCH_MAX_FILES = 5;

    const run = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session || cancelled) return;
      let budget = PREFETCH_MAX_TOTAL_BYTES;
      let fetched = 0;
      for (const att of atts as {
        filename: string;
        mime_type: string;
        size: number;
        attachment_id: string;
      }[]) {
        if (cancelled || fetched >= PREFETCH_MAX_FILES) return;
        const cacheKey = `${email.gmail_id}::${att.attachment_id}`;
        if (attachmentBlobCache.has(cacheKey)) continue;
        if (att.size > PREFETCH_MAX_FILE_BYTES || att.size > budget) continue;
        try {
          // Sequential: a parallel burst competes with the request that
          // actually matters when the user opens a preview.
          await fetchAttachmentBlob(att);
        } catch {
          /* best effort */
        }
        budget -= att.size;
        fetched++;
      }
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email.id]);

  const trackFollowUp = async () => {
    if (trackingSaving) return;
    setTrackingSaving(true);
    const remindAt = new Date(trackRemindAt).toISOString();
    const recipients = (email.recipients || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    const firstRecipient = recipients[0] || email.recipients || "";
    const nameMatch = firstRecipient.match(/^(.*?)\s*<[^>]+>/);
    const emailMatch = firstRecipient.match(/<([^>]+)>/);
    const recipientEmail = emailMatch
      ? emailMatch[1]
      : firstRecipient.replace(/<.*>/, "").trim();
    const recipientName = nameMatch ? nameMatch[1].trim() : null;
    const { error } = await supabase.from("follow_up_reminders").upsert(
      {
        user_id: user.id,
        email_id: email.id,
        thread_id: email.thread_id || email.id,
        recipient_email: recipientEmail || email.recipients || "unknown",
        recipient_name: recipientName,
        subject: email.subject || "(no subject)",
        remind_at: remindAt,
        status: "waiting",
      },
      { onConflict: "user_id,thread_id" },
    );
    setTrackingSaving(false);
    setMenu("");
    if (!error) {
      setIsTracked(true);
      addToast("success", "Follow-up reminder set");
    } else addToast("error", "Could not set the reminder. Try again.");
  };

  const [rethinking, setRethinking] = useState(false);
  const [extractingTodos, setExtractingTodos] = useState(false);
  const [addedTodos, setAddedTodos] = useState<Set<string>>(new Set());
  const [activeInputAction, setActiveInputAction] = useState<{
    qa: any;
    answers: Record<string, string>;
  } | null>(null);
  type ThreadAtt = {
    filename: string;
    mime_type: string;
    size: number;
    attachment_id: string;
  };
  type ThreadEmail = {
    id: string;
    subject: string;
    sender: string;
    sender_email: string;
    received_at: string;
    body_html: string | null;
    body_text: string | null;
    snippet: string;
    is_read: boolean;
    gmail_id: string;
    has_attachments: boolean;
    attachments: ThreadAtt[];
  };
  const [threadEmails, setThreadEmails] = useState<ThreadEmail[]>([]);
  const [threadLoading, setThreadLoading] = useState(!!email.thread_id);
  type AttachmentPreviewState = {
    att: {
      filename: string;
      mime_type: string;
      size: number;
      attachment_id: string;
    };
    gmailId?: string; // the message the attachment belongs to, in a thread
    blobUrl: string | null;
    text: string | null;
    error: string | null;
  };
  const [previewAtt, setPreviewAtt] = useState<AttachmentPreviewState | null>(
    null,
  );
  // Thread messages shown in full; the rest are one line each.
  const [openMessages, setOpenMessages] = useState<Set<string>>(new Set());

  // Fetch all thread emails for chat view
  useEffect(() => {
    setThreadLoading(!!email.thread_id);
    setThreadEmails([]);
    if (!email.thread_id) return;
    supabase
      .from("emails")
      .select(
        "id, subject, sender, sender_email, received_at, body_html, body_text, snippet, is_read, gmail_id, has_attachments, attachments",
      )
      .eq("user_id", user.id)
      .eq("thread_id", email.thread_id)
      .order("received_at", { ascending: true })
      .limit(20)
      .then(({ data }) => {
        setThreadLoading(false);
        if (data && data.length > 1) {
          setThreadEmails(data as ThreadEmail[]);
          setOpenMessages(new Set([email.id, (data as ThreadEmail[])[data.length - 1].id]));
          // Preload thread attachments in the background.
          for (const msg of data as ThreadEmail[]) {
            const msgAtts = Array.isArray(msg.attachments) ? msg.attachments : [];
            for (const att of msgAtts) {
              if (att.size > 10 * 1024 * 1024) continue;
              fetchAttachmentBlob(att, msg.gmail_id).catch(() => {});
            }
          }
        }
      });
  }, [email.thread_id, email.id, user.id]);

  // Load user tags
  useEffect(() => {
    supabase
      .from("categories")
      .select("slug, display_name, color")
      .eq("user_id", user.id)
      .then(({ data }) => {
        if (data)
          setUserTags(
            data as { slug: string; display_name: string; color: string }[],
          );
      });
  }, [user.id]);

  // Close the bar's popover on a click outside the bar
  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setMenu("");
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menu]);

  // Module-level cache doesn't need per-instance cleanup (blobs reused across emails)

  const apiUrl = "/api";

  const getAuthHeaders = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token}`,
    };
  };

  const fetchAttachmentBlob = async (
    att: {
      filename: string;
      mime_type: string;
      size: number;
      attachment_id: string;
    },
    gmailIdOverride?: string,
  ) => {
    const gid = gmailIdOverride || email.gmail_id;
    const cacheKey = `${gid}::${att.attachment_id}`;
    const cached = touchAttachment(cacheKey);
    if (cached) return cached;
    const headers = await getAuthHeaders();
    const res = await fetch(
      `${apiUrl}/attachment?gmail_id=${encodeURIComponent(gid)}&attachment_id=${encodeURIComponent(att.attachment_id)}`,
      { headers: { Authorization: headers.Authorization } },
    );
    if (!res.ok) throw new Error("Failed to fetch attachment");
    const { data } = await res.json();
    const base64 = (data as string).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
    const blob = new Blob([bytes], {
      type: att.mime_type || "application/octet-stream",
    });
    const blobUrl = URL.createObjectURL(blob);
    let text: string | null = null;
    if (
      att.mime_type?.startsWith("text/") ||
      att.mime_type === "application/json"
    ) {
      text = await blob.text();
    }
    const result = { blobUrl, blob, text };
    cacheAttachment(cacheKey, result);
    return result;
  };

  const downloadAttachment = async (
    att: {
      filename: string;
      mime_type: string;
      size: number;
      attachment_id: string;
    },
    gmailIdOverride?: string,
  ) => {
    try {
      const { blobUrl } = await fetchAttachmentBlob(att, gmailIdOverride);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = att.filename;
      a.click();
    } catch {
      addToast("error", "Download failed");
    }
  };

  const currentCategory = categoryOverride || proc?.category;

  const overrideCategory = async (newCategory: string) => {
    setCategoryOverride(newCategory);
    setMenu("");

    // Update local state and notify parent immediately
    const updatedProc = { ...proc, category: newCategory };
    setProc(updatedProc);
    onRethink?.(updatedProc);

    await supabase
      .from("email_processed")
      .update({ category: newCategory })
      .eq("email_id", email.id);

    addToast("success", `Moved to ${CATEGORY_NAMES[newCategory] || newCategory}`);
  };

  const toggleTag = async (slug: string) => {
    const updated = emailTags.includes(slug)
      ? emailTags.filter((t) => t !== slug)
      : [...emailTags, slug];
    setEmailTags(updated);
    await supabase
      .from("email_processed")
      .update({ extra_labels: updated })
      .eq("email_id", email.id);
    // Notify parent (InboxView) so the sidebar card updates immediately
    onRethink?.({ ...proc, extra_labels: updated });
  };

  const handleMarkUnread = async () => {
    try {
      await setMailState([email.id], { read: false });
    } catch {
      return addToast("error", "Could not mark it unread in Gmail.");
    }
    addToast("info", "Marked as unread");
    onMarkUnread?.();
  };

  // Resolving marks an email as dealt with while leaving it in the inbox.
  // The Solve agent already sets resolved_at when it clears something; this
  // is the manual equivalent, for the times you handled a mail yourself.
  const toggleResolved = async () => {
    if (resolvingEmail) return;
    setResolvingEmail(true);
    const previous = resolvedAt;
    const next = previous ? null : new Date().toISOString();
    setResolvedAt(next);
    const { error } = await supabase
      .from("emails")
      .update({ resolved_at: next })
      .eq("id", email.id);
    setResolvingEmail(false);
    if (error) {
      setResolvedAt(previous);
      addToast("error", "Could not update this email");
      return;
    }
    onResolvedChange?.(email.id, next);
    if (next) {
      addToast("success", "Marked resolved", {
        action: {
          label: "Undo",
          onClick: async () => {
            setResolvedAt(null);
            await supabase
              .from("emails")
              .update({ resolved_at: null })
              .eq("id", email.id);
            onResolvedChange?.(email.id, null);
          },
        },
      });
    } else {
      addToast("info", "Marked unresolved");
    }
  };

  const handleSnooze = async (hours: number, label: string) => {
    const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    // Persist to DB for cross-device sync
    await supabase
      .from("emails")
      .update({ is_snoozed: true, snooze_until: until })
      .eq("id", email.id);
    // Keep localStorage as fast local cache
    localStorage.setItem(`snooze:${email.id}`, until);
    setMenu("");
    addToast("success", `Snoozed until ${label}`);
    onSnooze?.();
  };

  const handleRethink = async () => {
    if (rethinking) return;
    setRethinking(true);
    // ── Cloud rethink ─────────────────────────────────────────────────────────
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/rethink-email`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email_id: email.id }),
      });
      if (res.ok) {
        const updated = await res.json();
        setProc(updated);
        onRethink?.(updated);
        addToast("success", "Tabellar read it again");
      } else {
        addToast("error", "Tabellar could not read it again. Try once more.");
      }
    } catch {
      addToast("error", "Tabellar's server did not answer. Try again.");
    }
    setRethinking(false);
  };

  const handleExtractTodos = async () => {
    setExtractingTodos(true);
    // ── Cloud extraction ──────────────────────────────────────────────────────
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/extract-todos`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email_id: email.id }),
      });
      if (res.ok) {
        const data = await res.json();
        const count = data.count ?? 0;
        addToast(
          "success",
          count > 0
            ? `Added ${count} task${count > 1 ? "s" : ""} to Todos`
            : "No todos in this email",
        );
      } else {
        addToast("error", "Could not look for todos. Try again.");
      }
    } catch {
      addToast("error", "Tabellar's server did not answer. Try again.");
    }
    setExtractingTodos(false);
  };

  const addTodoFromChip = async (task: string) => {
    await supabase
      .from("todos")
      .insert({ user_id: user.id, text: task, source: "email" });
    setAddedTodos((prev) => new Set([...prev, task]));
    addToast("success", "Added to Todos");
  };

  const submitInputAction = (replyAll = false) => {
    if (!activeInputAction) return;
    const { qa, answers } = activeInputAction;
    let text = qa.text || qa.label;
    for (const [k, v] of Object.entries(answers)) {
      text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), (v as string) || `[${k}]`);
    }
    openCompose({ ...email, _prefillBody: text, _autoGenerate: true, ...(replyAll ? { _replyAll: true } : {}) });
    setActiveInputAction(null);
  };

  const senderEmailLc = (email.sender_email || "").toLowerCase();
  const isNoreply =
    /no.?reply|do.not.reply|noreply|mailer-daemon|postmaster/.test(
      senderEmailLc,
    );
  const replyActions = isNoreply
    ? []
    : (proc?.quick_actions || []).filter((qa: any) => qa.action === "reply");
  const meetingActions = (proc?.quick_actions || []).filter(
    (qa: any) => qa.action === "schedule_meeting",
  );
  const todoActions = (proc?.quick_actions || []).filter(
    (qa: any) => qa.action === "add_todo",
  );
  const hasReplyAll =
    !!(email.cc_recipients) ||
    (email.recipients || "").split(",").filter(Boolean).length > 1;
  // Only show the panel when there are actual actions to render.
  // An empty list from Tabellar is a decision too: then there is no panel.
  const hasActions =
    replyActions.length > 0 ||
    meetingActions.length > 0 ||
    todoActions.length > 0;
  const showSuggestionsPanel =
    hasActions &&
    (!isNoreply || meetingActions.length > 0 || todoActions.length > 0);

  const singleMessageBody = resolveEmailBodyDisplay({
    body_html: bodyHtml,
    body_text: email.body_text,
    snippet: email.snippet,
  });
  const isMultiMessageThread = threadEmails.length > 1;
  const needsReply = !isNoreply && (replyActions.length > 0 || currentCategory === "action-required");
  const singleAtts: Att[] = Array.isArray(email.attachments) ? email.attachments : [];
  const categoryText = CATEGORY_NAMES[currentCategory] || currentCategory || "Not sorted yet";
  const labelNames = emailTags
    .map((slug) => userTags.find((t) => t.slug === slug)?.display_name)
    .filter(Boolean) as string[];

  const reply = () => {
    openCompose(email);
    onReply();
  };

  const openPreview = async (att: Att, gmailId?: string) => {
    setPreviewAtt({ att, gmailId, blobUrl: null, text: null, error: null });
    try {
      const result = await fetchAttachmentBlob(att, gmailId);
      setPreviewAtt({ att, gmailId, blobUrl: result.blobUrl, text: result.text, error: null });
    } catch {
      setPreviewAtt((prev) => (prev ? { ...prev, error: "Tabellar could not load this attachment from Gmail." } : null));
    }
  };

  // Keys while reading: Esc goes back (or closes what is open), R replies,
  // E archives, U marks unread. Caught before the list's own handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector("[data-compose-modal]")) return;
      if (e.key === "Escape") {
        if (previewAtt) setPreviewAtt(null);
        else if (menu) setMenu("");
        else if (document.querySelector('[aria-modal="true"]')) return;
        else onBack();
        e.stopPropagation();
        return;
      }
      if (previewAtt || document.querySelector('[aria-modal="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === "r") reply();
      else if (k === "e") onArchive();
      else if (k === "u") handleMarkUnread();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const toggleMenu = (m: typeof menu) => setMenu(menu === m ? "" : m);
  const divider = <div className="mx-2 my-1 border-t border-line-soft" />;

  // What the user has set on this email: dealt with, a follow-up reminder.
  const status = (resolvedAt || isTracked) && (
    <div className="mt-3 space-y-1 text-xs text-ink3">
      {resolvedAt && (
        <p className="flex items-center gap-1.5">
          <Glyph state="done" />
          You marked this as dealt with.
          <button className="link" onClick={toggleResolved} disabled={resolvingEmail}>
            Undo
          </button>
        </p>
      )}
      {isTracked && (
        <p className="flex items-center gap-1.5">
          <Glyph state="info" />
          Follow-up if nobody replies
          <button className="link" onClick={() => setView("followups")}>
            Open in Follow-ups
          </button>
        </p>
      )}
    </div>
  );

  const missingAnswer =
    !!activeInputAction &&
    (activeInputAction.qa.questions || []).some((q: any) => !(activeInputAction.answers[q.key] || "").trim());

  // What Tabellar did with this email, each with its reason and its undo.
  const outcomes = (mail?.byEmail.get(email.id) || []).filter((o: any) => o.state !== "info" || o.title);
  const doneBlock = outcomes.length > 0 && (
    <div className="mt-4">
      {outcomes.map((o: any) => (
        <div key={o.key} className="grid grid-cols-[22px_1fr_auto] items-start gap-x-1 border-b border-line-soft py-2 last:border-0">
          <Glyph state={o.state} className="mt-px" />
          <div className="min-w-0">
            <b className={`block leading-snug ${o.state === "info" ? "font-normal text-ink2" : "font-medium"}`}>{o.title}</b>
            {o.why && <p className="mt-0.5 text-[12.5px] leading-snug text-ink2">{o.why}</p>}
          </div>
          <div className="pt-px">
            {o.act?.kind === "undo" && (
              <button className="link" onClick={() => mail.undo(o.act.id).then(() => addToast("info", "Undone")).catch(() => {})}>
                Undo
              </button>
            )}
            {o.act?.kind === "cancel" && (
              <button className="link" onClick={() => mail.undo(o.act.id).then(() => addToast("success", "Reply cancelled. It is kept as a draft.")).catch(() => {})}>
                Cancel
              </button>
            )}
            {o.act?.kind === "approve" && (
              <button className="link !text-wax-ink" onClick={() => mail.approve(o.act.id, o.act.hash).then(() => addToast("success", "Approved")).catch(() => {})}>
                Approve
              </button>
            )}
            {o.act?.kind === "review" && (
              <button className="link !text-wax-ink" onClick={() => (setViewCache("replies:focus", o.act.draftId), setView("replies"))}>
                Review reply
              </button>
            )}
            {o.act?.kind === "view" && (
              <button className="link" onClick={() => setView(o.act.view)}>
                Show
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  // What Tabellar made of the email, and the next steps it suggests.
  const summaryBlock = (proc?.summary || showSuggestionsPanel || rethinking) && (
    <div className="inset mt-4">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <p className="label">Summary</p>
        {rethinking && (
          <span className="text-xs text-ink3" role="status">
            Reading it again
          </span>
        )}
      </div>
      {proc?.summary && <p className="leading-normal text-ink2">{proc.summary}</p>}
      {showSuggestionsPanel && (
        <div className={`flex flex-wrap gap-1.5 ${proc?.summary ? "mt-2.5" : "mt-1"} ${activeInputAction ? "opacity-50" : ""}`}>
          {replyActions.map((qa: any, i: number) => {
            const label = (qa.label || "").replace(/^Reply:\s*/i, "");
            const prefill = qa.text || label;
            const hasQuestions = qa.questions?.length > 0;
            const run = (replyAll: boolean) => {
              if (hasQuestions) setActiveInputAction({ qa, answers: {} });
              else openCompose({ ...email, _prefillBody: prefill, _autoGenerate: true, ...(replyAll ? { _replyAll: true } : {}) });
            };
            return (
              <span key={`reply-${i}`} className="inline-flex gap-0.5">
                <button className="btn btn-sm" onClick={() => run(false)} title={hasQuestions ? `${label}. Tabellar asks a few details first.` : label}>
                  <Icon name="reply" size={13} className="text-ink3" />
                  {label}
                </button>
                {hasReplyAll && (
                  <button className="btn btn-sm px-1.5" onClick={() => run(true)} title={`${label}, to everyone`} aria-label={`${label}, to everyone`}>
                    <Icon name="reply_all" size={13} className="text-ink3" />
                  </button>
                )}
              </span>
            );
          })}
          {meetingActions.map((qa: any, i: number) => {
            const label = (qa.label || "").replace(/^Schedule:\s*/i, "").replace(/^Add to Calendar:\s*/i, "");
            const details = qa.meetingDetails;
            return (
              <button
                key={`meeting-${i}`}
                className="btn btn-sm"
                title={`Set up in Meetings: ${label}`}
                onClick={() => {
                  setPendingMeetingSchedule({
                    title: details?.title || qa.text?.trim() || label,
                    dateTime: details?.dateTime || undefined,
                    duration: details?.duration || undefined,
                    location: details?.location || undefined,
                    attendees: details?.attendees || (email.sender_email ? [email.sender_email] : []),
                    description: details?.description || email.subject,
                  });
                  setView("meetings");
                }}
              >
                <Icon name="event" size={13} className="text-ink3" />
                {label}
              </button>
            );
          })}
          {todoActions.map((qa: any, i: number) => {
            const task = (qa.label || "").replace(/^Todo:\s*/i, "");
            const added = addedTodos.has(task);
            return (
              <button key={`todo-${i}`} className="btn btn-sm" onClick={() => !added && addTodoFromChip(task)} disabled={added} title={added ? "Added to Todos" : `Add to Todos: ${task}`}>
                <Icon name={added ? "check" : "add_task"} size={13} className="text-ink3" />
                {added ? `Added: ${task}` : task}
              </button>
            );
          })}
        </div>
      )}

      {/* A suggested reply that needs a few details before Tabellar writes it */}
      {activeInputAction && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-2 font-medium text-ink">{(activeInputAction.qa.label || "").replace(/^Reply:\s*/i, "")}</p>
          {(activeInputAction.qa.questions || []).map((q: any, qi: number) => {
            const isLast = qi === (activeInputAction.qa.questions || []).length - 1;
            return (
              <label key={q.key} className="mb-2 block">
                <span className="mb-1 block text-xs text-ink3">{q.label}</span>
                <input
                  type="text"
                  autoFocus={qi === 0}
                  placeholder={q.placeholder || ""}
                  value={activeInputAction.answers[q.key] || ""}
                  onChange={(e) =>
                    setActiveInputAction((prev) => (prev ? { ...prev, answers: { ...prev.answers, [q.key]: e.target.value } } : null))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isLast && !missingAnswer) submitInputAction();
                    if (e.key === "Escape") setActiveInputAction(null);
                  }}
                  className="input"
                />
              </label>
            );
          })}
          <div className="mt-3 flex items-center gap-1.5">
            <button className="btn btn-sm btn-pri" onClick={() => submitInputAction(false)} disabled={missingAnswer}>
              Write reply
            </button>
            {hasReplyAll && (
              <button className="btn btn-sm" onClick={() => submitInputAction(true)} disabled={missingAnswer}>
                Write reply to all
              </button>
            )}
            <button className="btn btn-sm btn-plain" onClick={() => setActiveInputAction(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-canvas">
      <header ref={barRef} className="bar gap-1 pl-3">
        <button className="iconbtn" onClick={onBack} title="Back (Esc)" aria-label="Back">
          <Icon name="arrow_back" size={16} />
        </button>
        <h1 className="bar-title ml-1 min-w-0 flex-1 truncate" title={email.subject || undefined}>
          {email.subject || "(no subject)"}
        </h1>

        {/* Category and labels, as plain text, changed from a menu */}
        <div className="relative hidden flex-none items-center gap-2 pr-2 text-xs text-ink3 md:flex">
          <span className="max-w-[240px] truncate">{[categoryText, ...labelNames].join(", ")}</span>
          <button className="link" aria-haspopup="menu" aria-expanded={menu === "sort"} onClick={() => toggleMenu("sort")}>
            Change
          </button>
          {menu === "sort" && (
            <div className="pop absolute right-0 top-8 w-56" role="menu">
              <p className="label px-2 py-1">Category</p>
              {CATEGORIES.map((cat) => (
                <button key={cat} role="menuitemradio" aria-checked={currentCategory === cat} className="pop-item" onClick={() => overrideCategory(cat)}>
                  <Icon name="check" size={13} className={currentCategory === cat ? "text-ink" : "invisible"} />
                  {CATEGORY_NAMES[cat]}
                </button>
              ))}
              {divider}
              <p className="label px-2 py-1">Labels</p>
              {userTags.length === 0 ? (
                <p className="px-2 pb-1.5 text-xs leading-normal text-ink3">No labels yet. Make one in Labels to file mail under it.</p>
              ) : (
                userTags.map((tag) => {
                  const on = emailTags.includes(tag.slug);
                  return (
                    <button key={tag.slug} role="menuitemcheckbox" aria-checked={on} className="pop-item" onClick={() => toggleTag(tag.slug)}>
                      <Icon name="check" size={13} className={on ? "text-ink" : "invisible"} />
                      <span className="truncate">{tag.display_name}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        {!needsReply && (
          <button className="iconbtn" onClick={reply} title="Reply (R)" aria-label="Reply">
            <Icon name="reply" size={16} />
          </button>
        )}
        <button className="iconbtn" onClick={onArchive} title="Archive (E)" aria-label="Archive">
          <Icon name="archive" size={16} />
        </button>
        <button className="iconbtn" onClick={handleMarkUnread} title="Mark unread (U)" aria-label="Mark unread">
          <Icon name="mark_email_unread" size={16} />
        </button>
        <div className="relative">
          <button className="iconbtn" onClick={() => toggleMenu("snooze")} title="Snooze" aria-label="Snooze" aria-haspopup="menu" aria-expanded={menu === "snooze"}>
            <Icon name="snooze" size={16} />
          </button>
          {menu === "snooze" && (
            <div className="pop absolute right-0 top-8 min-w-[180px]" role="menu">
              <p className="label px-2 py-1">Snooze until</p>
              {SNOOZE_OPTIONS.map((opt) => (
                <button
                  key={opt.hours}
                  role="menuitem"
                  className="pop-item"
                  onClick={() =>
                    handleSnooze(
                      opt.hours,
                      new Date(Date.now() + opt.hours * 3_600_000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }),
                    )
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="relative">
          <button
            className="iconbtn"
            onClick={() => toggleMenu(menu === "track" ? "track" : "more")}
            title="More"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menu === "more" || menu === "track"}
          >
            <Icon name="more" size={16} />
          </button>
          {menu === "more" && (
            <div className="pop absolute right-0 top-8 w-60" role="menu">
              {hasReplyAll && (
                <button role="menuitem" className="pop-item" onClick={() => (setMenu(""), openCompose({ ...email, _replyAll: true }))}>
                  Reply all
                </button>
              )}
              <button role="menuitem" className="pop-item" onClick={() => (setMenu(""), openCompose({ ...email, sender_email: "", subject: `Fwd: ${email.subject}` }))}>
                Forward
              </button>
              {email.thread_id &&
                (isTracked ? (
                  <button role="menuitem" className="pop-item" onClick={() => (setMenu(""), setView("followups"))}>
                    Open in Follow-ups
                  </button>
                ) : (
                  <button role="menuitem" className="pop-item" onClick={() => setMenu("track")}>
                    Remind me if nobody replies
                  </button>
                ))}
              <button role="menuitem" className="pop-item" disabled={resolvingEmail} onClick={() => (setMenu(""), toggleResolved())}>
                {resolvedAt ? "Mark as not dealt with" : "Mark as dealt with, keep in Inbox"}
              </button>
              {divider}
              <button role="menuitem" className="pop-item disabled:opacity-45" disabled={extractingTodos} onClick={() => (setMenu(""), handleExtractTodos())}>
                {extractingTodos ? "Looking for todos" : "Look for todos"}
              </button>
              <button role="menuitem" className="pop-item disabled:opacity-45" disabled={rethinking} onClick={() => (setMenu(""), handleRethink())}>
                Read it again
              </button>
            </div>
          )}
          {menu === "track" && (
            <div className="pop absolute right-0 top-8 w-72 p-3" role="dialog" aria-label="Follow-up reminder">
              <p className="label mb-2">Remind me if nobody replies by</p>
              <DateTimePicker value={trackRemindAt} onChange={setTrackRemindAt} placeholder="Pick date and time" />
              <div className="mt-3 flex items-center gap-1.5">
                <button className="btn btn-sm btn-pri" onClick={trackFollowUp} disabled={trackingSaving}>
                  {trackingSaving ? "Setting reminder" : "Set reminder"}
                </button>
                <button className="btn btn-sm btn-plain" onClick={() => setMenu("")}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        {needsReply && (
          <button className="btn btn-pri ml-1.5" onClick={reply}>
            Reply
          </button>
        )}
      </header>

      <div className="email-reader-pane min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-5 pb-12 pt-5 md:px-8">
          {threadLoading ? (
            <div aria-busy="true" aria-label="Loading">
              <div className="skel h-3.5 w-44" />
              <div className="skel mt-2 h-2.5 w-64" />
              <div className="skel mt-6 h-16 w-full rounded-[9px]" />
              <div className="skel mt-6 h-2.5 w-full" />
              <div className="skel mt-2.5 h-2.5 w-11/12" />
              <div className="skel mt-2.5 h-2.5 w-3/5" />
            </div>
          ) : isMultiMessageThread ? (
            <>
              {status}
              {summaryBlock}
              {doneBlock}
              <p className="label mb-1 mt-6">{threadEmails.length} messages</p>
              <div className="-mx-2">
                {threadEmails.map((msg) => {
                  const isMe = !!(user?.email && msg.sender_email && msg.sender_email.toLowerCase() === user.email.toLowerCase());
                  const name = isMe ? "You" : nameOf(msg.sender, msg.sender_email);
                  const toggle = () =>
                    setOpenMessages((prev) => {
                      const next = new Set(prev);
                      if (next.has(msg.id)) next.delete(msg.id);
                      else next.add(msg.id);
                      return next;
                    });
                  if (!openMessages.has(msg.id))
                    return (
                      <button key={msg.id} className="row2 flex w-[calc(100%-1rem)] items-baseline gap-3 text-left" onClick={toggle} aria-expanded={false}>
                        <span className="w-36 flex-none truncate font-medium text-ink">{name}</span>
                        <span className="min-w-0 flex-1 truncate text-ink3">{msg.snippet}</span>
                        {msg.has_attachments && <Icon name="attachment" size={13} className="flex-none self-center text-ink3" title="Has attachments" />}
                        <time className="flex-none text-xs text-ink3">{shortWhen(msg.received_at)}</time>
                      </button>
                    );
                  const atts = Array.isArray(msg.attachments) ? (msg.attachments as Att[]) : [];
                  return (
                    <article key={msg.id} className="mx-2 border-b border-line-soft pb-6 pl-1.5 pr-3 pt-3 last:border-b-0">
                      <button className="flex w-full items-baseline gap-2 text-left" onClick={toggle} aria-expanded title="Collapse">
                        <span className="min-w-0 truncate text-[15px] font-[650] tracking-[-0.01em] text-ink">{name}</span>
                        {!isMe && msg.sender_email && <span className="min-w-0 truncate text-xs text-ink3">{msg.sender_email}</span>}
                        <span className="flex-1" />
                        <time className="flex-none text-xs text-ink3">{fullWhen(msg.received_at)}</time>
                      </button>
                      {!isMe && <SuspicionBanner verdict={assessSuspicion(msg)} />}
                      <div className="mt-3">
                        <MessageBody
                          body={resolveEmailBodyDisplay({ body_html: msg.body_html, body_text: msg.body_text, snippet: msg.snippet })}
                        />
                      </div>
                      <AttachmentList atts={atts} onPreview={(a) => openPreview(a, msg.gmail_id)} onDownload={(a) => downloadAttachment(a, msg.gmail_id)} />
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-[15px] font-[650] tracking-[-0.01em] text-ink">{nameOf(email.sender, email.sender_email)}</span>
                {email.sender_email && <span className="min-w-0 truncate text-xs text-ink3">{email.sender_email}</span>}
                <span className="flex-1" />
                <time className="flex-none text-xs text-ink3">{fullWhen(email.received_at)}</time>
              </div>
              {(email.recipients || email.cc_recipients) && (
                <p className="mt-0.5 truncate text-xs text-ink3" title={[email.recipients, email.cc_recipients].filter(Boolean).join(", ")}>
                  To {email.recipients || "you"}
                  {email.cc_recipients ? `, cc ${email.cc_recipients}` : ""}
                </p>
              )}
              {status}
              <SuspicionBanner verdict={suspicion} />
              {summaryBlock}
              {doneBlock}
              <div className="mt-5">
                <MessageBody body={singleMessageBody} />
              </div>
              <AttachmentList atts={singleAtts} onPreview={(a) => openPreview(a)} onDownload={(a) => downloadAttachment(a)} />
            </>
          )}
        </div>
      </div>

      {/* Attachment preview */}
      {previewAtt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setPreviewAtt(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={previewAtt.att.filename}
            className="flex flex-col overflow-hidden rounded-[12px] bg-raised shadow-pop"
            style={{ width: "min(92vw, 900px)", height: "min(90vh, 700px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-11 flex-none items-center gap-2 border-b border-line-soft pl-4 pr-1.5">
              <p className="min-w-0 flex-1 truncate font-semibold text-ink">{previewAtt.att.filename}</p>
              {previewAtt.att.size > 0 && <span className="flex-none text-xs text-ink3">{fileSize(previewAtt.att.size)}</span>}
              <button className="btn ml-1" onClick={() => downloadAttachment(previewAtt.att, previewAtt.gmailId)}>
                Download
              </button>
              <button className="iconbtn" onClick={() => setPreviewAtt(null)} title="Close (Esc)" aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-side">
              {!previewAtt.blobUrl && !previewAtt.error && <div className="skel h-[70%] w-[70%] rounded-[9px]" aria-busy="true" aria-label="Loading" />}

              {previewAtt.error && (
                <div className="empty">
                  <p className="!mt-0 !text-danger">{previewAtt.error}</p>
                  <button className="btn mt-3" onClick={() => downloadAttachment(previewAtt.att, previewAtt.gmailId)}>
                    Try downloading it
                  </button>
                </div>
              )}

              {previewAtt.blobUrl && previewAtt.att.mime_type?.startsWith("image/") && (
                <img src={previewAtt.blobUrl} alt={previewAtt.att.filename} className="max-h-full max-w-full object-contain p-4" />
              )}

              {previewAtt.blobUrl && previewAtt.att.mime_type?.includes("pdf") && (
                <iframe src={previewAtt.blobUrl} title={previewAtt.att.filename} className="h-full w-full border-0" />
              )}

              {previewAtt.blobUrl && previewAtt.text !== null && (
                <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed text-ink">{previewAtt.text}</pre>
              )}

              {previewAtt.blobUrl &&
                !previewAtt.att.mime_type?.startsWith("image/") &&
                !previewAtt.att.mime_type?.includes("pdf") &&
                previewAtt.text === null && (
                  <div className="empty">
                    <Icon name="description" size={22} className="text-ink3" />
                    <h3>No preview for this kind of file</h3>
                    <p>Download it to open it in the app it belongs to.</p>
                    <button className="btn mt-4" onClick={() => downloadAttachment(previewAtt.att, previewAtt.gmailId)}>
                      Download
                    </button>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
