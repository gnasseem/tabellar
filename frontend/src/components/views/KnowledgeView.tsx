import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import { Empty, KeyHints, Menu, Seg, SkeletonRows, ViewBar, shortWhen } from "../ui";

// Knowledge, facts: what Tabellar has noted about people, companies and
// projects while reading mail, and what the user has told it. Drafts and
// answers draw on these. The people it has heard from are in RelationshipsView,
// which shows this view under its Facts tab.

type KnowledgeEntry = {
  id: string;
  entity: string;
  entity_type: string;
  info: string;
  source: string | null;
  confidence: number;
  created_at: string;
  importance: string;
  use_count: number;
  last_used_at: string | null;
};

const KINDS: { id: string; label: string }[] = [
  { id: "person", label: "Person" },
  { id: "company", label: "Company" },
  { id: "project", label: "Project" },
  { id: "topic", label: "Topic" },
  { id: "location", label: "Place" },
  { id: "other", label: "Other" },
];
const IMPORTANCE = ["critical", "high", "normal", "low"];
const COLS = "grid grid-cols-[150px_minmax(0,1fr)_56px] gap-x-3 lg:grid-cols-[150px_minmax(0,1fr)_68px_84px_56px]";

// Where a fact came from, in the window's words.
const SOURCES: Record<string, string> = { manual: "You", assistant: "Ask", draft_refinement: "Your edits", email: "Your mail" };

function sourceLabel(source: string | null): string {
  if (!source) return "Your mail";
  return SOURCES[source] ?? source.replace(/_/g, " ");
}

export default function KnowledgeView({ onPeople }: { onPeople?: () => void }) {
  const { user, search, addToast, setView } = useApp();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([]);
  const [kind, setKind] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ entity: "", entity_type: "person", info: "", importance: "normal" });

  // The inline row that adds a fact
  const [adding, setAdding] = useState(false);
  const [newEntity, setNewEntity] = useState("");
  const [newEntityType, setNewEntityType] = useState("person");
  const [newInfo, setNewInfo] = useState("");

  useEffect(() => {
    load();
  }, [user.id]);

  // Important facts first, then the ones used most.
  const sortFacts = (list: KnowledgeEntry[]) =>
    [...list].sort((a, b) => {
      const ia = IMPORTANCE.indexOf(a.importance);
      const ib = IMPORTANCE.indexOf(b.importance);
      if (ia !== ib) return (ia < 0 ? 2 : ia) - (ib < 0 ? 2 : ib);
      return (b.use_count || 0) - (a.use_count || 0);
    });

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("knowledge_base")
      .select("*")
      .eq("user_id", user.id)
      .order("importance", { ascending: true })
      .order("use_count", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(500);
    setKnowledge(sortFacts((data || []) as KnowledgeEntry[]));
    setLoading(false);
  };

  const addKnowledge = async () => {
    if (!newEntity.trim() || !newInfo.trim()) return;
    const { data } = await supabase
      .from("knowledge_base")
      .insert({
        user_id: user.id,
        entity: newEntity.trim(),
        entity_type: newEntityType,
        info: newInfo.trim(),
        source: "manual",
        confidence: 1.0,
      })
      .select();
    if (!data?.[0]) return addToast("error", `Could not add that. Tabellar may already have a fact about "${newEntity.trim()}"; edit that one instead.`);
    setKnowledge((prev) => [data[0], ...prev]);
    setSelectedId(data[0].id);
    setNewEntity("");
    setNewInfo("");
    setAdding(false);
  };

  const saveKnowledge = async (k: KnowledgeEntry) => {
    const patch = { entity: edit.entity.trim() || k.entity, entity_type: edit.entity_type, info: edit.info.trim() || k.info, importance: edit.importance };
    const { error } = await supabase.from("knowledge_base").update(patch).eq("id", k.id);
    if (error) return addToast("error", "Could not save the change. Another fact may already use that name and kind.");
    setKnowledge((prev) => prev.map((entry) => (entry.id === k.id ? { ...entry, ...patch } : entry)));
  };

  const deleteKnowledge = async (k: KnowledgeEntry) => {
    await supabase.from("knowledge_base").delete().eq("id", k.id);
    setKnowledge((prev) => prev.filter((entry) => entry.id !== k.id));
    if (selectedId === k.id) setSelectedId(null);
    const undo = async () => {
      const { data } = await supabase.from("knowledge_base").insert(k).select();
      if (data?.[0]) setKnowledge((prev) => sortFacts([...prev, data[0]]));
    };
    addToast("info", `Forgot the fact about ${k.entity}`, { action: { label: "Undo", onClick: undo } });
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return knowledge.filter((k) => (kind === "all" || k.entity_type === kind) && (!q || `${k.entity} ${k.info}`.toLowerCase().includes(q)));
  }, [knowledge, kind, search]);
  const current = knowledge.find((k) => k.id === selectedId) || null;

  // Opening a fact loads it into the edit fields.
  useEffect(() => {
    if (current) setEdit({ entity: current.entity, entity_type: current.entity_type, info: current.info, importance: current.importance || "normal" });
  }, [selectedId]);

  const dirty = !!current && (edit.entity.trim() !== current.entity || edit.entity_type !== current.entity_type || edit.info.trim() !== current.info || edit.importance !== (current.importance || "normal"));

  return (
    <>
      <ViewBar
        title="Knowledge"
        search="Search facts"
        right={
          <>
            <Menu label="Kind" value={kind} onChange={setKind} options={[{ id: "all", label: "All" }, ...KINDS]} />
            <button className="btn" onClick={() => setAdding(true)}>
              <Icon name="add" size={14} className="text-ink3" />
              Add a fact
            </button>
          </>
        }
      >
        <Seg
          value="facts"
          onChange={(v) => v === "people" && (onPeople ? onPeople() : setView("relationships"))}
          options={[
            { id: "people", label: "People" },
            { id: "facts", label: "Facts", count: knowledge.length },
          ]}
        />
      </ViewBar>
      <div className="flex min-h-0 flex-1">
        <div className={`min-w-0 flex-1 overflow-y-auto pb-3 ${current ? "hidden md:block" : ""}`} role="listbox" aria-label="Facts">
          {loading ? (
            <div className="pt-9">
              <SkeletonRows />
            </div>
          ) : (
            <>
              <div className={`${COLS} sticky top-0 z-[2] mx-2 h-[34px] items-end bg-canvas pb-[7px] pl-3 pr-3 text-xs text-ink3`}>
                <span>About</span>
                <span>What is known</span>
                <span className="hidden lg:block">Importance</span>
                <span className="hidden lg:block">From</span>
                <span className="text-right">Used</span>
              </div>
              {adding && (
                <form
                  className="mx-2 flex min-h-8 flex-wrap items-center gap-1.5 rounded-md bg-hover px-1.5 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addKnowledge();
                  }}
                  onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
                >
                  <select className="input h-6 w-auto bg-canvas" value={newEntityType} onChange={(e) => setNewEntityType(e.target.value)} aria-label="Kind">
                    {KINDS.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                  <input autoFocus className="input h-6 w-[140px] bg-canvas" value={newEntity} onChange={(e) => setNewEntity(e.target.value)} placeholder="Who or what" aria-label="Who or what the fact is about" />
                  <input className="input h-6 min-w-[140px] flex-1 bg-canvas" value={newInfo} onChange={(e) => setNewInfo(e.target.value)} placeholder="What Tabellar should know" aria-label="The fact" />
                  <button type="submit" className="btn btn-sm" disabled={!newEntity.trim() || !newInfo.trim()}>
                    Add
                  </button>
                  <button type="button" className="btn btn-sm btn-plain" onClick={() => setAdding(false)}>
                    Cancel
                  </button>
                </form>
              )}
              {!shown.length ? (
                <Empty icon="lightbulb" title={knowledge.length ? "No fact matches" : "Nothing learned yet"}>
                  {knowledge.length
                    ? "Try another word, or set Kind back to All."
                    : "As Tabellar reads your mail it notes facts about the people, companies and projects in it, and uses them when it drafts replies. You can also add a fact yourself."}
                </Empty>
              ) : (
                shown.map((k) => (
                  <div key={k.id} role="option" aria-selected={k.id === selectedId} className={`row ${COLS} !pl-3`} onClick={() => setSelectedId(k.id)}>
                    <b className="truncate font-medium text-ink">{k.entity}</b>
                    <span className="truncate">{k.info}</span>
                    <span className={`hidden truncate text-xs lg:block ${k.importance === "critical" || k.importance === "high" ? "text-ink" : "text-ink3"}`}>{k.importance === "normal" ? "" : k.importance}</span>
                    <span className="hidden truncate text-xs text-ink3 lg:block">{sourceLabel(k.source)}</span>
                    <span className="text-right text-xs text-ink3">{k.last_used_at ? shortWhen(k.last_used_at) : ""}</span>
                  </div>
                ))
              )}
            </>
          )}
        </div>

        {current && (
          <div className="flex w-full flex-none flex-col border-line md:w-[360px] md:border-l">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-[18px]">
              <button className="link mb-3 md:hidden" onClick={() => setSelectedId(null)}>
                Back to facts
              </button>
              <div className="grid gap-3">
                <label className="grid gap-1">
                  <span className="label">About</span>
                  <input className="input" value={edit.entity} onChange={(e) => setEdit({ ...edit, entity: e.target.value })} />
                </label>
                <label className="grid gap-1">
                  <span className="label">Kind</span>
                  <select className="input" value={edit.entity_type} onChange={(e) => setEdit({ ...edit, entity_type: e.target.value })}>
                    {!KINDS.some((x) => x.id === edit.entity_type) && <option value={edit.entity_type}>{edit.entity_type}</option>}
                    {KINDS.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="label">What is known</span>
                  <textarea className="input resize-none" rows={5} value={edit.info} onChange={(e) => setEdit({ ...edit, info: e.target.value })} />
                </label>
                <div className="grid gap-1">
                  <span className="label">Importance</span>
                  <div className="-ml-2">
                    <Seg
                      value={edit.importance}
                      onChange={(v) => setEdit({ ...edit, importance: v })}
                      options={[
                        { id: "low", label: "Low" },
                        { id: "normal", label: "Normal" },
                        { id: "high", label: "High" },
                        { id: "critical", label: "Critical" },
                      ]}
                    />
                  </div>
                </div>
              </div>
              <dl className="mt-5 grid grid-cols-[92px_minmax(0,1fr)] gap-y-1 border-t border-line-soft pt-3.5 text-xs text-ink2">
                <dt className="text-ink3">Came from</dt>
                <dd>{current.source === "manual" ? "You added it" : current.source === "assistant" ? "A conversation in Ask" : current.source === "draft_refinement" ? "Your edits to a draft" : sourceLabel(current.source)}</dd>
                <dt className="text-ink3">Noted</dt>
                <dd>{new Date(current.created_at).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })}</dd>
                <dt className="text-ink3">Used</dt>
                <dd>{current.use_count ? `${current.use_count} ${current.use_count === 1 ? "time" : "times"}${current.last_used_at ? `, last ${shortWhen(current.last_used_at)}` : ""}` : "Not yet"}</dd>
              </dl>
            </div>
            <div className="flex flex-none items-center gap-2 border-t border-line px-5 py-[11px]">
              <button className="btn btn-pri" disabled={!dirty} onClick={() => saveKnowledge(current)}>
                Save
              </button>
              <span className="flex-1" />
              <button className="btn btn-danger" onClick={() => deleteKnowledge(current)}>
                Forget
              </button>
            </div>
          </div>
        )}
      </div>
      <KeyHints left={loading ? "" : shown.length === knowledge.length ? `${knowledge.length} ${knowledge.length === 1 ? "fact" : "facts"}` : `${shown.length} of ${knowledge.length} facts`} keys={[]} />
    </>
  );
}
