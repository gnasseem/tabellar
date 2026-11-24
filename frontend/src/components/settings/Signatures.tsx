// Settings, Signatures and templates.
import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import { Field, Group, loadingLines, Row, Switch } from "./parts";

const supabase = createClient();

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

type Template = { id: string; name: string; subject: string | null; body_html: string };
type Signature = { id: string; name: string; html: string; is_default: boolean; account_id: string | null; created_at: string };

const emptyLine = (text: string) => <p className="py-3 text-ink3">{text}</p>;

async function call(path: string, method: string, body?: unknown) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${data.session?.access_token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
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

export default function SignaturesAndTemplates() {
  return (
    <>
      <Signatures />
      <Templates />
    </>
  );
}

function Signatures() {
  const { profile, addToast, accounts } = useApp();
  const [list, setList] = useState<Signature[] | null>(null);
  const [open, setOpen] = useState<Signature | "new" | null>(null);
  const [form, setForm] = useState({ name: "", html: "", is_default: false, account_id: "" });
  const [busy, setBusy] = useState(false);
  const several = accounts.list.length > 1;
  const editing = open && open !== "new" ? open : null;

  useEffect(() => {
    call("/signatures", "GET")
      .then((r) => setList(r.signatures ?? []))
      .catch(() => setList([]));
  }, []);

  const startNew = () => {
    setForm({ name: "", html: `<p><strong>${profile?.display_name || "Your name"}</strong><br />Your title<br />Your company</p>`, is_default: !list?.length, account_id: accounts.list[0]?.id || "" });
    setOpen("new");
  };
  const startEdit = (s: Signature) => {
    setForm({ name: s.name, html: s.html, is_default: s.is_default, account_id: s.account_id || "" });
    setOpen(s);
  };
  const save = async () => {
    setBusy(true);
    const json = await call(editing ? `/signatures/${editing.id}` : "/signatures", editing ? "PATCH" : "POST", { name: form.name, html: sanitizeSignatureHtml(form.html), is_default: form.is_default, account_id: form.account_id || null }).catch(() => ({}));
    setBusy(false);
    if (!json.signature) return addToast("error", json.error || "Could not save the signature. Try again.");
    const others = (prev: Signature[]) => (form.is_default ? prev.map((s) => ({ ...s, is_default: false })) : prev);
    setList((prev) => (editing ? others(prev ?? []).map((s) => (s.id === editing.id ? json.signature : s)) : [...others(prev ?? []), json.signature]));
    setOpen(null);
  };
  const remove = async (s: Signature) => {
    await call(`/signatures/${s.id}`, "DELETE").catch(() => {});
    setList((prev) => (prev ?? []).filter((x) => x.id !== s.id));
    setOpen(null);
    const undo = async () => {
      const json = await call("/signatures", "POST", { name: s.name, html: s.html, is_default: s.is_default, account_id: s.account_id }).catch(() => ({}));
      if (json.signature) setList((prev) => [...(prev ?? []), json.signature]);
    };
    addToast("info", `Signature "${s.name}" deleted`, { action: { label: "Undo", onClick: undo } });
  };

  const editor = (
    <form
      className="space-y-2.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Field label="Name">
        <input autoFocus className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Such as Work" />
      </Field>
      {several && (
        <Field label="Account">
          <select className="input" value={form.account_id} onChange={(e) => setForm((f) => ({ ...f, account_id: e.target.value }))}>
            <option value="">All accounts</option>
            {accounts.list.map((a) => (
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
          <SignatureBody key={editing?.id ?? "new"} initial={form.html} onChange={(html) => setForm((f) => ({ ...f, html }))} />
          <p className="mt-1.5 text-xs text-ink2">Your contact block, added after your sign-off: name, title, company, phone or a link.</p>
        </div>
      </div>
      <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3">
        <span className="text-ink3">Default</span>
        <span className="flex items-center gap-2.5 text-ink2">
          <Switch label="Use by default" on={form.is_default} onChange={(v) => setForm((f) => ({ ...f, is_default: v }))} />
          Added to new emails{several ? " from this account" : ""}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-[100px] pt-1">
        <button type="submit" className="btn btn-pri" disabled={busy || !form.name.trim()}>
          {busy ? "Saving" : editing ? "Save" : "Create signature"}
        </button>
        <button type="button" className="btn btn-plain" onClick={() => setOpen(null)}>
          Cancel
        </button>
        <span className="flex-1" />
        {editing && (
          <button type="button" className="btn btn-danger" onClick={() => remove(editing)}>
            Delete
          </button>
        )}
      </div>
    </form>
  );

  return (
    <Group
      title="Signatures"
      right={
        <button className="btn btn-sm" onClick={startNew}>
          New signature
        </button>
      }
    >
      {open === "new" && editor}
      {!list
        ? loadingLines
        : !list.length && !open
          ? emptyLine("No signatures yet")
          : list.map((s) =>
              editing?.id === s.id ? (
                <div key={s.id}>{editor}</div>
              ) : (
                <Row
                  key={s.id}
                  name={
                    <>
                      {s.name}
                      {s.is_default && <span className="ml-2 text-xs text-ink3">Default</span>}
                    </>
                  }
                  text={
                    <span className="block truncate">
                      {s.account_id ? (accounts.byId.get(s.account_id)?.address ?? "One account") : "All accounts"}, {plainText(s.html).slice(0, 100) || "empty"}
                    </span>
                  }
                >
                  <button className="btn btn-sm" onClick={() => startEdit(s)}>
                    Edit
                  </button>
                </Row>
              ),
            )}
    </Group>
  );
}

function Templates() {
  const { user, addToast } = useApp();
  const [list, setList] = useState<Template[] | null>(null);
  const [open, setOpen] = useState<Template | "new" | null>(null);
  const [form, setForm] = useState({ name: "", subject: "", body_html: "" });
  const [busy, setBusy] = useState(false);
  const editing = open && open !== "new" ? open : null;

  useEffect(() => {
    supabase
      .from("email_templates")
      .select("id, name, subject, body_html")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }: { data: Template[] | null }) => setList(data ?? []));
  }, [user.id]);

  const start = (t: Template | "new") => {
    setForm(t === "new" ? { name: "", subject: "", body_html: "" } : { name: t.name, subject: t.subject || "", body_html: t.body_html });
    setOpen(t);
  };
  const save = async () => {
    setBusy(true);
    const values = { name: form.name.trim(), subject: form.subject || null, body_html: form.body_html };
    const { data } = editing
      ? await supabase.from("email_templates").update(values).eq("id", editing.id).select("id, name, subject, body_html")
      : await supabase.from("email_templates").insert({ user_id: user.id, ...values }).select("id, name, subject, body_html");
    setBusy(false);
    const row = data?.[0] as Template | undefined;
    if (!row) return addToast("error", "Could not save the template. Try again.");
    setList((prev) => (editing ? (prev ?? []).map((t) => (t.id === row.id ? row : t)) : [row, ...(prev ?? [])]));
    setOpen(null);
  };
  const remove = async (t: Template) => {
    await supabase.from("email_templates").delete().eq("id", t.id);
    setList((prev) => (prev ?? []).filter((x) => x.id !== t.id));
    setOpen(null);
    const undo = async () => {
      const { data } = await supabase.from("email_templates").insert({ user_id: user.id, name: t.name, subject: t.subject, body_html: t.body_html }).select("id, name, subject, body_html");
      if (data?.[0]) setList((prev) => [data[0] as Template, ...(prev ?? [])]);
    };
    addToast("info", `Template "${t.name}" deleted`, { action: { label: "Undo", onClick: undo } });
  };

  const editor = (
    <form
      className="space-y-2.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => e.key === "Escape" && setOpen(null)}
    >
      <Field label="Name">
        <input autoFocus className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Such as Introduction" />
      </Field>
      <Field label="Subject">
        <input className="input" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="Optional" />
      </Field>
      <label className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3">
        <span className="pt-1.5 text-ink3">Text</span>
        <textarea className="input resize-y leading-[1.6]" rows={7} value={form.body_html} onChange={(e) => setForm((f) => ({ ...f, body_html: e.target.value }))} placeholder="What the template says" />
      </label>
      <div className="flex items-center gap-2 pl-[100px]">
        <button type="submit" className="btn btn-pri" disabled={busy || !form.name.trim() || !form.body_html.trim()}>
          {busy ? "Saving" : editing ? "Save" : "Create template"}
        </button>
        <button type="button" className="btn btn-plain" onClick={() => setOpen(null)}>
          Cancel
        </button>
        <span className="flex-1" />
        {editing && (
          <button type="button" className="btn btn-danger" onClick={() => remove(editing)}>
            Delete
          </button>
        )}
      </div>
    </form>
  );

  return (
    <Group
      title="Templates"
      right={
        <button className="btn btn-sm" onClick={() => start("new")}>
          New template
        </button>
      }
      note="Inserted from More in compose."
    >
      {open === "new" && editor}
      {!list
        ? loadingLines
        : !list.length && !open
          ? emptyLine("No templates yet")
          : list.map((t) =>
              editing?.id === t.id ? (
                <div key={t.id}>{editor}</div>
              ) : (
                <Row key={t.id} name={t.name} text={<span className="block truncate">{[t.subject && `Subject: ${t.subject}`, plainText(t.body_html).slice(0, 120)].filter(Boolean).join(". ")}</span>}>
                  <button className="btn btn-sm" onClick={() => start(t)}>
                    Edit
                  </button>
                </Row>
              ),
            )}
    </Group>
  );
}
