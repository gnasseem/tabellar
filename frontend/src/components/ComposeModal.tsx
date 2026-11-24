import { forwardRef, useImperativeHandle, useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "./AppShell";
import { api } from "@/lib/outcomes";
import { replyFrom } from "@/lib/accounts";
import { FILE_ICON, fileKind, type Att } from "@/lib/attachments";
import { EmailField, useContacts } from "./EmailAutocomplete";
import DateTimePicker from "./DateTimePicker";
import { Tick } from "./ui";

// Gmail rejects messages over 25 MB once encoded. Attachments go out base64
// encoded (~4 bytes per 3 bytes of input), so cap the raw total below that to
// leave room for the encoding overhead, headers, and the body itself.
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

// Registers offered by the Tone control. The prompt fragment completes the
// sentence "Rewrite this so it reads ...".
const TONES = [
  {
    id: "formal",
    label: "Formal",
    prompt:
      "more formal and professional: complete sentences, no contractions, no slang, a courteous opening and closing",
  },
  {
    id: "friendly",
    label: "Friendly",
    prompt:
      "warmer and more personable, as if writing to a colleague you like, while staying professional",
  },
  {
    id: "direct",
    label: "Direct",
    prompt:
      "more direct and concise: lead with the ask, cut hedging and filler, keep it brief",
  },
  {
    id: "apologetic",
    label: "Apologetic",
    prompt:
      "apologetic and accommodating, acknowledging the inconvenience without grovelling or over-explaining",
  },
  {
    id: "firm",
    label: "Firm",
    prompt:
      "firmer and more assertive: state the position plainly and hold it, while staying polite and professional",
  },
] as const;

type ComposeProps = {
  onClose: () => void;
  onMinimize: () => void;
  minimized?: boolean; // still there, with everything typed, only not shown
  replyTo?: any;
  draft?: any;
};

// close: as the X does, keeping what was written. keep: the same, when
// another message takes the window.
export type ComposeHandle = { close: () => void; keep: () => void };

interface Template {
  id: string;
  name: string;
  subject: string | null;
  body_html: string;
}

function getNow(): { date: string; time: string } {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const h = String(now.getHours()).padStart(2, "0");
  const m = now.getMinutes() < 30 ? "00" : "30";
  return { date, time: `${h}:${m}` };
}

type WorkingHours = { start?: string; end?: string; days?: number[] } | null;

function getNextWorkingSlot(wh: WorkingHours): Date {
  const now = new Date();
  const days = wh?.days || [1, 2, 3, 4, 5];
  const [startH, startM] = (wh?.start || "09:00").split(":").map(Number);
  for (let d = 0; d <= 7; d++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + d);
    candidate.setHours(startH, startM, 0, 0);
    if (!days.includes(candidate.getDay())) continue;
    if (candidate > now) return candidate;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow;
}

function isOutsideWorkingHours(isoStr: string, wh: WorkingHours): boolean {
  if (!isoStr || !wh) return false;
  const d = new Date(isoStr);
  const days = wh.days || [1, 2, 3, 4, 5];
  if (!days.includes(d.getDay())) return true;
  const [startH, startM] = (wh.start || "09:00").split(":").map(Number);
  const [endH, endM] = (wh.end || "17:00").split(":").map(Number);
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins < startH * 60 + startM || mins >= endH * 60 + endM;
}

// The signature under a message, marked so a draft opened again can tell it
// from the text.
const SIGNATURE = '<div data-tabellar-sig="1" style="margin-top:16px;padding-top:12px;border-top:1px solid #e4e0da;">';

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// What is typed is text; this is what goes out of it.
const textHtml = (text: string) => escapeHtml(text).replace(/\n/g, "<br>");

// A saved draft's HTML as the text the editor holds; sending turns it back.
function draftText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>\s*/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ComposeModal = forwardRef<ComposeHandle, ComposeProps>(function ComposeModal({ onClose, onMinimize, minimized, replyTo, draft }, handle) {
  const {
    user,
    profile,
    openCompose,
    addToast,
    notifyDraftChange,
    notifySent,
    accounts,
    mail,
  } = useApp();
  const supabase = createClient();
  const draftId = useRef(draft?.id ?? crypto.randomUUID());
  // An email handed on: it goes out below the note, with its attachments. A
  // saved draft of one carries it.
  const forwardId: string | null = draft?.forward?.email_id ?? (replyTo?._forward ? replyTo.id : null);
  const [forwarded, setForwarded] = useState<{ id: string; subject: string; sender: string; body_text: string | null; snippet: string | null; received_at: string; attachments: Att[] } | null>(null);
  const [without, setWithout] = useState<string[]>(draft?.forward?.without ?? []);
  const [readReceipt, setReadReceipt] = useState<boolean>(!!draft?.read_receipt);
  useEffect(() => {
    if (!forwardId) return;
    supabase
      .from("emails")
      .select("id, subject, sender, body_text, snippet, received_at, attachments")
      .eq("id", forwardId)
      .maybeSingle()
      .then(({ data }: { data: any }) => setForwarded(data));
  }, [forwardId]);
  const forward = forwardId ? { email_id: forwardId, without } : null;
  // Helper: extract bare email addresses from a comma-separated RFC 2822 string,
  // excluding the user's own addresses.
  const extractReplyAddresses = (
    raw: string,
    exclude: Set<string>,
  ): string[] => {
    return (raw || "")
      .split(",")
      .map((s) => {
        const trimmed = s.trim();
        const angleMatch = trimmed.match(/^.*?<([^>]+)>\s*$/);
        const addr = angleMatch
          ? angleMatch[1].trim().toLowerCase()
          : trimmed.toLowerCase();
        return addr;
      })
      .filter((e) => e.includes("@") && !exclude.has(e));
  };

  // Every address of every account, and the aliases each sends as.
  const mine = new Set([...accounts.mine, (profile?.email || user?.email || "").toLowerCase()]);

  const [to, setTo] = useState(() => {
    if (draft) return (draft.to_addresses || []).join(", ");
    if (replyTo?._replyAll) {
      const addrs = new Set<string>();
      if (replyTo.reply_to_email || replyTo.sender_email) {
        const raw = (replyTo.reply_to_email || replyTo.sender_email).trim();
        const angleMatch = raw.match(/^.*?<([^>]+)>\s*$/);
        const addr = (angleMatch ? angleMatch[1] : raw).toLowerCase();
        if (addr.includes("@") && !mine.has(addr)) addrs.add(addr);
      }
      for (const addr of extractReplyAddresses(
        replyTo.recipients || "",
        mine,
      ))
        addrs.add(addr);
      return Array.from(addrs).join(", ");
    }
    return replyTo?._forward ? "" : replyTo?.reply_to_email || replyTo?.sender_email || "";
  });
  const [cc, setCc] = useState(() => {
    if (draft?.cc_addresses?.length)
      return (draft.cc_addresses as string[]).join(", ");
    if (replyTo?._replyAll && replyTo.cc_recipients) {
      return extractReplyAddresses(replyTo.cc_recipients, mine).join(", ");
    }
    return "";
  });
  const [bcc, setBcc] = useState(() =>
    draft?.bcc_addresses?.length
      ? (draft.bcc_addresses as string[]).join(", ")
      : "",
  );
  const [showCcBcc, setShowCcBcc] = useState(
    !!(
      draft?.cc_addresses?.length ||
      draft?.bcc_addresses?.length ||
      (replyTo?._replyAll && replyTo?.cc_recipients)
    ),
  );
  const [subject, setSubject] = useState(
    draft
      ? draft.subject || ""
      : replyTo?._forward
        ? /^(fwd?|wg|tr):/i.test(replyTo.subject || "")
          ? replyTo.subject
          : `Fwd: ${replyTo.subject || ""}`
      : replyTo
        ? /^Re:/i.test(replyTo.subject || "")
          ? replyTo.subject
          : `Re: ${replyTo.subject}`
        : "",
  );
  const [body, setBody] = useState<string>(
    draft
      ? draftText((draft.body_html || "").split(SIGNATURE)[0])
      : replyTo?._autoGenerate
        ? ""
        : replyTo?._prefillBody || "",
  );
  // The last text Tabellar wrote here: what the user changes in it before
  // sending teaches their way of writing (server/writing.ts).
  const drafted = useRef<string>(draft?.source === "tabellar" ? draftText((draft.body_html || "").split(SIGNATURE)[0]) : "");
  const [sending, setSending] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(draft?.send_at || "");

  const [templates, setTemplates] = useState<Template[]>([]);
  const [saveTemplateName, setSaveTemplateName] = useState("");

  const [showMeetingPanel, setShowMeetingPanel] = useState(false);

  // The footer menu that is open, if any: Rewrite, Send later or Templates.
  const [menu, setMenu] = useState<"" | "rewrite" | "later" | "more" | "templates">("");
  const footerRef = useRef<HTMLDivElement>(null);

  // Convert ISO scheduleAt to datetime-local format for the picker, and back
  function isoToDatetimeLocal(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function datetimeLocalToIso(dtl: string): string {
    if (!dtl) return "";
    const [datePart, timePart] = dtl.split("T");
    const [y, mo, d] = datePart.split("-").map(Number);
    const [h, mi] = timePart.split(":").map(Number);
    return new Date(y, mo - 1, d, h, mi).toISOString();
  }

  // Draft written by Tabellar
  const [generatingDraft, setGeneratingDraft] = useState(
    !!replyTo?._autoGenerate,
  );
  const [aiGenerated, setAiGenerated] = useState(false);
  const [showRefinePanel, setShowRefinePanel] = useState(false);
  const [refineFeedback, setRefineFeedback] = useState("");
  const [keepFeedback, setKeepFeedback] = useState(false);
  const [refining, setRefining] = useState(false);
  const [rephrasingTone, setRephrasingTone] = useState<string | null>(null);

  // Context-aware knowledge entries for current recipient
  const [recipientKnowledge, setRecipientKnowledge] = useState<
    { entity: string; entity_type: string; info: string }[]
  >([]);
  useEffect(() => {
    const primaryTo = to.split(",")[0]?.trim();
    if (!primaryTo || !primaryTo.includes("@")) {
      setRecipientKnowledge([]);
      return;
    }
    const domain = primaryTo.split("@")[1] ?? "";
    const firstName = primaryTo.split("@")[0].replace(/[^a-z]/gi, "") ?? "";
    const filters: string[] = [];
    if (firstName.length > 2)
      filters.push(`entity.ilike.%${firstName}%`, `info.ilike.%${firstName}%`);
    if (domain.length > 3)
      filters.push(`entity.ilike.%${domain}%`, `info.ilike.%${domain}%`);
    if (filters.length === 0) {
      setRecipientKnowledge([]);
      return;
    }
    supabase
      .from("knowledge_base")
      .select("entity, entity_type, info")
      .eq("user_id", user.id)
      .or(filters.join(","))
      .limit(5)
      .then(({ data }) => setRecipientKnowledge(data ?? []));
  }, [to, user.id]);

  // Attachments
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;

    // Gmail caps a message at 25 MB after encoding, and attachments are sent
    // base64 encoded, which inflates them by roughly a third. Check the raw
    // total against that budget here: without this the whole message is
    // encoded and uploaded before Gmail rejects it, which reads as a hang.
    const used = attachments.reduce((sum, f) => sum + f.size, 0);
    const accepted: File[] = [];
    const rejected: string[] = [];
    let total = used;
    for (const file of files) {
      if (total + file.size > MAX_ATTACHMENT_BYTES) {
        rejected.push(file.name);
        continue;
      }
      total += file.size;
      accepted.push(file);
    }
    if (rejected.length > 0) {
      addToast(
        "error",
        rejected.length === 1
          ? `"${rejected[0]}" would push this email past the ${formatFileSize(MAX_ATTACHMENT_BYTES)} attachment limit`
          : `${rejected.length} files would push this email past the ${formatFileSize(MAX_ATTACHMENT_BYTES)} attachment limit`,
      );
    }
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Meeting scheduler state (title & attendees derived from subject & to)
  const { date: nowDate, time: nowTime } = getNow();
  // meetingDatetime = "YYYY-MM-DDTHH:MM"
  const [meetingDatetime, setMeetingDatetime] = useState(
    `${nowDate}T${nowTime}`,
  );
  const meetingDate = meetingDatetime.split("T")[0] || nowDate;
  const meetingTime = meetingDatetime.split("T")[1] || nowTime;
  const [meetingDuration, setMeetingDuration] = useState("");
  const [meetingLocation, setMeetingLocation] = useState("");

  // From: an account and one of the addresses it sends as. A draft keeps its
  // own; a reply goes from the address the email was sent to; new mail from
  // the account the sidebar shows, else the default account.
  const initialFrom = (): { accountId: string; address: string } => {
    if (draft?.account_id && accounts.byId.has(draft.account_id)) {
      const a = accounts.byId.get(draft.account_id)!;
      return { accountId: a.id, address: a.from.some((f) => f.address === draft.from_address) ? draft.from_address : a.default_from };
    }
    const own = accounts.byId.get(replyTo?.account_id || "");
    if (own) return { accountId: own.id, address: replyFrom(own, replyTo) };
    const a = accounts.byId.get(accounts.only) ?? accounts.list.find((x) => x.is_default) ?? accounts.list[0];
    return a ? { accountId: a.id, address: a.default_from } : { accountId: "", address: "" };
  };
  const [from, setFrom] = useState(initialFrom);
  // The accounts arrive after the window opens only on a cold start.
  useEffect(() => {
    if (!from.accountId && accounts.list.length) setFrom(initialFrom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.list]);
  const selectedAccountId = from.accountId;
  const fromChoices = accounts.list.flatMap((a) => a.from.map((f) => ({ accountId: a.id, account: a.address, ...f })));
  const { contacts, addContacts, primaryAccountId } = useContacts(user.id);

  // Signatures
  const [allSignatures, setAllSignatures] = useState<
    {
      id: string;
      name: string;
      html: string;
      is_default: boolean;
      account_id: string | null;
    }[]
  >([]);
  const [appliedSignatureId, setAppliedSignatureId] = useState<string | null>(
    null,
  );
  // Kept apart from the text, shown under it, and added when it goes out.
  const [signature, setSignature] = useState<string>(() => {
    const at = (draft?.body_html || "").indexOf(SIGNATURE);
    return at < 0 ? "" : draft.body_html.slice(at + SIGNATURE.length).replace(/<\/div>$/, "");
  });
  const getDefaultSignatureForAccount = (
    accountId: string,
    sigs: typeof allSignatures,
  ) => {
    // First try exact account match, then fall back to global (null account), then first default
    return (
      sigs.find((s) => s.is_default && s.account_id === accountId) ??
      sigs.find((s) => s.is_default && !s.account_id) ??
      null
    );
  };

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("email_templates")
        .select("id, name, subject, body_html")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (data) setTemplates(data);
    })();
    // Load signatures (only for new emails, not replies/drafts)
    if (!replyTo && !draft) {
      (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) return;
        try {
          const res = await fetch(
            `/api/signatures`,
            {
              headers: { Authorization: `Bearer ${session.access_token}` },
            },
          );
          const json = await res.json();
          const sigs = json.signatures ?? [];
          setAllSignatures(sigs);
        } catch {
          /* non-critical */
        }
      })();
    }
  }, [user.id]);

  // Apply default signature when account or signatures change (new compose only)
  useEffect(() => {
    if (replyTo || draft || allSignatures.length === 0) return;
    const effectiveAccountId = selectedAccountId;
    const sig = getDefaultSignatureForAccount(
      effectiveAccountId,
      allSignatures,
    );
    if ((sig?.id ?? null) === appliedSignatureId) return;
    setSignature(sig?.html ?? "");
    setAppliedSignatureId(sig?.id ?? null);
  }, [selectedAccountId, allSignatures]);

  const applyTemplate = (t: Template) => {
    const newSubject = t.subject || t.name;
    if (newSubject) setSubject(newSubject);
    setBody(/<(p|br|div|span|a|ul|b|i)\b/i.test(t.body_html) ? draftText(t.body_html) : t.body_html);
    setMenu("");
  };

  const saveAsTemplate = async () => {
    const name = saveTemplateName.trim();
    if (!name || !body) return;
    const { data } = await supabase
      .from("email_templates")
      .insert({ user_id: user.id, name, subject, body_html: body })
      .select("id, name, subject, body_html");
    if (data?.[0]) setTemplates((prev) => [data[0], ...prev]);
    setSaveTemplateName("");
  };

  const deleteTemplate = async (id: string) => {
    await supabase.from("email_templates").delete().eq("id", id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  };

  // A forward's note needs no words from the user. One drafted on its own
  // (`quiet`) never replaces what they have started to write.
  const generateDraft = async (intentOverride?: string, quiet = false) => {
    const intent = intentOverride ?? body;
    if (!intent.trim() && !forwarded) {
      addToast("error", "Write a few words on what to say first");
      return;
    }
    setGeneratingDraft(true);

    try {
      const data = await api("/draft-email", {
        intent,
        subject,
        to,
        senderName: profile?.display_name || "",
        forward: forwarded ? { subject: forwarded.subject, from: forwarded.sender, body: forwarded.body_text || forwarded.snippet } : undefined,
        replyTo: replyTo && !forwardId ? { subject: replyTo.subject, body: replyTo.body_text?.slice(0, 1000) } : undefined,
      });
      if (quiet && bodyNow.current.trim()) {
        // The user wrote their own meanwhile.
      } else if (data.draft) {
        setBody(data.draft);
        drafted.current = data.draft;
        setAiGenerated(true);
        setShowRefinePanel(false);
        setRefineFeedback("");
      } else if (!quiet) {
        addToast("error", "The draft came back empty. Try again.");
      }
    } catch (e) {
      if (!quiet) addToast("error", (e as Error).message);
    }
    setGeneratingDraft(false);
  };

  // The note on a forwarded email, drafted once it has someone to go to.
  const bodyNow = useRef(body);
  bodyNow.current = body;
  const noted = useRef(false);
  const firstTo = to.split(",")[0].trim();
  useEffect(() => {
    if (!forwarded || draft || noted.current || body.trim() || !mail.engine?.model || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(firstTo)) return;
    const timer = setTimeout(() => {
      noted.current = true;
      generateDraft("", true);
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forwarded, firstTo, body, mail.engine?.model]);

  const refineWithFeedback = async () => {
    if (!refineFeedback.trim() || !body) return;
    setRefining(true);
    try {
      const data = await api("/refine-draft", { currentDraft: body, feedback: refineFeedback.trim(), keep: keepFeedback, to });
      if (data.draft) {
        setBody(data.draft);
        drafted.current = data.draft;
        setAiGenerated(true);
        setShowRefinePanel(false);
        setRefineFeedback("");
        setKeepFeedback(false);
        addToast("success", data.kept ? "Changed, and kept as a writing rule" : "Changed");
      } else {
        addToast("error", "The draft came back empty. Try again.");
      }
    } catch (e) {
      addToast("error", (e as Error).message);
    }
    setRefining(false);
  };

  // Close the open footer menu on a click outside the footer, or on Escape
  useEffect(() => {
    if (!menu) return;
    const outside = (e: MouseEvent) => {
      if (footerRef.current && !footerRef.current.contains(e.target as Node)) setMenu("");
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu("");
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  // Rewrite the current body in a different register, this once.
  const rephraseInTone = async (tone: (typeof TONES)[number]) => {
    const current = body.trim();
    if (!current || rephrasingTone) return;
    setMenu("");
    setRephrasingTone(tone.id);
    const previousBody = body;

    const restore = () => {
      setBody(previousBody);
      addToast("info", "Reverted to the previous wording");
    };

    try {
      const data = await api("/refine-draft", {
        currentDraft: current,
        feedback: `Rewrite this so it reads ${tone.prompt}. Preserve every fact, name, date, question and commitment exactly, and keep roughly the same length. Return only the rewritten message.`,
        to,
      });
      const rewritten = data.draft?.trim();
      if (!rewritten) {
        addToast("error", "Could not rephrase this draft");
        setRephrasingTone(null);
        return;
      }

      setBody(rewritten);
      drafted.current = rewritten;
      setAiGenerated(true);
      addToast("success", `Rewritten to sound ${tone.label.toLowerCase()}`, {
        action: { label: "Undo", onClick: restore },
      });
    } catch (e) {
      addToast("error", (e as Error).message);
    }
    setRephrasingTone(null);
  };

  // Auto-generate when opened via quick reply  -  body stays empty so the user
  // never sees the raw prompt; intent is passed directly to generateDraft.
  const hasAutoTriggered = useRef(false);
  useEffect(() => {
    if (replyTo?._autoGenerate && !hasAutoTriggered.current) {
      hasAutoTriggered.current = true;
      generateDraft(replyTo._prefillBody || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The message this one answers: a forward starts a conversation of its own.
  const answers = forward ? null : replyTo;

  // Whether there is anything here that was not here when it opened.
  const snapshot = JSON.stringify([to, cc, bcc, subject, body, attachments.length, without]);
  const started = useRef(snapshot);
  const changed = snapshot !== started.current && !!(body.trim() || (to.trim() && subject.trim()) || attachments.length);
  useEffect(() => {
    if (!changed) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed]);

  const outgoing = (text: string) => textHtml(text) + (signature ? `${SIGNATURE}${signature}</div>` : "");
  const split = (v: string) => v.split(",").map((x: string) => x.trim()).filter(Boolean);

  // Kept here and in that mailbox's Drafts, From the address chosen.
  const saveDraft = async () => {
    try {
      const id = draft?._scheduledId ? crypto.randomUUID() : draftId.current;
      const { inGmail } = await api("/drafts/save", {
        id,
        account_id: from.accountId || undefined,
        from_address: from.address || undefined,
        to: split(to),
        cc: split(cc),
        bcc: split(bcc),
        subject,
        body_html: outgoing(body),
        email_id: draft?.email_id ?? (forward ? null : (replyTo?.id ?? null)),
        in_reply_to: answers?.gmail_id ?? draft?.in_reply_to,
        thread_id: answers?.thread_id ?? draft?.thread_id,
        forward,
        read_receipt: readReceipt,
      });
      // Scheduled before, a draft now: it no longer goes out.
      if (draft?._scheduledId) await supabase.from("scheduled_emails").update({ status: "cancelled" }).eq("id", draft._scheduledId).in("status", ["pending", "failed"]);
      notifyDraftChange();
      const files = attachments.length ? ` Attach ${attachments.length === 1 ? `"${attachments[0].name}"` : `the ${attachments.length} files`} again before sending.` : "";
      addToast(inGmail && !files ? "success" : "info", (inGmail ? "Draft saved." : "Draft saved here. The mailbox could not be reached, so it is not in its Drafts.") + files);
      onClose();
    } catch (e) {
      addToast("error", `Could not save the draft. ${(e as Error).message}`);
    }
  };

  // The row a message is kept as when it comes back.
  const asDraft = () => ({
    user_id: user.id,
    account_id: from.accountId || null,
    from_address: from.address || null,
    to_addresses: split(to),
    cc_addresses: split(cc),
    bcc_addresses: split(bcc),
    subject,
    body_html: outgoing(body),
    email_id: draft?.email_id ?? (forward ? null : (replyTo?.id ?? null)),
    source: draft?.source ?? null,
    forward,
    read_receipt: readReceipt,
  });

  // The X keeps what was written; the bin does not, with Undo.
  const close = () => {
    if (!changed) return onClose();
    if (draft?._scheduledId) return discard();
    void saveDraft();
  };
  const discard = async () => {
    const saved = draft?.id && !draft._scheduledId ? draft : null;
    if (!saved && !changed) return onClose();
    const row = saved ? { ...asDraft(), id: saved.id } : asDraft();
    if (saved) {
      try {
        await api("/drafts/discard", { ids: [saved.id] });
      } catch (e) {
        return addToast("error", (e as Error).message);
      }
      notifyDraftChange();
      mail.reload();
    }
    onClose();
    addToast("info", draft?._scheduledId ? "Changes not kept" : saved ? "Draft discarded" : "Discarded", {
      action: {
        label: "Undo",
        onClick: async () => {
          if (saved) {
            await supabase.from("draft_emails").insert(row);
            notifyDraftChange();
            mail.reload();
          }
          openCompose(replyTo, draft?._scheduledId ? { ...draft, ...row, id: draft.id } : row);
        },
      },
    });
  };
  useImperativeHandle(handle, () => ({ close, keep: () => void (changed && !draft?._scheduledId && saveDraft()) }));

  const meetingOn = showMeetingPanel && !!meetingDate && !!meetingTime && Number(meetingDuration) > 0;
  const meetingTimes = () => {
    const [yr, mo, dy] = meetingDate.split("-").map(Number);
    const [hr, mn] = meetingTime.split(":").map(Number);
    const start = new Date(yr, mo - 1, dy, hr, mn);
    return { start, end: new Date(start.getTime() + Number(meetingDuration) * 60000) };
  };

  // A plain summary of the meeting under the message. It is the user's own
  // message, so it makes no claim to come from a calendar service and carries
  // no buttons that do nothing.
  const meetingBlock = () => {
    const { start, end } = meetingTimes();
    const day = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `<div style="font-family:-apple-system,system-ui,'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:20px 0;padding:16px 18px;border:1px solid #e4e0da;border-radius:10px;color:#1c1a18">
  <div style="font-size:16px;font-weight:600;margin-bottom:6px">${escapeHtml(subject || "Meeting")}</div>
  <div style="font-size:14px;line-height:1.5">${day}</div>
  <div style="font-size:14px;line-height:1.5;color:#6a655f">${time(start)} to ${time(end)} (${meetingDuration} min)</div>
  ${meetingLocation ? `<div style="font-size:14px;line-height:1.5;color:#6a655f">${escapeHtml(meetingLocation)}</div>` : ""}
</div>`;
  };

  // On the calendar, inviting the recipients, once the email has gone.
  const createMeeting = async () => {
    const { start, end } = meetingTimes();
    const row: Record<string, unknown> = { user_id: user.id, title: subject || "Meeting", start_time: start.toISOString(), end_time: end.toISOString(), attendees: split(to), location: meetingLocation || null, status: "proposed" };
    try {
      const ev = await api("/calendar/create-event", { title: row.title, start_time: row.start_time, end_time: row.end_time, attendees: row.attendees, location: meetingLocation || "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      row.calendar_event_id = ev.event_id;
      row.status = "confirmed";
    } catch {
      addToast("error", "The email went out, but the meeting could not be put on the calendar. It waits in Meetings.");
    }
    await supabase.from("meetings").insert(row);
  };

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);

    try {
      // Resolve the "From" account once and use it for every branch (schedule,
      // undo-send, immediate). Previously schedule and undo-send fell back to
      // accounts[0], ignoring the selection.
      const parsedTo = to
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      const parsedCc = cc
        ? cc
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [];
      const parsedBcc = bcc
        ? bcc
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [];
      const emailOk = (addr: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
      const allRecipientsValid = [...parsedTo, ...parsedCc, ...parsedBcc].every(
        emailOk,
      );
      if (parsedTo.length === 0 || !allRecipientsValid) {
        addToast("error", "Please enter valid recipient email addresses");
        setSending(false);
        return;
      }

      const effectiveAccountId = selectedAccountId;
      if (!effectiveAccountId) {
        addToast("error", "Connect a mailbox first");
        setSending(false);
        return;
      }
      // A saved draft that is in that mailbox's Gmail Drafts is sent from there.
      const gmailDraftId = draft?.gmail_draft_id && draft.account_id === effectiveAccountId ? draft.gmail_draft_id : null;

      const apiUrl = "/api";
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const sendBody = textHtml(body) + (meetingOn ? meetingBlock() : "") + (signature ? `${SIGNATURE}${signature}</div>` : "");
      const inReplyTo = answers?.gmail_id ?? draft?.in_reply_to ?? null;
      const threadId = answers?.thread_id ?? draft?.thread_id ?? null;

      if (scheduleAt) {
        if (draft?._scheduledId) {
          const { data: changedRow, error: upErr } = await supabase
            .from("scheduled_emails")
            .update({
              account_id: effectiveAccountId,
              from_address: from.address || null,
              to_addresses: parsedTo,
              cc_addresses: parsedCc.length ? parsedCc : null,
              bcc_addresses: parsedBcc.length ? parsedBcc : null,
              subject,
              body_html: sendBody,
              send_at: scheduleAt,
              status: "pending",
              read_receipt: readReceipt,
              forward,
            })
            .eq("id", draft._scheduledId)
            .in("status", ["pending", "failed"])
            .select("id");
          if (upErr || !changedRow?.length) {
            addToast("error", upErr ? "Could not change the scheduled email" : "It has already gone out, so it was not changed");
            setSending(false);
            return;
          }
        } else {
          const { error: insErr } = await supabase
            .from("scheduled_emails")
            .insert({
              user_id: user.id,
              account_id: effectiveAccountId,
              from_address: from.address || null,
              gmail_draft_id: gmailDraftId,
              to_addresses: parsedTo,
              cc_addresses: parsedCc.length ? parsedCc : null,
              bcc_addresses: parsedBcc.length ? parsedBcc : null,
              subject,
              body_html: sendBody,
              send_at: scheduleAt,
              in_reply_to: inReplyTo,
              thread_id: threadId,
              read_receipt: readReceipt,
              forward,
            });
          if (insErr) {
            addToast("error", "Failed to schedule email");
            setSending(false);
            return;
          }
        }
      } else if (attachments.length === 0 && !meetingOn) {
        // Queued for 15 seconds, so it can be taken back.
        const { data: scheduled, error: undoErr } = await supabase
          .from("scheduled_emails")
          .insert({
            user_id: user.id,
            account_id: effectiveAccountId,
            from_address: from.address || null,
            gmail_draft_id: gmailDraftId,
            to_addresses: parsedTo,
            cc_addresses: parsedCc.length ? parsedCc : null,
            bcc_addresses: parsedBcc.length ? parsedBcc : null,
            subject,
            body_html: sendBody,
            in_reply_to: inReplyTo,
            thread_id: threadId,
            read_receipt: readReceipt,
            forward,
            send_at: new Date(Date.now() + 15_000).toISOString(),
          })
          .select("id")
          .single();

        if (undoErr || !scheduled?.id) {
          addToast("error", "Failed to queue send");
          setSending(false);
          return;
        }

        const scheduledId = scheduled.id;
        const others = parsedTo.length - 1;
        // Taken back, it is a draft again and opens as it was.
        const row = { ...asDraft(), id: draft?.id && !draft._scheduledId ? draft.id : crypto.randomUUID(), gmail_draft_id: gmailDraftId };
        addToast("info", `Sending to ${parsedTo[0]}${others > 0 ? ` and ${others} more` : ""}`, {
          duration: 15_000,
          action: {
            label: "Undo",
            onClick: async () => {
              const { data: stopped } = await supabase.from("scheduled_emails").update({ status: "cancelled" }).eq("id", scheduledId).eq("status", "pending").select("id");
              if (!stopped?.length) return addToast("info", "Too late, already sent.");
              await supabase.from("draft_emails").upsert(row, { onConflict: "id" });
              notifyDraftChange();
              mail.reload();
              openCompose(replyTo, row);
              addToast("success", "Not sent");
            },
          },
        });
      } else {
        // Immediate send: attachments present
        const attachmentData = await Promise.all(
          attachments.map(
            (file) =>
              new Promise<{ name: string; contentType: string; data: string }>(
                (resolve) => {
                  const reader = new FileReader();
                  reader.onload = () => {
                    const base64 = (reader.result as string).split(",")[1];
                    resolve({
                      name: file.name,
                      contentType: file.type || "application/octet-stream",
                      data: base64,
                    });
                  };
                  reader.readAsDataURL(file);
                },
              ),
          ),
        );

        let sendRes: Response;
        try {
          sendRes = await fetch(`${apiUrl}/send-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session?.access_token}`,
            },
            body: JSON.stringify({
              to: parsedTo,
              cc: parsedCc.length ? parsedCc : undefined,
              bcc: parsedBcc.length ? parsedBcc : undefined,
              subject,
              body_html: sendBody,
              in_reply_to: inReplyTo,
              thread_id: threadId,
              read_receipt: readReceipt,
              forward,
              account_id: effectiveAccountId,
              from_address: from.address || undefined,
              gmail_draft_id: gmailDraftId ?? undefined,
              attachments: attachmentData.length ? attachmentData : undefined,
            }),
          });
        } catch (netErr) {
          console.error("[compose/send] network error:", netErr);
          addToast("error", "Failed to send: network error");
          setSending(false);
          return;
        }
        if (!sendRes.ok) {
          let msg = "Failed to send email";
          try {
            const data = await sendRes.json();
            if (data?.error && typeof data.error === "string") msg = data.error;
          } catch {
            /* ignore */
          }
          addToast("error", msg);
          setSending(false);
          return;
        }
        if (meetingOn) await createMeeting();
      }
      // The row it came from: a scheduled email sent now, or a draft. One that
      // is in another account's Drafts is taken out there too.
      if (draft?._scheduledId) {
        if (!scheduleAt) await supabase.from("scheduled_emails").delete().eq("id", draft._scheduledId);
      } else if (draft?.id) {
        if (draft.gmail_draft_id && !gmailDraftId) await api("/drafts/discard", { ids: [draft.id] }).catch(() => {});
        await supabase.from("draft_emails").delete().eq("id", draft.id);
        notifyDraftChange();
      }
      // Immediately persist recipient addresses so they appear in autocomplete without waiting for next fetch
      const allRecipients = [
        ...to.split(","),
        ...(cc ? cc.split(",") : []),
        ...(bcc ? bcc.split(",") : []),
      ]
        .map((s) => s.trim())
        .filter((s) => s.includes("@"));
      if (allRecipients.length > 0) {
        const newContacts = allRecipients.map((email) => ({
          email: email.toLowerCase(),
          name: "",
        }));
        addContacts(newContacts);
        supabase.from("email_memory").upsert(
          newContacts.map((c) => ({
            user_id: user.id,
            sender_email: c.email,
            sender_name: "",
            interaction_count: 1,
            last_interaction_at: new Date().toISOString(),
          })),
          { onConflict: "user_id,sender_email", ignoreDuplicates: true },
        );
      }
      const sentTo = to
        .split(",")
        .map((s: string) => s.trim())
        .join(", ");
      notifySent({ to: sentTo, subject, body_html: sendBody });
      if (drafted.current && body.trim() !== drafted.current.trim()) {
        api("/writing/edited", { to: parsedTo[0], before: drafted.current, after: body }).catch(() => {});
      }

      // Prepend to sent localStorage cache so SentView shows it immediately
      try {
        const cacheKey = `tabellar_sent_cache_${user.id}`;
        const raw = localStorage.getItem(cacheKey);
        const existing = raw ? JSON.parse(raw) : { data: [], ts: 0 };
        const newEntry = {
          id: `local-${Date.now()}`,
          subject,
          to: sentTo,
          date: new Date().toISOString(),
          body_html: sendBody,
        };
        localStorage.setItem(
          cacheKey,
          JSON.stringify({
            data: [newEntry, ...(existing.data || [])],
            ts: existing.ts,
          }),
        );
      } catch {
        /* non-critical */
      }

      onClose();
    } finally {
      setSending(false);
    }
  };

  // What the window says while Tabellar is writing.
  const busy = generatingDraft
    ? "Writing a draft"
    : rephrasingTone
      ? `Rewriting to sound ${TONES.find((t) => t.id === rephrasingTone)?.label.toLowerCase()}.`
      : refining
        ? "Applying your changes."
        : "";
  const offHours = !!(scheduleAt && isOutsideWorkingHours(scheduleAt, profile?.working_hours as WorkingHours));
  const replyName = (replyTo?.sender ?? "").replace(/<.*>/, "").replace(/"/g, "").trim() || replyTo?.sender_email || "";
  const title = draft?._scheduledId
    ? "Scheduled message"
    : forward
      ? "Forward"
      : !replyTo
      ? "New message"
        : replyName
          ? `Reply to ${replyName}`
          : "Reply";
  // Files and meetings go out with the email itself, which a later send cannot hold.
  const notLater = !!scheduleAt && (attachments.length > 0 || meetingOn);
  const canSend = !sending && !!to && !!subject && !notLater;
  const row = "flex min-h-9 items-center gap-2 border-b border-line-soft";
  const rowLabel = "w-12 flex-none text-xs text-ink3";
  const menuItem = "pop-item disabled:pointer-events-none disabled:opacity-45";

  return (
    <div
      {...(minimized ? {} : { "data-compose-modal": true })}
      hidden={minimized}
      role="dialog"
      aria-label={title}
      className={`fixed bottom-4 z-50 flex-col rounded-[12px] bg-raised shadow-pop ${minimized ? "hidden" : "flex"}`}
      style={{
        right: "1rem",
        width: "40rem",
        maxWidth: "calc(100vw - 2rem)",
        maxHeight: "min(82vh, 43.75rem)",
        transition: "right 0.2s ease",
      }}
      onKeyDown={(e) => {
        // Cmd or Ctrl with Enter sends from anywhere in the window.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
          e.preventDefault();
          handleSend();
        }
      }}
    >
      <div className="flex h-10 flex-none select-none items-center border-b border-line-soft pl-4 pr-1.5">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{title}</h2>
        <button className="iconbtn" onClick={onMinimize} title="Minimize" aria-label="Minimize">
          <Icon name="minimize" size={16} />
        </button>
        <button className="iconbtn" onClick={close} title={changed && !draft?._scheduledId ? "Save and close" : "Close"} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {fromChoices.length > 1 && (
          <label className={row}>
            <span className={rowLabel}>From</span>
            <select
              value={`${from.accountId}|${from.address}`}
              onChange={(e) => {
                const [accountId, address] = e.target.value.split("|");
                setFrom({ accountId, address });
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            >
              {accounts.list.length > 1
                ? accounts.list.map((a) => (
                    <optgroup key={a.id} label={a.address}>
                      {a.from.map((f) => (
                        <option key={f.address} value={`${a.id}|${f.address}`}>
                          {f.name ? `${f.name} <${f.address}>` : f.address}
                        </option>
                      ))}
                    </optgroup>
                  ))
                : fromChoices.map((f) => (
                    <option key={f.address} value={`${f.accountId}|${f.address}`}>
                      {f.name ? `${f.name} <${f.address}>` : f.address}
                    </option>
                  ))}
            </select>
          </label>
        )}

        <EmailField
          label="To"
          value={to}
          onChange={setTo}
          contacts={contacts}
          accountId={selectedAccountId || primaryAccountId}
          suffix={
            !showCcBcc ? (
              <button className="link flex-none leading-[22px]" onClick={() => setShowCcBcc(true)}>
                Cc, Bcc
              </button>
            ) : (
              <button
                className="iconbtn -my-[3px]"
                title="Remove Cc and Bcc"
                aria-label="Remove Cc and Bcc"
                onClick={() => {
                  setShowCcBcc(false);
                  setCc("");
                  setBcc("");
                }}
              >
                <Icon name="close" size={14} />
              </button>
            )
          }
        />

        {showCcBcc && (
          <>
            <EmailField label="Cc" value={cc} onChange={setCc} contacts={contacts} accountId={selectedAccountId || primaryAccountId} />
            <EmailField label="Bcc" value={bcc} onChange={setBcc} contacts={contacts} accountId={selectedAccountId || primaryAccountId} />
          </>
        )}

        <label className={row}>
          <span className={rowLabel}>Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none"
          />
        </label>

        {/* Meeting that goes on the calendar when the email is sent */}
        {showMeetingPanel && (
          <div className="inset mt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="label">Meeting</span>
              <button className="iconbtn -my-1 -mr-1.5" onClick={() => setShowMeetingPanel(false)} title="Remove the meeting" aria-label="Remove the meeting">
                <Icon name="close" size={14} />
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <DateTimePicker value={meetingDatetime} onChange={setMeetingDatetime} placeholder="Pick date and time" />
              <input
                type="text"
                value={meetingLocation}
                onChange={(e) => setMeetingLocation(e.target.value)}
                placeholder="Location (optional)"
                className="input"
              />
            </div>
            <div className="seg mt-2 flex-wrap" role="group" aria-label="Length">
              {[
                { label: "15 min", value: "15" },
                { label: "30 min", value: "30" },
                { label: "45 min", value: "45" },
                { label: "1 hr", value: "60" },
                { label: "1.5 hr", value: "90" },
                { label: "2 hr", value: "120" },
              ].map(({ label, value }) => (
                <button key={value} type="button" aria-pressed={meetingDuration === value} onClick={() => setMeetingDuration(value)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink3">
              {meetingDuration
                ? scheduleAt
                  ? "A meeting goes out with the email. Send now, or remove it."
                  : "Sending also adds this to your calendar and invites the recipients, without the 15 second undo."
                : "Pick a length. Without one, no meeting is created."}
            </p>
          </div>
        )}

        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (aiGenerated) setAiGenerated(false);
          }}
          placeholder="Write your message"
          rows={showMeetingPanel || forward ? 6 : 10}
          className="block w-full resize-none bg-transparent py-3 text-sm leading-[1.6] text-ink outline-none"
        />

        {signature && (
          <div className="mb-3 flex items-start gap-2 border-t border-line-soft pt-3">
            <div className="min-w-0 flex-1 text-[13px] leading-normal text-ink2 [&_img]:max-h-16" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(signature, { USE_PROFILES: { html: true } }) }} />
            <button className="iconbtn -my-1" onClick={() => setSignature("")} title="Remove the signature" aria-label="Remove the signature">
              <Icon name="close" size={14} />
            </button>
          </div>
        )}

        {busy && (
          <p role="status" className="pb-2.5 text-xs text-ink3">
            {busy}
          </p>
        )}

        {/* The email that goes out below the text, and its files */}
        {forwarded && (
          <div className="inset mb-3">
            <div className="flex items-baseline gap-2">
              <b className="min-w-0 truncate font-medium text-ink">{forwarded.subject || "(no subject)"}</b>
              <span className="min-w-0 flex-1 truncate text-xs text-ink3">{forwarded.sender.replace(/<.*>/, "").replace(/"/g, "").trim()}</span>
            </div>
            <p className="mt-1 line-clamp-2 leading-snug text-ink3">{forwarded.snippet}</p>
            {(forwarded.attachments || [])
              .filter((a) => !without.includes(a.attachment_id))
              .map((a) => (
                <div key={a.attachment_id} className="mt-1 flex h-6 items-center gap-2">
                  <Icon name={FILE_ICON[fileKind(a)]} size={14} className="flex-none text-ink3" />
                  <span className="min-w-0 truncate text-ink">{a.filename}</span>
                  {a.size > 0 && <span className="flex-none text-xs text-ink3">{formatFileSize(a.size)}</span>}
                  <button className="iconbtn h-6 w-6" onClick={() => setWithout((w) => [...w, a.attachment_id])} title="Leave out" aria-label={`Leave out ${a.filename}`}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
          </div>
        )}

        {/* Asking Tabellar for a change to the draft */}
        {!busy && showRefinePanel && (
          <div className="pb-3">
            <label htmlFor="compose-refine" className="label">
              What should change?
            </label>
            <textarea
              id="compose-refine"
              value={refineFeedback}
              onChange={(e) => setRefineFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  // Applies the change; must not reach the window's own send shortcut.
                  e.preventDefault();
                  e.stopPropagation();
                  refineWithFeedback();
                }
              }}
              placeholder="For example: shorter, less formal, end with a question"
              rows={2}
              className="input mt-1.5 resize-none"
              autoFocus
            />
            <div className="mt-2 flex items-center gap-2">
              <button className="btn btn-sm" onClick={refineWithFeedback} disabled={!refineFeedback.trim() || !body}>
                Apply
              </button>
              <button
                className="btn btn-sm btn-plain"
                onClick={() => {
                  setShowRefinePanel(false);
                  setRefineFeedback("");
                }}
              >
                Cancel
              </button>
              <span className="flex cursor-default items-center gap-2 pl-1 text-ink2" onClick={() => setKeepFeedback(!keepFeedback)}>
                <Tick checked={keepFeedback} onChange={setKeepFeedback} label="For later drafts too" />
                For later drafts too
              </span>
            </div>
          </div>
        )}

        {readReceipt && (
          <p className="flex items-center gap-2 pb-2.5 text-xs text-ink3">
            Asks for a read receipt
            <button className="link" onClick={() => setReadReceipt(false)}>
              Remove
            </button>
          </p>
        )}

        {!busy && !showRefinePanel && aiGenerated && (
          <p className="pb-2.5 text-xs text-ink3">
            Drafted for you{" "}
            <button className="link" onClick={() => setShowRefinePanel(true)}>
              Ask for changes
            </button>
          </p>
        )}

        {attachments.length > 0 && (
          <div className="pb-2.5">
            {attachments.map((file, idx) => (
              <div key={idx} className="flex h-7 items-center gap-2">
                <Icon name="attach_file" size={14} className="text-ink3" />
                <span className="min-w-0 truncate text-ink">{file.name}</span>
                <span className="flex-none text-xs text-ink3">{formatFileSize(file.size)}</span>
                <button className="iconbtn h-6 w-6" onClick={() => removeAttachment(idx)} title="Remove" aria-label={`Remove ${file.name}`}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
            {scheduleAt ? (
              <p className="pt-1 text-xs text-warn">Attachments cannot wait with a scheduled email. Send now, or remove them.</p>
            ) : (
              <p className="pt-1 text-xs text-ink3">With attachments the email goes out at once, without the 15 second undo.</p>
            )}
          </div>
        )}

        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
      </div>

      <div ref={footerRef} className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
        <button className="btn btn-pri" onClick={() => handleSend()} disabled={!canSend}>
          {sending ? "Sending" : scheduleAt ? "Schedule" : "Send"}
        </button>

        <div className="relative">
          <button
            className="btn"
            aria-haspopup="dialog"
            aria-expanded={menu === "later"}
            onClick={() => {
              if (menu !== "later" && !scheduleAt) {
                const wh = profile?.working_hours as WorkingHours;
                const slot = getNextWorkingSlot(wh);
                setScheduleAt(slot.toISOString());
              }
              setMenu(menu === "later" ? "" : "later");
            }}
          >
            {scheduleAt
              ? `Sends ${new Date(scheduleAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`
              : "Send later"}
            <Icon name="expand_more" size={13} className="text-ink3" />
          </button>
          {menu === "later" && (
            <div className="pop absolute bottom-9 left-0 w-72 p-3" role="dialog" aria-label="Send later">
              <p className="label mb-2">Send later</p>
              <DateTimePicker
                value={isoToDatetimeLocal(scheduleAt)}
                onChange={(dtl) => setScheduleAt(datetimeLocalToIso(dtl))}
                placeholder="Pick date and time"
                showWarning={offHours}
              />
              {offHours && <p className="mt-2 text-xs text-warn">Outside your working hours.</p>}
              <div className="mt-3 flex items-center gap-2">
                <button className="btn btn-sm" onClick={() => setMenu("")}>
                  Done
                </button>
                {scheduleAt && (
                  <button
                    className="btn btn-sm btn-plain"
                    onClick={() => {
                      setScheduleAt("");
                      setMenu("");
                    }}
                  >
                    Send now instead
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Writing help: draft from notes, change the tone, describe a change */}
        <div className="relative">
          <button className="btn" aria-haspopup="menu" aria-expanded={menu === "rewrite"} disabled={!!busy} onClick={() => setMenu(menu === "rewrite" ? "" : "rewrite")}>
            Rewrite <Icon name="expand_more" size={13} className="text-ink3" />
          </button>
          {menu === "rewrite" && (
            <div className="pop absolute bottom-9 left-0 w-56" role="menu">
              <button
                role="menuitem"
                className={menuItem}
                disabled={!to || !subject}
                title={forward ? "Writes the note again" : "Turns the notes in the message into a full email. Needs a recipient and a subject."}
                onClick={() => {
                  setMenu("");
                  generateDraft();
                }}
              >
                Draft it
              </button>
              <div className="mx-2 my-1 border-t border-line-soft" />
              <p className="label px-2 py-1">Change the tone</p>
              {TONES.map((tone) => (
                <button key={tone.id} role="menuitem" className={menuItem} disabled={!body.trim()} onClick={() => rephraseInTone(tone)}>
                  {tone.label}
                </button>
              ))}
              <div className="mx-2 my-1 border-t border-line-soft" />
              <button
                role="menuitem"
                className={menuItem}
                disabled={!body.trim()}
                onClick={() => {
                  setMenu("");
                  setShowRefinePanel(true);
                }}
              >
                Describe a change
              </button>
            </div>
          )}
        </div>

        <button className="iconbtn" onClick={() => fileInputRef.current?.click()} title="Attach files" aria-label="Attach files">
          <Icon name="attach_file" size={16} />
        </button>

        {/* What few emails need: a template, a meeting, a read receipt */}
        <div className="relative">
          <button className="iconbtn" aria-haspopup="menu" aria-expanded={menu === "more"} title="More" aria-label="More" onClick={() => setMenu(menu === "more" ? "" : "more")}>
            <Icon name="more" size={16} />
          </button>
          {menu === "more" && (
            <div className="pop absolute bottom-9 left-0 w-56" role="menu">
              <button
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  setSaveTemplateName(subject || "");
                  setMenu("templates");
                }}
              >
                Templates
                <Icon name="chevron_right" size={14} className="ml-auto text-ink3" />
              </button>
              <button
                role="menuitemcheckbox"
                aria-checked={showMeetingPanel}
                className={menuItem}
                disabled={!to || !subject}
                title={!to || !subject ? "Add a recipient and a subject to set up a meeting" : undefined}
                onClick={() => {
                  setMenu("");
                  setShowMeetingPanel((v) => !v);
                }}
              >
                {showMeetingPanel ? "Remove the meeting" : "Set up a meeting"}
              </button>
              <button
                role="menuitemcheckbox"
                aria-checked={readReceipt}
                className={menuItem}
                title="Many mail programs do not answer it. Without an answer in two days, it is in Follow-ups."
                onClick={() => {
                  setMenu("");
                  setReadReceipt((v) => !v);
                }}
              >
                Ask for a read receipt
                {readReceipt && <Icon name="check" size={13} className="ml-auto" />}
              </button>
            </div>
          )}
          {menu === "templates" && (
            <div className="pop absolute bottom-9 left-0 flex max-h-[340px] w-72 flex-col" role="dialog" aria-label="Templates">
              <p className="label px-2 py-1.5">Templates</p>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {templates.length === 0 ? (
                  <p className="px-2 pb-2 text-xs leading-normal text-ink3">No templates yet. Name the message you are writing below to keep it as one.</p>
                ) : (
                  templates.map((t) => (
                    <div key={t.id} className="group flex items-center rounded-md hover:bg-sel">
                      <button className="min-w-0 flex-1 px-2 py-1.5 text-left" onClick={() => applyTemplate(t)}>
                        <span className="block truncate text-ink">{t.name}</span>
                        {t.subject && t.subject !== t.name && <span className="block truncate text-xs text-ink3">{t.subject}</span>}
                      </button>
                      <button
                        className="iconbtn mr-0.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => deleteTemplate(t.id)}
                        title="Delete template"
                        aria-label={`Delete template ${t.name}`}
                      >
                        <Icon name="delete" size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-1 flex items-center gap-1.5 border-t border-line-soft px-1 pb-1 pt-2">
                <input
                  type="text"
                  value={saveTemplateName}
                  onChange={(e) => setSaveTemplateName(e.target.value)}
                  placeholder="Save this message as"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) saveAsTemplate();
                  }}
                  className="input"
                />
                <button className="btn" onClick={saveAsTemplate} disabled={!saveTemplateName.trim() || !body}>
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <span className="flex-1" />

        <button className="btn btn-plain" onClick={saveDraft} disabled={!body && !forward && !(to && subject)} title="Keep this as a draft and close">
          Save draft
        </button>
        <button className="iconbtn" onClick={discard} title="Discard" aria-label="Discard">
          <Icon name="delete" size={16} />
        </button>
      </div>
    </div>
  );
});

export default ComposeModal;
