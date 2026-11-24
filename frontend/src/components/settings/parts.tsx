// The parts every Settings section is built from.
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import Icon from "../Icon";
import { RadioDot } from "../ModelSetup";

// "Saved" shows in the bar for a moment after anything is kept.
export const Saved = createContext<() => void>(() => {});

// Keep something on the profile at once, here and on the server.
export function useProfile() {
  const { user, profile, updateProfile, addToast } = useApp();
  const flash = useContext(Saved);
  const save = async (patch: Record<string, unknown>) => {
    updateProfile(patch as never);
    const { error } = await createClient().from("profiles").update(patch).eq("id", user.id);
    if (error) addToast("error", `That was not saved: ${error.message}. Try again.`);
    else flash();
  };
  return { profile, save };
}

// A group of settings: a label, then rows between hairlines.
export function Group({ title, right, note, children }: { title: string; right?: ReactNode; note?: ReactNode; children: ReactNode }) {
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
export function Row({ name, text, children }: { name: ReactNode; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-setting flex-wrap items-center gap-x-4 gap-y-2 py-row2">
      <div className="min-w-[150px] flex-1">
        <div className="text-[13px] text-ink">{name}</div>
        {text && <div className="mt-px text-xs leading-snug text-ink2">{text}</div>}
      </div>
      {children !== undefined && <div className="flex flex-none items-center gap-2">{children}</div>}
    </div>
  );
}

// A row that is one of several choices, chosen by clicking anywhere on it.
export function ChoiceRow({ on, onClick, name, text }: { on: boolean; onClick: () => void; name: string; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className="flex min-h-setting w-full items-center gap-3 py-row2 text-left">
      <RadioDot on={on} />
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] text-ink ${on ? "font-medium" : ""}`}>{name}</span>
        <span className="mt-px block text-xs leading-snug text-ink2">{text}</span>
      </span>
    </button>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
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
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3">
      <span className="text-ink3">{label}</span>
      {children}
    </label>
  );
}

// A text field that keeps what is typed when it is left, or on Enter.
export function LineField({ value, onSave, label, placeholder, rows, className = "" }: { value: string; onSave: (v: string) => void; label: string; placeholder?: string; rows?: number; className?: string }) {
  const [text, setText] = useState(value);
  const from = useRef(value);
  if (from.current !== value) {
    from.current = value;
    setText(value);
  }
  const leave = () => text.trim() !== value.trim() && onSave(text.trim());
  const common = { value: text, "aria-label": label, placeholder, spellCheck: false, onBlur: leave };
  return rows ? (
    <textarea className={`input resize-none ${className}`} rows={rows} {...common} onChange={(e) => setText(e.target.value)} />
  ) : (
    <input className={`input ${className}`} {...common} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  );
}

// Lines of text the user can add to, edit in place and delete.
export type Line = { id: string; text: string; right?: string; title?: string };
export function Lines({ lines, onSave, onDelete, placeholder, label, adding, setAdding }: { lines: Line[]; onSave: (text: string, replace?: string) => void; onDelete: (id: string) => void; placeholder: string; label: string; adding: boolean; setAdding: (v: boolean) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const form = (replace?: string) => (
    <form
      className="flex flex-1 items-center gap-1.5 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSave(text.trim(), replace);
        setEditing(null);
        setAdding(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && (setEditing(null), setAdding(false))}
    >
      <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={label} />
      <button className="btn btn-sm" type="submit" disabled={!text.trim()}>
        Save
      </button>
      <button className="btn btn-plain btn-sm" type="button" onClick={() => (setEditing(null), setAdding(false))}>
        Cancel
      </button>
    </form>
  );
  const start = (id: string | null, t: string) => {
    setText(t);
    setEditing(id);
  };
  return (
    <>
      {lines.map((l) =>
        editing === l.id ? (
          <div key={l.id} className="flex">
            {form(l.id)}
          </div>
        ) : (
          <div key={l.id} className="group flex min-h-row items-center gap-2 py-1">
            <button className="min-w-0 flex-1 text-left leading-snug text-ink" title={l.title} onClick={() => (setAdding(false), start(l.id, l.text))}>
              {l.text}
            </button>
            {l.right && <span className="flex-none text-xs text-ink3">{l.right}</span>}
            <button className="iconbtn -mr-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100" title="Delete" aria-label={`Delete ${l.text}`} onClick={() => onDelete(l.id)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ),
      )}
      {adding && editing === null && <div className="flex">{form()}</div>}
      {!lines.length && !adding && <p className="flex min-h-row items-center text-ink3">None</p>}
    </>
  );
}

export function AddButton({ onClick, label = "Add" }: { onClick: () => void; label?: string }) {
  return (
    <button className="btn btn-plain btn-sm -mr-2" onClick={onClick}>
      <Icon name="add" size={13} /> {label}
    </button>
  );
}

export const loadingLines = (
  <div className="space-y-3 py-4" aria-busy="true" aria-label="Loading">
    <span className="skel block h-2.5 w-48" />
    <span className="skel block h-2.5 w-72" />
  </div>
);
