
import { useState, useEffect, useRef } from "react";
import Icon from "@/components/Icon";
import DOMPurify from "dompurify";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import { LEVELS, confirmLevel, engineFetch } from "./ActivityView";
import { EmailField, useContacts } from "../EmailAutocomplete";
import { ModelSettings } from "../ModelSetup";

// Sanitize user-authored signature HTML before rendering via
// dangerouslySetInnerHTML or saving back to the DB. Keeps inline styles
// and basic formatting but strips <script>, event handlers, iframes, etc.
function sanitizeSignatureHtml(html: string): string {
  return DOMPurify.sanitize(html ?? "", {
    USE_PROFILES: { html: true },
    ALLOWED_ATTR: [
      "href",
      "src",
      "alt",
      "title",
      "style",
      "class",
      "target",
      "rel",
      "width",
      "height",
      "cellpadding",
      "cellspacing",
      "border",
      "align",
      "color",
      "face",
      "size",
    ],
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
    ],
    FORBID_ATTR: [
      "onerror",
      "onload",
      "onclick",
      "onmouseover",
      "onfocus",
      "onblur",
    ],
  });
}

type DelegationRule = {
  id: string;
  pattern: string;
  target_email: string;
  is_enabled: boolean;
  weight: number;
};

type TabId =
  | "account"
  | "ai"
  | "background"
  | "schedule"
  | "briefing"
  | "automation"
  | "templates"
  | "signatures";

interface EmailTemplate {
  id: string;
  name: string;
  subject: string | null;
  body_html: string;
}

interface EmailSignature {
  id: string;
  name: string;
  html: string;
  is_default: boolean;
  gmail_account_id: string | null;
  created_at: string;
}

function to12h(time24: string): {
  hour: string;
  minute: string;
  ampm: "AM" | "PM";
} {
  const [h, m] = (time24 || "09:00").split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return { hour: String(hour12), minute: String(m).padStart(2, "0"), ampm };
}

function to24h(hour: string, minute: string, ampm: "AM" | "PM"): string {
  let h = parseInt(hour, 10);
  if (ampm === "AM" && h === 12) h = 0;
  if (ampm === "PM" && h !== 12) h += 12;
  return `${h.toString().padStart(2, "0")}:${minute}`;
}

function TimePickerAmPm({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { hour, minute, ampm } = to12h(value || "09:00");

  const openDropdown = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropdownStyle({
        position: "fixed",
        top: rect.bottom + 6,
        left: rect.left,
        width: rect.width < 224 ? 224 : rect.width,
      });
    }
    setOpen(!open);
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        btnRef.current &&
        !btnRef.current.contains(e.target as Node) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="relative mt-1">
      <button
        ref={btnRef}
        type="button"
        onClick={openDropdown}
        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-line hover:border-wax transition-colors group"
      >
        <Icon name="schedule" size={15} className="text-wax" />
        <span className="text-sm font-semibold text-ink flex-1 text-left tabular-nums">
          {hour}:{minute}
        </span>
        <span
          className={`text-xs font-bold px-1.5 py-0.5 rounded ${ampm === "AM" ? "bg-field text-ink2" : "bg-warn-soft text-warn"}`}
        >
          {ampm}
        </span>
        <Icon name={open ? "expand_less" : "expand_more"} size={14} className="text-ink3" />
      </button>

      {open && (
        <div
          ref={dropdownRef}
          style={{ ...dropdownStyle, zIndex: 9999 }}
          className="bg-canvas border border-line rounded-xl shadow-xl p-3 w-56"
        >
          <p className="text-[9px] font-bold text-ink3 uppercase tracking-widest mb-1.5">
            Hour
          </p>
          <div className="grid grid-cols-6 gap-1 mb-3">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => onChange(to24h(String(h), minute, ampm))}
                className={`py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  hour === String(h)
                    ? "bg-wax text-on-wax shadow-sm"
                    : "text-ink2 hover:bg-field"
                }`}
              >
                {h}
              </button>
            ))}
          </div>

          <p className="text-[9px] font-bold text-ink3 uppercase tracking-widest mb-1.5">
            Minute
          </p>
          <div className="flex gap-1 mb-3">
            {["00", "15", "30", "45"].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onChange(to24h(hour, m, ampm))}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  minute === m
                    ? "bg-wax text-on-wax shadow-sm"
                    : "text-ink2 hover:bg-field"
                }`}
              >
                :{m}
              </button>
            ))}
          </div>

          <div className="flex rounded-lg overflow-hidden border border-line">
            {(["AM", "PM"] as const).map((period) => (
              <button
                key={period}
                type="button"
                onClick={() => {
                  onChange(to24h(hour, minute, period));
                  setOpen(false);
                }}
                className={`flex-1 py-1.5 text-xs font-bold transition-all ${
                  ampm === period
                    ? period === "AM"
                      ? "bg-wax text-on-wax"
                      : "bg-warn text-white"
                    : "text-ink3 hover:bg-hover"
                }`}
              >
                {period}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "account", label: "Account", icon: "manage_accounts" },
  { id: "ai", label: "AI", icon: "auto_awesome" },
  { id: "background", label: "Background", icon: "smart_toy" },
  { id: "schedule", label: "Schedule", icon: "schedule" },
  { id: "briefing", label: "Briefing", icon: "summarize" },
  { id: "automation", label: "Automation", icon: "alt_route" },
  { id: "templates", label: "Templates", icon: "description" },
  { id: "signatures", label: "Signatures", icon: "draw" },
];

// The background engine: how much it may do, how it tells you, and whether
// Tabellar starts at login. Each control saves as soon as it changes.
function BackgroundSettings() {
  const { user, profile, updateProfile, addToast } = useApp();
  const supabase = createClient();
  const [level, setLevel] = useState<string>(profile.autonomy_level ?? "suggest");
  const [paused, setPaused] = useState<boolean>(!!profile.engine_paused);
  const [notify, setNotify] = useState<string>(profile.notification_level ?? "important");
  const [preview, setPreview] = useState<boolean>(profile.notification_preview !== false);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [delay, setDelay] = useState<number>(profile.autopilot_delay_min ?? 5);
  const [cap, setCap] = useState<number>(profile.autopilot_daily_cap ?? 5);
  const [knownOnly, setKnownOnly] = useState<boolean>(profile.autopilot_known_only !== false);

  useEffect(() => {
    engineFetch("/engine/status")
      .then((s) => {
        setAutostart(!!s.autostart);
        setLevel(s.level);
        setPaused(!!s.paused);
      })
      .catch(() => setAutostart(false));
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    const { error } = await supabase.from("profiles").update(patch).eq("id", user.id);
    if (error) addToast("error", error.message);
    else updateProfile(patch);
  };

  const toggleAutostart = async (on: boolean) => {
    try {
      const r = await engineFetch("/engine/autostart", { on });
      setAutostart(!!r.autostart);
      addToast("success", on ? "Tabellar will start at login" : "Tabellar will no longer start at login");
    } catch (e) {
      addToast("error", (e as Error).message);
    }
  };

  return (
    <>
      <SectionLabel>What Tabellar may do on its own</SectionLabel>
      <SectionCard>
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => {
              if (!confirmLevel(l.id)) return;
              setLevel(l.id);
              save({ autonomy_level: l.id });
            }}
            className="w-full flex items-start gap-3 py-3.5 px-5 border-b border-line last:border-0 text-left hover:bg-field transition-colors"
          >
            <Icon name={level === l.id ? "radio_button_checked" : "radio_button_unchecked"} size={18} fill={level === l.id} className="mt-0.5" style={{ color: level === l.id ? "var(--wax)" : "var(--ink3)" }} />
            <span>
              <span className="block text-sm font-medium text-ink">{l.label}</span>
              <span className="block text-xs text-ink3 mt-0.5">{l.text}</span>
            </span>
          </button>
        ))}
        <SettingRow label="Pause" description="Stops every action at once, including the agent and the assistant. Mail still syncs.">
          <Toggle
            value={paused}
            onChange={(v) => {
              setPaused(v);
              save({ engine_paused: v });
            }}
          />
        </SettingRow>
      </SectionCard>
      <p className="text-xs text-ink3 px-1 -mt-1">
        It never deletes mail. Everything it does is listed in Activity, where labels, drafts, todos and meeting proposals can be undone.
      </p>

      {level === "autopilot" && (
        <>
          <SectionLabel>Autopilot limits</SectionLabel>
          <SectionCard>
            <SettingRow label="Wait before sending" description="Each reply waits this long in Activity, where you can read it and cancel it.">
              <select
                value={delay}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDelay(v);
                  save({ autopilot_delay_min: v });
                }}
                className="text-sm bg-field border border-line rounded-lg px-2 py-1.5 text-ink"
              >
                {[2, 5, 10, 30, 60].map((m) => (
                  <option key={m} value={m}>{m} minutes</option>
                ))}
              </select>
            </SettingRow>
            <SettingRow label="Replies per day" description="After this many, replies are saved as drafts until tomorrow.">
              <select
                value={cap}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setCap(v);
                  save({ autopilot_daily_cap: v });
                }}
                className="text-sm bg-field border border-line rounded-lg px-2 py-1.5 text-ink"
              >
                {[1, 3, 5, 10, 20].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </SettingRow>
            <SettingRow label="Only people I have written to" description="Anyone else gets a draft for you to send yourself.">
              <Toggle
                value={knownOnly}
                onChange={(v) => {
                  setKnownOnly(v);
                  save({ autopilot_known_only: v });
                }}
              />
            </SettingRow>
          </SectionCard>
          <p className="text-xs text-ink3 px-1 -mt-1">
            Autopilot only answers the person who wrote, inside the same thread, with nobody copied in and no attachments. When a good answer needs a decision or facts it does not have, it saves a draft instead.
          </p>
        </>
      )}

      <SectionLabel>Notifications</SectionLabel>
      <SectionCard>
        <SettingRow label="Notify me about" description="macOS notifications for new mail, sent while Tabellar runs, with the window open or closed.">
          <select
            value={notify}
            onChange={(e) => {
              setNotify(e.target.value);
              save({ notification_level: e.target.value });
            }}
            className="text-sm bg-field border border-line rounded-lg px-2 py-1.5 text-ink"
          >
            <option value="important">Important and action needed</option>
            <option value="all">All new mail</option>
            <option value="none">Nothing</option>
          </select>
        </SettingRow>
        <SettingRow label="Show sender and summary" description="Off shows only that something arrived, for privacy on a shared screen.">
          <Toggle
            value={preview}
            onChange={(v) => {
              setPreview(v);
              save({ notification_preview: v });
            }}
          />
        </SettingRow>
      </SectionCard>

      <SectionLabel>Running in the background</SectionLabel>
      <SectionCard>
        <SettingRow label="Start at login" description="Keeps Tabellar running after you close this window and the terminal, and restarts it if it stops unexpectedly.">
          {autostart === null ? (
            <Icon name="progress_activity" size={18} className="animate-spin text-ink3" />
          ) : (
            <Toggle value={autostart} onChange={toggleAutostart} />
          )}
        </SettingRow>
      </SectionCard>
    </>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-4 px-5 border-b border-line last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        {description && (
          <p className="text-xs text-ink3 mt-0.5 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${value ? "bg-wax" : "bg-ink4"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${value ? "translate-x-5" : ""}`}
      />
    </button>
  );
}

function SectionCard({
  children,
  className = "",
  allowOverflow = false,
}: {
  children: React.ReactNode;
  className?: string;
  allowOverflow?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-line ${allowOverflow ? "overflow-visible" : "overflow-hidden"} ${className}`}
    >
      {children}
    </div>
  );
}

function SectionLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`text-[11px] font-semibold uppercase tracking-widest px-1 pt-1 pb-1 text-ink3 ${className}`}
    >
      {children}
    </p>
  );
}

export default function SettingsView() {
  const {
    user,
    profile,
    updateProfile,
    addToast,
  } = useApp();
  const supabase = createClient();
  const { contacts } = useContacts(user.id);

  const [activeTab, setActiveTab] = useState<TabId>("account");

  // Delegation rules
  const [delegations, setDelegations] = useState<DelegationRule[]>([]);
  const [delegationsLoaded, setDelegationsLoaded] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [newTargetEmail, setNewTargetEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(true);
  const [gmailAccounts, setGmailAccounts] = useState<
    { id: string; gmail_address: string }[]
  >([]);
  const [removingAccount, setRemovingAccount] = useState<string | null>(null);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(
    null,
  );
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [templateForm, setTemplateForm] = useState<{
    name: string;
    subject: string;
    body_html: string;
  }>({ name: "", subject: "", body_html: "" });
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Signatures
  const [signatures, setSignatures] = useState<EmailSignature[]>([]);
  const [signaturesLoaded, setSignaturesLoaded] = useState(false);
  const [editingSignature, setEditingSignature] =
    useState<EmailSignature | null>(null);
  const [sigForm, setSigForm] = useState<{
    name: string;
    html: string;
    is_default: boolean;
    gmail_account_id: string;
  }>({ name: "", html: "", is_default: false, gmail_account_id: "" });
  const [savingSignature, setSavingSignature] = useState(false);
  const [showSigEditor, setShowSigEditor] = useState(false);

  // Writing style
  const [styleNotes, setStyleNotes] = useState(profile?.style_notes || "");
  const [detectedStyle, setDetectedStyle] = useState<{
    greeting_style: string;
    closing_style: string;
    tone: string;
    avg_length: string;
    last_learned_at: string;
  } | null>(null);
  const [styleGreeting, setStyleGreeting] = useState("");
  const [styleClosing, setStyleClosing] = useState("");
  const [styleTone, setStyleTone] = useState("");
  const [styleLength, setStyleLength] = useState("");
  const [detectingStyle, setDetectingStyle] = useState(false);

  const handleDetectStyle = async () => {
    if (detectingStyle) return;
    setDetectingStyle(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        addToast("error", "Session expired. Please sign in again.");
        return;
      }
      const res = await fetch(
        `/api/learn-style`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        addToast(
          "error",
          err.error || "Couldn't detect style yet. Send a few emails first.",
        );
        return;
      }
      const data = await res.json();
      const s = data.style || {};
      setDetectedStyle({
        greeting_style: s.greeting_style || "",
        closing_style: s.closing_style || "",
        tone: s.tone || "",
        avg_length: s.avg_length || "",
        last_learned_at: new Date().toISOString(),
      });
      setStyleGreeting(s.greeting_style || "");
      setStyleClosing(s.closing_style || "");
      setStyleTone(s.tone || "");
      setStyleLength(s.avg_length || "");
      addToast(
        "success",
        `Writing style detected from ${data.sample_count} sent emails.`,
      );
    } catch {
      addToast("error", "Could not detect writing style.");
    } finally {
      setDetectingStyle(false);
    }
  };

  // Working hours
  const [workStart, setWorkStart] = useState("09:00");
  const [workEnd, setWorkEnd] = useState("17:00");
  const [workDays, setWorkDays] = useState([1, 2, 3, 4, 5]);
  const [workDnd, setWorkDnd] = useState(false);

  // Briefing scope
  const [briefingScope, setBriefingScope] = useState(
    profile?.briefing_scope || "today_new",
  );

  // Calendar invites
  const [calendarSendInvites, setCalendarSendInvites] = useState(
    profile?.calendar_send_invites !== false,
  );

  const loadGmailAccounts = () => {
    supabase
      .from("gmail_accounts")
      .select("id, gmail_address")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .then(({ data }) =>
        setGmailAccounts(
          (data || []) as { id: string; gmail_address: string }[],
        ),
      );
  };

  const loadDelegations = async () => {
    const { data } = await supabase
      .from("delegation_rules")
      .select("*")
      .eq("user_id", user.id)
      .order("weight", { ascending: false })
      .limit(200);
    setDelegations(data || []);
    setDelegationsLoaded(true);
  };

  const loadTemplates = async () => {
    const { data } = await supabase
      .from("email_templates")
      .select("id, name, subject, body_html")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setEmailTemplates(data || []);
    setTemplatesLoaded(true);
  };

  const deleteTemplate = async (id: string) => {
    await supabase.from("email_templates").delete().eq("id", id);
    setEmailTemplates((prev) => prev.filter((t) => t.id !== id));
    if (editingTemplate?.id === id) setShowTemplateEditor(false);
    addToast("success", "Template deleted");
  };

  const openNewTemplate = () => {
    setEditingTemplate(null);
    setTemplateForm({ name: "", subject: "", body_html: "" });
    setShowTemplateEditor(true);
  };

  const openEditTemplate = (t: EmailTemplate) => {
    setEditingTemplate(t);
    setTemplateForm({
      name: t.name,
      subject: t.subject || "",
      body_html: t.body_html,
    });
    setShowTemplateEditor(true);
  };

  const saveTemplate = async () => {
    if (!templateForm.name.trim()) {
      addToast("error", "Template name is required");
      return;
    }
    if (!templateForm.body_html.trim()) {
      addToast("error", "Template body is required");
      return;
    }
    setSavingTemplate(true);
    if (editingTemplate) {
      const { data } = await supabase
        .from("email_templates")
        .update({
          name: templateForm.name,
          subject: templateForm.subject || null,
          body_html: templateForm.body_html,
        })
        .eq("id", editingTemplate.id)
        .select("id, name, subject, body_html");
      if (data?.[0]) {
        setEmailTemplates((prev) =>
          prev.map((t) => (t.id === editingTemplate.id ? data[0] : t)),
        );
        setShowTemplateEditor(false);
        addToast("success", "Template updated");
      } else {
        addToast("error", "Failed to update template");
      }
    } else {
      const { data } = await supabase
        .from("email_templates")
        .insert({
          user_id: user.id,
          name: templateForm.name,
          subject: templateForm.subject || null,
          body_html: templateForm.body_html,
        })
        .select("id, name, subject, body_html");
      if (data?.[0]) {
        setEmailTemplates((prev) => [data[0], ...prev]);
        setShowTemplateEditor(false);
        addToast("success", "Template created");
      } else {
        addToast("error", "Failed to create template");
      }
    }
    setSavingTemplate(false);
  };

  const loadSignatures = async () => {
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
      setSignatures(json.signatures ?? []);
    } catch {
      /* non-critical */
    }
    setSignaturesLoaded(true);
  };

  const openNewSignature = () => {
    setEditingSignature(null);
    const displayName = profile?.display_name || "Your Name";
    setSigForm({
      name: "",
      html: `<p><strong>${displayName}</strong><br />Your Title<br />Your Company</p>`,
      is_default: signatures.length === 0,
      gmail_account_id: gmailAccounts[0]?.id || "",
    });
    setShowSigEditor(true);
  };

  const openEditSignature = (sig: EmailSignature) => {
    setEditingSignature(sig);
    setSigForm({
      name: sig.name,
      html: sig.html,
      is_default: sig.is_default,
      gmail_account_id: sig.gmail_account_id || "",
    });
    setShowSigEditor(true);
  };

  const saveSignature = async () => {
    if (!sigForm.name.trim()) {
      addToast("error", "Signature name is required");
      return;
    }
    setSavingSignature(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setSavingSignature(false);
      return;
    }
    try {
      const body = {
        name: sigForm.name,
        html: sanitizeSignatureHtml(sigForm.html),
        is_default: sigForm.is_default,
        gmail_account_id: sigForm.gmail_account_id || null,
      };
      const url = editingSignature
        ? `/api/signatures/${editingSignature.id}`
        : `/api/signatures`;
      const res = await fetch(url, {
        method: editingSignature ? "PATCH" : "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.signature) {
        if (editingSignature) {
          setSignatures((prev) =>
            prev.map((s) =>
              s.id === editingSignature.id
                ? json.signature
                : sigForm.is_default
                  ? { ...s, is_default: false }
                  : s,
            ),
          );
        } else {
          setSignatures((prev) => [
            ...(sigForm.is_default
              ? prev.map((s) => ({ ...s, is_default: false }))
              : prev),
            json.signature,
          ]);
        }
        setShowSigEditor(false);
        addToast(
          "success",
          editingSignature ? "Signature updated" : "Signature created",
        );
      } else {
        addToast("error", json.error || "Failed to save signature");
      }
    } catch {
      addToast("error", "Failed to save signature");
    }
    setSavingSignature(false);
  };

  const deleteSignature = async (id: string) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    await fetch(
      `/api/signatures/${id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      },
    );
    setSignatures((prev) => prev.filter((s) => s.id !== id));
    addToast("success", "Signature deleted");
  };

  const addDelegation = async () => {
    if (!newPattern.trim() || !newTargetEmail.trim()) return;
    const { data } = await supabase
      .from("delegation_rules")
      .insert({
        user_id: user.id,
        pattern: newPattern.trim(),
        target_email: newTargetEmail.trim(),
      })
      .select();
    if (data?.[0]) setDelegations((prev) => [data[0], ...prev]);
    setNewPattern("");
    setNewTargetEmail("");
  };

  const toggleDelegation = async (id: string, enabled: boolean) => {
    await supabase
      .from("delegation_rules")
      .update({ is_enabled: !enabled })
      .eq("id", id);
    setDelegations((prev) =>
      prev.map((d) => (d.id === id ? { ...d, is_enabled: !enabled } : d)),
    );
  };

  const deleteDelegation = async (id: string) => {
    await supabase.from("delegation_rules").delete().eq("id", id);
    setDelegations((prev) => prev.filter((d) => d.id !== id));
  };

  const removeGmailAccount = async (accountId: string) => {
    setRemovingAccount(accountId);
    try {
      const apiUrl = "/api";
      const {
        data: { session },
      } = await supabase.auth.getSession();
      await fetch(`${apiUrl}/remove-gmail-account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ account_id: accountId }),
      });
      const remaining = gmailAccounts.filter((a) => a.id !== accountId);
      if (remaining.length === 0) {
        await supabase.auth.signOut();
        window.location.href = "/";
      } else {
        loadGmailAccounts();
      }
    } catch {
      /* ignore */
    }
    setRemovingAccount(null);
  };

  useEffect(() => {
    loadGmailAccounts();

    supabase
      .from("style_profiles")
      .select(
        "greeting_style, closing_style, tone, avg_length, last_learned_at",
      )
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          const s = data as {
            greeting_style: string;
            closing_style: string;
            tone: string;
            avg_length: string;
            last_learned_at: string;
          };
          setDetectedStyle(s);
          setStyleGreeting(s.greeting_style || "");
          setStyleClosing(s.closing_style || "");
          setStyleTone(s.tone || "");
          setStyleLength(s.avg_length || "");
        }
      });

    if (profile?.working_hours) {
      const wh = profile.working_hours as any;
      if (wh.start) setWorkStart(wh.start);
      if (wh.end) setWorkEnd(wh.end);
      if (wh.days) setWorkDays(wh.days);
      if (wh.dnd !== undefined) setWorkDnd(!!wh.dnd);
    }

    loadDelegations();
    loadTemplates();
    loadSignatures();
  }, [user.id]);

  const autoSave = async () => {
    setSaving(true);
    const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { error: profileErr } = await supabase
      .from("profiles")
      .update({
        style_notes: styleNotes || null,
        working_hours: {
          start: workStart,
          end: workEnd,
          days: workDays,
          timezone: detectedTimezone,
          dnd: workDnd,
        },
        briefing_scope: briefingScope,
        calendar_send_invites: calendarSendInvites,
      })
      .eq("id", user.id);
    let styleErr: { message?: string } | null = null;
    if (
      detectedStyle ||
      styleGreeting ||
      styleClosing ||
      styleTone ||
      styleLength
    ) {
      const res = await supabase.from("style_profiles").upsert(
        {
          user_id: user.id,
          greeting_style: styleGreeting || null,
          closing_style: styleClosing || null,
          tone: styleTone || null,
          avg_length: styleLength || null,
        },
        { onConflict: "user_id" },
      );
      styleErr = res.error;
    }
    setSaving(false);
    if (profileErr || styleErr) {
      console.error("[settings/autosave] failed:", profileErr ?? styleErr);
      const hint =
        profileErr?.message || styleErr?.message || "Failed to save settings";
      addToast("error", hint);
      return;
    }
    updateProfile({
      style_notes: styleNotes || null,
      working_hours: {
        start: workStart,
        end: workEnd,
        days: workDays,
        timezone: detectedTimezone,
        dnd: workDnd,
      },
      briefing_scope: briefingScope,
      calendar_send_invites: calendarSendInvites,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  useEffect(() => {
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      return;
    }
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      autoSave();
    }, 800);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [
    styleNotes,
    workStart,
    workEnd,
    workDays,
    workDnd,
    briefingScope,
    calendarSendInvites,
    styleGreeting,
    styleClosing,
    styleTone,
    styleLength,
  ]);

  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const connectGmail = async (addAccount = false) => {
    if (addAccount) {
      window.location.assign("/oauth/start");
    } else {
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          scopes:
            "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
          queryParams: { access_type: "offline", prompt: "consent" },
        },
      });
    }
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="max-w-xl mx-auto w-full px-6 pt-6 pb-0 shrink-0">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-lg font-bold text-ink">
            Settings
          </h1>
          {(saving || saved) && (
            <div
              className={`flex items-center gap-1.5 text-xs font-medium transition-all ${saved ? "text-ok" : "text-ink3"}`}
            >
              <Icon name={saving ? "sync" : "check_circle"} size={14} />
              {saving ? "Saving..." : "Saved"}
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex gap-0.5 bg-field rounded-xl p-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg text-center transition-all duration-150 ${
                activeTab === tab.id
                  ? "bg-canvas text-wax shadow-sm"
                  : "text-ink3 hover:text-ink"
              }`}
            >
              <Icon name={tab.icon} size={18} />
              <span className="text-[10px] font-semibold tracking-wide">
                {tab.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 px-6 py-5">
        <div className="max-w-xl mx-auto space-y-4">
          {/* ---- ACCOUNT ---- */}
          {activeTab === "account" && (
            <>
              <SectionLabel>Gmail Accounts</SectionLabel>
              <SectionCard>
                {gmailAccounts.length === 0 ? (
                  <div className="p-4 flex items-center gap-3 text-ink3">
                    <Icon name="error" size={22} />
                    <p className="text-sm">
                      No Gmail account connected. Connect one to start fetching
                      emails.
                    </p>
                  </div>
                ) : (
                  gmailAccounts.map((acc) => (
                    <div
                      key={acc.id}
                      className="p-3 flex items-center gap-3 border-b border-line last:border-0"
                    >
                      <Icon name="check_circle" size={20} className="text-ok" />
                      <p className="text-sm font-medium text-ink flex-1 truncate">
                        {acc.gmail_address || "Connected account"}
                      </p>
                      <button
                        onClick={() => connectGmail(false)}
                        title="Re-connect"
                        className="p-1.5 rounded-lg hover:bg-field text-ink3"
                      >
                        <Icon name="sync" size={16} />
                      </button>
                      <button
                        onClick={() => removeGmailAccount(acc.id)}
                        disabled={removingAccount === acc.id}
                        title="Remove"
                        className="p-1.5 rounded-lg hover:bg-danger-soft text-danger disabled:opacity-50"
                      >
                        <Icon name={removingAccount === acc.id
                            ? "hourglass_top"
                            : "close"} size={16} />
                      </button>
                    </div>
                  ))
                )}
                <div className="p-3 border-t border-line">
                  <button
                    onClick={() => connectGmail(gmailAccounts.length > 0)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-dashed border-line text-sm text-ink3 hover:border-wax hover:text-wax transition-colors"
                  >
                    <Icon name="add" size={18} />
                    {gmailAccounts.length === 0
                      ? "Connect Gmail"
                      : "Add another account"}
                  </button>
                </div>
              </SectionCard>
            </>
          )}

          {activeTab === "background" && <BackgroundSettings />}

          {/* ---- AI & WRITING ---- */}
          {activeTab === "ai" && (
            <>
              <SectionLabel>Model</SectionLabel>
              <SectionCard allowOverflow>
                <div className="p-4">
                  <ModelSettings />
                </div>
              </SectionCard>

              <SectionLabel>Writing Style</SectionLabel>
              <SectionCard>
                <div className="p-4 border-b border-line">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <Icon name="auto_awesome" size={15} className="text-wax" />
                      <span className="text-xs font-medium text-wax">
                        {detectedStyle
                          ? "Auto-detected from your sent emails"
                          : "Detect from your sent emails or set manually"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={handleDetectStyle}
                      disabled={detectingStyle}
                      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-wax text-on-wax hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                      <Icon name={detectingStyle ? "progress_activity" : "auto_fix"} size={13} className={`${detectingStyle ? " animate-spin" : ""}`} />
                      {detectingStyle
                        ? "Detecting..."
                        : detectedStyle
                          ? "Redetect"
                          : "Detect now"}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      {
                        label: "Greeting",
                        value: styleGreeting,
                        set: setStyleGreeting,
                        placeholder: "e.g. Hi",
                      },
                      {
                        label: "Closing",
                        value: styleClosing,
                        set: setStyleClosing,
                        placeholder: "e.g. Best regards",
                      },
                      {
                        label: "Tone",
                        value: styleTone,
                        set: setStyleTone,
                        placeholder: "e.g. casual",
                      },
                      {
                        label: "Length",
                        value: styleLength,
                        set: setStyleLength,
                        placeholder: "e.g. short",
                      },
                    ].map(({ label, value, set, placeholder }) => (
                      <div key={label} className="flex flex-col gap-1">
                        <span className="text-xs text-ink3">
                          {label}
                        </span>
                        <input
                          type="text"
                          value={value}
                          onChange={(e) => set(e.target.value)}
                          placeholder={placeholder}
                          className="px-2 py-1.5 rounded-lg border border-line bg-transparent text-xs font-medium text-ink placeholder:text-ink3 focus:outline-none focus:ring-1 focus:ring-wax"
                        />
                      </div>
                    ))}
                  </div>
                  {!detectedStyle &&
                    !styleGreeting &&
                    !styleClosing &&
                    !styleTone &&
                    !styleLength && (
                      <p className="text-[11px] text-ink3 mt-2">
                        Style not yet detected. Click Detect now, or fill these
                        fields manually.
                      </p>
                    )}
                </div>
                <div className="p-4">
                  <p className="text-xs text-ink3 mb-3">
                    Override or add context the AI can&apos;t detect, e.g.
                    &quot;Always sign off with &apos;Best, George&apos;&quot; or
                    &quot;Never use bullet points&quot;.
                  </p>
                  <textarea
                    value={styleNotes}
                    onChange={(e) => setStyleNotes(e.target.value)}
                    placeholder="e.g. Always sign off with 'Best, George'. Never use bullet points."
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg border border-line bg-transparent text-sm text-ink placeholder:text-ink3 focus:outline-none focus:ring-1 focus:ring-wax resize-none"
                  />
                </div>
              </SectionCard>
            </>
          )}

          {/* ---- SCHEDULE ---- */}
          {activeTab === "schedule" && (
            <>
              <SectionLabel>Working Hours</SectionLabel>
              <SectionCard allowOverflow>
                <div className="p-4 border-b border-line">
                  <p className="text-xs font-medium text-ink3 mb-2">
                    Work Days
                  </p>
                  <div className="flex gap-1.5">
                    {dayLabels.map((day, i) => (
                      <button
                        key={i}
                        onClick={() =>
                          setWorkDays((prev) =>
                            prev.includes(i)
                              ? prev.filter((d) => d !== i)
                              : [...prev, i],
                          )
                        }
                        className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          workDays.includes(i)
                            ? "bg-wax text-on-wax"
                            : "bg-field text-ink3 hover:bg-sel"
                        }`}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="p-4 overflow-visible">
                  <p className="text-xs font-medium text-ink3 mb-2">
                    Hours
                  </p>
                  <div className="flex items-center gap-3 overflow-visible">
                    <div className="flex-1 overflow-visible">
                      <label className="text-[10px] text-ink3 uppercase tracking-wide">
                        Start
                      </label>
                      <TimePickerAmPm
                        value={workStart}
                        onChange={setWorkStart}
                      />
                    </div>
                    <span className="text-ink3 mt-6 text-sm">to</span>
                    <div className="flex-1 overflow-visible">
                      <label className="text-[10px] text-ink3 uppercase tracking-wide">
                        End
                      </label>
                      <TimePickerAmPm value={workEnd} onChange={setWorkEnd} />
                    </div>
                  </div>
                </div>
              </SectionCard>
            </>
          )}

          {/* ---- BRIEFING ---- */}
          {activeTab === "briefing" && (
            <>
              <SectionLabel>Daily Briefing Scope</SectionLabel>
              <SectionCard>
                <div className="px-4 pt-3 pb-2 border-b border-line">
                  <p className="text-xs text-ink3">
                    Choose which emails are included in your AI-generated daily
                    briefing.
                  </p>
                </div>
                {(
                  [
                    {
                      id: "today_new",
                      icon: "today",
                      label: "Today",
                      desc: "New emails from today only.",
                    },
                    {
                      id: "past_2_days",
                      icon: "calendar_view_day",
                      label: "2 days",
                      desc: "Everything from the last 2 days; good for catching up after a day off.",
                    },
                    {
                      id: "past_week",
                      icon: "date_range",
                      label: "Week",
                      desc: "Emails from the last 7 days for a broader overview.",
                    },
                    {
                      id: "all_recent",
                      icon: "inbox",
                      label: "Full inbox",
                      desc: "Your 40 most recent emails regardless of date.",
                    },
                  ] as const
                ).map((opt, i, arr) => (
                  <button
                    key={opt.id}
                    onClick={() => setBriefingScope(opt.id)}
                    className={`w-full text-left flex items-center gap-3 p-4 transition-colors ${
                      i < arr.length - 1
                        ? "border-b border-line"
                        : ""
                    } ${briefingScope === opt.id ? "bg-wax-soft" : "hover:bg-hover"}`}
                  >
                    <Icon name={opt.icon} size={20} className={`${briefingScope === opt.id ? "text-wax" : "text-ink3"}`} />
                    <div className="flex-1">
                      <p
                        className={`text-sm font-medium ${briefingScope === opt.id ? "text-wax" : "text-ink"}`}
                      >
                        {opt.label}
                      </p>
                      <p className="text-xs text-ink3 mt-0.5">
                        {opt.desc}
                      </p>
                    </div>
                    <div
                      className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${briefingScope === opt.id ? "border-wax" : "border-line"}`}
                    >
                      {briefingScope === opt.id && (
                        <div className="w-2 h-2 rounded-full bg-wax" />
                      )}
                    </div>
                  </button>
                ))}
              </SectionCard>

              <SectionLabel>Calendar</SectionLabel>
              <SectionCard>
                <SettingRow
                  label="Send calendar invites to attendees"
                  description="When enabled, attendees receive Google Calendar notification emails when you create or update meetings."
                >
                  <Toggle
                    value={calendarSendInvites}
                    onChange={setCalendarSendInvites}
                  />
                </SettingRow>
              </SectionCard>
            </>
          )}

          {/* ---- AUTOMATION ---- */}
          {activeTab === "automation" && (
            <>
              <SectionLabel>Delegation Rules</SectionLabel>
              <SectionCard>
                <div className="p-4 border-b border-line bg-hover space-y-3">
                  <p className="text-xs text-ink3">
                    When an email matches the pattern, it will be flagged for
                    forwarding to the target address.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="text"
                      value={newPattern}
                      onChange={(e) => setNewPattern(e.target.value)}
                      placeholder="Pattern (e.g. invoice, support request)"
                      className="flex-1 min-w-[150px] px-3 py-1.5 rounded-lg border border-line bg-canvas text-sm text-ink focus:outline-none focus:ring-1 focus:ring-wax"
                    />
                    <EmailField
                      value={newTargetEmail}
                      onChange={setNewTargetEmail}
                      contacts={contacts}
                      placeholder="Forward to email"
                      multi={false}
                      className="flex-1 min-w-[150px]"
                    />
                    <button
                      onClick={addDelegation}
                      disabled={!newPattern.trim() || !newTargetEmail.trim()}
                      className="px-4 py-1.5 rounded-lg bg-wax text-on-wax text-sm font-medium hover:opacity-90 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                </div>
                {!delegationsLoaded ? (
                  <div className="p-4 text-sm text-ink3">
                    Loading...
                  </div>
                ) : delegations.length === 0 ? (
                  <div className="p-8 text-center text-sm text-ink3">
                    <Icon name="alt_route" size={32} className="block mx-auto mb-2 text-ink4" />
                    No delegation rules yet.
                  </div>
                ) : (
                  <div className="divide-y divide-line">
                    {delegations.map((d) => (
                      <div
                        key={d.id}
                        className="flex items-center gap-3 p-3 group"
                      >
                        <button
                          onClick={() => toggleDelegation(d.id, d.is_enabled)}
                        >
                          <Icon name="toggle_on" size={22} fill={d.is_enabled} className={`${d.is_enabled ? "text-ok" : "text-ink3"}`} />
                        </button>
                        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-ink">
                            &ldquo;{d.pattern}&rdquo;
                          </span>
                          <Icon name="arrow_forward" size={16} className="text-ink3" />
                          <span className="text-sm text-wax">
                            {d.target_email}
                          </span>
                        </div>
                        <button
                          onClick={() => deleteDelegation(d.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-danger-soft text-danger transition-opacity"
                        >
                          <Icon name="delete" size={18} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </>
          )}

          {activeTab === "templates" && (
            <>
              <div className="flex items-center justify-between mb-2">
                <SectionLabel className="mb-0">Email Templates</SectionLabel>
                <button
                  onClick={openNewTemplate}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-wax text-on-wax text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <Icon name="add" size={15} />
                  New Template
                </button>
              </div>

              {/* Template editor */}
              {showTemplateEditor && (
                <SectionCard className="mb-4 border-wax shadow-sm">
                  <div className="p-4 border-b border-line flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-wax flex items-center justify-center">
                        <Icon name="description" size={15} fill className="text-white" />
                      </div>
                      <p className="text-sm font-semibold text-ink">
                        {editingTemplate ? "Edit Template" : "New Template"}
                      </p>
                    </div>
                    <button
                      onClick={() => setShowTemplateEditor(false)}
                      className="p-1 rounded hover:bg-field text-ink3 cursor-pointer"
                    >
                      <Icon name="close" size={18} />
                    </button>
                  </div>

                  <div className="p-4 space-y-4">
                    {/* Name */}
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-widest text-ink3 mb-1.5">
                        Template Name
                      </label>
                      <input
                        type="text"
                        value={templateForm.name}
                        onChange={(e) =>
                          setTemplateForm((f) => ({
                            ...f,
                            name: e.target.value,
                          }))
                        }
                        placeholder="e.g. Follow-up, Introduction, Thank you"
                        className="w-full px-3 py-2 rounded-lg border border-line bg-canvas text-sm text-ink focus:outline-none focus:border-wax transition-colors"
                      />
                    </div>

                    {/* Subject */}
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-widest text-ink3 mb-1.5">
                        Subject{" "}
                        <span className="normal-case font-normal opacity-60">
                          (optional)
                        </span>
                      </label>
                      <input
                        type="text"
                        value={templateForm.subject}
                        onChange={(e) =>
                          setTemplateForm((f) => ({
                            ...f,
                            subject: e.target.value,
                          }))
                        }
                        placeholder="Pre-fill the subject line when applied"
                        className="w-full px-3 py-2 rounded-lg border border-line bg-canvas text-sm text-ink focus:outline-none focus:border-wax transition-colors"
                      />
                    </div>

                    {/* Body */}
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-widest text-ink3 mb-1.5">
                        Body
                      </label>
                      <textarea
                        value={templateForm.body_html}
                        onChange={(e) =>
                          setTemplateForm((f) => ({
                            ...f,
                            body_html: e.target.value,
                          }))
                        }
                        placeholder="Write your template content here..."
                        rows={8}
                        className="w-full px-3 py-2 rounded-lg border border-line bg-canvas text-sm text-ink focus:outline-none focus:border-wax transition-colors resize-y font-mono leading-relaxed"
                      />
                      <p className="text-[11px] text-ink3 mt-1.5">
                        This template can only be applied when composing an
                        email.
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-3 pt-1">
                      <button
                        onClick={saveTemplate}
                        disabled={
                          savingTemplate ||
                          !templateForm.name.trim() ||
                          !templateForm.body_html.trim()
                        }
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-wax text-on-wax text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer"
                      >
                        {savingTemplate && (
                          <Icon name="progress_activity" size={15} className="animate-spin" />
                        )}
                        {editingTemplate ? "Save Changes" : "Create Template"}
                      </button>
                      <button
                        onClick={() => setShowTemplateEditor(false)}
                        className="px-4 py-2 rounded-lg border border-line text-sm text-ink3 hover:text-ink hover:bg-field transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </SectionCard>
              )}

              {/* Template list */}
              <SectionCard>
                {!templatesLoaded ? (
                  <div className="p-6 flex justify-center">
                    <Icon name="progress_activity" size={20} className="animate-spin text-ink3" />
                  </div>
                ) : emailTemplates.length === 0 ? (
                  <div className="p-8 flex flex-col items-center gap-3 text-center">
                    <div className="w-12 h-12 rounded-2xl bg-field flex items-center justify-center">
                      <Icon name="description" size={24} fill className="text-ink3" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-ink opacity-60">
                        No templates yet
                      </p>
                      <p className="text-xs text-ink3 mt-1">
                        Create one above, or save your current message as a
                        template while composing.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="divide-y divide-line">
                    {emailTemplates.map((t) => {
                      const bodyText = t.body_html
                        .replace(/<[^>]+>/g, " ")
                        .replace(/\s+/g, " ")
                        .trim()
                        .slice(0, 120);
                      const isEditing =
                        editingTemplate?.id === t.id && showTemplateEditor;
                      return (
                        <div
                          key={t.id}
                          className={`flex items-start gap-3 px-4 py-3 transition-colors group ${isEditing ? "bg-wax-soft" : "hover:bg-field"}`}
                        >
                          <div className="w-8 h-8 rounded-lg bg-wax-soft flex items-center justify-center shrink-0 mt-0.5">
                            <Icon name="description" size={16} fill className="text-wax" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-ink truncate">
                              {t.name}
                            </p>
                            {t.subject && (
                              <p className="text-xs text-ink3 truncate mt-0.5">
                                Subject: {t.subject}
                              </p>
                            )}
                            {bodyText && (
                              <p className="text-xs text-ink3 truncate mt-0.5 opacity-70">
                                {bodyText}
                                {bodyText.length === 120 ? "..." : ""}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() =>
                                isEditing
                                  ? setShowTemplateEditor(false)
                                  : openEditTemplate(t)
                              }
                              className="p-1 rounded hover:bg-field text-ink3 hover:text-wax transition-colors"
                              title={
                                isEditing ? "Close editor" : "Edit template"
                              }
                            >
                              <Icon name={isEditing ? "close" : "edit"} size={16} />
                            </button>
                            <button
                              onClick={() => deleteTemplate(t.id)}
                              className="p-1 rounded hover:bg-danger-soft text-ink3 hover:text-danger transition-colors"
                              title="Delete template"
                            >
                              <Icon name="delete" size={16} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SectionCard>
            </>
          )}

          {activeTab === "signatures" && (
            <>
              <div className="flex items-center justify-between mb-2">
                <SectionLabel className="mb-0">Email Signatures</SectionLabel>
                <button
                  onClick={openNewSignature}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-wax text-on-wax text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <Icon name="add" size={15} />
                  New Signature
                </button>
              </div>

              {/* Editor / form */}
              {showSigEditor && (
                <SectionCard className="mb-4 border-wax shadow-sm">
                  <div className="p-4 border-b border-line flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-wax flex items-center justify-center">
                        <Icon name="draw" size={15} fill className="text-white" />
                      </div>
                      <p className="text-sm font-semibold text-ink">
                        {editingSignature ? "Edit Signature" : "New Signature"}
                      </p>
                    </div>
                    <button
                      onClick={() => setShowSigEditor(false)}
                      className="p-1 rounded hover:bg-field text-ink3 cursor-pointer"
                    >
                      <Icon name="close" size={18} />
                    </button>
                  </div>

                  <div className="p-4 space-y-4">
                    {/* Name + account row */}
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-[11px] font-semibold uppercase tracking-widest text-ink3 mb-1.5">
                          Name
                        </label>
                        <input
                          type="text"
                          value={sigForm.name}
                          onChange={(e) =>
                            setSigForm((f) => ({ ...f, name: e.target.value }))
                          }
                          placeholder="e.g. Work Signature"
                          className="w-full px-3 py-2 rounded-lg border border-line bg-canvas text-sm text-ink focus:outline-none focus:border-wax transition-colors"
                        />
                      </div>
                      {gmailAccounts.length > 1 && (
                        <div className="flex-1">
                          <label className="block text-[11px] font-semibold uppercase tracking-widest text-ink3 mb-1.5">
                            Account
                          </label>
                          <select
                            value={sigForm.gmail_account_id}
                            onChange={(e) =>
                              setSigForm((f) => ({
                                ...f,
                                gmail_account_id: e.target.value,
                              }))
                            }
                            className="w-full px-3 py-2 rounded-lg border border-line bg-canvas text-sm text-ink focus:outline-none focus:border-wax transition-colors cursor-pointer"
                          >
                            <option value="">All accounts</option>
                            {gmailAccounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.gmail_address}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    {/* Rich HTML body */}
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-widest text-ink3 mb-1.5">
                        Signature Content
                      </label>
                      {/* Simple contenteditable-backed rich area */}
                      <div className="rounded-xl border border-line overflow-hidden">
                        {/* Mini toolbar */}
                        <div className="flex items-center gap-1 px-3 py-2 bg-field border-b border-line">
                          {[
                            { cmd: "bold", icon: "format_bold", title: "Bold" },
                            {
                              cmd: "italic",
                              icon: "format_italic",
                              title: "Italic",
                            },
                            {
                              cmd: "underline",
                              icon: "format_underlined",
                              title: "Underline",
                            },
                          ].map(({ cmd, icon, title }) => (
                            <button
                              key={cmd}
                              type="button"
                              title={title}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                document.execCommand(cmd, false);
                              }}
                              className="p-1.5 rounded hover:bg-line text-ink transition-colors cursor-pointer"
                            >
                              <Icon name={icon} size={16} />
                            </button>
                          ))}
                          <div className="w-px h-5 bg-line mx-1" />
                          <button
                            type="button"
                            title="Insert link"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              const url = prompt("Link URL:");
                              if (url)
                                document.execCommand("createLink", false, url);
                            }}
                            className="p-1.5 rounded hover:bg-line text-ink transition-colors cursor-pointer"
                          >
                            <Icon name="link" size={16} />
                          </button>
                          <button
                            type="button"
                            title="Clear formatting"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              document.execCommand("removeFormat", false);
                            }}
                            className="p-1.5 rounded hover:bg-line text-ink transition-colors cursor-pointer"
                          >
                            <Icon name="format_clear" size={16} />
                          </button>
                        </div>
                        <div
                          contentEditable
                          suppressContentEditableWarning
                          dangerouslySetInnerHTML={{
                            __html: sanitizeSignatureHtml(sigForm.html),
                          }}
                          onInput={(e) =>
                            setSigForm((f) => ({
                              ...f,
                              html: (e.target as HTMLDivElement).innerHTML,
                            }))
                          }
                          className="min-h-[120px] p-4 text-sm text-ink focus:outline-none"
                          style={{ lineHeight: "1.6" }}
                        />
                      </div>
                      <p className="text-[11px] text-ink3 mt-1.5">
                        Your signature is your contact block, appended after
                        your closing (e.g. "Best regards,"). Include your name,
                        title, company, phone, or a link.
                      </p>
                    </div>

                    {/* Default toggle */}
                    <div className="flex items-center justify-between py-3 px-4 rounded-xl bg-field">
                      <div>
                        <p className="text-sm font-medium text-ink">
                          Set as default
                        </p>
                        <p className="text-xs text-ink3 mt-0.5">
                          Auto-append to new emails
                          {gmailAccounts.length > 1
                            ? " for the selected account"
                            : ""}
                        </p>
                      </div>
                      <Toggle
                        value={sigForm.is_default}
                        onChange={(v) =>
                          setSigForm((f) => ({ ...f, is_default: v }))
                        }
                      />
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-3 pt-1">
                      <button
                        onClick={saveSignature}
                        disabled={savingSignature || !sigForm.name.trim()}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-wax text-on-wax text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-all cursor-pointer"
                      >
                        {savingSignature ? (
                          <Icon name="progress_activity" size={16} className="animate-spin" />
                        ) : (
                          <Icon name="save" size={16} />
                        )}
                        {savingSignature
                          ? "Saving..."
                          : editingSignature
                            ? "Save Changes"
                            : "Create Signature"}
                      </button>
                      <button
                        onClick={() => setShowSigEditor(false)}
                        className="px-4 py-2 rounded-lg border border-line text-sm font-medium text-ink hover:bg-field transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </SectionCard>
              )}

              {/* Signature list */}
              <SectionCard>
                {!signaturesLoaded ? (
                  <div className="p-6 flex justify-center">
                    <Icon name="progress_activity" size={20} className="animate-spin text-ink3" />
                  </div>
                ) : signatures.length === 0 ? (
                  <div className="p-10 flex flex-col items-center gap-4 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-wax-soft to-field flex items-center justify-center shadow-sm">
                      <Icon name="draw" size={28} fill className="text-wax" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-ink">
                        No signatures yet
                      </p>
                      <p className="text-xs text-ink3 mt-1 max-w-xs">
                        Create a signature with your name, title, company, and
                        contact info. It appears after your email closing.
                      </p>
                    </div>
                    <button
                      onClick={openNewSignature}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl bg-wax text-on-wax text-sm font-semibold hover:opacity-90 transition-opacity cursor-pointer shadow-sm"
                    >
                      <Icon name="add" size={16} />
                      Create your first signature
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-line">
                    {signatures.map((sig) => {
                      const accountLabel = sig.gmail_account_id
                        ? (gmailAccounts.find(
                            (a) => a.id === sig.gmail_account_id,
                          )?.gmail_address ?? "Specific account")
                        : "All accounts";
                      const preview = sig.html
                        .replace(/<[^>]+>/g, " ")
                        .replace(/\s+/g, " ")
                        .trim()
                        .slice(0, 100);
                      return (
                        <div
                          key={sig.id}
                          className="group flex items-start gap-4 px-5 py-4 hover:bg-field transition-colors"
                        >
                          {/* Icon */}
                          <div className="w-9 h-9 rounded-xl bg-wax-soft flex items-center justify-center shrink-0 mt-0.5">
                            <Icon name="draw" size={18} fill className="text-wax" />
                          </div>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-semibold text-ink truncate">
                                {sig.name}
                              </p>
                              {sig.is_default && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-wax text-on-wax text-[10px] font-bold uppercase tracking-wide">
                                  <Icon name="star" size={10} fill />
                                  Default
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-ink3 mt-0.5 flex items-center gap-1">
                              <Icon name="mail" size={12} />
                              {accountLabel}
                            </p>
                            {preview && (
                              <p className="text-xs text-ink3 mt-1.5 opacity-70 leading-relaxed line-clamp-2">
                                {preview}
                                {preview.length >= 100 ? "..." : ""}
                              </p>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              onClick={() => openEditSignature(sig)}
                              className="p-1.5 rounded-lg hover:bg-line text-ink3 hover:text-ink transition-all cursor-pointer"
                              title="Edit signature"
                            >
                              <Icon name="edit" size={16} />
                            </button>
                            <button
                              onClick={() => deleteSignature(sig.id)}
                              className="p-1.5 rounded-lg hover:bg-danger-soft text-ink3 hover:text-danger transition-all cursor-pointer"
                              title="Delete signature"
                            >
                              <Icon name="delete" size={16} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SectionCard>

              {/* Info callout */}
              <div className="mt-3 flex items-start gap-3 px-4 py-3 rounded-xl bg-field border border-line">
                <Icon name="info" size={16} fill className="text-ink2 mt-0.5" />
                <p className="text-xs text-ink2 leading-relaxed">
                  Your signature is appended after the email closing and
                  contains your contact details. It is added automatically when
                  you open a new email; you can switch or remove it inside the
                  Compose window.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
