// The questions Tabellar asks instead of guessing, and the "Not this" menu on
// what it made. Everything it was told or learned is in settings/AboutYou.tsx.
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
// by `id` (or, while it waits for approval, by its `proposal`) and its sender
// by its email; follow-ups and newsletters pass the `sender` address. `who`
// names the sender in the menu. `onNotThis` replaces the server's "Not this"
// where the view removes the item itself (follow-ups).
export function NotThis({
  thing,
  id,
  proposal,
  sender,
  who: name,
  onDone,
  onNotThis,
}: {
  thing: NotThisThing;
  id?: string;
  proposal?: string;
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
        await api("/profile/feedback", { thing, outcome, id, proposal, sender: sender ?? undefined, topic: outcome === "never_topic" ? text.trim() : undefined });
        addToast("success", done);
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
              {(sender || id || proposal) && (
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
