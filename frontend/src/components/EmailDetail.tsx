import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { api, setMailState, type Outcome } from "@/lib/outcomes";
import { assessSuspicion, type SuspicionVerdict } from "@/lib/suspicion";
import { useApp } from "./AppShell";
import DateTimePicker from "./DateTimePicker";
import EmailBody from "./EmailBody";
import FilePreview from "./FilePreview";
import { SnoozeMenu, useSnooze } from "./Snooze";
import { FILE_ICON, fetchAttachment, fileKind, fileSize, saveAttachment, type Att } from "@/lib/attachments";
import { Countdown, Glyph, OutcomeLines, shortWhen } from "./ui";

// The reader: one column at a readable measure. The thread shows its latest
// message in full and each earlier one as a line; Tabellar's reply, drafted or
// on its way out, sits under it. One action row: Reply, Archive, more.

/* eslint-disable @typescript-eslint/no-explicit-any */

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

const MESSAGE_FIELDS =
  "id, gmail_id, thread_id, account_id, subject, sender, sender_email, recipients, cc_recipients, received_at, body_html, body_text, snippet, label_ids, has_attachments, attachments, reply_to_email";

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
  const { user, openCompose, addToast, pushUndo, setView, mail, liveChanges, draftVersion, notifyDraftChange, accounts } = useApp();
  const snoozeMail = useSnooze();
  const supabase = createClient();
  const [proc, setProc] = useState<any>(Array.isArray(email.email_processed) ? email.email_processed[0] : email.email_processed);
  const [messages, setMessages] = useState<any[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [unfolded, setUnfolded] = useState(false);
  const [menu, setMenu] = useState<"" | "more" | "sort" | "track">("");
  const [snoozeAt, setSnoozeAt] = useState<DOMRect | null>(null);
  const snoozeButton = useRef<HTMLButtonElement>(null);
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
  const [preview, setPreview] = useState<{ att: Att; gmailId: string } | null>(null);

  // The thread, oldest first; only the latest message opens.
  useEffect(() => {
    let live = true;
    const q = supabase.from("emails").select(MESSAGE_FIELDS).eq("user_id", user.id);
    (email.thread_id ? q.eq("thread_id", email.thread_id) : q.eq("id", email.id))
      .order("received_at", { ascending: false })
      .limit(100)
      .then(({ data }: { data: any[] | null }) => {
        if (!live) return;
        const list = data?.length ? data.reverse() : [email];
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
    supabase.from("categories").select("slug, display_name").eq("user_id", user.id).order("position", { ascending: true }).then(({ data }: { data: any[] | null }) => setLabels(data || []));
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
      return addToast("error", "Could not mark it unread in the mailbox.");
    }
    addToast("info", "Marked unread", { action: { label: "Undo", onClick: () => setMailState([email.id], { read: true }) } });
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
    pushUndo(next ? "Done" : "Not done", async () => {
      await supabase.from("emails").update({ resolved_at: before }).eq("id", email.id);
      setResolvedAt(before);
      onResolvedChange?.(email.id, before);
    });
  };

  const track = async () => {
    setBusy(true);
    // Who owes the answer: the sender of an email received, who one sent went to.
    const sent = (email.label_ids || []).includes("SENT");
    const first = sent ? String(email.recipients || "").split(",")[0]?.trim() || "" : email.sender || email.sender_email || "";
    const { error } = await supabase.from("follow_up_reminders").upsert(
      {
        user_id: user.id,
        email_id: email.id,
        thread_id: email.thread_id || email.id,
        recipient_email: first.match(/<([^>]+)>/)?.[1] || first.replace(/<.*>/, "").trim() || "unknown",
        recipient_name: first.match(/^(.*?)\s*</)?.[1]?.replace(/"/g, "").trim() || null,
        subject: email.subject || "(no subject)",
        remind_at: new Date(remindAt).toISOString(),
        created_at: new Date().toISOString(),
        status: "waiting",
      },
      { onConflict: "user_id,thread_id" },
    );
    setBusy(false);
    setMenu("");
    if (error) return addToast("error", "Could not set the reminder.");
    setTracked(true);
    addToast("success", "Reminder set", {
      action: {
        label: "Undo",
        onClick: async () => {
          await supabase.from("follow_up_reminders").delete().eq("user_id", user.id).eq("thread_id", email.thread_id || email.id);
          setTracked(false);
        },
      },
    });
  };

  const sort = async (category: string, byHand = true) => {
    const before = proc?.category;
    const next = { ...proc, category };
    setProc(next);
    onRethink?.(next);
    await supabase.from("email_processed").update({ category }).eq("email_id", email.id);
    if (byHand && before && before !== category) pushUndo(`Sorted as ${CATEGORIES.find(([slug]) => slug === category)?.[1] ?? category}`, () => sort(before, false));
  };

  // In or out of one of the user's labels: in Gmail too, and kept as an example.
  const label = async (slug: string, on: boolean, byHand = true) => {
    const before = proc;
    const extraNow: string[] = Array.isArray(proc?.extra_labels) ? proc.extra_labels : [];
    const next = { ...proc, extra_labels: on ? [...extraNow, slug] : extraNow.filter((x) => x !== slug) };
    setProc(next);
    onRethink?.(next);
    try {
      await api("/labels/apply", { email_id: email.id, slug, on });
      const name = labels.find((l) => l.slug === slug)?.display_name ?? slug;
      if (byHand) pushUndo(on ? `Labelled ${name}` : `Label ${name} taken off`, () => label(slug, !on, false));
    } catch (e) {
      setProc(before);
      onRethink?.(before);
      addToast("error", (e as Error).message);
    }
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
    try {
      await api("/drafts/discard", { ids: [draft.id] });
    } catch (e) {
      return addToast("error", (e as Error).message);
    }
    notifyDraftChange();
    mail.reload();
    addToast("info", "Draft discarded", {
      action: {
        label: "Undo",
        onClick: async () => {
          const { id: _id, gmail_draft_id: _gone, ...rest } = draft;
          await supabase.from("draft_emails").insert(rest);
          notifyDraftChange();
          mail.reload();
        },
      },
    });
  };

  const download = (att: Att, gmailId: string) => saveAttachment(att, gmailId).catch(() => addToast("error", "Download failed"));
  const openSnooze = () => {
    setMenu("");
    setSnoozeAt(snoozeButton.current?.getBoundingClientRect() ?? null);
  };
  const forward = () => {
    setMenu("");
    openCompose({ ...email, _forward: true });
  };
  const vip = mail.isVip(email.sender_email);
  const toggleVip = () => {
    setMenu("");
    const who = nameOf(email.sender, email.sender_email);
    mail
      .setVip(email.sender_email, !vip, who)
      .then(() => addToast("success", vip ? `${who} is not most important` : `${who} is most important`))
      .catch((e: Error) => addToast("error", e.message));
  };

  // Esc goes back (or closes what is open); R replies, E archives, S snoozes,
  // F forwards, V marks the sender, U marks unread. Caught before the list's
  // own handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector("[data-compose-modal]") || document.querySelector("[data-key-menu]")) return;
      if (e.key === "Escape") {
        if (menu) setMenu("");
        else if (document.querySelector('[aria-modal="true"]')) return;
        else onBack();
        e.stopPropagation();
        return;
      }
      if (preview || document.querySelector('[aria-modal="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === "r") replyTo();
      else if (k === "e") onArchive();
      else if (k === "s") openSnooze();
      else if (k === "f") forward();
      else if (k === "v") toggleVip();
      else if (k === "u") markUnread();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const folded = !unfolded && (messages?.length ?? 0) > 8;
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
        <button ref={snoozeButton} className="iconbtn" onClick={openSnooze} title="Snooze (S)" aria-label="Snooze" aria-haspopup="menu" aria-expanded={!!snoozeAt}>
          <Icon name="snooze" size={16} />
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
              <button role="menuitem" className="pop-item" onClick={forward}>
                Forward
              </button>
              <button role="menuitem" className="pop-item" onClick={() => (setMenu(""), markUnread())}>
                Mark unread
              </button>
              <button role="menuitem" className="pop-item" onClick={() => setResolved(resolvedAt ? null : new Date().toISOString())}>
                {resolvedAt ? "Not done" : "Done, keep in Inbox"}
              </button>
              {email.thread_id && !tracked && (
                <button role="menuitem" className="pop-item" onClick={() => setMenu("track")}>
                  Remind me if no answer
                </button>
              )}
              <div className="mx-2 my-1 border-t border-line-soft" />
              <button role="menuitemcheckbox" aria-checked={vip} className="pop-item" onClick={toggleVip}>
                {vip ? "Sender is not most important" : "Sender is most important"}
              </button>
              <button role="menuitem" className="pop-item" onClick={() => setMenu("sort")}>
                Category and labels
                <Icon name="chevron_right" size={14} className="ml-auto text-ink3" />
              </button>
              <button role="menuitem" className="pop-item disabled:opacity-45" disabled={busy} onClick={readAgain}>
                Read again
              </button>
            </div>
          )}
          {menu === "sort" && (
            <div className="pop absolute right-0 top-8 w-56" role="menu">
              {CATEGORIES.map(([slug, name]) => (
                <button key={slug} role="menuitemradio" aria-checked={proc?.category === slug} className="pop-item" onClick={() => sort(slug)}>
                  <Icon name="check" size={13} className={proc?.category === slug ? "text-ink" : "invisible"} />
                  {name}
                </button>
              ))}
              {labels.length > 0 && <div className="mx-2 my-1 border-t border-line-soft" />}
              {labels.map((l) => {
                const on = extra.includes(l.slug);
                return (
                  <button key={l.slug} role="menuitemcheckbox" aria-checked={on} className="pop-item" onClick={() => label(l.slug, !on)}>
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
                <li className="flex h-item items-center gap-1.5 text-ink2">
                  <Glyph state="done" />
                  <span className="flex-1">Done</span>
                  <button className="link" onClick={() => setResolved(null)}>
                    Undo
                  </button>
                </li>
              )}
              {tracked && (
                <li className="flex h-item items-center gap-1.5 text-ink2">
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
              {messages.map((m, i) => {
                // A long thread folds its middle: the first message, then the last three.
                if (folded && i > 0 && i < messages.length - 3) {
                  return i > 1 ? null : (
                    <button key="fold" className="row2 -mx-1.5 w-[calc(100%+0.75rem)] !pl-1.5 text-left text-ink3 hover:text-ink" onClick={() => setUnfolded(true)}>
                      {messages.length - 4} more messages
                    </button>
                  );
                }
                const me = (m.label_ids || []).includes("SENT") || accounts.mine.has(String(m.sender_email || "").toLowerCase()) || (!!user.email && String(m.sender_email || "").toLowerCase() === user.email.toLowerCase());
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
                          <div key={att.attachment_id} className="-mx-2 flex h-row items-center gap-2 rounded-md px-2 hover:bg-hover">
                            <Icon name={FILE_ICON[fileKind(att)]} size={14} className="flex-none text-ink3" />
                            <button className="min-w-0 truncate text-left text-ink hover:underline" onClick={() => setPreview({ att, gmailId: m.gmail_id })}>
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

      {preview && <FilePreview att={preview.att} gmailId={preview.gmailId} onClose={() => setPreview(null)} />}
      {snoozeAt && (
        <SnoozeMenu
          anchor={snoozeAt}
          onPick={async (until) => {
            setSnoozeAt(null);
            if (await snoozeMail(ids, until)) onSnooze?.();
          }}
          onClose={() => setSnoozeAt(null)}
        />
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
