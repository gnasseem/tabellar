
import { useState, useRef, useEffect, useMemo, Fragment } from "react";
import Icon from "@/components/Icon";
import DOMPurify from "dompurify";

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

const categoryColorMap: Record<string, string> = {
  important: "bg-danger-soft text-danger",
  "action-required":
    "bg-warn-soft text-warn",
  promotions:
    "bg-field text-ink2",
  updates:
    "bg-field text-ink2",
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
        className="text-ink2 underline break-all hover:text-ink3"
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

function lightenColor([r, g, b]: [number, number, number]): string {
  const [h, s] = toHsl([r, g, b]);
  if (s < 0.05) return "#d1d5db"; // achromatic gray
  return hslToHex(h, Math.min(s, 0.65), 0.82);
}



function processLinks(html: string): string {
  if (typeof window === "undefined") return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("a[href]").forEach((a) => {
      (a as HTMLElement).setAttribute("target", "_blank");
      (a as HTMLElement).setAttribute("rel", "noopener noreferrer");
      (a as HTMLElement).style.color = "#3b82f6";
    });
    return doc.body.innerHTML;
  } catch {
    return html;
  }
}

function adaptTextForDarkMode(html: string): string {
  if (typeof window === "undefined") return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("a[href]").forEach((a) => {
      (a as HTMLElement).setAttribute("target", "_blank");
      (a as HTMLElement).setAttribute("rel", "noopener noreferrer");
      (a as HTMLElement).style.color = "#60a5fa";
    });
    const walk = (el: Element): void => {
      if (el instanceof HTMLElement) {
        // Lighten explicit dark text colors
        if (el.style.color) {
          const rgb = parseRgb(el.style.color);
          if (rgb && relLum(rgb) < 0.25) el.style.color = lightenColor(rgb);
        }
        const cAttr = el.getAttribute("color");
        if (cAttr && !el.style.color) {
          const rgb = parseRgb(cAttr);
          if (rgb && relLum(rgb) < 0.25)
            el.setAttribute("color", lightenColor(rgb));
        }
        // Remove near-white/white backgrounds so the dark UI shows through
        if (el.style.backgroundColor) {
          const rgb = parseRgb(el.style.backgroundColor);
          if (rgb && relLum(rgb) > 0.7)
            el.style.backgroundColor = "transparent";
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

function SuspicionBanner({ verdict }: { verdict: SuspicionVerdict }) {
  if (verdict.level === "none") return null;
  const danger = verdict.level === "danger";
  return (
    <div
      className={`mb-4 rounded-xl border px-4 py-3 ${
        danger
          ? "border-danger-line bg-danger-soft"
          : "border-warn-line bg-warn-soft"
      }`}
    >
      <div className="flex items-start gap-2">
        <Icon name={danger ? "gpp_maybe" : "warning"} size={18} className={`shrink-0 ${
            danger
              ? "text-danger"
              : "text-warn"
          }`} />
        <div className="min-w-0">
          <div
            className={`text-xs font-semibold ${
              danger
                ? "text-danger"
                : "text-warn"
            }`}
          >
            {danger
              ? "This message looks like a phishing attempt"
              : "Something about this message looks off"}
          </div>
          <ul className="mt-1.5 space-y-1">
            {verdict.signals.map((s) => (
              <li
                key={s.id}
                className="text-[11px] leading-relaxed text-ink/80"
              >
                <span className="font-medium">{s.label}.</span> {s.detail}
              </li>
            ))}
          </ul>
          <div className="mt-1.5 text-[11px] text-ink3">
            Do not enter passwords or payment details from a link in this
            email. If it claims to be from a service you use, open that service
            directly instead.
          </div>
        </div>
      </div>
    </div>
  );
}

function EmailBody({ html, isDark }: { html: string; isDark: boolean }) {
  const processed = useMemo(() => {
    const content = fixMojibake(html);
    return isDark ? adaptTextForDarkMode(content) : processLinks(content);
  }, [html, isDark]);

  return (
    <div
      dangerouslySetInnerHTML={{ __html: processed }}
      style={{
        fontSize: "14px",
        lineHeight: "1.65",
        wordBreak: "break-word",
        overflowX: "auto",
        maxWidth: "100%",
        color: isDark ? "#e2e8f0" : undefined,
      }}
    />
  );
}

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
  const { user, openCompose, addToast, theme, setView, setSearch, setPendingMeetingSchedule } =
    useApp() as any;
  const supabase = createClient();

  const senderEmailAddr = email.sender_email || "";

  const [proc, setProc] = useState<any>(
    Array.isArray(email.email_processed)
      ? email.email_processed[0]
      : email.email_processed,
  );
  const [categoryOverride, setCategoryOverride] = useState("");
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [userTags, setUserTags] = useState<
    { slug: string; display_name: string; color: string }[]
  >([]);
  const [emailTags, setEmailTags] = useState<string[]>(
    Array.isArray(proc?.extra_labels) ? proc.extra_labels : [],
  );
  const [bodyHtml, setBodyHtml] = useState<string | null | undefined>(
    email.body_html,
  );
  const tagRef = useRef<HTMLDivElement>(null);
  const [showSnoozeMenu, setShowSnoozeMenu] = useState(false);
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
  const [showTrackPopup, setShowTrackPopup] = useState(false);
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
    setShowTrackPopup(false);
    if (!error) {
      setIsTracked(true);
      addToast("success", "Follow-up reminder set");
    } else addToast("error", "Failed to set reminder");
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
    blobUrl: string | null;
    text: string | null;
    error: string | null;
  };
  const [previewAtt, setPreviewAtt] = useState<AttachmentPreviewState | null>(
    null,
  );
  const snoozeRef = useRef<HTMLDivElement>(null);
  const catRef = useRef<HTMLDivElement>(null);

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

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (snoozeRef.current && !snoozeRef.current.contains(e.target as Node))
        setShowSnoozeMenu(false);
      if (catRef.current && !catRef.current.contains(e.target as Node))
        setShowCategoryMenu(false);
      if (tagRef.current && !tagRef.current.contains(e.target as Node))
        setShowTagMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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
    setShowCategoryMenu(false);

    // Update local state and notify parent immediately
    const updatedProc = { ...proc, category: newCategory };
    setProc(updatedProc);
    onRethink?.(updatedProc);

    await supabase
      .from("email_processed")
      .update({ category: newCategory })
      .eq("email_id", email.id);

    addToast("success", `Category changed to "${newCategory}"`);
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
    await supabase.from("emails").update({ is_read: false }).eq("id", email.id);
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
    setShowSnoozeMenu(false);
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
        addToast("success", "AI analysis refreshed");
      } else {
        addToast("error", "Rethink failed");
      }
    } catch {
      addToast("error", "Network error");
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
            : "No actionable tasks found",
        );
      } else {
        addToast("error", "Could not extract tasks");
      }
    } catch {
      addToast("error", "Network error");
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

  const handleQuickAction = (action: any) => {
    const label = (action.label || action.text || action || "").toLowerCase();
    if (label.includes("forward")) {
      openCompose({
        ...email,
        sender_email: "",
        subject: `Fwd: ${email.subject}`,
      });
    } else {
      openCompose({
        ...email,
        _prefillBody: action.text || "",
        _autoGenerate: !!action.text,
      });
    }
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
  const hasNoActions = !proc?.quick_actions || proc.quick_actions.length === 0;
  const hasReplyAll =
    !!(email.cc_recipients) ||
    (email.recipients || "").split(",").filter(Boolean).length > 1;
  // Only show the panel when there are actual actions to render.
  // If the AI ran and returned [] it made a deliberate decision  -  hide the panel.
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

  return (
    <div className="h-full flex overflow-hidden bg-canvas">
      {/* Main email content column */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* ── Compact header ── */}
        <div className="px-3 py-1.5 flex-shrink-0 bg-raised">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={onBack}
              className={`${showBack ? "flex" : "md:hidden"} p-0.5 rounded hover:bg-field shrink-0 items-center gap-1 text-ink3 hover:text-ink transition-colors`}
            >
              <Icon name="arrow_back" size={16} />
              {showBack && <span className="text-xs font-medium">Back</span>}
            </button>
            <div className="min-w-0 flex-1">
              {/* Sender + subject + time + badges  -  first line */}
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-[12px] font-semibold text-ink shrink-0 max-w-[35%] truncate">
                  {(email.sender ?? "").replace(/<.*>/, "").trim() ||
                    email.sender_email ||
                    "Unknown"}
                </p>
                <p className="text-[11px] text-ink3 truncate flex-1 min-w-0">
                  {email.subject || "(no subject)"}
                </p>
                <div className="flex items-center gap-0.5 shrink-0">
                  {/* Category badge + dropdown */}
                  <div ref={catRef} className="relative">
                    <button
                      onClick={() => {
                        setShowCategoryMenu(!showCategoryMenu);
                        setShowTagMenu(false);
                      }}
                      className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium cursor-pointer ${categoryColorMap[currentCategory] || "bg-field text-ink2"}`}
                      title="Change category"
                    >
                      {currentCategory || "uncategorized"}
                    </button>
                    {showCategoryMenu && (
                      <div className="absolute right-0 top-full mt-1 bg-canvas border border-line rounded-lg shadow-lg p-1 z-20 min-w-[160px]">
                        {CATEGORIES.map((cat) => (
                          <button
                            key={cat}
                            onClick={() => overrideCategory(cat)}
                            className={`w-full text-left px-2.5 py-1.5 text-xs rounded flex items-center gap-2 hover:bg-field`}
                          >
                            <span
                              className={`inline-block w-2 h-2 rounded-full shrink-0 ${categoryColorMap[cat]?.includes("red") ? "bg-danger" : categoryColorMap[cat]?.includes("orange") ? "bg-warn" : categoryColorMap[cat]?.includes("purple") ? "bg-wax" : "bg-wax"}`}
                            />
                            <span
                              className={`flex-1 ${categoryColorMap[cat] || ""} px-1 py-0.5 rounded text-[10px] font-medium ${currentCategory === cat ? "font-bold" : ""}`}
                            >
                              {cat}
                            </span>
                            {currentCategory === cat && (
                              <Icon name="check" size={12} className="text-wax" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Tag + button */}
                  <div ref={tagRef} className="relative">
                    <button
                      onClick={() => {
                        setShowTagMenu(!showTagMenu);
                        setShowCategoryMenu(false);
                      }}
                      className="flex items-center p-0.5 rounded text-ink3 hover:bg-field"
                      title="Add tag"
                    >
                      <Icon name="add" size={12} />
                    </button>
                    {showTagMenu && (
                      <div className="absolute right-0 top-full mt-1 bg-canvas border border-line rounded-lg shadow-lg p-2 z-20 min-w-[160px]">
                        <p className="text-[10px] text-ink3 font-semibold uppercase tracking-wide mb-1.5 px-1">
                          Tags
                        </p>
                        {userTags.length === 0 ? (
                          <p className="text-xs text-ink3 px-1 py-1">
                            No tags yet. Create tags in Categories.
                          </p>
                        ) : (
                          userTags.map((tag) => {
                            const active = emailTags.includes(tag.slug);
                            return (
                              <button
                                key={tag.slug}
                                onClick={() => toggleTag(tag.slug)}
                                className="w-full text-left px-2 py-1.5 text-xs rounded flex items-center gap-2 hover:bg-field"
                              >
                                <span
                                  className="w-2.5 h-2.5 rounded-full shrink-0"
                                  style={{ backgroundColor: tag.color }}
                                />
                                <span className="flex-1 text-ink">
                                  {tag.display_name}
                                </span>
                                {active && (
                                  <Icon name="check" size={12} className="text-wax" />
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {/* Applied tags */}
                {emailTags.length > 0 &&
                  emailTags.map((slug) => {
                    const tag = userTags.find((t) => t.slug === slug);
                    if (!tag) return null;
                    return (
                      <span
                        key={slug}
                        className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium shrink-0"
                        style={{
                          backgroundColor: `${tag.color}20`,
                          color: tag.color,
                          boxShadow: `inset 0 0 0 1px ${tag.color}40`,
                        }}
                      >
                        {tag.display_name}
                      </span>
                    );
                  })}
                {email.has_attachments && (
                  <Icon name="attachment" size={12} className="text-ink3 shrink-0" title="Has attachments" />
                )}
                <span className="text-[10px] text-ink3 shrink-0 tabular-nums">
                  {new Date(email.received_at).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Email body or Thread chat view ── */}
        {threadLoading ? (
          <div className="flex-1 flex flex-col gap-3 px-3 py-3">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className={`flex flex-col gap-1 ${n % 2 === 0 ? "items-end" : "items-start"}`}
              >
                <div className="h-3 w-24 rounded bg-line animate-pulse" />
                <div
                  className={`h-12 rounded-2xl animate-pulse bg-line ${n % 2 === 0 ? "w-48 rounded-tr-sm" : "w-64 rounded-tl-sm"}`}
                />
              </div>
            ))}
          </div>
        ) : threadEmails.length > 1 ? (
          <div className="flex-1 min-h-0 overflow-auto email-reader-pane bg-canvas">
            <div className="w-full max-w-3xl mx-auto px-3 sm:px-4 py-4 min-w-0">
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-field/60 px-3 py-2.5">
                <Icon name="forum" size={20} className="text-wax shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink3">
                    Thread
                  </p>
                  <p className="text-[13px] font-medium text-ink truncate">
                    {threadEmails.length} messages in this conversation
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-0">
                {threadEmails.map((msg, msgIndex) => {
                  const msgSenderName =
                    (msg.sender ?? "").replace(/<.*>/, "").trim() ||
                    msg.sender_email ||
                    "Unknown";
                  const isMe = !!(
                    user?.email &&
                    msg.sender_email &&
                    msg.sender_email.toLowerCase() === user.email.toLowerCase()
                  );
                  const atts = Array.isArray(msg.attachments)
                    ? (msg.attachments as ThreadAtt[])
                    : [];
                  const bodyDisplay = resolveEmailBodyDisplay({
                    body_html: msg.body_html,
                    body_text: msg.body_text,
                    snippet: msg.snippet,
                  });
                  const timeStr = new Date(msg.received_at).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  const isLast = msgIndex === threadEmails.length - 1;
                  return (
                    <div
                      key={msg.id}
                      className="flex gap-3 min-w-0 pb-5 last:pb-0"
                    >
                      <div className="flex w-10 shrink-0 flex-col items-center pt-1">
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors duration-200 ${
                            isMe
                              ? "bg-wax/20 text-wax ring-2 ring-wax/35"
                              : "bg-field text-ink ring-1 ring-line"
                          }`}
                          title={`Message ${msgIndex + 1} of ${threadEmails.length}`}
                        >
                          {msgIndex + 1}
                        </div>
                        {!isLast && (
                          <div
                            className="mt-1 w-px flex-1 min-h-[20px] bg-gradient-to-b from-line to-transparent"
                            aria-hidden
                          />
                        )}
                      </div>
                      <article
                        className={`min-w-0 flex-1 overflow-hidden rounded-2xl border bg-raised transition-shadow duration-200 motion-reduce:transition-none ${
                          isMe
                            ? "border-wax/40 shadow-sm dark:shadow-[0_4px_20px_rgba(0,0,0,0.45)]"
                            : "border-line shadow-sm dark:shadow-[0_4px_20px_rgba(0,0,0,0.35)] dark:ring-1"
                        }`}
                      >
                        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line/70 bg-field/30 px-3 py-2.5 sm:px-4">
                          <div className="min-w-0">
                            <p className="text-[13px] font-semibold leading-snug text-ink">
                              {isMe ? "You" : msgSenderName}
                            </p>
                            <p className="mt-0.5 text-[11px] text-ink3 tabular-nums">
                              {timeStr}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-md bg-field px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink3">
                            {msgIndex + 1} / {threadEmails.length}
                          </span>
                        </header>
                        <div className="px-3 py-3 sm:px-4 sm:py-4">
                          {!isMe && (
                            <SuspicionBanner verdict={assessSuspicion(msg)} />
                          )}
                          {bodyDisplay.kind === "html" && (
                            <EmailBody
                              html={bodyDisplay.html}
                              isDark={theme === "dark"}
                            />
                          )}
                          {bodyDisplay.kind === "text" && (
                            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.65] text-ink">
                              {linkify(bodyDisplay.text)}
                            </pre>
                          )}
                          {bodyDisplay.kind === "snippet" && (
                            <p className="text-[13px] leading-relaxed text-ink3">
                              {bodyDisplay.text}
                            </p>
                          )}
                          {bodyDisplay.kind === "empty" && (
                            <p className="text-xs text-ink3">
                              (no content)
                            </p>
                          )}
                          {msg.has_attachments && atts.length > 0 && (
                            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line/50 pt-2.5">
                              {atts.map((att) => (
                                <div
                                  key={att.attachment_id}
                                  className="flex items-center overflow-hidden rounded-lg border border-line bg-field/60 transition-colors duration-150 group"
                                >
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      setPreviewAtt({
                                        att,
                                        blobUrl: null,
                                        text: null,
                                        error: null,
                                      });
                                      try {
                                        const result =
                                          await fetchAttachmentBlob(
                                            att,
                                            msg.gmail_id,
                                          );
                                        setPreviewAtt({
                                          att,
                                          ...result,
                                          error: null,
                                        });
                                      } catch {
                                        setPreviewAtt((prev) =>
                                          prev
                                            ? {
                                                ...prev,
                                                error:
                                                  "Failed to load attachment",
                                              }
                                            : null,
                                        );
                                      }
                                    }}
                                    className="flex cursor-pointer items-center gap-1 px-2 py-1 hover:bg-field"
                                  >
                                    <Icon name={att.mime_type?.startsWith("image/")
                                        ? "image"
                                        : att.mime_type?.includes("pdf")
                                          ? "picture_as_pdf"
                                          : "description"} size={13} className="text-ink3 group-hover:text-wax" />
                                    <span className="max-w-[120px] truncate text-left text-[10px] font-medium text-ink">
                                      {att.filename}
                                    </span>
                                    {att.size > 0 && (
                                      <span className="shrink-0 text-[9px] text-ink3 tabular-nums">
                                        {att.size > 1024 * 1024
                                          ? `${(att.size / 1024 / 1024).toFixed(1)}M`
                                          : `${Math.ceil(att.size / 1024)}K`}
                                      </span>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      downloadAttachment(att, msg.gmail_id)
                                    }
                                    className="cursor-pointer border-l border-line px-1.5 py-1 hover:bg-field"
                                    title="Download"
                                    aria-label={`Download ${att.filename}`}
                                  >
                                    <Icon name="download" size={11} className="text-ink3 hover:text-wax" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </article>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto email-reader-pane bg-canvas px-3 py-4 sm:px-5">
            <div className="mx-auto w-full max-w-3xl min-w-0">
              <SuspicionBanner verdict={suspicion} />
              {singleMessageBody.kind === "html" && (
                <EmailBody
                  html={singleMessageBody.html}
                  isDark={theme === "dark"}
                />
              )}
              {singleMessageBody.kind === "text" && (
                <pre className="max-w-prose whitespace-pre-wrap font-sans text-[15px] leading-[1.65] text-ink">
                  {linkify(singleMessageBody.text)}
                </pre>
              )}
              {singleMessageBody.kind === "snippet" && (
                <p className="max-w-prose text-[15px] leading-relaxed text-ink3">
                  {singleMessageBody.text}
                </p>
              )}
              {singleMessageBody.kind === "empty" && (
                <span className="text-sm text-ink3">
                  (no content)
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Attachments + AI Suggestions Panel ── */}
        {((Array.isArray(email.attachments) &&
          email.attachments.length > 0 &&
          !isMultiMessageThread) ||
          showSuggestionsPanel) && (
          <div className="px-3 pt-2 pb-2 flex-shrink-0 bg-wax/5 flex flex-col gap-1.5">
            {/* Attachments row  -  only for single-message view (thread messages show their own) */}
            {!isMultiMessageThread &&
              Array.isArray(email.attachments) &&
              email.attachments.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Icon name="attach_file" size={13} className="text-ink3" />
                  {(
                    email.attachments as {
                      filename: string;
                      mime_type: string;
                      size: number;
                      attachment_id: string;
                    }[]
                  ).map((att, i) => (
                    <div
                      key={i}
                      className="flex items-center rounded-xl border border-line bg-raised overflow-hidden group"
                    >
                      <button
                        onClick={async () => {
                          setPreviewAtt({
                            att,
                            blobUrl: null,
                            text: null,
                            error: null,
                          });
                          try {
                            const result = await fetchAttachmentBlob(att);
                            setPreviewAtt({ att, ...result, error: null });
                          } catch {
                            setPreviewAtt((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    error: "Failed to load attachment",
                                  }
                                : null,
                            );
                          }
                        }}
                        className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-field transition-colors"
                      >
                        <Icon name={att.mime_type?.startsWith("image/")
                            ? "image"
                            : att.mime_type?.includes("pdf")
                              ? "picture_as_pdf"
                              : "description"} size={13} className="text-ink3 group-hover:text-wax" />
                        <span className="text-[11px] font-medium text-ink truncate max-w-[140px]">
                          {att.filename}
                        </span>
                        <span className="text-[9px] text-ink3 shrink-0">
                          {att.size > 1024 * 1024
                            ? `${(att.size / 1024 / 1024).toFixed(1)} MB`
                            : `${Math.ceil(att.size / 1024)} KB`}
                        </span>
                        <Icon name="visibility" size={12} className="text-ink3 group-hover:text-wax shrink-0" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadAttachment(att);
                        }}
                        className="px-1.5 py-1.5 border-l border-line hover:bg-field transition-colors shrink-0"
                        title="Download"
                      >
                        <Icon name="download" size={12} className="text-ink3 hover:text-wax" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

            {showSuggestionsPanel && (
              <div className="flex flex-col gap-2">
              <div className={`flex items-center gap-1.5 flex-wrap transition-opacity ${activeInputAction ? "opacity-50" : "opacity-100"}`}>
                <Icon name="auto_awesome" size={13} className="text-ink3 shrink-0" />
                {replyActions.map((qa: any, i: number) => {
                  const label = (qa.label || "").replace(/^Reply:\s*/i, "");
                  const prefill = qa.text || label;
                  const hasQuestions = qa.questions?.length > 0;
                  const isActive = activeInputAction?.qa === qa;
                  const baseChipClass = isActive
                    ? "border-line bg-field text-ink2"
                    : "border-line bg-field text-ink2 hover:bg-field";
                  return (
                    <div key={`reply-${i}`} className="flex items-stretch">
                      <button
                        onClick={() => {
                          if (hasQuestions) {
                            setActiveInputAction({ qa, answers: {} });
                          } else {
                            openCompose({
                              ...email,
                              _prefillBody: prefill,
                              _autoGenerate: true,
                            });
                          }
                        }}
                        className={`flex items-center gap-1 px-3 py-1.5 border text-[11px] font-medium transition-colors ${hasReplyAll ? "rounded-l-xl border-r-0" : "rounded-xl"} ${baseChipClass}`}
                        title={label}
                      >
                        <Icon name="chat_bubble" size={12} className="text-ink2" />
                        <span>{label}</span>
                        {hasQuestions && (
                          <Icon name="edit" size={11} className="text-ink2 opacity-70" />
                        )}
                      </button>
                      {hasReplyAll && (
                        <button
                          onClick={() => {
                            if (hasQuestions) {
                              setActiveInputAction({ qa, answers: {} });
                            } else {
                              openCompose({
                                ...email,
                                _prefillBody: prefill,
                                _autoGenerate: true,
                                _replyAll: true,
                              });
                            }
                          }}
                          className={`flex items-center px-1.5 py-1.5 rounded-r-xl border text-[11px] transition-colors ${baseChipClass}`}
                          title={`${label} (Reply All)`}
                        >
                          <Icon name="reply_all" size={12} className="text-ink2" />
                        </button>
                      )}
                    </div>
                  );
                })}
                {meetingActions.map((qa: any, i: number) => {
                  const label = (qa.label || "").replace(/^Schedule:\s*/i, "").replace(/^Add to Calendar:\s*/i, "");
                  const details = qa.meetingDetails;
                  return (
                    <button
                      key={`meeting-${i}`}
                      onClick={() => {
                        setPendingMeetingSchedule({
                          title: details?.title || (qa.text?.trim()) || label,
                          dateTime: details?.dateTime || undefined,
                          duration: details?.duration || undefined,
                          location: details?.location || undefined,
                          attendees: details?.attendees || (email.sender_email ? [email.sender_email] : []),
                          description: details?.description || email.subject,
                        });
                        setView("meetings");
                      }}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-ok-line bg-ok-soft text-[11px] font-medium text-ok hover:bg-ok-soft transition-colors"
                      title={label}
                    >
                      <Icon name="event_upcoming" size={12} className="text-ok" />
                      <span>{label}</span>
                    </button>
                  );
                })}
                {todoActions.map((qa: any, i: number) => {
                  const task = (qa.label || "").replace(/^Todo:\s*/i, "");
                  const added = addedTodos.has(task);
                  return (
                    <button
                      key={`todo-${i}`}
                      onClick={() => !added && addTodoFromChip(task)}
                      disabled={added}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[11px] font-medium transition-all ${
                        added
                          ? "border-ok-line bg-ok-soft text-ok cursor-default"
                          : "border-warn-line bg-warn-soft text-warn hover:bg-warn-soft"
                      }`}
                      title={task}
                    >
                      <Icon name={added ? "check_circle" : "add_task"} size={13} fill={added} />
                      <span>{task}</span>
                    </button>
                  );
                })}
              </div>

              {/* Inline input card  -  shown when a reply action with questions is clicked */}
              {activeInputAction && (
                <div className="rounded-xl border border-line bg-field p-3 flex flex-col gap-2.5 shadow-sm">
                  {/* Header */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Icon name="auto_awesome" size={12} className="text-ink2 shrink-0" />
                      <span className="text-[11px] font-medium text-ink2 truncate">
                        {(activeInputAction.qa.label || "").replace(/^Reply:\s*/i, "")}
                      </span>
                    </div>
                    <button
                      onClick={() => setActiveInputAction(null)}
                      className="shrink-0 p-0.5 rounded hover:bg-field text-ink2 hover:text-ink2 transition-colors"
                      title="Dismiss"
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>

                  {/* Question fields */}
                  {(activeInputAction.qa.questions || []).map((q: any, qi: number) => {
                    const isLast = qi === (activeInputAction.qa.questions || []).length - 1;
                    return (
                      <div key={q.key} className="flex flex-col gap-1">
                        <label className="text-[10px] font-medium text-ink3">{q.label}</label>
                        <input
                          type="text"
                          autoFocus={qi === 0}
                          placeholder={q.placeholder || ""}
                          value={activeInputAction.answers[q.key] || ""}
                          onChange={(e) =>
                            setActiveInputAction((prev) =>
                              prev ? { ...prev, answers: { ...prev.answers, [q.key]: e.target.value } } : null
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && isLast) submitInputAction();
                          }}
                          className="text-[11px] rounded-lg border border-line bg-white text-ink px-2 py-1.5 w-full outline-none focus:ring-1 focus:ring-line placeholder:text-ink3 transition-shadow"
                        />
                      </div>
                    );
                  })}

                  {/* Submit row */}
                  <div className="flex justify-end gap-1.5">
                    {hasReplyAll && (
                      <button
                        onClick={() => submitInputAction(true)}
                        disabled={
                          (activeInputAction.qa.questions || []).some(
                            (q: any) => !(activeInputAction.answers[q.key] || "").trim()
                          )
                        }
                        className="flex items-center gap-1 px-3 py-1 text-[11px] font-medium rounded-lg border border-line text-ink2 hover:bg-field transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Icon name="reply_all" size={12} />
                        <span>Reply All</span>
                      </button>
                    )}
                    <button
                      onClick={() => submitInputAction(false)}
                      disabled={
                        (activeInputAction.qa.questions || []).some(
                          (q: any) => !(activeInputAction.answers[q.key] || "").trim()
                        )
                      }
                      className="flex items-center gap-1 px-3 py-1 text-[11px] font-medium rounded-lg bg-wax hover:bg-wax text-on-wax transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span>Write Reply</span>
                      <Icon name="arrow_forward" size={12} />
                    </button>
                  </div>
                </div>
              )}
              </div>
            )}
          </div>
        )}

        {/* ── Action bar ── */}
        <div className="px-3 py-1.5 border-t border-line flex-shrink-0 flex items-center gap-1.5 flex-wrap">
          {/* Reply button  -  always visible */}
          <button
            onClick={() => onReply()}
            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-line text-[11px] font-medium text-ink2 hover:bg-field transition-colors"
          >
            <Icon name="reply" size={12} />
            Reply
          </button>

          {/* Reply All  -  show when there are CC recipients or multiple TO recipients */}
          {hasReplyAll && (
            <button
              onClick={() => openCompose({ ...email, _replyAll: true })}
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-line text-[11px] font-medium text-ink2 hover:bg-field transition-colors"
            >
              <Icon name="reply_all" size={12} />
              Reply All
            </button>
          )}

          <div className="flex-1" />

          {/* Action buttons */}
          <button
            onClick={() =>
              openCompose({
                ...email,
                sender_email: "",
                subject: `Fwd: ${email.subject}`,
              })
            }
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-ink2 hover:bg-field transition-colors"
          >
            <Icon name="forward_to_inbox" size={13} />
            Delegate
          </button>
          <button
            onClick={handleMarkUnread}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-ink2 hover:bg-field transition-colors"
          >
            <Icon name="mark_email_unread" size={13} />
            Unread
          </button>
          <div ref={snoozeRef} className="relative">
            <button
              onClick={() => setShowSnoozeMenu(!showSnoozeMenu)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-ink2 hover:bg-field transition-colors"
            >
              <Icon name="snooze" size={13} />
              Snooze
            </button>
            {showSnoozeMenu && (
              <div className="absolute bottom-full mb-1 right-0 bg-canvas border border-line rounded-lg shadow-lg p-1 z-20 min-w-[160px]">
                {SNOOZE_OPTIONS.map((opt) => (
                  <button
                    key={opt.hours}
                    onClick={() => handleSnooze(opt.hours, opt.label)}
                    className="w-full text-left px-3 py-1.5 text-xs rounded text-ink hover:bg-field"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Track follow-up  -  shown for sent/outbound emails with a thread_id */}
          {email.thread_id && (
            <div className="relative">
              <button
                onClick={() => {
                  if (isTracked) {
                    setView("followups");
                  } else {
                    setShowTrackPopup((v) => !v);
                  }
                }}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-medium transition-colors ${
                  isTracked
                    ? "border-wax text-wax bg-wax-soft"
                    : "border-line text-ink3 hover:bg-field hover:text-ink"
                }`}
                title={isTracked ? "View in Follow-ups" : "Track follow-up"}
              >
                <Icon name="schedule_send" size={13} fill={isTracked} />
                {isTracked ? "Tracked" : "Track"}
              </button>
              {showTrackPopup && !isTracked && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowTrackPopup(false)}
                  />
                  <div className="absolute bottom-full mb-2 right-0 z-20 bg-canvas border border-line rounded-xl shadow-xl p-3 w-64">
                    <p className="text-[11px] font-semibold text-ink mb-2">
                      Remind me if no reply by
                    </p>
                    <div className="mb-2">
                      <DateTimePicker
                        value={trackRemindAt}
                        onChange={setTrackRemindAt}
                        placeholder="Pick date and time"
                      />
                    </div>
                    <button
                      onClick={trackFollowUp}
                      disabled={trackingSaving}
                      className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-wax text-on-wax text-xs font-semibold hover:opacity-90 disabled:opacity-60 transition-opacity"
                    >
                      {trackingSaving ? (
                        <Icon name="progress_activity" size={13} className="animate-spin" />
                      ) : (
                        <Icon name="add_alert" size={13} />
                      )}
                      Set Reminder
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <button
            onClick={toggleResolved}
            disabled={resolvingEmail}
            title={
              resolvedAt
                ? "Mark this email as still needing attention"
                : "Mark this email as dealt with, without archiving it"
            }
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-60 ${
              resolvedAt
                ? "text-ok bg-ok/10 hover:bg-ok/20"
                : "text-ink3 hover:bg-line"
            }`}
          >
            <Icon name={resolvedAt ? "task_alt" : "check_circle"} size={13} />
            {resolvedAt ? "Resolved" : "Resolve"}
          </button>
          <button
            onClick={onArchive}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-danger hover:bg-danger-soft transition-colors"
          >
            <Icon name="archive" size={13} />
            Archive
          </button>
        </div>
      </div>
      {/* end main column */}

      {/* ── Attachment Preview Modal ── */}
      {previewAtt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setPreviewAtt(null)}
        >
          <div
            className="relative flex flex-col bg-canvas border border-line rounded-2xl shadow-2xl overflow-hidden"
            style={{ width: "min(92vw, 900px)", height: "min(90vh, 700px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-line bg-raised shrink-0">
              <Icon name={previewAtt.att.mime_type?.startsWith("image/")
                  ? "image"
                  : previewAtt.att.mime_type?.includes("pdf")
                    ? "picture_as_pdf"
                    : "description"} size={18} className="text-wax" />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-ink truncate">
                  {previewAtt.att.filename}
                </p>
                <p className="text-[10px] text-ink3">
                  {previewAtt.att.size > 1024 * 1024
                    ? `${(previewAtt.att.size / 1024 / 1024).toFixed(1)} MB`
                    : `${Math.ceil(previewAtt.att.size / 1024)} KB`}
                  {" · "}
                  {previewAtt.att.mime_type || "unknown type"}
                </p>
              </div>
              <button
                onClick={() => downloadAttachment(previewAtt.att)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-wax text-on-wax text-[11px] font-semibold hover:opacity-90 transition-opacity shrink-0"
              >
                <Icon name="download" size={13} />
                Download
              </button>
              <button
                onClick={() => setPreviewAtt(null)}
                className="p-1.5 rounded-lg hover:bg-field transition-colors shrink-0"
                title="Close"
              >
                <Icon name="close" size={16} className="text-ink3" />
              </button>
            </div>

            {/* Content area */}
            <div className="flex-1 overflow-auto flex items-center justify-center bg-field">
              {/* Loading */}
              {!previewAtt.blobUrl && !previewAtt.error && (
                <div className="flex flex-col items-center gap-3 text-ink3">
                  <Icon name="progress_activity" size={28} className="animate-spin text-wax" />
                  <span className="text-[12px]">Loading preview...</span>
                </div>
              )}

              {/* Error */}
              {previewAtt.error && (
                <div className="flex flex-col items-center gap-3 text-ink3">
                  <Icon name="error_outline" size={28} className="text-danger" />
                  <span className="text-[12px]">{previewAtt.error}</span>
                  <button
                    onClick={() => downloadAttachment(previewAtt.att)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-[11px] font-medium hover:bg-raised transition-colors"
                  >
                    <Icon name="download" size={13} />
                    Download instead
                  </button>
                </div>
              )}

              {/* Image preview */}
              {previewAtt.blobUrl &&
                previewAtt.att.mime_type?.startsWith("image/") && (
                  <img
                    src={previewAtt.blobUrl}
                    alt={previewAtt.att.filename}
                    className="max-w-full max-h-full object-contain"
                    style={{ padding: "16px" }}
                  />
                )}

              {/* PDF preview */}
              {previewAtt.blobUrl &&
                previewAtt.att.mime_type?.includes("pdf") && (
                  <iframe
                    src={previewAtt.blobUrl}
                    title={previewAtt.att.filename}
                    className="w-full h-full border-0"
                  />
                )}

              {/* Text / CSV / JSON preview */}
              {previewAtt.blobUrl && previewAtt.text !== null && (
                <pre className="w-full h-full overflow-auto p-4 text-[11px] font-mono text-ink leading-relaxed whitespace-pre-wrap break-all">
                  {previewAtt.text}
                </pre>
              )}

              {/* Unsupported type */}
              {previewAtt.blobUrl &&
                !previewAtt.att.mime_type?.startsWith("image/") &&
                !previewAtt.att.mime_type?.includes("pdf") &&
                previewAtt.text === null && (
                  <div className="flex flex-col items-center gap-3 text-ink3 text-center px-8">
                    <Icon name="draft" size={36} />
                    <p className="text-[13px] font-medium text-ink">
                      Preview not available
                    </p>
                    <p className="text-[11px]">
                      This file type cannot be previewed in the browser.
                    </p>
                    <button
                      onClick={() => downloadAttachment(previewAtt.att)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-wax text-on-wax text-[11px] font-semibold hover:opacity-90 transition-opacity"
                    >
                      <Icon name="download" size={13} />
                      Download to open
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
