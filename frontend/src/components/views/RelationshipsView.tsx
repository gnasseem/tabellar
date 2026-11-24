import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";
import { Empty, Menu, Seg, SkeletonRows, ViewBar, shortWhen } from "../ui";
import KnowledgeView from "./KnowledgeView";

// Knowledge, people: everyone Tabellar has seen mail from, how often and how
// recently, and the notes kept about them. The Facts tab shows KnowledgeView.

type Contact = {
  sender_email: string;
  sender_name: string | null;
  interaction_count: number;
  relationship_notes: string | null;
  last_subject: string | null;
  last_interaction_at: string | null;
};

const COLS = "grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_52px] gap-x-3 lg:grid-cols-[minmax(0,180px)_minmax(0,1fr)_52px_52px]";

function daysSince(isoStr: string | null): number {
  if (!isoStr) return 9999;
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
}

// How current the correspondence is, as one word.
function healthLabel(contact: Contact): string {
  const days = daysSince(contact.last_interaction_at);
  if (days <= 7) return "Active";
  if (days <= 30) return "Recent";
  if (days <= 90) return "Fading";
  return "Dormant";
}

function nameOf(c: Contact): string {
  return c.sender_name || c.sender_email.split("@")[0];
}

export default function RelationshipsView() {
  const { getViewCache, setViewCache } = useApp();
  const [tab, setTab] = useState<"people" | "facts">(() => (getViewCache("knowledge:tab") === "facts" ? "facts" : "people"));
  const show = (t: "people" | "facts") => {
    setViewCache("knowledge:tab", t);
    setTab(t);
  };
  return tab === "facts" ? <KnowledgeView onPeople={() => show("people")} /> : <People onFacts={() => show("facts")} />;
}

function People({ onFacts }: { onFacts: () => void }) {
  const { user, search, addToast } = useApp();
  const supabase = createClient();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "quiet">("all");
  const [selected, setSelected] = useState<Contact | null>(null);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);

  // Whole rows are kept so a forgotten person can be put back as they were.
  const fetch = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("email_memory").select("*").eq("user_id", user.id).order("interaction_count", { ascending: false }).limit(500);
    setContacts((data as Contact[]) ?? []);
    setLoading(false);
  }, [user.id]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter((c) => (filter === "all" || daysSince(c.last_interaction_at) > 30) && (!q || `${c.sender_email} ${c.sender_name ?? ""} ${c.relationship_notes ?? ""}`.toLowerCase().includes(q)));
  }, [contacts, filter, search]);

  const open = (c: Contact) => {
    setSelected(c);
    setNotes(c.relationship_notes ?? "");
  };

  const saveNotes = async () => {
    if (!selected) return;
    setSavingNotes(true);
    await supabase.from("email_memory").update({ relationship_notes: notes }).eq("user_id", user.id).eq("sender_email", selected.sender_email);
    setContacts((prev) => prev.map((c) => (c.sender_email === selected.sender_email ? { ...c, relationship_notes: notes } : c)));
    setSelected((prev) => (prev ? { ...prev, relationship_notes: notes } : prev));
    setSavingNotes(false);
  };

  const forget = async (c: Contact) => {
    await supabase.from("email_memory").delete().eq("user_id", user.id).eq("sender_email", c.sender_email);
    setContacts((prev) => prev.filter((x) => x.sender_email !== c.sender_email));
    setSelected(null);
    const undo = async () => {
      const { error } = await supabase.from("email_memory").insert(c);
      if (!error) setContacts((prev) => [...prev, c].sort((a, b) => b.interaction_count - a.interaction_count));
    };
    addToast("info", `Forgot what Tabellar knew about ${nameOf(c)}`, { action: { label: "Undo", onClick: undo } });
  };

  const days = selected ? daysSince(selected.last_interaction_at) : 0;

  return (
    <>
      <ViewBar
        title="Knowledge"
        search="Search people"
        right={
          <Menu
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { id: "all", label: "Everyone" },
              { id: "quiet", label: "Quiet for a month" },
            ]}
          />
        }
      >
        <Seg
          value="people"
          onChange={(v) => v === "facts" && onFacts()}
          options={[
            { id: "people", label: "People" },
            { id: "facts", label: "Facts" },
          ]}
        />
      </ViewBar>
      <div className="flex min-h-0 flex-1">
        <div className={`min-w-0 flex-1 overflow-y-auto pb-3 ${selected ? "hidden md:block" : ""}`} role="listbox" aria-label="People">
          {loading ? (
            <div className="pt-9">
              <SkeletonRows />
            </div>
          ) : !filtered.length ? (
            <Empty icon="group" title={contacts.length ? "Nobody matches" : "No people yet"} />
          ) : (
            <>
              <div className={`${COLS} sticky top-0 z-[2] mx-2 h-head items-end bg-canvas pb-[7px] pl-3 pr-3 text-xs text-ink3`}>
                <span>Person</span>
                <span>What is known</span>
                <span className="hidden text-right lg:block">Emails</span>
                <span className="text-right">Last</span>
              </div>
              {filtered.map((c) => (
                <div key={c.sender_email} role="option" aria-selected={selected?.sender_email === c.sender_email} className={`row ${COLS} !pl-3`} onClick={() => open(c)}>
                  <b className="truncate font-medium text-ink">{nameOf(c)}</b>
                  <span className="truncate">{c.relationship_notes || <span className="text-ink3">{c.last_subject ? `Last wrote about: ${c.last_subject}` : c.sender_email}</span>}</span>
                  <span className="hidden text-right text-xs text-ink3 lg:block">{c.interaction_count.toLocaleString()}</span>
                  <span className="text-right text-xs text-ink3">{c.last_interaction_at ? shortWhen(c.last_interaction_at) : ""}</span>
                </div>
              ))}
            </>
          )}
        </div>

        {selected && (
          <div className="flex w-full flex-none flex-col border-line md:w-[360px] md:border-l">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-[18px]">
              <button className="link mb-3 md:hidden" onClick={() => setSelected(null)}>
                Back to people
              </button>
              <h2 className="text-[15px] font-[650] tracking-[-0.01em] text-ink">{nameOf(selected)}</h2>
              <p className="truncate text-xs text-ink3">{selected.sender_email}</p>

              <dl className="mt-4 grid grid-cols-[92px_minmax(0,1fr)] gap-y-1 border-y border-line-soft py-3 text-xs text-ink2">
                <dt className="text-ink3">Emails</dt>
                <dd>{selected.interaction_count.toLocaleString()}</dd>
                <dt className="text-ink3">Last heard</dt>
                <dd>{days === 9999 ? "Never" : days === 0 ? "Today" : `${new Date(selected.last_interaction_at!).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })}, ${days} ${days === 1 ? "day" : "days"} ago`}</dd>
                <dt className="text-ink3">In touch</dt>
                <dd>{healthLabel(selected)}</dd>
                {selected.last_subject && (
                  <>
                    <dt className="text-ink3">Last subject</dt>
                    <dd>{selected.last_subject}</dd>
                  </>
                )}
              </dl>

              <label className="mt-4 grid gap-1">
                <span className="label">Notes</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={6}
                  placeholder="Role, company, how you know them"
                  className="input resize-none"
                />
              </label>
            </div>
            <div className="flex flex-none items-center gap-2 border-t border-line px-5 py-[11px]">
              <button className="btn btn-pri" onClick={saveNotes} disabled={savingNotes || notes === (selected.relationship_notes ?? "")}>
                {savingNotes ? "Saving" : "Save notes"}
              </button>
              <span className="flex-1" />
              <button className="btn btn-danger" onClick={() => forget(selected)}>
                Forget
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
