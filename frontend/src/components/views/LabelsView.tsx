import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";
import { LABEL_COLORS, labelColor, slugOf } from "@/lib/labelColors";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { Empty, SkeletonRows, ViewBar } from "../ui";

// Labels: the user's own, in the order they want them. Each has a name, a
// colour, a line that tells the model which mail belongs, examples (senders,
// with the subject of an email put in the label by hand), and the Gmail label
// it maps to. The order is the Inbox's Priority grouping. Suggestions from
// the first read sit under the list until added or put away.

type Example = { sender: string; subject?: string };
type Label = { id: string; slug: string; display_name: string; color: string; description: string; examples: Example[]; position: number; gmail_label: string | null };
type Suggestion = { name: string; description: string; senders: string[]; count: number };
type Draft = { name: string; color: string; description: string; examples: Example[]; gmail: string };

const COLUMNS = "!grid grid-cols-[26px_minmax(0,180px)_minmax(0,1fr)_64px] md:grid-cols-[26px_minmax(0,200px)_minmax(0,1fr)_minmax(0,180px)_64px]";

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="block h-2 w-2 flex-none rounded-full" style={{ background: labelColor(color) }} />;
}

const mappedTo = (l: { display_name: string; gmail_label: string | null }) => l.gmail_label?.trim() || `Tabellar/${l.display_name}`;

export default function LabelsView() {
  const { user, addToast, search, liveChanges } = useApp();
  const supabase = createClient();
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [gmailLabels, setGmailLabels] = useState<string[]>([]);
  // The label being edited: its id, or "new".
  const [editing, setEditing] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [list, sorted] = await Promise.all([
      supabase.from("categories").select("id, slug, display_name, color, description, examples, position, gmail_label").eq("user_id", user.id).order("position", { ascending: true }),
      supabase.from("email_processed").select("extra_labels").eq("user_id", user.id).not("extra_labels", "is", null).limit(50000),
    ]);
    setLabels(((list.data || []) as Label[]).map((l) => ({ ...l, examples: Array.isArray(l.examples) ? l.examples : [] })));
    const n: Record<string, number> = {};
    for (const row of (sorted.data || []) as { extra_labels: string[] | null }[]) for (const slug of row.extra_labels || []) n[slug] = (n[slug] || 0) + 1;
    setCounts(n);
  }, [user.id]);

  useEffect(() => {
    load();
  }, [load, liveChanges.email_processed]);

  useEffect(() => {
    api("/labels/suggestions")
      .then((r: { suggestions: Suggestion[] }) => setSuggestions(r.suggestions || []))
      .catch(() => {});
    api("/labels/gmail")
      .then((r: { labels: string[] }) => setGmailLabels(r.labels || []))
      .catch(() => {});
  }, []);

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => (labels || []).filter((l) => !q || `${l.display_name} ${l.description}`.toLowerCase().includes(q)), [labels, q]);
  const taken = useMemo(() => new Set((labels || []).map((l) => l.display_name.toLowerCase())), [labels]);
  const offered = suggestions.filter((s) => !taken.has(s.name.toLowerCase()) && (!q || `${s.name} ${s.description}`.toLowerCase().includes(q)));
  const current = editing && editing !== "new" ? (labels || []).find((l) => l.id === editing) ?? null : null;
  const cursor = shown.find((l) => l.id === cursorId) || null;

  // The new order, written as 0, 1, 2... on every label.
  const reorder = async (ids: string[]) => {
    const byId = new Map((labels || []).map((l) => [l.id, l]));
    const next = ids.map((id, i) => ({ ...byId.get(id)!, position: i }));
    setLabels(next);
    const failed = (await Promise.all(next.map((l) => supabase.from("categories").update({ position: l.position }).eq("id", l.id)))).some((r) => r.error);
    if (failed) {
      addToast("error", "The new order was not saved. Try again.");
      load();
    }
  };

  const move = (l: Label, delta: number) => {
    const ids = (labels || []).map((x) => x.id);
    const at = ids.indexOf(l.id);
    const to = Math.min(ids.length - 1, Math.max(0, at + delta));
    if (to === at) return;
    ids.splice(at, 1);
    ids.splice(to, 0, l.id);
    reorder(ids);
  };

  const drop = (to: number) => {
    const id = dragId;
    setDragId(null);
    setDropAt(null);
    if (!id) return;
    const ids = (labels || []).map((x) => x.id);
    const from = ids.indexOf(id);
    ids.splice(from, 1);
    ids.splice(from < to ? to - 1 : to, 0, id);
    if (ids.join() !== (labels || []).map((x) => x.id).join()) reorder(ids);
  };

  const save = async (d: Draft): Promise<boolean> => {
    const name = d.name.trim();
    if (!name) return false;
    const fields = { display_name: name, color: d.color, description: d.description.trim(), examples: d.examples, gmail_label: d.gmail.trim() && d.gmail.trim() !== `Tabellar/${name}` ? d.gmail.trim() : null };
    if (current) {
      const { error } = await supabase.from("categories").update(fields).eq("id", current.id);
      if (error) return addToast("error", `That was not saved: ${error.message}`), false;
    } else {
      const slug = slugOf(name);
      const { data, error } = await supabase.from("categories").insert({ user_id: user.id, slug, position: (labels || []).length, ...fields }).select("id").single();
      if (error || !data) return addToast("error", `The label was not added: ${error?.message || "the database did not answer"}`), false;
      setCursorId((data as { id: string }).id);
    }
    setEditing(null);
    load();
    return true;
  };

  const remove = async (l: Label) => {
    if (!window.confirm(`Delete the label ${l.display_name}?\n\nMail keeps the mailbox label ${mappedTo(l)} where it has it; Tabellar stops adding it.`)) return;
    const { error } = await supabase.from("categories").delete().eq("id", l.id);
    if (error) return addToast("error", `The label was not deleted: ${error.message}`);
    setEditing(null);
    load();
  };

  const addSuggestion = async (s: Suggestion) => {
    const slug = slugOf(s.name);
    const color = LABEL_COLORS[(labels || []).length % LABEL_COLORS.length].hex;
    const { error } = await supabase
      .from("categories")
      .insert({ user_id: user.id, slug, display_name: s.name, description: s.description, color, examples: s.senders.map((sender) => ({ sender })), position: (labels || []).length });
    if (error) return addToast("error", `The label was not added: ${error.message}`);
    load();
  };

  const dismiss = (s: Suggestion) => {
    setSuggestions((list) => list.filter((x) => x.name !== s.name));
    api("/labels/suggestions/dismiss", { name: s.name }).catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey) return;
      if (document.querySelector("[data-compose-modal]")) return;
      const at = cursor ? shown.indexOf(cursor) : -1;
      if (e.altKey && cursor && (e.key === "ArrowUp" || e.key === "ArrowDown")) move(cursor, e.key === "ArrowUp" ? -1 : 1);
      else if (e.altKey) return;
      else if ((e.key === "j" || e.key === "ArrowDown") && shown.length) setCursorId(shown[Math.min(shown.length - 1, at + 1)].id);
      else if ((e.key === "k" || e.key === "ArrowUp") && shown.length) setCursorId(shown[Math.max(0, at - 1)].id);
      else if (e.key === "Enter" && cursor) setEditing(cursor.id);
      else if (e.key === "Escape" && editing) setEditing(null);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const list = (
    <div className="min-h-0 flex-1 overflow-y-auto pb-6" role="listbox" aria-label="Labels">
      {labels === null ? (
        <div className="pt-9">
          <SkeletonRows count={8} />
        </div>
      ) : !shown.length && !offered.length ? (
        q ? (
          <Empty icon="search" title="Nothing matches that search" />
        ) : (
          <Empty icon="label" title="No labels yet">
            <button className="link" onClick={() => setEditing("new")}>
              New label
            </button>
          </Empty>
        )
      ) : (
        <>
          {shown.length > 0 && (
            <div className="day !static">
              <b>Your labels</b>
            </div>
          )}
          {shown.map((l, i) => (
            <div
              key={l.id}
              role="option"
              aria-selected={cursor?.id === l.id || editing === l.id}
              draggable={!q}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                setDragId(l.id);
              }}
              onDragEnd={() => (setDragId(null), setDropAt(null))}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY < box.top + box.height / 2 ? i : i + 1);
              }}
              onDrop={(e) => (e.preventDefault(), drop(dropAt ?? i))}
              className={`row group relative ${COLUMNS} ${dragId === l.id ? "opacity-45" : ""}`}
              onClick={() => (setCursorId(l.id), setEditing(l.id))}
              title={q ? undefined : "Drag to reorder"}
            >
              {dropAt === i && dragId && <i aria-hidden className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-ink" />}
              {dropAt === i + 1 && i === shown.length - 1 && dragId && <i aria-hidden className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-ink" />}
              <span className="grid place-items-center">
                <span className="group-hover:hidden">
                  <Dot color={l.color} />
                </span>
                <Icon name="drag" size={14} className="hidden cursor-grab text-ink3 group-hover:block" />
              </span>
              <span className="truncate pr-3 text-ink">{l.display_name}</span>
              <span className="truncate pr-3 text-ink3">{l.description}</span>
              <span className="hidden truncate pr-3 text-[12.5px] text-ink3 md:block" title="Mailbox label">
                {mappedTo(l)}
              </span>
              <span className="text-right text-xs text-ink3">{(counts[l.slug] || 0).toLocaleString()}</span>
            </div>
          ))}
          {offered.length > 0 && (
            <>
              <div className="day !static">
                <b>Suggested</b>
              </div>
              {offered.map((s) => (
                <div key={s.name} className={`row group ${COLUMNS}`} title={s.senders.join(", ")}>
                  <span />
                  <span className="truncate pr-3 text-ink2">{s.name}</span>
                  <span className="truncate pr-3 text-ink3">{s.description}</span>
                  <span className="hidden truncate pr-3 text-[12.5px] text-ink3 md:block">{s.senders.length === 1 ? s.senders[0] : `${s.senders[0]} and ${s.senders.length - 1} more`}</span>
                  <span className="flex items-center justify-end gap-3">
                    <button className="link hidden group-hover:inline group-focus-within:inline" onClick={() => dismiss(s)}>
                      Not now
                    </button>
                    <button className="link" onClick={() => addSuggestion(s)}>
                      Add
                    </button>
                  </span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      <ViewBar
        title="Labels"
        search="Search labels"
        right={
          <button className="btn" onClick={() => setEditing("new")}>
            New label
          </button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className={`min-h-0 min-w-0 flex-1 flex-col md:flex ${editing ? "hidden" : "flex"}`}>{list}</div>
        {editing && (
          <Editor
            key={editing}
            label={current}
            next={(labels || []).length}
            gmailLabels={gmailLabels}
            onSave={save}
            onCancel={() => setEditing(null)}
            onDelete={current ? () => remove(current) : undefined}
            onMove={current ? (d) => move(current, d) : undefined}
          />
        )}
      </div>
    </>
  );
}

// The column beside the list where a label is made or changed.
function Editor({ label, next, gmailLabels, onSave, onCancel, onDelete, onMove }: { label: Label | null; next: number; gmailLabels: string[]; onSave: (d: Draft) => Promise<boolean>; onCancel: () => void; onDelete?: () => void; onMove?: (delta: number) => void }) {
  const [d, setD] = useState<Draft>(() => ({
    name: label?.display_name ?? "",
    color: label ? labelColor(label.color) : LABEL_COLORS[next % LABEL_COLORS.length].hex,
    description: label?.description ?? "",
    examples: label?.examples ?? [],
    gmail: label ? mappedTo(label) : "",
  }));
  const [sender, setSender] = useState("");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  const field = "label mb-1.5 mt-4 block";
  const validSender = /^(@[^\s@]+\.[^\s@]+|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(sender.trim());

  useEffect(() => {
    if (!label) nameRef.current?.focus();
  }, [label]);

  const addSender = () => {
    const s = sender.trim().toLowerCase();
    if (!validSender || d.examples.some((x) => x.sender === s && !x.subject)) return;
    set({ examples: [{ sender: s }, ...d.examples] });
    setSender("");
  };

  return (
    <form
      className="flex w-full flex-none flex-col border-line md:w-[400px] md:border-l"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        await onSave(d);
        setSaving(false);
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
        <div className="flex items-center">
          <h2 className="text-[15px] font-[650] tracking-[-0.01em] text-ink">{label ? label.display_name : "New label"}</h2>
          <span className="flex-1" />
          {onMove && (
            <>
              <button type="button" className="iconbtn" aria-label="Move up" title="Move up (Alt Up)" onClick={() => onMove(-1)}>
                <Icon name="expand_less" size={15} />
              </button>
              <button type="button" className="iconbtn" aria-label="Move down" title="Move down (Alt Down)" onClick={() => onMove(1)}>
                <Icon name="expand_more" size={15} />
              </button>
            </>
          )}
          <button type="button" className="iconbtn" aria-label="Close" onClick={onCancel}>
            <Icon name="close" size={15} />
          </button>
        </div>

        <label className={field} htmlFor="label-name">
          Name
        </label>
        <input id="label-name" ref={nameRef} className="input w-full" value={d.name} maxLength={40} onChange={(e) => set({ name: e.target.value, gmail: !label && (!d.gmail || d.gmail === `Tabellar/${d.name}`) ? `Tabellar/${e.target.value}` : d.gmail })} />

        <div className={field}>Colour</div>
        <div className="flex gap-1" role="radiogroup" aria-label="Colour">
          {LABEL_COLORS.map((c) => (
            <button key={c.hex} type="button" role="radio" aria-checked={d.color === c.hex} aria-label={c.name} title={c.name} className={`grid h-7 w-7 place-items-center rounded-md ${d.color === c.hex ? "bg-sel" : "hover:bg-hover"}`} onClick={() => set({ color: c.hex })}>
              <span className="h-3 w-3 rounded-full" style={{ background: c.hex }} />
            </button>
          ))}
        </div>

        <label className={field} htmlFor="label-description">
          Which mail belongs
        </label>
        <input id="label-description" className="input w-full" value={d.description} maxLength={200} placeholder="Replies from companies I applied to" onChange={(e) => set({ description: e.target.value })} />

        <label className={field} htmlFor="label-gmail">
          Mailbox label
        </label>
        <input id="label-gmail" className="input w-full" list="gmail-labels" value={d.gmail} placeholder={d.name ? `Tabellar/${d.name}` : "Tabellar/Name"} onChange={(e) => set({ gmail: e.target.value })} />
        <datalist id="gmail-labels">
          {gmailLabels.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>

        <div className={field}>Examples</div>
        <div className="flex gap-1.5">
          <input
            className="input min-w-0 flex-1"
            value={sender}
            placeholder="name@company.com or @company.com"
            aria-label="Add a sender"
            onChange={(e) => setSender(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSender();
              }
            }}
          />
          <button type="button" className="btn" disabled={!validSender} onClick={addSender}>
            Add
          </button>
        </div>
        {d.examples.length > 0 && (
          <ul className="pt-1.5">
            {d.examples.map((x, i) => (
              <li key={`${x.sender}:${x.subject ?? ""}`} className="group flex min-h-7 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-ink">{x.sender}</span>
                  {x.subject && <span className="text-ink3">, {x.subject}</span>}
                </span>
                <button type="button" className="iconbtn h-6 w-6 flex-none opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Remove ${x.sender}`} onClick={() => set({ examples: d.examples.filter((_, j) => j !== i) })}>
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-none items-center gap-2 border-t border-line px-5 py-[11px]">
        <button type="submit" className="btn btn-pri" disabled={saving || !d.name.trim()}>
          {label ? "Save" : "Add label"}
        </button>
        <button type="button" className="btn btn-plain" onClick={onCancel}>
          Cancel
        </button>
        <span className="flex-1" />
        {onDelete && (
          <button type="button" className="btn btn-plain !text-danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
