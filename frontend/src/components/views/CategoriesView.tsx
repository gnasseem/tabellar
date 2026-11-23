import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import { Empty, KeyHints, SkeletonRows, ViewBar } from "../ui";
import { BUILT_IN_COLORS, LABEL_COLORS, addDismissedSlug, analyzeEmailPatterns, getDismissedSlugs, labelColor, removeDismissedSlug, type TagSuggestion } from "@/lib/tagSuggestions";

// Labels: the four every email is sorted into, the user's own, and the rules
// that tell Tabellar when to use each. A label's rules open beside the list.

/* eslint-disable @typescript-eslint/no-explicit-any */
type CategoryRule = {
  id: string;
  match_type: string;
  match_value: string;
  category_slug: string;
  hits: number;
  created_at: string;
};

type Tag = {
  id: string;
  slug: string;
  display_name: string;
  color: string;
  description: string;
  rules: any[];
};

// One row of the list: a built-in label or one of the user's.
type Label = { slug: string; name: string; color: string; description: string; tag: Tag | null };

const MAIN_CATEGORIES = [
  { slug: "important", display_name: "Important", description: "Mail from a person that is worth reading, with nothing to do." },
  { slug: "action-required", display_name: "Action required", description: "Mail that needs an answer or a task from you." },
  { slug: "promotions", display_name: "Promotions", description: "Marketing, offers and newsletters." },
  { slug: "updates", display_name: "Updates", description: "Receipts, notifications and other automated mail." },
];

const MATCH_TYPES: Record<string, string> = {
  description: "Described as",
  subject: "Subject contains",
  sender: "Sender contains",
  keyword: "Body mentions",
  domain: "Sender domain",
};

function Dot({ color, className = "" }: { color: string; className?: string }) {
  return <span aria-hidden className={`h-2 w-2 flex-none rounded-full ${className}`} style={{ background: color }} />;
}

export default function CategoriesView() {
  const { user, addToast, search } = useApp();
  const supabase = createClient();
  const [rules, setRules] = useState<CategoryRule[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  // The rule being typed for the selected label
  const [newMatchValue, setNewMatchValue] = useState("");

  // The inline row that creates a label
  const [creating, setCreating] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagDescription, setNewTagDescription] = useState("");
  const [newTagColor, setNewTagColor] = useState(LABEL_COLORS[3].hex);

  // Edits to the selected label, saved with Save
  const [edit, setEdit] = useState({ name: "", description: "", color: "" });

  // Labels Tabellar suggests from recent mail
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [suggestionsStatus, setSuggestionsStatus] = useState<"idle" | "loading" | "done">("idle");

  useEffect(() => {
    loadData();
  }, [user.id]);

  const loadData = async () => {
    setLoading(true);
    const [rulesRes, tagsRes, sortedRes] = await Promise.all([
      supabase.from("category_rules").select("*").eq("user_id", user.id).order("hits", { ascending: false }),
      supabase.from("categories").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
      supabase.from("email_processed").select("category, extra_labels").eq("user_id", user.id).limit(50000),
    ]);
    setRules(rulesRes.data || []);
    setTags(tagsRes.data || []);
    // How many emails carry each label: its one main label plus any others.
    const n: Record<string, number> = {};
    for (const row of (sortedRes.data || []) as { category: string; extra_labels: string[] | null }[]) {
      n[row.category] = (n[row.category] || 0) + 1;
      if (Array.isArray(row.extra_labels)) for (const slug of row.extra_labels) n[slug] = (n[slug] || 0) + 1;
    }
    setCounts(n);
    setLoading(false);
    analyzeSuggestions(tagsRes.data || []);
  };

  const addRule = async (slug: string) => {
    if (!newMatchValue.trim()) return;
    const { data } = await supabase
      .from("category_rules")
      .insert({
        user_id: user.id,
        match_type: "description",
        match_value: newMatchValue.trim(),
        category_slug: slug,
      })
      .select();
    if (data?.[0]) {
      setRules((prev) => [data[0], ...prev]);
      addToast("info", "Rule saved. It applies to new mail, not mail already sorted.");
    } else addToast("error", "Could not save that rule. It may already exist.");
    setNewMatchValue("");
  };

  const deleteRule = async (rule: CategoryRule) => {
    await supabase.from("category_rules").delete().eq("id", rule.id);
    setRules((prev) => prev.filter((r) => r.id !== rule.id));
    const undo = async () => {
      const { data } = await supabase.from("category_rules").insert(rule).select();
      if (data?.[0]) setRules((prev) => [data[0], ...prev]);
    };
    addToast("info", "Rule removed", { action: { label: "Undo", onClick: undo } });
  };

  const addTag = async () => {
    if (!newTagName.trim()) return;
    const slug = newTagName.trim().toLowerCase().replace(/\s+/g, "-");
    const { data } = await supabase
      .from("categories")
      .insert({
        user_id: user.id,
        slug,
        display_name: newTagName.trim(),
        color: newTagColor,
        description: newTagDescription.trim(),
      })
      .select();
    if (data?.[0]) {
      setTags((prev) => [...prev, data[0]]);
      setSelected(data[0].slug);
      addToast("info", "Label created. Tabellar applies it to new mail, not mail already sorted.");
      setNewTagName("");
      setNewTagDescription("");
      setNewTagColor(LABEL_COLORS[3].hex);
      setCreating(false);
    } else addToast("error", `Could not create "${newTagName.trim()}". A label with that name may already exist.`);
  };

  const saveTag = async (tag: Tag) => {
    const patch = { display_name: edit.name.trim() || tag.display_name, description: edit.description.trim(), color: edit.color };
    const { error } = await supabase.from("categories").update(patch).eq("id", tag.id);
    if (error) return addToast("error", "Could not save the label. Try again.");
    setTags((prev) => prev.map((t) => (t.id === tag.id ? { ...t, ...patch } : t)));
  };

  const deleteTag = async (tag: Tag) => {
    await supabase.from("categories").delete().eq("id", tag.id);
    setTags((prev) => prev.filter((t) => t.id !== tag.id));
    if (selected === tag.slug) setSelected(null);
    const undo = async () => {
      const { data } = await supabase.from("categories").insert(tag).select();
      if (data?.[0]) setTags((prev) => [...prev, data[0]]);
    };
    addToast("info", `Label "${tag.display_name}" deleted`, { action: { label: "Undo", onClick: undo } });
  };

  const analyzeSuggestions = async (current: Tag[] = tags) => {
    setSuggestionsStatus("loading");
    const { data: emailRows } = await supabase.from("emails").select("subject, sender_email").eq("user_id", user.id).order("received_at", { ascending: false }).limit(300);
    const dismissedSlugs = getDismissedSlugs(user.id);
    const existingSlugs = current.map((t) => t.slug);
    setSuggestions(analyzeEmailPatterns(emailRows ?? [], existingSlugs, dismissedSlugs));
    setSuggestionsStatus("done");
  };

  const addTagFromSuggestion = async (s: TagSuggestion) => {
    const { data } = await supabase.from("categories").insert({ user_id: user.id, slug: s.slug, display_name: s.name, color: s.color, description: s.description }).select();
    if (data?.[0]) {
      setTags((prev) => [...prev, data[0]]);
      setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
      addToast("success", `Label "${s.name}" added. Tabellar applies it to new mail.`);
    } else addToast("error", `Could not add "${s.name}". Try again.`);
  };

  const dismissSuggestion = (s: TagSuggestion) => {
    addDismissedSlug(user.id, s.slug);
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    const undo = () => {
      removeDismissedSlug(user.id, s.slug);
      setSuggestions((prev) => [...prev, s].sort((a, b) => b.matchCount - a.matchCount));
    };
    addToast("info", `"${s.name}" will not be suggested again`, { action: { label: "Undo", onClick: undo } });
  };

  const q = search.trim().toLowerCase();
  const matches = (name: string, description: string) => !q || `${name} ${description}`.toLowerCase().includes(q);
  const builtIn: Label[] = useMemo(() => MAIN_CATEGORIES.map((c) => ({ slug: c.slug, name: c.display_name, color: BUILT_IN_COLORS[c.slug], description: c.description, tag: null })), []);
  const own: Label[] = useMemo(() => tags.map((t) => ({ slug: t.slug, name: t.display_name, color: labelColor(t.color), description: t.description || "", tag: t })), [tags]);
  const current = [...builtIn, ...own].find((l) => l.slug === selected) || null;
  const currentRules = current ? rules.filter((r) => r.category_slug === current.slug) : [];
  const shownSuggestions = suggestions.filter((s) => matches(s.name, s.description));

  // Opening a label loads its details into the edit fields.
  useEffect(() => {
    setNewMatchValue("");
    if (current) setEdit({ name: current.name, description: current.description, color: current.color });
  }, [selected]);

  const dirty = !!current?.tag && (edit.name.trim() !== current.name || edit.description.trim() !== current.description || edit.color !== current.color);

  // What a row says after the name: the description, else its first rule.
  const about = (l: Label) => {
    const first = rules.find((r) => r.category_slug === l.slug);
    return l.description || first?.match_value || "No description or rules yet";
  };

  const row = (l: Label) => (
    <div key={l.slug} role="option" aria-selected={selected === l.slug} className="row gap-2.5" onClick={() => setSelected(l.slug)}>
      <Dot color={l.color} className="ml-1.5 mr-0.5" />
      <b className="flex-none font-medium text-ink">{l.name}</b>
      <span className="min-w-0 flex-1 truncate text-ink3">{about(l)}</span>
      <span className="flex-none text-xs text-ink3">{(counts[l.slug] || 0).toLocaleString()}</span>
    </div>
  );

  return (
    <>
      <ViewBar
        title="Labels"
        search="Search labels"
        right={
          <button className="btn" onClick={() => setCreating(true)}>
            <Icon name="add" size={14} className="text-ink3" />
            New label
          </button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className={`w-full flex-none overflow-y-auto border-line pb-3 md:w-[480px] md:border-r ${current ? "hidden md:block" : ""}`} role="listbox" aria-label="Labels">
          {loading ? (
            <div className="pt-9">
              <SkeletonRows count={8} />
            </div>
          ) : (
            <>
              <div className="day">
                <b>Sorted by Tabellar</b>
                <span className="truncate">Every email gets exactly one</span>
                <span className="flex-1" />
                <span>Emails</span>
              </div>
              {builtIn.filter((l) => matches(l.name, l.description)).map(row)}

              <div className="day">
                <b>Your labels</b>
                <span className="truncate">An email can carry several</span>
                <span className="flex-1" />
                <span>{own.length ? "Emails" : ""}</span>
              </div>
              {creating && (
                <form
                  className="mx-2 flex min-h-8 flex-wrap items-center gap-1.5 rounded-md bg-hover py-1 pl-1.5 pr-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addTag();
                  }}
                  onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
                >
                  <button
                    type="button"
                    className="grid h-6 w-6 flex-none place-items-center rounded-md hover:bg-sel"
                    title="Change colour"
                    aria-label="Change colour"
                    onClick={() => setNewTagColor(LABEL_COLORS[(LABEL_COLORS.findIndex((c) => c.hex === newTagColor) + 1) % LABEL_COLORS.length].hex)}
                  >
                    <Dot color={newTagColor} />
                  </button>
                  <input autoFocus className="input !h-6 !w-[120px] bg-canvas" value={newTagName} onChange={(e) => setNewTagName(e.target.value)} placeholder="Name" aria-label="Label name" />
                  <input
                    className="input !h-6 min-w-[120px] flex-1 bg-canvas"
                    value={newTagDescription}
                    onChange={(e) => setNewTagDescription(e.target.value)}
                    placeholder="Which mail gets it, in your words"
                    aria-label="When Tabellar should use this label"
                  />
                  <button type="submit" className="btn btn-sm" disabled={!newTagName.trim()}>
                    Add
                  </button>
                  <button type="button" className="btn btn-sm btn-plain" onClick={() => setCreating(false)}>
                    Cancel
                  </button>
                </form>
              )}
              {own.filter((l) => matches(l.name, l.description)).map(row)}
              {!own.length && !creating && <p className="px-5 py-1.5 text-ink3">None yet. Add one with New label, or take one of the suggestions below.</p>}

              <div className="day">
                <b>Suggested by Tabellar</b>
                <span className="truncate">From your last 300 emails</span>
                <span className="flex-1" />
                {suggestionsStatus === "done" && (
                  <button className="link" onClick={() => analyzeSuggestions()}>
                    Look again
                  </button>
                )}
              </div>
              {suggestionsStatus !== "done" ? (
                <SkeletonRows count={3} />
              ) : !shownSuggestions.length ? (
                <p className="px-5 py-1.5 text-ink3">{q ? "No suggestion matches that search." : "Nothing to suggest right now."}</p>
              ) : (
                shownSuggestions.map((s) => (
                  <div key={s.id} className="row gap-2.5" title={s.examples.join("\n")}>
                    <Dot color={labelColor(s.color)} className="ml-1.5 mr-0.5" />
                    <span className="flex-none text-ink">{s.name}</span>
                    <span className="min-w-0 flex-1 truncate text-ink3">{s.description}</span>
                    <span className="flex-none text-xs text-ink3">{s.matchCount} emails</span>
                    <button className="btn btn-sm" onClick={() => addTagFromSuggestion(s)}>
                      Add
                    </button>
                    <button className="iconbtn !h-6 !w-6" aria-label={`Do not suggest ${s.name}`} title="Do not suggest this" onClick={() => dismissSuggestion(s)}>
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                ))
              )}
            </>
          )}
        </div>

        {current ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-[18px] md:px-8">
              <div className="max-w-[520px]">
                <button className="link mb-3 md:hidden" onClick={() => setSelected(null)}>
                  Back to labels
                </button>
                <div className="flex items-center gap-2.5">
                  <Dot color={current.tag ? edit.color : current.color} />
                  <h2 className="text-[15px] font-[650] tracking-[-0.01em] text-ink">{current.name}</h2>
                  <span className="text-xs text-ink3">{(counts[current.slug] || 0).toLocaleString()} emails</span>
                </div>

                {current.tag ? (
                  <div className="mt-4 grid grid-cols-[92px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
                    <label htmlFor="label-name" className="text-ink3">
                      Name
                    </label>
                    <input id="label-name" className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                    <label htmlFor="label-about" className="self-start pt-1.5 text-ink3">
                      Used for
                    </label>
                    <textarea
                      id="label-about"
                      className="input resize-none"
                      rows={2}
                      value={edit.description}
                      onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                      placeholder="Which mail gets this label, in your words. Tabellar reads this when it sorts."
                    />
                    <span className="text-ink3">Colour</span>
                    <div className="flex gap-1" role="radiogroup" aria-label="Colour">
                      {LABEL_COLORS.map((c) => (
                        <button
                          key={c.hex}
                          type="button"
                          role="radio"
                          aria-checked={edit.color === c.hex}
                          aria-label={c.name}
                          title={c.name}
                          className={`grid h-6 w-6 place-items-center rounded-md transition-colors duration-150 ${edit.color === c.hex ? "bg-sel" : "hover:bg-hover"}`}
                          onClick={() => setEdit({ ...edit, color: c.hex })}
                        >
                          <Dot color={c.hex} />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 leading-normal text-ink2">{current.description} Tabellar decides this for every email as it arrives; rules below steer it.</p>
                )}

                <h3 className="label mt-7">Rules</h3>
                <p className="mt-0.5 text-xs text-ink2">Say in plain words which mail belongs under {current.name}. Rules apply to new mail, not mail already sorted.</p>
                <div className="mt-2 border-t border-line-soft">
                  {currentRules.map((rule) => (
                    <div key={rule.id} className="flex min-h-9 items-center gap-3 border-b border-line-soft py-1.5">
                      <span className="w-[104px] flex-none text-xs text-ink3">{MATCH_TYPES[rule.match_type] || rule.match_type}</span>
                      <span className="min-w-0 flex-1 text-ink">{rule.match_value}</span>
                      <span className="flex-none text-xs text-ink3">{rule.hits > 1 ? `used ${rule.hits} times` : ""}</span>
                      <button className="iconbtn !h-6 !w-6" aria-label="Remove rule" title="Remove rule" onClick={() => deleteRule(rule)}>
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  ))}
                  {!currentRules.length && <p className="border-b border-line-soft py-2 text-ink3">No rules. Tabellar goes by the label's name{current.tag ? " and what it is used for" : ""}.</p>}
                </div>
                <form
                  className="mt-2.5 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addRule(current.slug);
                  }}
                >
                  <input className="input" value={newMatchValue} onChange={(e) => setNewMatchValue(e.target.value)} placeholder="Such as: anything from my bank, or about invoices and payments" aria-label="New rule" />
                  <button type="submit" className="btn flex-none" disabled={!newMatchValue.trim()}>
                    Add rule
                  </button>
                </form>
              </div>
            </div>
            {current.tag && (
              <div className="flex flex-none items-center gap-2 border-t border-line py-[11px] pl-6 pr-4 md:pl-8">
                <button className="btn btn-pri" disabled={!dirty} onClick={() => saveTag(current.tag!)}>
                  Save
                </button>
                <span className="flex-1" />
                <button className="btn btn-danger" onClick={() => deleteTag(current.tag!)}>
                  Delete label
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="hidden min-w-0 flex-1 md:block">
            {!loading && (
              <Empty icon="label" title="Select a label to see its rules">
                Rules tell Tabellar, in plain words, which mail belongs under a label. Your own labels can also be renamed, recoloured or deleted here.
              </Empty>
            )}
          </div>
        )}
      </div>
      <KeyHints left={loading ? "" : `${builtIn.length + own.length} labels, ${rules.length} ${rules.length === 1 ? "rule" : "rules"}`} keys={[]} />
    </>
  );
}
