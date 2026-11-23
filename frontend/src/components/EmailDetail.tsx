import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { setMailState, type Outcome } from "@/lib/outcomes";
import { assessSuspicion, type SuspicionVerdict } from "@/lib/suspicion";
import { useApp } from "./AppShell";
import DateTimePicker from "./DateTimePicker";
import EmailBody from "./EmailBody";
import { Countdown, Glyph, OutcomeLines, shortWhen } from "./ui";

// The reader: one column at a readable measure. The thread shows its latest
// message in full and each earlier one as a line; Tabellar's reply, drafted or
// on its way out, sits under it. One action row: Reply, Archive, more.

/* eslint-disable @typescript-eslint/no-explicit-any */

// Attachments fetched in this window, kept across emails. Bounded: an object
// URL keeps its Blob alive until revoked.
type CachedAttachment = { blobUrl: string; blob: Blob; text: string | null };
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 24;
const cache = new Map<string, CachedAttachment>();
let cacheBytes = 0;

function evict(key: string) {
  const entry = cache.get(key);
  if (!entry) return;
  URL.revokeObjectURL(entry.blobUrl);
  cacheBytes -= entry.blob.size;
  cache.delete(key);
}

function remember(key: string, entry: CachedAttachment) {
  evict(key);
  cache.set(key, entry);
  cacheBytes += entry.blob.size;
  while (cache.size > 1 && (cacheBytes > CACHE_MAX_BYTES || cache.size > CACHE_MAX_ENTRIES)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    evict(oldest);
  }
}

// Reading an entry moves it to the back, so eviction is least recently used.
function recall(key: string): CachedAttachment | undefined {
  const entry = cache.get(key);
  if (entry) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

type Att = { filename: string; mime_type: string; size: number; attachment_id: string };

async function fetchAttachment(att: Att, gmailId: string): Promise<CachedAttachment> {
  const key = `${gmailId}::${att.attachment_id}`;
  const cached = recall(key);
  if (cached) return cached;
  const { data } = await createClient().auth.getSession();
  const res = await fetch(`/api/attachment?gmail_id=${encodeURIComponent(gmailId)}&attachment_id=${encodeURIComponent(att.attachment_id)}`, {
    headers: { Authorization: `Bearer ${data.session?.access_token}` },
  });
  if (!res.ok) throw new Error("Could not fetch the attachment");
  const binary = atob(((await res.json()).data as string).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: att.mime_type || "application/octet-stream" });
  const text = att.mime_type?.startsWith("text/") || att.mime_type === "application/json" ? await blob.text() : null;
  const entry = { blobUrl: URL.createObjectURL(blob), blob, text };
  remember(key, entry);
  return entry;
}

const fileSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);
const fileIcon = (mime: string | undefined) => (mime?.startsWith("image/") ? "image" : mime?.includes("pdf") ? "picture_as_pdf" : "description");
const nameOf = (sender: string | null | undefined, address: string | null | undefined) => (sender ?? "").replace(/<.*>/, "").replace(/"/g, "").trim() || address || "Unknown sender";
const fullWhen = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const plain = (html: string) =>
  (html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();

const CATEGORIES: [string, string][] = [
  ["important", "Important"],
  ["action-required", "Action required"],
  ["updates", "Updates"],
  ["promotions", "Promotions"],
];

const SNOOZE: [string, number][] = [
  ["1 hour", 1],
  ["3 hours", 3],
  ["Tomorrow morning", 16],
  ["Next week", 168],
];

const MESSAGE_FIELDS =
  "id, gmail_id, thread_id, gmail_account_id, subject, sender, sender_email, recipients, cc_recipients, received_at, body_html, body_text, snippet, has_attachments, attachments, reply_to_email";

// A caution about the sender or its links, on one line; the reasons open below it.
function SuspicionBanner({ verdict }: { verdict: SuspicionVerdict }) {
  const [open, setOpen] = useState(false);
  if (verdict.level === "none") return null;
  const danger = verdict.level === "danger";
  return (
    <div className={`mt-3 rounded-[9px] px-3 py-2 ${danger ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"}`} role="alert">
      <div className="flex items-center gap-2">
        <Glyph state={danger ? "failed" : "held"} />
        <span className="min-w-0 flex-1 font-medium">{danger ? "Looks like phishing." : "Something here looks off."} Enter no passwords or payment details from its links.</span>
        <button className="link flex-none" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "Why"}
        </button>
      </div>
      {open && (
        <ul className="mt-1.5 space-y-1 pb-0.5 pl-6 text-xs leading-normal text-ink2">
          {verdict.signals.map((s) => (
            <li key={s.id}>
              <span className="font-medium text-ink">{s.label}.</span> {s.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type EmailDetailProps = {
  email: any;
  onBack: () => void;
  onArchive: () => void;
  onReply: () => void;
  onMarkUnread?: () => void;
  onSnooze?: () => void;
  onRethink?: (updated: any) => void;
  onResolvedChange?: (emailId: string, resolvedAt: string | null) => void;
};

export default function EmailDetail({ email, onBack, onArchive, onReply, onMarkUnread, onSnooze, onRethink, onResolvedChange }: EmailDetailProps) {
  const { user, openCompose, addToast, setView, mail, liveChanges, draftVersion, notifyDraftChange } = useApp();
  const supabase = createClient();
  const [proc, setProc] = useState<any>(Array.isArray(email.email_processed) ? email.email_processed[0] : email.email_processed);
  const [messages, setMessages] = useState<any[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<"" | "more" | "sort" | "snooze" | "track">("");
  const barRef = useRef<HTMLElement>(null);
  const [labels, setLabels] = useState<{ slug: string; display_name: string }[]>([]);
  const [resolvedAt, setResolvedAt] = useState<string | null>(email.resolved_at ?? null);
  const [tracked, setTracked] = useState(false);
  const [remindAt, setRemindAt] = useState(() => {
    const d = new Date(Date.now() + 3 * 86_400_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
  });
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ draft?: any; going?: any } | null>(null);
  const [preview, setPreview] = useState<{ att: Att; gmailId: string; entry: CachedAttachment | null; error: string | null } | null>(null);

  // The thread, oldest first; only the latest message opens.
  useEffect(() => {
    let live = true;
    const q = supabase.from("emails").select(MESSAGE_FIELDS).eq("user_id", user.id);
    (email.thread_id ? q.eq("thread_id", email.thread_id) : q.eq("id", email.id))
      .order("received_at", { ascending: true })
      .limit(40)
      .then(({ data }: { data: any[] | null }) => {
        if (!live) return;
        const list = data?.length ? data : [email];
        setMessages(list);
        setOpen(new Set([list[list.length - 1].id]));
      });
    return () => {
      live = false;
    };
  }, [email.id, email.thread_id, user.id]);

  const ids = (messages || [email]).map((m) => m.id);
  const idKey = ids.join(",");

  // Tabellar's reply to this thread: a draft to review, or one going out.
  useEffect(() => {
    let live = true;
    Promise.all([
      supabase.from("draft_emails").select("*").eq("user_id", user.id).in("email_id", ids).order("created_at", { ascending: false }).limit(1),
      supabase.from("scheduled_emails").select("*").eq("user_id", user.id).eq("status", "pending").eq("source", "autopilot").in("email_id", ids).limit(1),
    ]).then(([d, s]) => live && setReply(d.data?.[0] || s.data?.[0] ? { draft: d.data?.[0], going: s.data?.[0] } : null));
    return () => {
      live = false;
    };
  }, [idKey, liveChanges.draft_emails, liveChanges.scheduled_emails, draftVersion]);

  useEffect(() => {
    supabase.from("categories").select("slug, display_name").eq("user_id", user.id).then(({ data }: { data: any[] | null }) => setLabels(data || []));
    if (email.thread_id)
      supabase
        .from("follow_up_reminders")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("thread_id", email.thread_id)
        .then(({ count }: { count: number | null }) => setTracked((count ?? 0) > 0));
  }, [email.id, user.id]);

  // A few of the latest message's smaller attachments, fetched one at a time
  // so a preview opens at once; dropped when the reader closes.
  useEffect(() => {
    const last = messages?.[messages.length - 1];
    const atts: Att[] = Array.isArray(last?.attachments) ? last.attachments : [];
    let cancelled = false;
    (async () => {
      let budget = 20 * 1024 * 1024;
      for (const att of atts.slice(0, 5)) {
        if (cancelled || att.size > 5 * 1024 * 1024 || att.size > budget) continue;
        await fetchAttachment(att, last.gmail_id).catch(() => {});
        budget -= att.size;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => barRef.current && !barRef.current.contains(e.target as Node) && setMenu("");
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const replyTo = () => {
    openCompose(email);
    onReply();
  };

  const markUnread = async () => {
    try {
      await setMailState([email.id], { read: false });
    } catch {
      return addToast("error", "Could not mark it unread in Gmail.");
    }
    addToast("info", "Marked unread");
    onMarkUnread?.();
  };

  const setResolved = async (next: string | null) => {
    setMenu("");
    const before = resolvedAt;
    setResolvedAt(next);
    const { error } = await supabase.from("emails").update({ resolved_at: next }).eq("id", email.id);
    if (error) {
      setResolvedAt(before);
      return addToast("error", "Could not update this email.");
    }
    onResolvedChange?.(email.id, next);
  };

  const snooze = async (hours: number) => {
    const until = new Date(Date.now() + hours * 3_600_000);
    await supabase.from("emails").update({ is_snoozed: true, snooze_until: until.toISOString() }).eq("id", email.id);
    setMenu("");
    addToast("success", `Snoozed until ${until.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
    onSnooze?.();
  };

  const track = async () => {
    setBusy(true);
    const first = String(email.recipients || "").split(",")[0]?.trim() || "";
    const { error } = await supabase.from("follow_up_reminders").upsert(
      {
        user_id: user.id,
        email_id: email.id,
        thread_id: email.thread_id || email.id,
        recipient_email: first.match(/<([^>]+)>/)?.[1] || first.replace(/<.*>/, "").trim() || "unknown",
        recipient_name: first.match(/^(.*?)\s*</)?.[1]?.replace(/"/g, "").trim() || null,
        subject: email.subject || "(no subject)",
        remind_at: new Date(remindAt).toISOString(),
        status: "waiting",
      },
      { onConflict: "user_id,thread_id" },
    );
    setBusy(false);
    setMenu("");
    if (error) return addToast("error", "Could not set the reminder.");
    setTracked(true);
    addToast("success", "Reminder set");
  };

  const sort = async (patch: { category?: string; extra_labels?: string[] }) => {
    const next = { ...proc, ...patch };
    setProc(next);
    onRethink?.(next);
    await supabase.from("email_processed").update(patch).eq("email_id", email.id);
  };

  const readAgain = async () => {
    setMenu("");
    setBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch("/api/rethink-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token}` },
        body: JSON.stringify({ email_id: email.id }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setProc(updated);
      onRethink?.(updated);
      addToast("success", "Read again");
    } catch {
      addToast("error", "Could not read it again.");
    }
    setBusy(false);
  };

  const discard = async (draft: any) => {
    await supabase.from("draft_emails").delete().eq("id", draft.id);
    notifyDraftChange();
    mail.reload();
    addToast("info", "Draft discarded", {
      action: {
        label: "Undo",
        onClick: async () => {
          const { id: _id, ...rest } = draft;
          await supabase.from("draft_emails").insert(rest);
          notifyDraftChange();
          mail.reload();
        },
      },
    });
  };

  const showAttachment = async (att: Att, gmailId: string) => {
    setPreview({ att, gmailId, entry: null, error: null });
    try {
      const entry = await fetchAttachment(att, gmailId);
      setPreview((p) => (p?.att === att ? { ...p, entry } : p));
    } catch {
      setPreview((p) => (p?.att === att ? { ...p, error: "Could not load this attachment from Gmail." } : p));
    }
  };

  const download = async (att: Att, gmailId: string) => {
    try {
      const a = document.createElement("a");
      a.href = (await fetchAttachment(att, gmailId)).blobUrl;
      a.download = att.filename;
      a.click();
    } catch {
      addToast("error", "Download failed");
    }
  };

  // Esc goes back (or closes what is open); R replies, E archives, U marks
  // unread. Caught before the list's own handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector("[data-compose-modal]")) return;
      if (e.key === "Escape") {
        if (preview) setPreview(null);
        else if (menu) setMenu("");
        else if (document.querySelector('[aria-modal="true"]')) return;
        else onBack();
        e.stopPropagation();
        return;
      }
      if (preview || document.querySelector('[aria-modal="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === "r") replyTo();
      else if (k === "e") onArchive();
      else if (k === "u") markUnread();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The inline reply below stands for its own outcome line.
  const outcomes: Outcome[] = ids.flatMap((id) => mail.byEmail.get(id) || []).filter((o) => o.state !== "info" && !(reply && (o.act?.kind === "review" || o.act?.kind === "cancel")));
  const multiple = !!email.cc_recipients || String(email.recipients || "").split(",").filter(Boolean).length > 1;
  const extra: string[] = Array.isArray(proc?.extra_labels) ? proc.extra_labels : [];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-canvas">
      <header ref={barRef} className="bar gap-1 pl-3">
        <button className="iconbtn" onClick={onBack} title="Back" aria-label="Back">
          <Icon name="arrow_back" size={16} />
        </button>
        <h1 className="bar-title ml-1 min-w-0 flex-1 truncate" title={email.subject || undefined}>
          {email.subject || "(no subject)"}
        </h1>
        <button className="btn" onClick={replyTo}>
          <Icon name="reply" size={15} className="text-ink3" />
          Reply
        </button>
        <button className="iconbtn" onClick={onArchive} title="Archive" aria-label="Archive">
          <Icon name="archive" size={16} />
        </button>
        <div className="relative">
          <button className="iconbtn" onClick={() => setMenu(menu ? "" : "more")} title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded={!!menu}>
            <Icon name="more" size={16} />
          </button>
          {menu === "more" && (
            <div className="pop absolute right-0 top-8 w-56" role="menu">
              {multiple && (
                <button role="menuitem" className="pop-item" onClick={() => (setMenu(""), openCompose({ ...email, _replyAll: true }))}>
                  Reply all
                </button>
              )}
              <button role="menuitem" className="pop-item" onClick={() => (setMenu(""), openCompose({ ...email, sender_email: "", subject: `Fwd: ${email.subject}` }))}>
                Forward
              </button>
              <button role="menuitem" className="pop-item" onClick={() => (setMenu(""), markUnread())}>
                Mark unread
              </button>
              <button role="menuitem" className="pop-item" onClick={() => setResolved(resolvedAt ? null : new Date().toISOString())}>
                {resolvedAt ? "Not done" : "Done, keep in Inbox"}
              </button>
              <button role="menuitem" className="pop-item" onClick={() => setMenu("snooze")}>
                Snooze
                <Icon name="chevron_right" size={14} className="ml-auto text-ink3" />
              </button>
              {email.thread_id && !tracked && (
                <button role="menuitem" className="pop-item" onClick={() => setMenu("track")}>
                  Remind me if no answer
                </button>
              )}
              <div className="mx-2 my-1 border-t border-line-soft" />
              <button role="menuitem" className="pop-item" onClick={() => setMenu("sort")}>
                Category and labels
                <Icon name="chevron_right" size={14} className="ml-auto text-ink3" />
              </button>
              <button role="menuitem" className="pop-item disabled:opacity-45" disabled={busy} onClick={readAgain}>
                Read again
              </button>
            </div>
          )}
          {menu === "snooze" && (
            <div className="pop absolute right-0 top-8 w-48" role="menu">
              {SNOOZE.map(([label, hours]) => (
                <button key={hours} role="menuitem" className="pop-item" onClick={() => snooze(hours)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {menu === "sort" && (
            <div className="pop absolute right-0 top-8 w-56" role="menu">
              {CATEGORIES.map(([slug, name]) => (
                <button key={slug} role="menuitemradio" aria-checked={proc?.category === slug} className="pop-item" onClick={() => sort({ category: slug })}>
                  <Icon name="check" size={13} className={proc?.category === slug ? "text-ink" : "invisible"} />
                  {name}
                </button>
              ))}
              {labels.length > 0 && <div className="mx-2 my-1 border-t border-line-soft" />}
              {labels.map((l) => {
                const on = extra.includes(l.slug);
                return (
                  <button key={l.slug} role="menuitemcheckbox" aria-checked={on} className="pop-item" onClick={() => sort({ extra_labels: on ? extra.filter((x) => x !== l.slug) : [...extra, l.slug] })}>
                    <Icon name="check" size={13} className={on ? "text-ink" : "invisible"} />
                    <span className="truncate">{l.display_name}</span>
                  </button>
                );
              })}
            </div>
          )}
          {menu === "track" && (
            <div className="pop absolute right-0 top-8 w-72 p-3" role="dialog" aria-label="Reminder">
              <p className="label mb-2">Remind me if no answer by</p>
              <DateTimePicker value={remindAt} onChange={setRemindAt} placeholder="Pick a date and time" />
              <div className="mt-3 flex gap-1.5">
                <button className="btn btn-sm btn-pri" onClick={track} disabled={busy}>
                  Set reminder
                </button>
                <button className="btn btn-sm btn-plain" onClick={() => setMenu("")}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="email-reader-pane min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-5 pb-16 pt-4 md:px-8">
          <OutcomeLines outcomes={outcomes} />
          {(resolvedAt || tracked) && (
            <ul>
              {resolvedAt && (
                <li className="flex h-7 items-center gap-1.5 text-ink2">
                  <Glyph state="done" />
                  <span className="flex-1">Done</span>
                  <button className="link" onClick={() => setResolved(null)}>
                    Undo
                  </button>
                </li>
              )}
              {tracked && (
                <li className="flex h-7 items-center gap-1.5 text-ink2">
                  <Glyph state="info" />
                  <span className="flex-1">Reminder if no answer</span>
                  <button className="link" onClick={() => setView("followups")}>
                    Show
                  </button>
                </li>
              )}
            </ul>
          )}

          {messages === null ? (
            <div className="mt-4" aria-busy="true" aria-label="Loading">
              <div className="skel h-3.5 w-44" />
              <div className="skel mt-2 h-2.5 w-64" />
              <div className="skel mt-7 h-2.5 w-full" />
              <div className="skel mt-2.5 h-2.5 w-11/12" />
              <div className="skel mt-2.5 h-2.5 w-3/5" />
            </div>
          ) : (
            <div className={outcomes.length || resolvedAt || tracked ? "mt-3 border-t border-line-soft pt-2" : ""}>
              {messages.length > 1 && <p className="label mb-1 mt-2">{messages.length} messages</p>}
              {messages.map((m) => {
                const me = !!user.email && String(m.sender_email || "").toLowerCase() === user.email.toLowerCase();
                const name = me ? "You" : nameOf(m.sender, m.sender_email);
                if (!open.has(m.id))
                  return (
                    <button key={m.id} className="row2 -mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-3 !pl-1.5 text-left" onClick={() => toggle(m.id)} aria-expanded={false}>
                      <span className="w-36 flex-none truncate font-medium text-ink">{name}</span>
                      <span className="min-w-0 flex-1 truncate text-ink3">{m.snippet}</span>
                      <time className="flex-none text-xs text-ink3">{shortWhen(m.received_at)}</time>
                    </button>
                  );
                const atts: Att[] = Array.isArray(m.attachments) ? m.attachments : [];
                return (
                  <article key={m.id} className="pb-6 pr-1.5 pt-3">
                    <button className="flex w-full items-baseline gap-2 text-left" onClick={() => messages.length > 1 && toggle(m.id)} aria-expanded>
                      <span className="min-w-0 truncate text-[15px] font-[650] tracking-[-0.01em] text-ink">{name}</span>
                      {!me && <span className="min-w-0 truncate text-xs text-ink3">{m.sender_email}</span>}
                      <span className="flex-1" />
                      <time className="flex-none text-xs text-ink3">{fullWhen(m.received_at)}</time>
                    </button>
                    {(m.recipients || m.cc_recipients) && (
                      <p className="mt-0.5 truncate text-xs text-ink3" title={[m.recipients, m.cc_recipients].filter(Boolean).join(", ")}>
                        To {m.recipients || "you"}
                        {m.cc_recipients ? `, cc ${m.cc_recipients}` : ""}
                      </p>
                    )}
                    {!me && <SuspicionBanner verdict={assessSuspicion(m)} />}
                    <div className="mt-4">
                      <EmailBody email={m} />
                    </div>
                    {atts.length > 0 && (
                      <div className="mt-5 border-t border-line-soft pt-2">
                        {atts.map((att) => (
                          <div key={att.attachment_id} className="-mx-2 flex h-8 items-center gap-2 rounded-md px-2 hover:bg-hover">
                            <Icon name={fileIcon(att.mime_type)} size={14} className="flex-none text-ink3" />
                            <button className="min-w-0 truncate text-left text-ink hover:underline" onClick={() => showAttachment(att, m.gmail_id)}>
                              {att.filename}
                            </button>
                            {att.size > 0 && <span className="flex-none text-xs text-ink3">{fileSize(att.size)}</span>}
                            <span className="flex-1" />
                            <button className="btn btn-plain btn-sm" onClick={() => download(att, m.gmail_id)} aria-label={`Download ${att.filename}`}>
                              Download
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
              {reply && <InlineReply reply={reply} source={messages.find((m) => m.id === (reply.going || reply.draft).email_id) || email} onDiscard={discard} />}
            </div>
          )}
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setPreview(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={preview.att.filename}
            className="flex flex-col overflow-hidden rounded-[12px] bg-raised shadow-pop"
            style={{ width: "min(92vw, 900px)", height: "min(90vh, 700px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-11 flex-none items-center gap-2 border-b border-line-soft pl-4 pr-1.5">
              <p className="min-w-0 flex-1 truncate font-semibold text-ink">{preview.att.filename}</p>
              {preview.att.size > 0 && <span className="flex-none text-xs text-ink3">{fileSize(preview.att.size)}</span>}
              <button className="btn ml-1" onClick={() => download(preview.att, preview.gmailId)}>
                Download
              </button>
              <button className="iconbtn" onClick={() => setPreview(null)} title="Close" aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-side">
              {preview.error ? (
                <p className="text-danger">{preview.error}</p>
              ) : !preview.entry ? (
                <div className="skel h-[70%] w-[70%] rounded-[9px]" aria-busy="true" aria-label="Loading" />
              ) : preview.att.mime_type?.startsWith("image/") ? (
                <img src={preview.entry.blobUrl} alt={preview.att.filename} className="max-h-full max-w-full object-contain p-4" />
              ) : preview.att.mime_type?.includes("pdf") ? (
                <iframe src={preview.entry.blobUrl} title={preview.att.filename} className="h-full w-full border-0" />
              ) : preview.entry.text !== null ? (
                <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed text-ink">{preview.entry.text}</pre>
              ) : (
                <div className="empty">
                  <Icon name="description" size={22} className="text-ink3" />
                  <h3>No preview</h3>
                  <button className="link mt-1.5" onClick={() => download(preview.att, preview.gmailId)}>
                    Download it
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

// Tabellar's reply under the message it answers: a draft with Edit and
// Discard, or one Autopilot is about to send, with Cancel.
function InlineReply({ reply, source, onDiscard }: { reply: { draft?: any; going?: any }; source: any; onDiscard: (draft: any) => void }) {
  const { openCompose, mail, addToast } = useApp();
  const r = reply.going || reply.draft;
  const to = (r.to_addresses || []).join(", ");
  return (
    <section className="inset mt-2" aria-label="Reply">
      <div className="flex items-baseline gap-2">
        <Glyph state={reply.going ? "going" : "need"} className="self-center" />
        <b className="font-medium text-ink">{reply.going ? "Replying in " : "Reply drafted"}</b>
        {reply.going && <Countdown until={reply.going.send_at} className="font-medium text-wax-ink" />}
        <span className="min-w-0 flex-1 truncate text-xs text-ink3">{to && `to ${to}`}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words leading-[1.6] text-ink2">{plain(r.body_html || r.body_text || "")}</p>
      <div className="mt-3 flex gap-1.5">
        {reply.going ? (
          reply.going.action_id && (
            <button className="btn" onClick={() => mail.undo(reply.going.action_id).then(() => addToast("success", "Cancelled. Kept as a draft.")).catch(() => {})}>
              Cancel
            </button>
          )
        ) : (
          <>
            <button className="btn btn-pri" onClick={() => openCompose(source, reply.draft)}>
              Edit and send
            </button>
            <button className="btn btn-plain" onClick={() => onDiscard(reply.draft)}>
              Discard
            </button>
          </>
        )}
      </div>
    </section>
  );
}

// The reader opened from a page that is not the Inbox (Todos, Meetings): it
// loads the email by id and goes back to the page on close, archive or reply.
export function ReaderById({ emailId, onClose }: { emailId: string; onClose: () => void }) {
  const { addToast } = useApp();
  const [email, setEmail] = useState<any | null>(null);
  useEffect(() => {
    createClient()
      .from("emails")
      .select("*, email_processed(*)")
      .eq("id", emailId)
      .single()
      .then(({ data }: { data: any }) => {
        if (data) setEmail(data);
        else {
          addToast("error", "That email is no longer in Tabellar.");
          onClose();
        }
      });
  }, [emailId]);
  if (!email) return null;
  const flag = (archived: boolean) => {
    onClose();
    setMailState([email.id], archived ? { archived: true } : { read: false })
      .then(() => archived && addToast("success", "Archived", { action: { label: "Undo", onClick: () => void setMailState([email.id], { archived: false }) } }))
      .catch((e: Error) => addToast("error", `Could not ${archived ? "archive" : "mark it unread"}: ${e.message}`));
  };
  return (
    <EmailDetail
      email={email}
      onBack={onClose}
      onArchive={() => flag(true)}
      onReply={onClose}
      onMarkUnread={() => flag(false)}
      onSnooze={onClose}
      onRethink={(updated: any) => setEmail((prev: any) => (prev ? { ...prev, email_processed: updated } : prev))}
    />
  );
}
