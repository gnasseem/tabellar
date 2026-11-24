// Settings, Appearance: theme, accent, density, text size and what the sidebar
// shows. Kept on the profile and applied at once (lib/appearance.ts).
import { ACCENTS, appearanceOf, type Appearance as Look, type Density, type TextSize, type ThemeChoice } from "@/lib/appearance";
import { NAV } from "../Sidebar";
import { Seg, Tick } from "../ui";
import { Group, Row, useProfile } from "./parts";

export default function Appearance() {
  const { profile, save } = useProfile();
  const look = appearanceOf(profile);
  const set = (patch: Partial<Look>) => save({ appearance: { ...look, ...patch } });
  return (
    <>
      <Group title="Window">
        <Row name="Theme">
          <Seg<ThemeChoice> value={profile.theme} onChange={(theme) => save({ theme })} options={[{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }, { id: "auto", label: "Auto" }]} />
        </Row>
        <Row name="Accent" text="What needs you, main buttons, replies going out">
          <div className="flex gap-1" role="radiogroup" aria-label="Accent">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={look.accent === a.id}
                aria-label={a.label}
                title={a.label}
                data-accent={a.id}
                onClick={() => set({ accent: a.id })}
                className={`grid h-7 w-7 place-items-center rounded-md transition-colors duration-150 ${look.accent === a.id ? "bg-sel" : "hover:bg-hover"}`}
              >
                <span className="h-3.5 w-3.5 rounded-full bg-wax" />
              </button>
            ))}
          </div>
        </Row>
        <Row name="Density">
          <Seg<Density> value={look.density} onChange={(density) => set({ density })} options={[{ id: "comfortable", label: "Comfortable" }, { id: "compact", label: "Compact" }]} />
        </Row>
        <Row name="Text size">
          <Seg<TextSize> value={look.text} onChange={(text) => set({ text })} options={[{ id: "small", label: "Small" }, { id: "default", label: "Default" }, { id: "large", label: "Large" }, { id: "larger", label: "Larger" }]} />
        </Row>
      </Group>

      <Group title="In the sidebar" note="A hidden page still opens with its key or from a link.">
        <div className="grid grid-cols-2 gap-x-6 py-1.5 sm:grid-cols-3">
          {NAV.flat()
            .filter((i) => i.id !== "inbox")
            .map((i) => {
              const on = !look.hidden.includes(i.id);
              const toggle = () => set({ hidden: on ? [...look.hidden, i.id] : look.hidden.filter((x) => x !== i.id) });
              return (
                <div key={i.id} className="flex h-row cursor-default items-center gap-2.5 text-ink" onClick={toggle}>
                  <Tick checked={on} onChange={toggle} label={i.label} />
                  {i.label}
                </div>
              );
            })}
        </div>
      </Group>
    </>
  );
}
