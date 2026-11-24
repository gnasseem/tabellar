// Settings, Brief: when a new one starts, how long it is, what is in it and
// whether a paragraph opens it. profiles.brief, read by server/brief.ts.
import { useApp } from "../AppShell";
import { Seg, Tick } from "../ui";
import { Group, Row, Switch, useProfile } from "./parts";

type Length = "short" | "standard" | "long";
type Tone = "plain" | "warm" | "blunt";
type Settings = { time: string; length: Length; sections: string[]; summary: boolean; tone: Tone };
const SECTIONS = [
  { id: "needs", label: "Needs you today" },
  { id: "waiting", label: "Waiting on others" },
  { id: "calendar", label: "Today's calendar" },
  { id: "handled", label: "Handled for you" },
];

export default function Brief() {
  const { setView } = useApp();
  const { profile, save } = useProfile();
  const b: Settings = { time: "08:00", length: "standard", sections: SECTIONS.map((s) => s.id), summary: false, tone: "plain", ...((profile.brief as Partial<Settings> | null) ?? {}) };
  const set = (patch: Partial<Settings>) => save({ brief: { ...b, ...patch } });
  return (
    <>
      <Group
        title="Time and length"
        right={
          <button className="btn btn-plain btn-sm -mr-2" onClick={() => setView("briefing")}>
            Open the Brief
          </button>
        }
      >
        <Row name="Time" text="A new Brief starts; what was handled counts from this time the day before">
          <input type="time" className="input w-[120px]" value={b.time} onChange={(e) => e.target.value && set({ time: e.target.value })} aria-label="Time" />
        </Row>
        <Row name="Length" text={{ short: "3 lines in each section", standard: "5 lines in each section", long: "10 lines in each section" }[b.length]}>
          <Seg<Length> value={b.length} onChange={(length) => set({ length })} options={[{ id: "short", label: "Short" }, { id: "standard", label: "Standard" }, { id: "long", label: "Long" }]} />
        </Row>
      </Group>

      <Group title="Sections">
        <div className="grid grid-cols-1 gap-x-6 py-1.5 sm:grid-cols-2">
          {SECTIONS.map((s) => {
            const on = b.sections.includes(s.id);
            // The last one stays: an empty Brief is not a Brief.
            const toggle = () => (!on || b.sections.length > 1) && set({ sections: on ? b.sections.filter((x) => x !== s.id) : SECTIONS.map((x) => x.id).filter((x) => x === s.id || b.sections.includes(x)) });
            return (
              <div key={s.id} className="flex h-row cursor-default items-center gap-2.5 text-ink" onClick={toggle}>
                <Tick checked={on} onChange={toggle} label={s.label} />
                {s.label}
              </div>
            );
          })}
        </div>
      </Group>

      <Group title="Summary">
        <Row name="A paragraph at the top" text="Written by the careful model from the lines of the Brief, at its time">
          <Switch label="A paragraph at the top" on={b.summary} onChange={(summary) => set({ summary })} />
        </Row>
        {b.summary && (
          <Row name="Tone">
            <Seg<Tone> value={b.tone} onChange={(tone) => set({ tone })} options={[{ id: "plain", label: "Plain" }, { id: "warm", label: "Warm" }, { id: "blunt", label: "Blunt" }]} />
          </Row>
        )}
      </Group>
    </>
  );
}
