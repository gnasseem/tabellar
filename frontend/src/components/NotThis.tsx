// The "Not this" menu on what Tabellar made. Everything it was told or learned
// is in settings/AboutYou.tsx; what it asks is in the Brief.
import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { useApp } from "./AppShell";
import { api } from "@/lib/outcomes";
import { reversible } from "@/lib/undo";

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
  const { user, addToast } = useApp();
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
        const undo = await reversible(user.id, () => api("/profile/feedback", { thing, outcome, id, proposal, sender: sender ?? undefined, topic: outcome === "never_topic" ? text.trim() : undefined }));
        addToast("success", done, { action: { label: "Undo", onClick: () => undo().then(onDone) } });
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
