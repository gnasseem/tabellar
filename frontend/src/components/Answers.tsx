// A reply draft that leaves a decision to the user: the letter, with the
// answers to choose from in their place (server/choices.ts).
import { blocksOf } from "../../../server/choices.ts";

export type Picks = (number | undefined)[];

export default function Answers({ text, picks, onPick }: { text: string; picks: Picks; onPick: (picks: Picks) => void }) {
  let n = 0;
  return (
    <div className="grid gap-3">
      {blocksOf(text).map((b, i) => {
        if ("text" in b || b.choice.length < 2)
          return (
            <p key={i} className="whitespace-pre-line break-words">
              {"text" in b ? b.text : b.choice[0].text}
            </p>
          );
        const at = n++;
        return (
          <div key={i} role="radiogroup" aria-label="Answer" className="-mx-2 grid gap-0.5">
            {b.choice.map((c, j) => {
              const on = picks[at] === j;
              return (
                <button
                  key={c.label}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`grid grid-cols-[84px_minmax(0,1fr)] items-baseline gap-x-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${on ? "bg-sel" : "hover:bg-hover"}`}
                  onClick={() => {
                    const next = [...picks];
                    next[at] = on ? undefined : j;
                    onPick(next);
                  }}
                >
                  <span className={`break-words font-medium ${on ? "text-ink" : "text-wax-ink"}`}>{c.label}</span>
                  <span className={`break-words ${on ? "text-ink" : "text-ink2"}`}>{c.text}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
