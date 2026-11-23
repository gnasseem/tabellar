import { useState, useEffect, useRef } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "./AppShell";
import { EmailField, useContacts } from "./EmailAutocomplete";
import DateTimePicker from "./DateTimePicker";
import { Kbd } from "./ui";

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
  replyTo?: any;
  draft?: any;
};

interface Template {
  id: string;
  name: string;
  subject: string | null;
  body_html: string;
}

function getNow(): { date: string; time: string } {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
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

export default function ComposeModal({
  onClose,
  onMinimize,
  replyTo,
  draft,
}: ComposeProps) {
  const {
    user,
    profile,
    addToast,
    notifyDraftChange,
    notifySent,
    assistantOpen,
  } = useApp();
  const supabase = createClient();
  const draftId = useRef(draft?.id ?? crypto.randomUUID());
  // Helper: extract bare email addresses from a comma-separated RFC 2822 string,
  // excluding the user's own address.
  const extractReplyAddresses = (
    raw: string,
    excludeEmail: string,
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
      .filter((e) => e.includes("@") && e !== excludeEmail);
  };

  const userEmail = (profile?.email || user?.email || "").toLowerCase();

  const [to, setTo] = useState(() => {
    if (draft) return (draft.to_addresses || []).join(", ");
    if (replyTo?._replyAll) {
      const addrs = new Set<string>();
      if (replyTo.sender_email) {
        const raw = replyTo.sender_email.trim();
        const angleMatch = raw.match(/^.*?<([^>]+)>\s*$/);
        const addr = (angleMatch ? angleMatch[1] : raw).toLowerCase();
        if (addr.includes("@") && addr !== userEmail) addrs.add(addr);
      }
      for (const addr of extractReplyAddresses(
        replyTo.recipients || "",
        userEmail,
      ))
        addrs.add(addr);
      return Array.from(addrs).join(", ");
    }
    return replyTo?.sender_email || "";
  });
  const [cc, setCc] = useState(() => {
    if (draft?.cc_addresses?.length)
      return (draft.cc_addresses as string[]).join(", ");
    if (replyTo?._replyAll && replyTo.cc_recipients) {
      return extractReplyAddresses(replyTo.cc_recipients, userEmail).join(", ");
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
      : replyTo
        ? /^Re:/i.test(replyTo.subject || "")
          ? replyTo.subject
          : `Re: ${replyTo.subject}`
        : "",
  );
  const [body, setBody] = useState<string>(
    draft
      ? draft.body_html || ""
      : replyTo?._autoGenerate
        ? ""
        : replyTo?._prefillBody || "",
  );
  const [sending, setSending] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(draft?.send_at || "");

  const [templates, setTemplates] = useState<Template[]>([]);
  const [saveTemplateName, setSaveTemplateName] = useState("");

  const [showMeetingPanel, setShowMeetingPanel] = useState(false);

  // The footer menu that is open, if any: Rewrite, Send later or Templates.
  const [menu, setMenu] = useState<"" | "rewrite" | "later" | "templates">("");
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

  const [gmailAccounts, setGmailAccounts] = useState<
    { id: string; gmail_address: string }[]
  >([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    replyTo?.gmail_account_id || "",
  );
  const { contacts, addContacts, primaryAccountId } = useContacts(user.id);

  // Signatures
  const [allSignatures, setAllSignatures] = useState<
    {
      id: string;
      name: string;
      html: string;
      is_default: boolean;
      gmail_account_id: string | null;
    }[]
  >([]);
  const [appliedSignatureId, setAppliedSignatureId] = useState<string | null>(
    null,
  );
  const SIGNATURE_SEPARATOR =
    '<div data-tabellar-sig="1" style="margin-top:16px;padding-top:12px;border-top:1px solid #e4e0da;">';

  const getDefaultSignatureForAccount = (
    accountId: string,
    sigs: typeof allSignatures,
  ) => {
    // First try exact account match, then fall back to global (null account), then first default
    return (
      sigs.find((s) => s.is_default && s.gmail_account_id === accountId) ??
      sigs.find((s) => s.is_default && !s.gmail_account_id) ??
      null
    );
  };

  const stripSignature = (html: string) => {
    const idx = html.indexOf(SIGNATURE_SEPARATOR);
    return idx >= 0 ? html.slice(0, idx) : html;
  };

  const appendSignature = (html: string, sig: { html: string } | null) => {
    const base = stripSignature(html);
    if (!sig) return base;
    return base + SIGNATURE_SEPARATOR + sig.html + "</div>";
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
    (async () => {
      const { data } = await supabase
        .from("gmail_accounts")
        .select("id, gmail_address")
        .eq("user_id", user.id)
        .eq("is_active", true);
      if (data) {
        setGmailAccounts(data as { id: string; gmail_address: string }[]);
        if (!selectedAccountId && data.length > 0) {
          setSelectedAccountId((data[0] as { id: string }).id);
        }
      }
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
    const effectiveAccountId = selectedAccountId || gmailAccounts[0]?.id || "";
    const sig = getDefaultSignatureForAccount(
      effectiveAccountId,
      allSignatures,
    );
    if (sig && sig.id !== appliedSignatureId) {
      setBody((prev) => appendSignature(prev, sig));
      setAppliedSignatureId(sig.id);
    } else if (!sig && appliedSignatureId) {
      setBody((prev) => stripSignature(prev));
      setAppliedSignatureId(null);
    }
  }, [selectedAccountId, allSignatures, gmailAccounts]);

  const applyTemplate = (t: Template) => {
    const newSubject = t.subject || t.name;
    if (newSubject) setSubject(newSubject);
    setBody(t.body_html);
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

  const generateDraft = async (intentOverride?: string) => {
    const intent = intentOverride ?? body;
    if (!intent.trim()) {
      addToast("error", "Write a few words on what to say first");
      return;
    }
    setGeneratingDraft(true);

    try {
      const apiUrl = "/api";
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${apiUrl}/draft-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          intent: intent,
          subject,
          to,
          senderName: profile?.display_name || "",
          replyTo: replyTo
            ? {
                subject: replyTo.subject,
                body: replyTo.body_text?.slice(0, 1000),
              }
            : undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.draft) {
          setBody(data.draft);
          setAiGenerated(true);
          setShowRefinePanel(false);
          setRefineFeedback("");
        } else {
          addToast("error", "Could not generate draft");
        }
      } else {
        addToast("error", "Could not generate draft");
      }
    } catch {
      addToast("error", "Network error");
    }
    setGeneratingDraft(false);
  };

  const refineWithFeedback = async () => {
    if (!refineFeedback.trim() || !body) return;
    setRefining(true);
    try {
      const apiUrl = "/api";
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${apiUrl}/refine-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          currentDraft: body,
          feedback: refineFeedback.trim(),
          senderName: profile?.display_name || "",
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.draft) {
          setBody(data.draft);
          setAiGenerated(true);
          setShowRefinePanel(false);
          setRefineFeedback("");
          addToast(
            "success",
            "Draft updated. Feedback saved to your knowledge base.",
          );
        } else {
          addToast("error", "Could not refine draft");
        }
      } else {
        addToast("error", "Could not refine draft");
      }
    } catch {
      addToast("error", "Network error");
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

  // Rewrite the current body in a different register. Unlike refineWithFeedback
  // this is a one-off transformation, not a stated preference, so it asks the
  // backend not to record it as a style learning.
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
      let rewritten: string | null = null;
      const apiUrl = "/api";
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${apiUrl}/refine-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          currentDraft: current,
          feedback: `Rewrite this so it reads ${tone.prompt}. Preserve every fact, name, date, question and commitment exactly, and keep roughly the same length. Return only the rewritten message.`,
          senderName: profile?.display_name || "",
          skip_learning: true,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.draft?.trim()) rewritten = data.draft.trim();
      }

      if (!rewritten) {
        addToast("error", "Could not rephrase this draft");
        setRephrasingTone(null);
        return;
      }

      setBody(rewritten);
      setAiGenerated(true);
      addToast("success", `Rewritten to sound ${tone.label.toLowerCase()}`, {
        action: { label: "Undo", onClick: restore },
      });
    } catch {
      addToast("error", "Network error");
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

  const saveDraft = async () => {
    if (!body) return;
    const toAddresses = to
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    await supabase.from("draft_emails").upsert(
      {
        id: draftId.current,
        user_id: user.id,
        to_addresses: toAddresses,
        subject,
        body_html: body,
      },
      { onConflict: "id" },
    );
    notifyDraftChange();
    addToast("success", "Draft saved");
    onClose();
  };

  const createMeetingRecord = async () => {
    if (!meetingDate || !meetingTime || !meetingDuration) return;

    const durationMin = parseInt(meetingDuration, 10);
    if (isNaN(durationMin) || durationMin <= 0) {
      addToast("error", "Enter a valid meeting duration");
      return;
    }
    const [yr, mo, dy] = meetingDate.split("-").map(Number);
    const [hr, mn] = meetingTime.split(":").map(Number);
    const startTime = new Date(yr, mo - 1, dy, hr, mn);
    const endTime = new Date(startTime.getTime() + durationMin * 60000);
    const attendees = to
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    const title = subject || "Meeting";

    const meetingData: Record<string, unknown> = {
      user_id: user.id,
      title,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      attendees,
      location: meetingLocation || null,
      status: "proposed",
    };

    try {
      const apiUrl = "/api";
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const calRes = await fetch(`${apiUrl}/calendar/create-event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          title,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          attendees,
          location: meetingLocation || "",
          description: `Scheduled from Tabellar`,
          sendUpdates: "all",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (calRes.ok) {
        const cal = await calRes.json();
        meetingData.calendar_event_id = cal.event_id;
      }
    } catch (err) {
      console.error("[ComposeModal] Calendar creation:", err);
    }

    await supabase.from("meetings").insert(meetingData);

    const startDt = new Date(`${meetingDate}T${meetingTime}`);
    const endDt = endTime;
    const dayName = startDt.toLocaleDateString("en-US", { weekday: "long" });
    const dateStr = startDt.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const timeStr = startDt.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const endTimeStr = endDt.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const locationLine = meetingLocation || "";

    // A plain summary of the proposed meeting, written into the email. It is
    // the user's own message, so it makes no claim to come from a calendar
    // service and carries no buttons that do nothing.
    const meetingBlock = `
<div style="font-family:-apple-system,system-ui,'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:20px 0;padding:16px 18px;border:1px solid #e4e0da;border-radius:10px;color:#1c1a18">
  <div style="font-size:16px;font-weight:600;margin-bottom:6px">${title}</div>
  <div style="font-size:14px;line-height:1.5">${dayName}, ${dateStr}</div>
  <div style="font-size:14px;line-height:1.5;color:#6a655f">${timeStr} to ${endTimeStr} (${durationMin} min)</div>
  ${locationLine ? `<div style="font-size:14px;line-height:1.5;color:#6a655f">${locationLine}</div>` : ""}
</div>`;

    setBody((prev) => prev + meetingBlock);
  };

  const handleSend = async (bodyOverride?: string) => {
    if (!to || !subject) return;
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

      let effectiveAccountId = selectedAccountId;
      if (!effectiveAccountId) {
        const { data: accounts } = await supabase
          .from("gmail_accounts")
          .select("id")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .order("created_at", { ascending: true })
          .limit(1);
        if (!accounts?.length) {
          addToast("error", "Connect a Gmail account first");
          setSending(false);
          return;
        }
        effectiveAccountId = accounts[0].id;
      }

      if (showMeetingPanel && meetingDate && meetingDuration) {
        await createMeetingRecord();
      }

      const apiUrl = "/api";
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const rawBody = bodyOverride || body;
      // Convert plain-text newlines to <br> for HTML email rendering
      const sendBody =
        rawBody.includes("<br") ||
        rawBody.includes("<p") ||
        rawBody.includes("<div")
          ? rawBody
          : rawBody.replace(/\n/g, "<br>");

      if (scheduleAt) {
        if (draft?._scheduledId) {
          const { error: upErr } = await supabase
            .from("scheduled_emails")
            .update({
              gmail_account_id: effectiveAccountId,
              to_addresses: parsedTo,
              cc_addresses: parsedCc.length ? parsedCc : null,
              bcc_addresses: parsedBcc.length ? parsedBcc : null,
              subject,
              body_html: sendBody,
              send_at: scheduleAt,
              status: "pending",
            })
            .eq("id", draft._scheduledId);
          if (upErr) {
            addToast("error", "Failed to update scheduled email");
            setSending(false);
            return;
          }
        } else {
          const { error: insErr } = await supabase
            .from("scheduled_emails")
            .insert({
              user_id: user.id,
              gmail_account_id: effectiveAccountId,
              to_addresses: parsedTo,
              cc_addresses: parsedCc.length ? parsedCc : null,
              bcc_addresses: parsedBcc.length ? parsedBcc : null,
              subject,
              body_html: sendBody,
              send_at: scheduleAt,
              in_reply_to: replyTo?.gmail_id,
              thread_id: replyTo?.thread_id,
            });
          if (insErr) {
            addToast("error", "Failed to schedule email");
            setSending(false);
            return;
          }
        }
      } else if (attachments.length === 0) {
        // Cancel Send: queue in scheduled_emails with 15-second window (no attachments)
        const { data: scheduled, error: undoErr } = await supabase
          .from("scheduled_emails")
          .insert({
            user_id: user.id,
            gmail_account_id: effectiveAccountId,
            to_addresses: parsedTo,
            cc_addresses: parsedCc.length ? parsedCc : null,
            bcc_addresses: parsedBcc.length ? parsedBcc : null,
            subject,
            body_html: sendBody,
            in_reply_to: replyTo?.gmail_id,
            thread_id: replyTo?.thread_id,
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
        addToast("info", `Sending to ${parsedTo[0]}${others > 0 ? ` and ${others} more` : ""}`, {
          duration: 15_000,
          action: {
            label: "Cancel",
            onClick: async () => {
              if (scheduledId) {
                await supabase
                  .from("scheduled_emails")
                  .update({ status: "cancelled" })
                  .eq("id", scheduledId)
                  .eq("status", "pending");
                addToast("success", "Send cancelled");
              }
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
              in_reply_to: replyTo?.gmail_id,
              thread_id: replyTo?.thread_id,
              gmail_account_id: effectiveAccountId,
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
      }
      // Delete source record: scheduled email sent immediately, or regular draft
      if (draft?._scheduledId && !scheduleAt) {
        await supabase
          .from("scheduled_emails")
          .delete()
          .eq("id", draft._scheduledId);
      } else if (draft?.id) {
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
    ? "Tabellar is writing a draft. A local model can take a moment."
    : rephrasingTone
      ? `Rewriting to sound ${TONES.find((t) => t.id === rephrasingTone)?.label.toLowerCase()}.`
      : refining
        ? "Applying your changes."
        : "";
  const offHours = !!(scheduleAt && isOutsideWorkingHours(scheduleAt, profile?.working_hours as WorkingHours));
  const replyName = (replyTo?.sender ?? "").replace(/<.*>/, "").replace(/"/g, "").trim() || replyTo?.sender_email || "";
  const title = draft?._scheduledId
    ? "Scheduled message"
    : !replyTo
      ? "New message"
      : /^fwd:/i.test(replyTo.subject || "")
        ? "Forward"
        : replyName
          ? `Reply to ${replyName}`
          : "Reply";
  const canSend = !sending && !!to && !!subject;
  const row = "flex min-h-9 items-center gap-2 border-b border-line-soft";
  const rowLabel = "w-12 flex-none text-xs text-ink3";
  const menuItem = "pop-item disabled:pointer-events-none disabled:opacity-45";

  return (
    <div
      data-compose-modal
      role="dialog"
      aria-label={title}
      className="fixed bottom-4 z-50 flex flex-col rounded-[12px] bg-raised shadow-pop"
      style={{
        right: assistantOpen ? "388px" : "16px",
        width: "640px",
        maxWidth: `calc(100vw - ${assistantOpen ? 404 : 32}px)`,
        maxHeight: "min(82vh, 700px)",
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
        <button className="iconbtn" onClick={onClose} title="Close" aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {gmailAccounts.length > 1 && (
          <label className={row}>
            <span className={rowLabel}>From</span>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            >
              {gmailAccounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.gmail_address}
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
                ? "Sending also adds this to your calendar and invites the recipients."
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
          placeholder="Write your message. Or note what you want to say, then choose Rewrite and Draft with Tabellar."
          rows={showMeetingPanel ? 6 : 10}
          className="block w-full resize-none bg-transparent py-3 text-sm leading-[1.6] text-ink outline-none"
        />

        {busy && (
          <p role="status" className="pb-2.5 text-xs text-ink3">
            {busy}
          </p>
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
                Apply <Kbd>⌘↵</Kbd>
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
              <span className="text-xs text-ink3">Tabellar remembers this for later drafts.</span>
            </div>
          </div>
        )}

        {!busy && !showRefinePanel && aiGenerated && (
          <p className="pb-2.5 text-xs text-ink3">
            Drafted by Tabellar. Read it before you send.{" "}
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
              <p className="pt-1 text-xs text-warn">A scheduled email goes out without its attachments. Send now to include them.</p>
            ) : (
              <p className="pt-1 text-xs text-ink3">With attachments the email goes out at once, without the 15 second undo.</p>
            )}
          </div>
        )}

        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
      </div>

      <div ref={footerRef} className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
        <button className="btn btn-pri" onClick={() => handleSend()} disabled={!canSend}>
          {sending ? "Sending" : scheduleAt ? "Schedule" : "Send"} <Kbd>⌘↵</Kbd>
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
                title="Turns the notes in the message into a full email. Needs a recipient and a subject."
                onClick={() => {
                  setMenu("");
                  generateDraft();
                }}
              >
                Draft with Tabellar
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

        <div className="relative">
          <button
            className={`iconbtn ${menu === "templates" ? "bg-sel text-ink" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={menu === "templates"}
            title="Templates"
            aria-label="Templates"
            onClick={() => {
              const opening = menu !== "templates";
              setMenu(opening ? "templates" : "");
              if (opening) setSaveTemplateName(subject || "");
            }}
          >
            <Icon name="description" size={16} />
          </button>
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

        <button
          className={`iconbtn ${showMeetingPanel ? "bg-sel text-ink" : ""}`}
          aria-pressed={showMeetingPanel}
          onClick={() => setShowMeetingPanel((p) => !p)}
          disabled={!to || !subject}
          title={!to || !subject ? "Add a recipient and a subject to set up a meeting" : "Set up a meeting with this email"}
          aria-label="Set up a meeting with this email"
        >
          <Icon name="event" size={16} />
        </button>

        <span className="flex-1" />

        <button className="btn btn-plain" onClick={saveDraft} disabled={!body} title="Keep this as a draft and close">
          Save draft
        </button>
        <button className="iconbtn" onClick={onClose} title="Discard" aria-label="Discard">
          <Icon name="delete" size={16} />
        </button>
      </div>
    </div>
  );
}
