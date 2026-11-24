import { useEffect, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import { LevelControl } from "../Sidebar";
import { api } from "@/lib/outcomes";
import { EmailField, useContacts } from "../EmailAutocomplete";
import { ModelSettings, RadioDot, useSetupState } from "../ModelSetup";
import AddMailbox from "../AddMailbox";
import { Menu, Seg, ViewBar } from "../ui";
import { AboutYou } from "../Profile";

// Settings, laid out like the Mac's own: the sections on the left, the chosen
// one on the right as groups of rows, each row a setting with its control.

// Sanitize user-authored signature HTML before rendering it or saving it.
// Keeps inline styles and basic formatting but strips scripts, event
// handlers, iframes and forms.
function sanitizeSignatureHtml(html: string): string {
  return DOMPurify.sanitize(html ?? "", {
    USE_PROFILES: { html: true },
    ALLOWED_ATTR: ["href", "src", "alt", "title", "style", "class", "target", "rel", "width", "height", "cellpadding", "cellspacing", "border", "align", "color", "face", "size"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
  });
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

type DelegationRule = {
  id: string;
  pattern: string;
  target_email: string;
  is_enabled: boolean;
  weight: number;
};

type TabId = "account" | "accounts" | "about" | "background" | "ai" | "style" | "signatures" | "templates" | "schedule" | "calendar" | "automation";

const SECTIONS: { id: TabId; label: string }[] = [
  { id: "account", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "about", label: "About you" },
  { id: "background", label: "Engine" },
  { id: "ai", label: "Models" },
  { id: "style", label: "Writing style" },
  { id: "signatures", label: "Signatures" },
  { id: "templates", label: "Templates" },
  { id: "schedule", label: "Working hours" },
  { id: "calendar", label: "Calendar" },
  { id: "automation", label: "Forwarding" },
];

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
  account_id: string | null;
  created_at: string;
}

// The parts every section is built from.

// A group of settings: a label, then rows between hairlines.
function Group({ title, right, note, children }: { title: string; right?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8 first-of-type:mt-0">
      <div className="mb-1.5 flex min-h-6 items-center gap-3">
        <h3 className="label">{title}</h3>
        <span className="flex-1" />
        {right}
      </div>
      <div className="divide-y divide-line-soft border-y border-line-soft">{children}</div>
      {note && <p className="mt-2 text-xs leading-normal text-ink3">{note}</p>}
    </section>
  );
}

// One setting: its name and a line about it on the left, its control on the right.
function Row({ name, text, children, disabled }: { name: ReactNode; text?: ReactNode; children?: ReactNode; disabled?: boolean }) {
  return (
    <div className={`flex min-h-[52px] items-center gap-4 py-2.5 ${disabled ? "opacity-45" : ""}`} aria-disabled={disabled || undefined}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{name}</div>
        {text && <div className="mt-px text-xs leading-snug text-ink2">{text}</div>}
      </div>
      {children !== undefined && <div className="flex flex-none items-center gap-2">{children}</div>}
    </div>
  );
}

// A row that is one of several choices, chosen by clicking anywhere on it.
function ChoiceRow({ on, onClick, name, text }: { on: boolean; onClick: () => void; name: string; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className="flex min-h-[52px] w-full items-start gap-3 py-2.5 text-left">
      <RadioDot on={on} />
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] text-ink ${on ? "font-medium" : ""}`}>{name}</span>
        <span className="mt-px block text-xs leading-snug text-ink2">{text}</span>
      </span>
    </button>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[18px] w-8 flex-none rounded-full transition-colors duration-150 disabled:pointer-events-none ${on ? "bg-ink" : "bg-ink4"}`}
    >
      <span className={`absolute left-0.5 top-0.5 h-[14px] w-[14px] rounded-full bg-canvas shadow-control transition-transform duration-150 ${on ? "translate-x-[14px]" : ""}`} />
    </button>
  );
}

// Labelled fields in an editor that opens inside a group.
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3">
      <span className="text-ink3">{label}</span>
      {children}
    </label>
  );
}

// The engine: how far Tabellar goes on its own, Autopilot's limits, how it
// tells you, and whether it starts at login. Each control saves at once.
function EngineSettings() {
  const { user, profile, updateProfile, addToast, mail } = useApp();
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
    api("/engine/status")
      .then((s) => {
        setAutostart(!!s.autostart);
        setLevel(s.level);
        setPaused(!!s.paused);
      })
      .catch(() => setAutostart(false));
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    const { error } = await supabase.from("profiles").update(patch).eq("id", user.id);
    if (error) return addToast("error", `Could not save that: ${error.message}. Try again.`);
    updateProfile(patch);
    mail.refreshEngine();
  };

  const toggleAutostart = async (on: boolean) => {
    try {
      const r = await api("/engine/autostart", { on });
      setAutostart(!!r.autostart);
      addToast("success", on ? "Tabellar will start at login" : "Tabellar will no longer start at login");
    } catch (e) {
      addToast("error", (e as Error).message);
    }
  };

  const autopilot = level === "autopilot";

  return (
    <>
      <Group title="Level">
        <div className="-mx-2 py-1">
          <LevelControl
            value={level}
            onChange={(l) => {
              setLevel(l);
              save({ autonomy_level: l });
            }}
          />
        </div>
        <Row name="Pause" text="Mail still syncs">
          <Switch
            label="Pause"
            on={paused}
            onChange={(v) => {
              setPaused(v);
              save({ engine_paused: v });
            }}
          />
        </Row>
      </Group>

      <Group
        title="Autopilot limits"
        note={autopilot ? "Only to the person who wrote, in the same thread, with no cc and no attachments." : "Only at Autopilot."}
      >
        <Row name="Wait before sending" text="Time to cancel each reply" disabled={!autopilot}>
          <select
            className="input w-auto"
            disabled={!autopilot}
            value={delay}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDelay(v);
              save({ autopilot_delay_min: v });
            }}
          >
            {[2, 5, 10, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </Row>
        <Row name="Replies per day" text="Then drafts until tomorrow" disabled={!autopilot}>
          <select
            className="input w-auto"
            disabled={!autopilot}
            value={cap}
            onChange={(e) => {
              const v = Number(e.target.value);
              setCap(v);
              save({ autopilot_daily_cap: v });
            }}
          >
            {[1, 3, 5, 10, 20].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>
        <Row name="Only people you have written to" text="Anyone else gets a draft" disabled={!autopilot}>
          <Switch
            label="Only people you have written to"
            disabled={!autopilot}
            on={knownOnly}
            onChange={(v) => {
              setKnownOnly(v);
              save({ autopilot_known_only: v });
            }}
          />
        </Row>
      </Group>

      <Group title="Notifications">
        <Row name="Notify me about">
          <select
            className="input w-auto"
            value={notify}
            onChange={(e) => {
              setNotify(e.target.value);
              save({ notification_level: e.target.value });
            }}
          >
            <option value="important">Important and action needed</option>
            <option value="all">All new mail</option>
            <option value="none">Nothing</option>
          </select>
        </Row>
        <Row name="Show sender and summary" text="Off shows only that mail arrived">
          <Switch
            label="Show sender and summary"
            on={preview}
            onChange={(v) => {
              setPreview(v);
              save({ notification_preview: v });
            }}
          />
        </Row>
      </Group>

      <Group title="Running in the background">
        <Row name="Start at login" text="Keeps running with the window closed">
          {autostart === null ? <span className="skel block h-[18px] w-8" aria-label="Loading" /> : <Switch label="Start at login" on={autostart} onChange={toggleAutostart} />}
        </Row>
      </Group>
    </>
  );
}

// The signature body is edited in place. Its HTML is set once when the
// editor opens, so typing does not reset the caret.
function SignatureBody({ initial, onChange }: { initial: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = sanitizeSignatureHtml(initial);
  }, []);
  const command = (cmd: string, value?: string) => document.execCommand(cmd, false, value);
  const tools: { cmd: string; icon: string; title: string }[] = [
    { cmd: "bold", icon: "format_bold", title: "Bold" },
    { cmd: "italic", icon: "format_italic", title: "Italic" },
    { cmd: "underline", icon: "format_underlined", title: "Underline" },
  ];
  return (
    <div className="rounded-[7px] bg-field focus-within:shadow-[0_0_0_2px_color-mix(in_oklch,var(--wax)_55%,transparent)]">
      <div className="flex items-center gap-0.5 border-b border-line-soft px-1 py-0.5">
        {tools.map((t) => (
          <button
            key={t.cmd}
            type="button"
            className="iconbtn !h-6 !w-6"
            title={t.title}
            aria-label={t.title}
            onMouseDown={(e) => {
              e.preventDefault();
              command(t.cmd);
            }}
          >
            <Icon name={t.icon} size={15} />
          </button>
        ))}
        <button
          type="button"
          className="iconbtn !h-6 !w-6"
          title="Insert link"
          aria-label="Insert link"
          onMouseDown={(e) => {
            e.preventDefault();
            const url = prompt("Link address:");
            if (url) command("createLink", url);
          }}
        >
          <Icon name="link" size={15} />
        </button>
        <button
          type="button"
          className="iconbtn !h-6 !w-6"
          title="Clear formatting"
          aria-label="Clear formatting"
          onMouseDown={(e) => {
            e.preventDefault();
            command("removeFormat");
          }}
        >
          <Icon name="format_clear" size={15} />
        </button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
        className="min-h-[96px] px-2.5 py-2 text-[13px] leading-[1.6] text-ink outline-none"
        aria-label="Signature"
      />
    </div>
  );
}

// Where Settings opens after Google or Microsoft sends the window back from
// adding an account.
const RETURN_TAB = "tabellar_settings_tab";

function returnHere() {
  try {
    sessionStorage.setItem(RETURN_TAB, "accounts");
  } catch {
    // the window then opens on General
  }
}

function signInAgain(provider: string) {
  returnHere();
  window.location.assign(provider === "microsoft" ? "/oauth/start?provider=microsoft" : "/oauth/start");
}

// Settings > Accounts: each mailbox, its default From, whether it is read,
// which one is the default, and adding or removing one.
function AccountsSettings() {
  const { accounts, addToast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const setup = useSetupState();
  const nameOf = (choice: string) => setup.state?.mailboxes.find((c) => c.id === choice)?.name ?? "";
  const several = accounts.list.length > 1;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest("[data-account-menu]") && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const change = async (id: string, patch: { paused?: boolean; is_default?: boolean; default_from?: string }) => {
    setBusy(id);
    try {
      await api("/accounts/update", { id, ...patch });
      await accounts.reload();
    } catch (e) {
      addToast("error", `Could not save that. ${(e as Error).message}`);
    }
    setBusy(null);
  };

  const remove = async (id: string, address: string) => {
    setMenu(null);
    const last = accounts.list.length === 1;
    if (!window.confirm(`Remove ${address} from Tabellar?\n\nIts mail leaves Tabellar; the mailbox itself is not changed.${last ? " It is the only account, so this window signs out." : ""}`)) return;
    setBusy(id);
    try {
      await api("/accounts/remove", { id });
      if (last) window.location.href = "/";
      else await accounts.reload();
    } catch (e) {
      addToast("error", `Could not remove the account. ${(e as Error).message}`);
    }
    setBusy(null);
  };

  return (
    <Group
      title="Accounts"
      right={
        <button className="btn btn-sm" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "Add an account"}
        </button>
      }
      note="A Gmail account also sends from the addresses in its Send mail as list."
    >
      {adding && (
        <div className="border-b border-line-soft pb-5 pt-1">
          {setup.state ? (
            <AddMailbox
              state={setup.state}
              refresh={setup.refresh}
              beforeSignIn={returnHere}
              onAdded={async () => {
                setAdding(false);
                await accounts.reload();
                addToast("success", "Account added. Its mail is being read.");
              }}
            />
          ) : (
            <p className="py-2 text-ink3">{setup.error || "Loading"}</p>
          )}
        </div>
      )}
      {!accounts.loaded ? (
        <div className="space-y-3 py-4" aria-busy="true" aria-label="Loading">
          <span className="skel block h-2.5 w-48" />
          <span className="skel block h-2.5 w-72" />
        </div>
      ) : !accounts.list.length ? (
        <p className="py-3 text-ink3">No account connected</p>
      ) : (
        accounts.list.map((a) => (
          <Row
            key={a.id}
            name={
              <span className="flex min-w-0 items-center gap-2">
                {several && <span className="mark">{accounts.mark(a.id)}</span>}
                <span className="truncate">{a.address}</span>
                {several && a.is_default && <span className="flex-none text-xs text-ink3">Default</span>}
              </span>
            }
            text={[
              nameOf(a.choice),
              a.paused ? "Paused" : a.from.length > 1 ? `Also sends as ${a.from.filter((f) => f.address !== a.address.toLowerCase()).map((f) => f.address).join(", ")}` : "",
            ].filter(Boolean).join(". ") || undefined}
          >
            {a.from.length > 1 && (
              <Menu label="From" value={a.default_from} onChange={(v) => change(a.id, { default_from: v })} options={a.from.map((f) => ({ id: f.address, label: f.address }))} />
            )}
            <Switch label={`Read mail from ${a.address}`} on={!a.paused} disabled={busy === a.id} onChange={(on) => change(a.id, { paused: !on })} />
            <div className="relative" data-account-menu>
              <button className="iconbtn" title="More" aria-label={`More for ${a.address}`} aria-haspopup="menu" aria-expanded={menu === a.id} onClick={() => setMenu(menu === a.id ? null : a.id)}>
                <Icon name="more" size={16} />
              </button>
              {menu === a.id && (
                <div className="pop absolute right-0 top-8 z-10 min-w-[160px]" role="menu">
                  {several && !a.is_default && (
                    <button role="menuitem" className="pop-item" onClick={() => (setMenu(null), change(a.id, { is_default: true }))}>
                      Make default
                    </button>
                  )}
                  <button role="menuitem" className="pop-item" onClick={() => (a.provider === "imap" ? (setMenu(null), setAdding(true)) : signInAgain(a.provider))}>
                    {a.provider === "imap" ? "Change the app password" : "Sign in again"}
                  </button>
                  <button role="menuitem" className="pop-item text-danger" onClick={() => remove(a.id, a.address)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          </Row>
        ))
      )}
    </Group>
  );
}

export default function SettingsView() {
  const { user, profile, updateProfile, addToast, theme, setTheme, setView, accounts } = useApp();
  const supabase = createClient();
  const { contacts } = useContacts(user.id);
  const gmailAccounts = accounts.list;

  // Back from adding an account, the window opens on Accounts.
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    try {
      const back = sessionStorage.getItem(RETURN_TAB) as TabId | null;
      sessionStorage.removeItem(RETURN_TAB);
      return back && SECTIONS.some((x) => x.id === back) ? back : "account";
    } catch {
      return "account";
    }
  });
  // Below md the section list and the chosen section show one at a time.
  const [listOpen, setListOpen] = useState(false);

  // Delegation rules
  const [delegations, setDelegations] = useState<DelegationRule[]>([]);
  const [delegationsLoaded, setDelegationsLoaded] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [newTargetEmail, setNewTargetEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(true);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [templateForm, setTemplateForm] = useState<{ name: string; subject: string; body_html: string }>({ name: "", subject: "", body_html: "" });
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Signatures
  const [signatures, setSignatures] = useState<EmailSignature[]>([]);
  const [signaturesLoaded, setSignaturesLoaded] = useState(false);
  const [editingSignature, setEditingSignature] = useState<EmailSignature | null>(null);
  const [sigForm, setSigForm] = useState<{ name: string; html: string; is_default: boolean; account_id: string }>({ name: "", html: "", is_default: false, account_id: "" });
  const [savingSignature, setSavingSignature] = useState(false);
  const [showSigEditor, setShowSigEditor] = useState(false);

  // Writing style
  const [styleNotes, setStyleNotes] = useState(profile?.style_notes || "");
  const [detectedStyle, setDetectedStyle] = useState<{ greeting_style: string; closing_style: string; tone: string; avg_length: string; last_learned_at: string } | null>(null);
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
        addToast("error", "This window lost its session. Open it again with tabellar open.");
        return;
      }
      const res = await fetch(`/api/learn-style`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        addToast("error", err.error || "Could not learn your style yet. Send a few emails first, then try again.");
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
      addToast("success", `Learned your style from ${data.sample_count} sent emails`);
    } catch {
      addToast("error", "Could not learn your style. Check that Tabellar is running, then try again.");
    } finally {
      setDetectingStyle(false);
    }
  };

  // Working hours
  const [workStart, setWorkStart] = useState("09:00");
  const [workEnd, setWorkEnd] = useState("17:00");
  const [workDays, setWorkDays] = useState([1, 2, 3, 4, 5]);
  const [workDnd, setWorkDnd] = useState(false);


  // Calendar invites
  const [calendarSendInvites, setCalendarSendInvites] = useState(profile?.calendar_send_invites !== false);

  const loadDelegations = async () => {
    const { data } = await supabase.from("delegation_rules").select("*").eq("user_id", user.id).order("weight", { ascending: false }).limit(200);
    setDelegations(data || []);
    setDelegationsLoaded(true);
  };

  const loadTemplates = async () => {
    const { data } = await supabase.from("email_templates").select("id, name, subject, body_html").eq("user_id", user.id).order("created_at", { ascending: false });
    setEmailTemplates(data || []);
    setTemplatesLoaded(true);
  };

  const deleteTemplate = async (t: EmailTemplate) => {
    await supabase.from("email_templates").delete().eq("id", t.id);
    setEmailTemplates((prev) => prev.filter((x) => x.id !== t.id));
    if (editingTemplate?.id === t.id) setShowTemplateEditor(false);
    const undo = async () => {
      const { data } = await supabase.from("email_templates").insert({ user_id: user.id, name: t.name, subject: t.subject, body_html: t.body_html }).select("id, name, subject, body_html");
      if (data?.[0]) setEmailTemplates((prev) => [data[0], ...prev]);
    };
    addToast("info", `Template "${t.name}" deleted`, { action: { label: "Undo", onClick: undo } });
  };

  const openNewTemplate = () => {
    setEditingTemplate(null);
    setTemplateForm({ name: "", subject: "", body_html: "" });
    setShowTemplateEditor(true);
  };

  const openEditTemplate = (t: EmailTemplate) => {
    setEditingTemplate(t);
    setTemplateForm({ name: t.name, subject: t.subject || "", body_html: t.body_html });
    setShowTemplateEditor(true);
  };

  const saveTemplate = async () => {
    if (!templateForm.name.trim()) return addToast("error", "Give the template a name.");
    if (!templateForm.body_html.trim()) return addToast("error", "Write the template's text first.");
    setSavingTemplate(true);
    if (editingTemplate) {
      const { data } = await supabase
        .from("email_templates")
        .update({ name: templateForm.name, subject: templateForm.subject || null, body_html: templateForm.body_html })
        .eq("id", editingTemplate.id)
        .select("id, name, subject, body_html");
      if (data?.[0]) {
        setEmailTemplates((prev) => prev.map((t) => (t.id === editingTemplate.id ? data[0] : t)));
        setShowTemplateEditor(false);
        addToast("success", "Template saved");
      } else addToast("error", "Could not save the template. Try again.");
    } else {
      const { data } = await supabase
        .from("email_templates")
        .insert({ user_id: user.id, name: templateForm.name, subject: templateForm.subject || null, body_html: templateForm.body_html })
        .select("id, name, subject, body_html");
      if (data?.[0]) {
        setEmailTemplates((prev) => [data[0], ...prev]);
        setShowTemplateEditor(false);
        addToast("success", "Template created");
      } else addToast("error", "Could not create the template. Try again.");
    }
    setSavingTemplate(false);
  };

  const loadSignatures = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    try {
      const res = await fetch(`/api/signatures`, { headers: { Authorization: `Bearer ${session.access_token}` } });
      const json = await res.json();
      setSignatures(json.signatures ?? []);
    } catch {
      /* non-critical */
    }
    setSignaturesLoaded(true);
  };

  const openNewSignature = () => {
    setEditingSignature(null);
    const displayName = profile?.display_name || "Your name";
    setSigForm({
      name: "",
      html: `<p><strong>${displayName}</strong><br />Your title<br />Your company</p>`,
      is_default: signatures.length === 0,
      account_id: gmailAccounts[0]?.id || "",
    });
    setShowSigEditor(true);
  };

  const openEditSignature = (sig: EmailSignature) => {
    setEditingSignature(sig);
    setSigForm({ name: sig.name, html: sig.html, is_default: sig.is_default, account_id: sig.account_id || "" });
    setShowSigEditor(true);
  };

  const postSignature = async (body: { name: string; html: string; is_default: boolean; account_id: string | null }, id?: string) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error("This window lost its session");
    const res = await fetch(id ? `/api/signatures/${id}` : `/api/signatures`, {
      method: id ? "PATCH" : "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  const saveSignature = async () => {
    if (!sigForm.name.trim()) return addToast("error", "Give the signature a name.");
    setSavingSignature(true);
    try {
      const json = await postSignature(
        { name: sigForm.name, html: sanitizeSignatureHtml(sigForm.html), is_default: sigForm.is_default, account_id: sigForm.account_id || null },
        editingSignature?.id,
      );
      if (json.signature) {
        if (editingSignature) {
          setSignatures((prev) => prev.map((s) => (s.id === editingSignature.id ? json.signature : sigForm.is_default ? { ...s, is_default: false } : s)));
        } else {
          setSignatures((prev) => [...(sigForm.is_default ? prev.map((s) => ({ ...s, is_default: false })) : prev), json.signature]);
        }
        setShowSigEditor(false);
        addToast("success", editingSignature ? "Signature saved" : "Signature created");
      } else addToast("error", json.error || "Could not save the signature. Try again.");
    } catch {
      addToast("error", "Could not save the signature. Try again.");
    }
    setSavingSignature(false);
  };

  const deleteSignature = async (sig: EmailSignature) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    await fetch(`/api/signatures/${sig.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${session.access_token}` } });
    setSignatures((prev) => prev.filter((s) => s.id !== sig.id));
    if (editingSignature?.id === sig.id) setShowSigEditor(false);
    const undo = async () => {
      const json = await postSignature({ name: sig.name, html: sig.html, is_default: sig.is_default, account_id: sig.account_id }).catch(() => ({}) as { signature?: EmailSignature });
      if (json.signature) setSignatures((prev) => [...prev, json.signature]);
    };
    addToast("info", `Signature "${sig.name}" deleted`, { action: { label: "Undo", onClick: undo } });
  };

  const addDelegation = async () => {
    if (!newPattern.trim() || !newTargetEmail.trim()) return;
    const { data } = await supabase.from("delegation_rules").insert({ user_id: user.id, pattern: newPattern.trim(), target_email: newTargetEmail.trim() }).select();
    if (data?.[0]) setDelegations((prev) => [data[0], ...prev]);
    else addToast("error", "Could not add that rule. Try again.");
    setNewPattern("");
    setNewTargetEmail("");
  };

  const toggleDelegation = async (id: string, enabled: boolean) => {
    await supabase.from("delegation_rules").update({ is_enabled: !enabled }).eq("id", id);
    setDelegations((prev) => prev.map((d) => (d.id === id ? { ...d, is_enabled: !enabled } : d)));
  };

  const deleteDelegation = async (d: DelegationRule) => {
    await supabase.from("delegation_rules").delete().eq("id", d.id);
    setDelegations((prev) => prev.filter((x) => x.id !== d.id));
    const undo = async () => {
      const { data } = await supabase.from("delegation_rules").insert({ user_id: user.id, pattern: d.pattern, target_email: d.target_email, is_enabled: d.is_enabled, weight: d.weight }).select();
      if (data?.[0]) setDelegations((prev) => [data[0], ...prev]);
    };
    addToast("info", "Forwarding rule removed", { action: { label: "Undo", onClick: undo } });
  };

  // Wipes what Tabellar stored and learned; Gmail and the connected accounts stay.


  const chooseTheme = async (next: "light" | "dark") => {
    setTheme(next);
    updateProfile({ theme: next });
    const { error } = await supabase.from("profiles").update({ theme: next }).eq("id", user.id);
    if (error) addToast("error", "Could not save the appearance. It applies until the window is reloaded.");
  };

  useEffect(() => {

    supabase
      .from("style_profiles")
      .select("greeting_style, closing_style, tone, avg_length, last_learned_at")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          const s = data as { greeting_style: string; closing_style: string; tone: string; avg_length: string; last_learned_at: string };
          setDetectedStyle(s);
          setStyleGreeting(s.greeting_style || "");
          setStyleClosing(s.closing_style || "");
          setStyleTone(s.tone || "");
          setStyleLength(s.avg_length || "");
        }
      });

    if (profile?.working_hours) {
      const wh = profile.working_hours as { start?: string; end?: string; days?: number[]; dnd?: boolean };
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
        working_hours: { start: workStart, end: workEnd, days: workDays, timezone: detectedTimezone, dnd: workDnd },
        calendar_send_invites: calendarSendInvites,
      })
      .eq("id", user.id);
    let styleErr: { message?: string } | null = null;
    if (detectedStyle || styleGreeting || styleClosing || styleTone || styleLength) {
      const res = await supabase.from("style_profiles").upsert(
        { user_id: user.id, greeting_style: styleGreeting || null, closing_style: styleClosing || null, tone: styleTone || null, avg_length: styleLength || null },
        { onConflict: "user_id" },
      );
      styleErr = res.error;
    }
    setSaving(false);
    if (profileErr || styleErr) {
      console.error("[settings/autosave] failed:", profileErr ?? styleErr);
      addToast("error", `Could not save your settings: ${profileErr?.message || styleErr?.message || "unknown error"}. Try again.`);
      return;
    }
    updateProfile({
      style_notes: styleNotes || null,
      working_hours: { start: workStart, end: workEnd, days: workDays, timezone: detectedTimezone, dnd: workDnd },
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
  }, [styleNotes, workStart, workEnd, workDays, workDnd, calendarSendInvites, styleGreeting, styleClosing, styleTone, styleLength]);

  // Monday first, as the week is read; the stored numbers keep Sunday as 0.
  const WEEK: [number, string][] = [
    [1, "Mon"],
    [2, "Tue"],
    [3, "Wed"],
    [4, "Thu"],
    [5, "Fri"],
    [6, "Sat"],
    [0, "Sun"],
  ];

  const emptyLine = (text: string) => <p className="py-3 text-ink3">{text}</p>;
  const loadingLines = (
    <div className="space-y-3 py-4" aria-busy="true" aria-label="Loading">
      <span className="skel block h-2.5 w-48" />
      <span className="skel block h-2.5 w-72" />
    </div>
  );

  const templateEditor = (
    <form
      className="space-y-2.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        saveTemplate();
      }}
      onKeyDown={(e) => e.key === "Escape" && setShowTemplateEditor(false)}
    >
      <Field label="Name">
        <input autoFocus className="input" value={templateForm.name} onChange={(e) => setTemplateForm((f) => ({ ...f, name: e.target.value }))} placeholder="Such as Follow-up, Introduction, Thank you" />
      </Field>
      <Field label="Subject">
        <input className="input" value={templateForm.subject} onChange={(e) => setTemplateForm((f) => ({ ...f, subject: e.target.value }))} placeholder="Optional, fills in the subject line" />
      </Field>
      <label className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3">
        <span className="pt-1.5 text-ink3">Text</span>
        <textarea className="input resize-y leading-[1.6]" rows={7} value={templateForm.body_html} onChange={(e) => setTemplateForm((f) => ({ ...f, body_html: e.target.value }))} placeholder="What the template says" />
      </label>
      <div className="flex items-center gap-2 pl-[100px]">
        <button type="submit" className="btn btn-pri" disabled={savingTemplate || !templateForm.name.trim() || !templateForm.body_html.trim()}>
          {savingTemplate ? "Saving" : editingTemplate ? "Save" : "Create template"}
        </button>
        <button type="button" className="btn btn-plain" onClick={() => setShowTemplateEditor(false)}>
          Cancel
        </button>
        <span className="flex-1" />
        {editingTemplate && (
          <button type="button" className="btn btn-danger" onClick={() => deleteTemplate(editingTemplate)}>
            Delete
          </button>
        )}
      </div>
    </form>
  );

  const signatureEditor = (
    <form
      className="space-y-2.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        saveSignature();
      }}
    >
      <Field label="Name">
        <input autoFocus className="input" value={sigForm.name} onChange={(e) => setSigForm((f) => ({ ...f, name: e.target.value }))} placeholder="Such as Work" />
      </Field>
      {gmailAccounts.length > 1 && (
        <Field label="Account">
          <select className="input" value={sigForm.account_id} onChange={(e) => setSigForm((f) => ({ ...f, account_id: e.target.value }))}>
            <option value="">All accounts</option>
            {gmailAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.address}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3">
        <span className="pt-1.5 text-ink3">Signature</span>
        <div>
          <SignatureBody key={editingSignature?.id ?? "new"} initial={sigForm.html} onChange={(html) => setSigForm((f) => ({ ...f, html }))} />
          <p className="mt-1.5 text-xs text-ink2">Your contact block, added after your closing line: name, title, company, phone or a link.</p>
        </div>
      </div>
      <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3">
        <span className="text-ink3">Default</span>
        <span className="flex items-center gap-2.5 text-ink2">
          <Switch label="Use by default" on={sigForm.is_default} onChange={(v) => setSigForm((f) => ({ ...f, is_default: v }))} />
          Added to new emails{gmailAccounts.length > 1 ? " from this account" : ""}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-[100px] pt-1">
        <button type="submit" className="btn btn-pri" disabled={savingSignature || !sigForm.name.trim()}>
          {savingSignature ? "Saving" : editingSignature ? "Save" : "Create signature"}
        </button>
        <button type="button" className="btn btn-plain" onClick={() => setShowSigEditor(false)}>
          Cancel
        </button>
        <span className="flex-1" />
        {editingSignature && (
          <button type="button" className="btn btn-danger" onClick={() => deleteSignature(editingSignature)}>
            Delete
          </button>
        )}
      </div>
    </form>
  );

  const section = SECTIONS.find((s) => s.id === activeTab)!;

  return (
    <>
      <ViewBar title="Settings" search={false} right={<span className="text-xs text-ink3" aria-live="polite">{saving ? "Saving" : saved ? "Saved" : ""}</span>} />
      <div className="flex min-h-0 flex-1">
        <nav className={`flex-none overflow-y-auto border-line px-2 py-3 md:block md:w-[200px] md:border-r ${listOpen ? "block w-full" : "hidden"}`} aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              aria-current={activeTab === s.id ? "page" : undefined}
              onClick={() => {
                setActiveTab(s.id);
                setListOpen(false);
              }}
              className={`flex h-7 w-full items-center rounded-md px-2 text-left transition-colors duration-150 ${activeTab === s.id ? "bg-sel font-medium text-ink" : "text-ink2 hover:bg-hover"}`}
            >
              {s.label}
            </button>
          ))}
          <button onClick={() => setView("history")} className="flex h-7 w-full items-center rounded-md px-2 text-left text-ink2 transition-colors duration-150 hover:bg-hover">
            History
          </button>
        </nav>

        <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto md:block ${listOpen ? "hidden" : "block"}`}>
          <div className="max-w-[640px] px-5 pb-12 pt-5 md:px-8">
            <button className="link mb-3 md:hidden" onClick={() => setListOpen(true)}>
              All settings
            </button>
            <h2 className="bar-title mb-5">{section.label}</h2>

            {activeTab === "about" && <AboutYou />}

            {activeTab === "accounts" && <AccountsSettings />}

            {activeTab === "account" && (
              <>
                <Group title="Appearance">
                  <Row name="Theme">
                    <Seg
                      value={theme}
                      onChange={chooseTheme}
                      options={[
                        { id: "light", label: "Light" },
                        { id: "dark", label: "Dark" },
                      ]}
                    />
                  </Row>
                </Group>

                <Group title="Setup">
                  <Row name="First-run steps" text="Mail, model, About you, examples from your mail, people and labels, level">
                    <button
                      className="btn"
                      onClick={() => {
                        window.location.hash = "setup";
                        window.location.reload();
                      }}
                    >
                      Go through them again
                    </button>
                  </Row>
                </Group>

                <Group title="Your data" note="All of it is in one file on this Mac. Keys and tokens are in the Keychain.">
                  <Row name="Knowledge" text="People and facts noted from your mail">
                    <button className="btn" onClick={() => setView("relationships")}>
                      Open Knowledge
                    </button>
                  </Row>
                </Group>
              </>
            )}

            {activeTab === "background" && <EngineSettings />}

            {activeTab === "ai" && (
              <section>
                <ModelSettings />
              </section>
            )}

            {activeTab === "style" && (
              <>
                <Group
                  title="How you write"
                  right={
                    <button className="btn btn-sm" onClick={handleDetectStyle} disabled={detectingStyle}>
                      {detectingStyle ? "Reading sent mail" : detectedStyle ? "Learn again" : "Learn from sent mail"}
                    </button>
                  }
                  note={
                    detectedStyle?.last_learned_at
                      ? `Learned ${new Date(detectedStyle.last_learned_at).toLocaleDateString([], { day: "numeric", month: "long" })}`
                      : undefined
                  }
                >
                  {(
                    [
                      ["Greeting", "How you open an email", styleGreeting, setStyleGreeting, "Such as Hi"],
                      ["Closing", "How you sign off, before your signature", styleClosing, setStyleClosing, "Such as Best regards"],
                      ["Tone", "How you sound", styleTone, setStyleTone, "Such as warm and direct"],
                      ["Length", "How long your replies usually are", styleLength, setStyleLength, "Such as short"],
                    ] as const
                  ).map(([name, text, value, set, placeholder]) => (
                    <Row key={name} name={name} text={text}>
                      <input className="input w-[200px]" value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} aria-label={name} />
                    </Row>
                  ))}
                </Group>

                <Group title="Notes for drafts">
                  <div className="py-3">
                    <p className="mb-2 text-xs text-ink2">Anything the fields above miss</p>
                    <textarea className="input resize-none" rows={3} value={styleNotes} onChange={(e) => setStyleNotes(e.target.value)} placeholder="Such as: Always sign off with 'Best, George'. Never use bullet points." aria-label="Notes for drafts" />
                  </div>
                </Group>
              </>
            )}

            {activeTab === "signatures" && (
              <Group
                title="Signatures"
                right={
                  <button className="btn btn-sm" onClick={openNewSignature}>
                    New signature
                  </button>
                }
              >
                {showSigEditor && !editingSignature && signatureEditor}
                {!signaturesLoaded
                  ? loadingLines
                  : !signatures.length && !showSigEditor
                    ? emptyLine("No signatures yet. Make one with your name, title and contact details; it goes after your closing line.")
                    : signatures.map((sig) =>
                        showSigEditor && editingSignature?.id === sig.id ? (
                          <div key={sig.id}>{signatureEditor}</div>
                        ) : (
                          <Row
                            key={sig.id}
                            name={
                              <>
                                {sig.name}
                                {sig.is_default && <span className="ml-2 text-xs text-ink3">Default</span>}
                              </>
                            }
                            text={
                              <span className="block truncate">
                                {sig.account_id ? (gmailAccounts.find((a) => a.id === sig.account_id)?.address ?? "One account") : "All accounts"}, {plainText(sig.html).slice(0, 100) || "empty"}
                              </span>
                            }
                          >
                            <button className="btn btn-sm" onClick={() => openEditSignature(sig)}>
                              Edit
                            </button>
                          </Row>
                        ),
                      )}
              </Group>
            )}

            {activeTab === "templates" && (
              <Group
                title="Templates"
                right={
                  <button className="btn btn-sm" onClick={openNewTemplate}>
                    New template
                  </button>
                }
              >
                {showTemplateEditor && !editingTemplate && templateEditor}
                {!templatesLoaded
                  ? loadingLines
                  : !emailTemplates.length && !showTemplateEditor
                    ? emptyLine("No templates yet. Make one here for replies you write again and again.")
                    : emailTemplates.map((t) =>
                        showTemplateEditor && editingTemplate?.id === t.id ? (
                          <div key={t.id}>{templateEditor}</div>
                        ) : (
                          <Row key={t.id} name={t.name} text={<span className="block truncate">{[t.subject && `Subject: ${t.subject}`, plainText(t.body_html).slice(0, 120)].filter(Boolean).join(". ")}</span>}>
                            <button className="btn btn-sm" onClick={() => openEditTemplate(t)}>
                              Edit
                            </button>
                          </Row>
                        ),
                      )}
              </Group>
            )}

            {activeTab === "schedule" && (
              <Group title="Working hours" note={Intl.DateTimeFormat().resolvedOptions().timeZone}>
                <Row name="Work days">
                  <div className="seg" role="group" aria-label="Work days">
                    {WEEK.map(([n, label]) => (
                      <button key={n} type="button" aria-pressed={workDays.includes(n)} onClick={() => setWorkDays((prev) => (prev.includes(n) ? prev.filter((d) => d !== n) : [...prev, n]))}>
                        {label}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row name="Day starts">
                  <input type="time" className="input w-[120px]" value={workStart} onChange={(e) => e.target.value && setWorkStart(e.target.value)} aria-label="Day starts" />
                </Row>
                <Row name="Day ends">
                  <input type="time" className="input w-[120px]" value={workEnd} onChange={(e) => e.target.value && setWorkEnd(e.target.value)} aria-label="Day ends" />
                </Row>
                {workEnd <= workStart && <p className="py-2 text-xs text-warn">The day ends before it starts</p>}
              </Group>
            )}

            {activeTab === "calendar" && (
              <>
                <Group title="Calendar">
                  <Row name="Send invitations to attendees" text="Google Calendar emails the people invited">
                    <Switch label="Send invitations to attendees" on={calendarSendInvites} onChange={setCalendarSendInvites} />
                  </Row>
                </Group>
              </>
            )}

            {activeTab === "automation" && (
              <Group title="Forwarding rules">
                <form
                  className="flex flex-wrap items-center gap-2 py-2.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addDelegation();
                  }}
                >
                  <input className="input min-w-[150px] flex-1" value={newPattern} onChange={(e) => setNewPattern(e.target.value)} placeholder="Mail about, such as invoices" aria-label="Mail the rule matches" />
                  <EmailField value={newTargetEmail} onChange={setNewTargetEmail} contacts={contacts} placeholder="Forward to" multi={false} className="min-w-[150px] flex-1" />
                  <button type="submit" className="btn" disabled={!newPattern.trim() || !newTargetEmail.trim()}>
                    Add rule
                  </button>
                </form>
                {!delegationsLoaded
                  ? loadingLines
                  : !delegations.length
                    ? emptyLine("No forwarding rules yet.")
                    : delegations.map((d) => (
                        <Row key={d.id} name={`"${d.pattern}"`} text={`To ${d.target_email}${d.is_enabled ? "" : ", turned off"}`}>
                          <Switch label={`Rule for ${d.pattern}`} on={d.is_enabled} onChange={() => toggleDelegation(d.id, d.is_enabled)} />
                          <button className="iconbtn" aria-label="Remove rule" title="Remove rule" onClick={() => deleteDelegation(d)}>
                            <Icon name="close" size={15} />
                          </button>
                        </Row>
                      ))}
              </Group>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
