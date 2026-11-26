import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";
import { LABEL_COLORS, labelColor, slugOf } from "@/lib/labelColors";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { Empty, SkeletonRows, ViewBar } from "../ui";

// Labels: the user's own, in the order they want them. A label is made from
// one sentence that says which mail belongs; its name is worked out from it
// and its mailbox label is Tabellar/<name>. The order is the Inbox's Priority
// grouping. Suggestions from the user's mail sit under the list until added
// or put away, and can be worked out again at any time.

type Example = { sender: string; subject?: string };
type Label = { id: string; slug: string; display_name: string; color: string; description: string; examples: Example[]; position: number; gmail_label: string | null };
type Suggestion = { name: string; description: string; senders: string[]; count: number };
type Draft = { name: string; color: string; description: string };

const COLUMNS = "!grid grid-cols-[26px_minmax(0,1fr)_auto] md:grid-cols-[26px_minmax(0,240px)_minmax(0,1fr)_auto]";

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
  const [suggesting, setSuggesting] = useState(false);
  const [describe, setDescribe] = useState("");
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);
  // The label open for changes, under its row.
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
  }, []);

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => (labels || []).filter((l) => !q || `${l.display_name} ${l.description}`.toLowerCase().includes(q)), [labels, q]);
  const taken = useMemo(() => new Set((labels || []).map((l) => l.display_name.toLowerCase())), [labels]);
  const offered = suggestions.filter((s) => !taken.has(s.name.toLowerCase()) && (!q || `${s.name} ${s.description}`.toLowerCase().includes(q)));
  const cursor = shown.find((l) => l.id === cursorId) || null;
  const nextColor = (n: number) => LABEL_COLORS[n % LABEL_COLORS.length].hex;

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

  // A name no other label has: "Receipts", then "Receipts 2".
  const freeName = (name: string) => {
    let out = name;
    for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${name} ${i}`;
    return out;
  };

  const insert = async (name: string, description: string, examples: Example[], n: number) => {
    const { data, error } = await supabase
      .from("categories")
      .insert({ user_id: user.id, slug: slugOf(name), display_name: name, description, color: nextColor(n), examples, position: n })
      .select("id")
      .single();
    if (error || !data) {
      addToast("error", `The label was not added: ${error?.message || "the database did not answer"}`);
      return null;
    }
    return (data as { id: string }).id;
  };

  const addFromSentence = async () => {
    const description = describe.trim();
    if (!description || adding) return;
    setAdding(true);
    const named = await api("/labels/name", { description }).catch(() => null);
    const name = freeName(String(named?.name || description.split(/\s+/).slice(0, 3).join(" ")).slice(0, 40));
    const id = await insert(name, description, [], (labels || []).length);
    setAdding(false);
    if (!id) return;
    setDescribe("");
    setCursorId(id);
    addToast("success", `Added ${name}. New mail that fits goes in it.`);
    load();
  };

  const save = async (l: Label, d: Draft): Promise<boolean> => {
    const name = d.name.trim();
    if (!name) return false;
    const { error } = await supabase.from("categories").update({ display_name: name, color: d.color, description: d.description.trim() }).eq("id", l.id);
    if (error) return addToast("error", `That was not saved: ${error.message}`), false;
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

  const addSuggestions = async (list: Suggestion[]) => {
    let n = (labels || []).length;
    for (const s of list) if (await insert(s.name, s.description, s.senders.map((sender) => ({ sender })), n)) n++;
    load();
  };

  const dismiss = (s: Suggestion) => {
    setSuggestions((list) => list.filter((x) => x.name !== s.name));
    api("/labels/suggestions/dismiss", { name: s.name }).catch(() => {});
  };

  const suggestNow = async () => {
    setSuggesting(true);
    try {
      const r = await api("/labels/suggestions/refresh", {});
      setSuggestions(r.suggestions || []);
      if (!(r.suggestions || []).length) addToast("info", "Nothing new to suggest from your mail yet.");
    } catch {
      addToast("error", "Suggestions need the model. Check Settings, Models.");
    }
    setSuggesting(false);
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
      else if (e.key === "Enter" && cursor) setEditing(editing === cursor.id ? null : cursor.id);
      else if (e.key === "Escape" && editing) setEditing(null);
      else if (e.key === "n") addRef.current?.focus();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <ViewBar title="Labels" search="Search labels" />
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <div className="px-6 pt-5">
          <form
            className="addfield"
            onSubmit={(e) => {
              e.preventDefault();
              addFromSentence();
            }}
          >
            <Icon name="add" size={16} className="text-ink3" />
            <input ref={addRef} value={describe} maxLength={200} placeholder="New label: describe its mail, like replies from companies I applied to" aria-label="Describe a new label" onChange={(e) => setDescribe(e.target.value)} />
            {describe.trim() && (
              <button type="submit" className="btn-act" disabled={adding}>
                {adding ? "Naming it" : "Add"}
              </button>
            )}
          </form>
        </div>

        <div className="pt-3" role="listbox" aria-label="Labels">
          {labels === null ? (
            <SkeletonRows count={6} />
          ) : !shown.length && q ? (
            <Empty icon="search" title="Nothing matches that search" />
          ) : (
            <>
              {shown.length > 0 && (
                <div className="day !static">
                  <b>Your labels</b>
                  <span className="text-ink3">Drag to reorder</span>
                </div>
              )}
              {shown.map((l, i) => (
                <div key={l.id}>
                  <div
                    role="option"
                    aria-selected={cursor?.id === l.id || editing === l.id}
                    draggable={!q && editing !== l.id}
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
                    className={`row group relative cursor-default ${COLUMNS} ${dragId === l.id ? "opacity-45" : ""}`}
                    onClick={() => (setCursorId(l.id), setEditing(editing === l.id ? null : l.id))}
                  >
                    {dropAt === i && dragId && <i aria-hidden className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-ink" />}
                    {dropAt === i + 1 && i === shown.length - 1 && dragId && <i aria-hidden className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-ink" />}
                    <span className="grid place-items-center">
                      <span className="group-hover:hidden">
                        <Dot color={l.color} />
                      </span>
                      <Icon name="drag" size={14} className="hidden cursor-grab text-ink3 group-hover:block" />
                    </span>
                    <span className="truncate pr-3 font-medium text-ink">{l.display_name}</span>
                    <span className="hidden truncate pr-3 text-ink3 md:block">{l.description}</span>
                    <span className="min-w-[40px] text-right text-xs text-ink3">{(counts[l.slug] || 0).toLocaleString()}</span>
                  </div>
                  {editing === l.id && <Editor key={l.id} label={l} onSave={(d) => save(l, d)} onCancel={() => setEditing(null)} onDelete={() => remove(l)} />}
                </div>
              ))}

              <div className="day !static mt-4">
                <b>Suggested from your mail</b>
                <span className="flex-1" />
                {offered.length > 1 && (
                  <button className="link" onClick={() => addSuggestions(offered)}>
                    Add all
                  </button>
                )}
                <button className="link" disabled={suggesting} onClick={suggestNow}>
                  {suggesting ? "Reading your mail" : offered.length ? "Suggest others" : "Suggest labels"}
                </button>
              </div>
              {!offered.length && !suggesting && <p className="px-6 py-2 text-ink3">Tabellar can look at who writes to you and suggest labels to sort it into.</p>}
              {suggesting && !offered.length && <SkeletonRows count={3} />}
              {offered.map((s) => (
                <div key={s.name} className={`row group ${COLUMNS}`} title={s.senders.join(", ")}>
                  <span className="grid place-items-center">
                    <Icon name="add" size={13} className="text-ink4" />
                  </span>
                  <span className="truncate pr-3 text-ink2">{s.name}</span>
                  <span className="hidden truncate pr-3 text-ink3 md:block">{s.description}</span>
                  <span className="flex items-center justify-end gap-1">
                    <button className="btn-act !font-normal !text-ink3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" onClick={() => dismiss(s)}>
                      Not now
                    </button>
                    <button className="btn-act" onClick={() => addSuggestions([s])}>
                      Add
                    </button>
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// A label opened under its row: its name, the sentence and the colour.
function Editor({ label, onSave, onCancel, onDelete }: { label: Label; onSave: (d: Draft) => Promise<boolean>; onCancel: () => void; onDelete: () => void }) {
  const [d, setD] = useState<Draft>(() => ({ name: label.display_name, color: labelColor(label.color), description: label.description }));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <form
      className="mx-3 mb-2 mt-1 grid gap-3 rounded-[10px] bg-raised p-4 shadow-control"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        await onSave(d);
        setSaving(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}
    >
      <div className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
        <input className="input" aria-label="Name" value={d.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
        <input className="input" aria-label="Which mail belongs" value={d.description} maxLength={200} placeholder="Which mail belongs" onChange={(e) => set({ description: e.target.value })} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-0.5" role="radiogroup" aria-label="Colour">
          {LABEL_COLORS.map((c) => (
            <button key={c.hex} type="button" role="radio" aria-checked={d.color === c.hex} aria-label={c.name} title={c.name} className={`grid h-7 w-7 place-items-center rounded-md ${d.color === c.hex ? "bg-sel" : "hover:bg-hover"}`} onClick={() => set({ color: c.hex })}>
              <span className="h-3 w-3 rounded-full" style={{ background: c.hex }} />
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <span className="hidden text-xs text-ink3 md:inline" title="The label it has in your mailbox">
          {mappedTo(label)}
        </span>
        <button type="button" className="btn btn-plain !text-danger" onClick={onDelete}>
          Delete
        </button>
        <button type="button" className="btn btn-plain" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-pri" disabled={saving || !d.name.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}
