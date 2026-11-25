// Settings, About you: everything Tabellar was told or learned about the user,
// editable and deletable, and the questions it asked.
import { useCallback, useContext, useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";
import { useApp } from "../AppShell";
import { EmailField, useContacts } from "../EmailAutocomplete";
import { AddButton, Group, LineField, Lines, loadingLines, Row, Saved } from "./parts";

const supabase = createClient();

type Pref = { id: string; kind: string; subject: string; value: string; source: string; evidence: string | null };
type Question = { id: string; text: string; detail: string | null; options: { label: string }[]; status: string; answer: string | null; answered_at: string | null };

// The two facts with a field of their own (ROLE and WORK in server/profile.ts).
const FIELDS = [
  { prefix: "Role: ", key: "role", name: "Role", placeholder: "Such as Head of sales at Acme" },
  { prefix: "Works on: ", key: "work", name: "Working on", placeholder: "Such as the spring launch" },
] as const;

const VALUE_LABEL: Record<string, string> = {
  vip: "Most important",
  normal: "Deals with",
  quiet: "Nothing from their mail",
  ignore: "Ignore",
  never_todo: "No todos",
  never_meeting: "No meetings",
  never_draft: "No drafts",
  never_followup: "No follow-ups",
  not_newsletter: "Not a newsletter",
};
const VALUES = Object.keys(VALUE_LABEL);
const SOURCE_LABEL: Record<string, string> = { asked: "You answered", learned: "Learned", user: "You set", onboarding: "First run" };

// People first by how much they matter, then by name.
const rank = (v: string) => VALUES.indexOf(v);

export default function AboutYou() {
  const { user, addToast, setView, liveChanges } = useApp();
  const flash = useContext(Saved);
  const { contacts } = useContacts(user.id);
  const [prefs, setPrefs] = useState<Pref[] | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [adding, setAdding] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const [value, setValue] = useState("vip");
  const [past, setPast] = useState(false);

  const load = useCallback(async () => {
    const [{ data: p }, { data: q }] = await Promise.all([
      supabase.from("preferences").select("*").eq("user_id", user.id).neq("kind", "writing").order("updated_at", { ascending: false }),
      supabase.from("questions").select("id, text, detail, options, status, answer, answered_at").eq("user_id", user.id).neq("status", "waiting").order("created_at", { ascending: false }).limit(200),
    ]);
    const rows = (p as Pref[]) ?? [];
    setPrefs(rows);
    setQuestions((q as Question[]) ?? []);
    const people = rows.filter((r) => r.kind === "sender").map((r) => r.subject);
    const found = new Map<string, string>();
    for (let i = 0; i < people.length; i += 300) {
      const { data } = await supabase.from("senders").select("address, name").eq("user_id", user.id).in("address", people.slice(i, i + 300));
      for (const s of (data as { address: string; name: string | null }[]) ?? []) if (s.name) found.set(s.address, s.name);
    }
    setNames(found);
  }, [user.id]);
  useEffect(() => {
    load();
  }, [load, liveChanges.questions]);

  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      flash();
    } catch (e) {
      addToast("error", (e as Error).message);
    }
    load();
  };
  const save = (kind: string, subject: string, v: string, replace?: string) => run(() => api("/preferences", { kind, subject, value: v, replace })).then(() => setAdding(null));
  const remove = (p: Pref) =>
    run(async () => {
      await supabase.from("preferences").delete().eq("id", p.id);
      addToast("info", "Deleted", { action: { label: "Undo", onClick: () => void supabase.from("preferences").insert({ user_id: user.id, kind: p.kind, subject: p.subject, value: p.value, source: p.source, evidence: p.evidence }).then(load) } });
    });

  if (!prefs) return loadingLines;
  const of = (kind: string) => prefs.filter((p) => p.kind === kind);
  const facts = of("fact").filter((f) => !FIELDS.some((x) => f.value.startsWith(x.prefix)));
  const open = questions.filter((q) => q.status === "open");
  const answered = questions.filter((q) => q.status === "answered");

  const lines = (kind: "fact" | "rule", rows: Pref[], placeholder: string, label: string) => (
    <Lines
      label={label}
      placeholder={placeholder}
      lines={rows.map((p) => ({ id: p.id, text: p.value, right: SOURCE_LABEL[p.source] ?? p.source, title: p.evidence ?? undefined }))}
      adding={adding === kind}
      setAdding={(v) => setAdding(v ? kind : null)}
      onSave={(text, replace) => save(kind, "", text, replace)}
      onDelete={(id) => {
        const p = rows.find((r) => r.id === id);
        if (p) remove(p);
      }}
    />
  );

  // Senders and domains: what each one is, in a select.
  const standing = (kind: "sender" | "domain") => {
    const rows = of(kind).sort((a, b) => rank(a.value) - rank(b.value) || a.subject.localeCompare(b.subject));
    return (
      <>
        {adding === kind && (
          <form
            className="flex flex-wrap items-center gap-1.5 py-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (who.trim()) save(kind, who.trim(), value).then(() => setWho(""));
            }}
            onKeyDown={(e) => e.key === "Escape" && setAdding(null)}
          >
            {kind === "sender" ? (
              <EmailField value={who} onChange={setWho} contacts={contacts} multi={false} placeholder="name@example.com" className="min-w-[200px] flex-1" />
            ) : (
              <input className="input !w-auto min-w-[200px] flex-1" autoFocus value={who} onChange={(e) => setWho(e.target.value)} placeholder="example.com" aria-label="Domain" />
            )}
            <StandingSelect value={value} onChange={setValue} label="What they are" />
            <button className="btn btn-sm" type="submit" disabled={!who.trim()}>
              Save
            </button>
            <button className="btn btn-plain btn-sm" type="button" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </form>
        )}
        {rows.map((p) => {
          const name = kind === "sender" ? names.get(p.subject) : "";
          return (
            <div key={p.id} className="group flex min-h-row items-center gap-2 py-1">
              <span className="min-w-0 flex-1 truncate" title={[p.subject, p.evidence].filter(Boolean).join(". ")}>
                <span className={p.value === "vip" ? "font-medium text-ink" : "text-ink"}>{name || p.subject}</span>
                {name && <span className="ml-2 text-ink3">{p.subject}</span>}
              </span>
              <span className="hidden flex-none text-right text-xs text-ink3 sm:inline">{SOURCE_LABEL[p.source] ?? p.source}</span>
              <StandingSelect value={p.value} onChange={(v) => save(kind, p.subject, v, p.id)} label={`What ${p.subject} is`} />
              <DeleteButton label={p.subject} onClick={() => remove(p)} />
            </div>
          );
        })}
        {!rows.length && adding !== kind && <p className="flex min-h-row items-center text-ink3">None</p>}
      </>
    );
  };
  const add = (kind: string) => (
    <AddButton
      onClick={() => {
        setWho("");
        setValue(kind === "domain" ? "quiet" : "vip");
        setAdding(kind);
      }}
    />
  );

  return (
    <>
      <Group title="You" right={add("fact")}>
        {FIELDS.map((f) => {
          const row = of("fact").find((r) => r.value.startsWith(f.prefix));
          return (
            <div key={f.key} className="flex min-h-setting items-center gap-4 py-row2">
              <span className="w-[96px] flex-none text-ink">{f.name}</span>
              <LineField className="min-w-0 flex-1" label={f.name} placeholder={f.placeholder} value={row ? row.value.slice(f.prefix.length) : ""} onSave={(v) => run(() => api("/onboarding/about", { [f.key]: v }))} />
            </div>
          );
        })}
        {lines("fact", facts, "Works on the payments team", "Fact")}
      </Group>

      {of("rule").length > 0 && (
        <Group title="Rules" note="For what Tabellar makes from mail. A new one is a sentence in Automations.">
          {lines("rule", of("rule"), "No todos from job application receipts", "Rule")}
        </Group>
      )}

      <Group title="Questions">
        {!open.length && <p className="flex min-h-row items-center text-ink3">No open questions</p>}
        {open.map((q) => (
          <div key={q.id} className="py-2.5">
            <p className="text-ink">{q.text}</p>
            {q.detail && <p className="mt-0.5 text-[12.5px] text-ink3">{q.detail}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {q.options.map((o, i) => (
                <button key={o.label} className={`btn btn-sm ${i === q.options.length - 1 && q.options.length > 2 ? "btn-plain" : ""}`} onClick={() => run(() => api("/questions/answer", { id: q.id, option: i }))}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {answered.length > 0 && (
          <button className="flex min-h-row w-full items-center gap-1 text-left text-ink2 hover:text-ink" aria-expanded={past} onClick={() => setPast(!past)}>
            {answered.length.toLocaleString()} answered
            <Icon name={past ? "expand_less" : "expand_more"} size={13} className="text-ink3" />
          </button>
        )}
        {past &&
          answered.map((q) => (
            <div key={q.id} className="group flex min-h-row items-center gap-3 py-1">
              <span className="min-w-0 flex-1 truncate text-ink" title={q.detail ?? undefined}>
                {q.text}
              </span>
              <span className="flex-none text-ink2">{q.answer}</span>
              <span className="w-12 flex-none text-right text-xs text-ink3">{q.answered_at ? new Date(q.answered_at).toLocaleDateString([], { day: "numeric", month: "short" }) : ""}</span>
              <button className="link flex-none" onClick={() => run(() => api("/questions/reopen", { id: q.id }))}>
                Ask again
              </button>
            </div>
          ))}
      </Group>

      <Group title="People" right={add("sender")}>
        {standing("sender")}
      </Group>

      <Group title="Domains" right={add("domain")}>
        {standing("domain")}
      </Group>

      <Group title="Not interested in" right={add("topic")}>
        {of("topic").map((p) => (
          <div key={p.id} className="group flex min-h-row items-center gap-2 py-1">
            <span className="min-w-0 flex-1 truncate text-ink" title={p.evidence ?? undefined}>
              {p.subject}
            </span>
            <span className="flex-none text-xs text-ink3">{SOURCE_LABEL[p.source] ?? p.source}</span>
            <DeleteButton label={p.subject} onClick={() => remove(p)} />
          </div>
        ))}
        {adding === "topic" && (
          <form
            className="flex items-center gap-1.5 py-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (who.trim()) save("topic", who.trim(), "ignore").then(() => setWho(""));
            }}
            onKeyDown={(e) => e.key === "Escape" && setAdding(null)}
          >
            <input className="input" autoFocus value={who} onChange={(e) => setWho(e.target.value)} placeholder="webinars" aria-label="Topic" />
            <button className="btn btn-sm" type="submit" disabled={!who.trim()}>
              Save
            </button>
            <button className="btn btn-plain btn-sm" type="button" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </form>
        )}
        {!of("topic").length && adding !== "topic" && <p className="flex min-h-row items-center text-ink3">None</p>}
      </Group>

      <Group title="Your data" note="All of it is in one file on this Mac. Keys and tokens are in the Keychain.">
        <Row name="Knowledge" text="People and companies noted from your mail">
          <button className="btn" onClick={() => setView("relationships")}>
            Open Knowledge
          </button>
        </Row>
      </Group>
    </>
  );
}

function StandingSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <select className="input !w-[204px] flex-none" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {VALUES.map((v) => (
        <option key={v} value={v}>
          {VALUE_LABEL[v]}
        </option>
      ))}
    </select>
  );
}

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="iconbtn -mr-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100" title="Delete" aria-label={`Delete ${label}`} onClick={onClick}>
      <Icon name="close" size={14} />
    </button>
  );
}
