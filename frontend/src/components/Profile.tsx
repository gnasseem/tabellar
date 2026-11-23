// What Tabellar knows about the user, in the window: the questions it asks
// instead of guessing, the "Not this" menu on what it made, and the plain
// list of everything it was told or learned.
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { useApp } from "./AppShell";
import { Glyph } from "./ui";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";

const supabase = createClient();

type Question = { id: string; text: string; detail: string | null; options: { label: string }[]; created_at: string };

// One quiet row at the top of the Inbox that opens in place. Nothing shows
// while there is nothing to ask.
export function Questions() {
  const { user, liveChanges, addToast } = useApp();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("tabellar_questions") === "open";
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from("questions").select("id, text, detail, options, created_at").eq("user_id", user.id).eq("status", "open").order("created_at", { ascending: true });
    setQuestions((data as Question[]) ?? []);
  }, [user.id]);
  useEffect(() => {
    load();
  }, [load, liveChanges.questions]);

  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem("tabellar_questions", open ? "closed" : "open");
    } catch {
      // Remembering is a convenience.
    }
  };

  const reply = async (q: Question, option: number) => {
    setBusy(q.id);
    try {
      await api("/questions/answer", { id: q.id, option });
      setQuestions((prev) => prev.filter((x) => x.id !== q.id));
      load();
    } catch (e) {
      addToast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!questions.length) return null;
  return (
    <div className="border-b border-line-soft pb-1 pt-1">
      <button className="row w-full gap-2 text-left" aria-expanded={open} onClick={toggle}>
        <Glyph state="info" />
        <span className="font-medium text-ink">{questions.length === 1 ? "A question" : `${questions.length} questions`}</span>
        <span className="flex-1" />
        <Icon name={open ? "expand_less" : "expand_more"} size={15} className="text-ink3" />
      </button>
      {open && (
        <ul className="pb-2">
          {questions.map((q) => (
            <li key={q.id} className="mx-2 py-2 pl-8 pr-3">
              <p className="text-ink">{q.text}</p>
              {q.detail && <p className="mt-0.5 text-[12.5px] text-ink3">{q.detail}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {q.options.map((o, i) => (
                  <button key={o.label} className={`btn btn-sm ${i === q.options.length - 1 && q.options.length > 2 ? "btn-plain" : ""}`} disabled={busy === q.id} onClick={() => reply(q, i)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type NotThisThing = "todo" | "meeting" | "followup" | "newsletter";

// The menu on a todo, meeting, follow-up or newsletter row. "Not this" is the
// one item; the other two teach Tabellar for good. A todo or meeting is found
// by `id` and its sender by its email; follow-ups and newsletters pass the
// `sender` address. `who` names the sender in the menu. `onNotThis` replaces
// the server's "Not this" where the view removes the item itself (follow-ups).
export function NotThis({
  thing,
  id,
  sender,
  who: name,
  onDone,
  onNotThis,
}: {
  thing: NotThisThing;
  id?: string;
  sender?: string | null;
  who?: string | null;
  onDone: () => void;
  onNotThis?: () => void | Promise<void>;
}) {
  const { addToast } = useApp();
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const send = async (outcome: "not_this" | "never_sender" | "never_topic", done: string) => {
    setOpen(false);
    try {
      if (outcome === "not_this" && onNotThis) await onNotThis();
      else {
        await api("/profile/feedback", { thing, outcome, id, sender: sender ?? undefined, topic: outcome === "never_topic" ? text.trim() : undefined });
        addToast("success", done);
        prefsChanged();
      }
      onDone();
    } catch (e) {
      addToast("error", (e as Error).message);
    }
  };

  const who = name || sender?.toLowerCase() || "this sender";
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        className="iconbtn"
        title="Not this"
        aria-label="Not this"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setTyping(false);
          setText("");
        }}
      >
        <Icon name="more" size={15} />
      </button>
      {open && (
        <div className="pop absolute right-0 top-8 w-[264px]" role="menu">
          {thing === "newsletter" ? (
            <button role="menuitem" className="pop-item" onClick={() => send("not_this", `${who} is not a newsletter`)}>
              Not a newsletter
            </button>
          ) : (
            <>
              <button role="menuitem" className="pop-item" onClick={() => send("not_this", "Removed")}>
                Not this
              </button>
              {(sender || id) && (
                <button role="menuitem" className="pop-item" onClick={() => send("never_sender", `No more ${thing === "followup" ? "follow-ups" : `${thing}s`} for ${who}`)}>
                  <span className="truncate">Never for {who}</span>
                </button>
              )}
            </>
          )}
          {typing ? (
            <form
              className="flex items-center gap-1.5 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) send("never_topic", `Not interested in ${text.trim()}`);
              }}
            >
              <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Topic, e.g. webinars" aria-label="Topic" />
              <button className="btn btn-sm" type="submit" disabled={!text.trim()}>
                Save
              </button>
            </form>
          ) : (
            <button role="menuitem" className="pop-item" onClick={() => setTyping(true)}>
              Not interested in this topic
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Which mail the user's preferences keep from becoming a `thing`: a sender,
// its domain, or a topic the user is not interested in. The server applies
// the same rules (server/profile.ts); this is for lists the window builds
// itself, such as suggested todos and meetings.
const PREFS_EVENT = "tabellar:preferences";
const prefsChanged = () => window.dispatchEvent(new Event(PREFS_EVENT));

const STOPPERS: Record<string, string[]> = {
  todo: ["quiet", "ignore", "never_todo"],
  meeting: ["quiet", "ignore", "never_meeting"],
};
export function usePrefStops(thing: "todo" | "meeting") {
  const { user } = useApp();
  const [rows, setRows] = useState<{ kind: string; subject: string; value: string }[]>([]);
  useEffect(() => {
    const load = () =>
      supabase
        .from("preferences")
        .select("kind, subject, value")
        .eq("user_id", user.id)
        .in("value", STOPPERS[thing])
        .then(({ data }) => setRows((data as { kind: string; subject: string; value: string }[]) ?? []));
    load();
    window.addEventListener(PREFS_EVENT, load);
    return () => window.removeEventListener(PREFS_EVENT, load);
  }, [user.id, thing]);
  return useCallback(
    (address: string | null | undefined, text: string) => {
      const a = String(address ?? "").toLowerCase();
      const d = a.split("@")[1] ?? "";
      const t = text.toLowerCase();
      return rows.some((r) =>
        r.kind === "sender"
          ? r.subject === a
          : r.kind === "domain"
            ? !!d && (d === r.subject || d.endsWith(`.${r.subject}`))
            : r.kind === "topic" && r.subject.split(/\s+/).every((w) => t.includes(w.length > 3 ? w.replace(/s$/, "") : w)),
      );
    },
    [rows],
  );
}

type Pref = { id: string; kind: string; subject: string; value: string; source: string; evidence: string | null; updated_at: string };

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
const SENDER_VALUES = ["vip", "normal", "quiet", "ignore", "never_todo", "never_meeting", "never_draft", "never_followup", "not_newsletter"];
const SOURCE_LABEL: Record<string, string> = { asked: "You answered", learned: "Learned", user: "You set", onboarding: "Onboarding" };
const GROUPS: { kind: string; title: string }[] = [
  { kind: "fact", title: "Facts" },
  { kind: "rule", title: "Rules" },
  { kind: "sender", title: "People" },
  { kind: "domain", title: "Domains" },
  { kind: "topic", title: "Topics" },
];

// Settings > About you: every fact and preference, editable and deletable.
export function AboutYou() {
  const { user, addToast } = useApp();
  const [prefs, setPrefs] = useState<Pref[] | null>(null);
  const [adding, setAdding] = useState<{ kind: string; subject: string; value: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from("preferences").select("*").eq("user_id", user.id).order("updated_at", { ascending: false });
    setPrefs((data as Pref[]) ?? []);
  }, [user.id]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async (kind: string, subject: string, value: string, replace?: string) => {
    try {
      await api("/preferences", { kind, subject, value, replace });
      prefsChanged();
      setAdding(null);
      setEditing(null);
      load();
    } catch (e) {
      addToast("error", (e as Error).message);
    }
  };
  const remove = async (p: Pref) => {
    await supabase.from("preferences").delete().eq("id", p.id);
    setPrefs((prev) => prev?.filter((x) => x.id !== p.id) ?? null);
  };

  const free = (kind: string) => kind === "fact" || kind === "rule";
  return (
    <div className="space-y-6">
      {prefs && !prefs.length && <p className="text-ink2">Nothing yet</p>}
      {GROUPS.map((g) => {
        const rows = (prefs ?? []).filter((p) => p.kind === g.kind);
        return (
          <section key={g.kind}>
            <div className="mb-1 flex items-center">
              <h3 className="label">{g.title}</h3>
              <span className="flex-1" />
              <button className="btn btn-plain btn-sm" onClick={() => setAdding({ kind: g.kind, subject: "", value: free(g.kind) ? "" : g.kind === "topic" ? "ignore" : "normal" })}>
                <Icon name="add" size={13} /> Add
              </button>
            </div>
            <ul>
              {rows.map((p) => (
                <li key={p.id} className="group flex min-h-8 items-center gap-2 border-b border-line-soft py-1">
                  {free(p.kind) ? (
                    editing?.id === p.id ? (
                      <form className="flex flex-1 gap-1.5" onSubmit={(e) => (e.preventDefault(), save(p.kind, "", editing.text, p.id))}>
                        <input className="input" autoFocus value={editing.text} onChange={(e) => setEditing({ id: p.id, text: e.target.value })} aria-label={g.title} />
                        <button className="btn btn-sm" type="submit">Save</button>
                        <button className="btn btn-plain btn-sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
                      </form>
                    ) : (
                      <button className="min-w-0 flex-1 text-left text-ink" onClick={() => setEditing({ id: p.id, text: p.value })}>
                        {p.value}
                      </button>
                    )
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-ink" title={p.evidence ?? undefined}>
                        {p.subject}
                      </span>
                      {p.kind === "topic" ? (
                        <span className="text-ink2">Not interested</span>
                      ) : (
                        <select className="input !w-auto" value={p.value} onChange={(e) => save(p.kind, p.subject, e.target.value, p.id)} aria-label={`What ${p.subject} is`}>
                          {SENDER_VALUES.map((v) => (
                            <option key={v} value={v}>
                              {VALUE_LABEL[v]}
                            </option>
                          ))}
                        </select>
                      )}
                    </>
                  )}
                  <span className="hidden w-24 text-right text-xs text-ink3 sm:inline">{SOURCE_LABEL[p.source] ?? p.source}</span>
                  <button className="iconbtn opacity-0 focus:opacity-100 group-hover:opacity-100" title="Delete" aria-label={`Delete ${p.subject || p.value}`} onClick={() => remove(p)}>
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
              {adding?.kind === g.kind && (
                <li className="py-1.5">
                  <form className="flex gap-1.5" onSubmit={(e) => (e.preventDefault(), save(adding.kind, adding.subject, free(g.kind) ? adding.subject : adding.value))}>
                    <input
                      className="input"
                      autoFocus
                      value={adding.subject}
                      onChange={(e) => setAdding({ ...adding, subject: e.target.value })}
                      placeholder={{ fact: "Works on the payments team", rule: "No todos from job application receipts", sender: "name@example.com", domain: "example.com", topic: "webinars" }[g.kind]}
                      aria-label={g.title}
                    />
                    {(g.kind === "sender" || g.kind === "domain") && (
                      <select className="input !w-auto" value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} aria-label="What it is">
                        {SENDER_VALUES.map((v) => (
                          <option key={v} value={v}>
                            {VALUE_LABEL[v]}
                          </option>
                        ))}
                      </select>
                    )}
                    <button className="btn btn-sm" type="submit" disabled={!adding.subject.trim()}>Save</button>
                    <button className="btn btn-plain btn-sm" type="button" onClick={() => setAdding(null)}>Cancel</button>
                  </form>
                </li>
              )}
              {!rows.length && adding?.kind !== g.kind && <li className="py-1.5 text-ink3">None</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
