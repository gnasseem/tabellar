import { Glyph } from "./ui";

// Shown over the Inbox while mail is fetched and read: the steps in order,
// the finished ones ticked and the current one marked as working.

const INITIAL_PHASES = ["Connect to Gmail", "Fetch your recent mail", "Read each email: sort it, draft replies, find todos and meetings, write the briefing"];
const REFRESH_PHASES = ["Connect to Gmail", "Fetch new mail", "Read the new mail"];

type Props = {
  phaseIndex: number;
  mode?: "initial" | "refresh";
};

export default function InitialFetchOverlay({ phaseIndex, mode = "initial" }: Props) {
  const phases = mode === "refresh" ? REFRESH_PHASES : INITIAL_PHASES;
  return (
    <div className="fixed inset-y-0 left-0 right-0 z-30 grid place-items-center bg-canvas/80 p-4 lg:left-56">
      <div className="w-full max-w-[400px] rounded-[12px] bg-raised px-5 pb-4 pt-[18px] shadow-pop" role="status" aria-live="polite">
        <h2 className="text-[15px] font-[650] tracking-[-0.01em] text-ink">{mode === "refresh" ? "Checking Gmail again" : "Getting your mail ready"}</h2>
        <p className="mt-1 text-xs leading-normal text-ink2">
          {mode === "refresh"
            ? "Tabellar is fetching what arrived since the last check and reading it."
            : "Tabellar fetches your recent mail once, then reads each email. With a model running on this Mac this can take a few minutes."}
        </p>
        <ol className="mt-3 border-t border-line-soft pt-2">
          {phases.map((label, i) => {
            const done = i < phaseIndex;
            const current = i === phaseIndex;
            return (
              <li key={label} className="grid grid-cols-[22px_minmax(0,1fr)] items-start py-[5px]" aria-current={current ? "step" : undefined}>
                {done ? <Glyph state="done" className="mt-px" /> : <span className="mt-px grid h-4 w-4 place-items-center">{current && <i className="h-[5px] w-[5px] rounded-full bg-ink2" />}</span>}
                <span className={done ? "text-ink2" : current ? "text-ink" : "text-ink3"}>
                  {label}
                  {current && <span className="skel mt-1.5 block h-[3px] w-24" />}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
