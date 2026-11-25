import { useCallback, useRef, useState } from "react";
import { useApp } from "../AppShell";
import { ModelSettings } from "../ModelSetup";
import { ViewBar } from "../ui";
import AboutYou from "../settings/AboutYou";
import Accounts, { RETURN_TAB } from "../settings/Accounts";
import Appearance from "../settings/Appearance";
import Brief from "../settings/Brief";
import General from "../settings/General";
import { HoursAndCalendar, Notifications } from "../settings/Notifications";
import { Saved } from "../settings/parts";
import SignaturesAndTemplates from "../settings/Signatures";
import Writing from "../settings/Writing";

// Settings, laid out like the Mac's own: the sections on the left, the chosen
// one on the right as groups of rows, each row a setting with its control.
// Every control keeps what it shows at once.

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Accounts" },
  { id: "about", label: "About you" },
  { id: "writing", label: "Writing" },
  { id: "signatures", label: "Signatures and templates" },
  { id: "appearance", label: "Appearance" },
  { id: "brief", label: "Brief" },
  { id: "notifications", label: "Notifications" },
  { id: "hours", label: "Hours and calendar" },
  { id: "models", label: "Models" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

// Back from adding an account the window opens on Accounts; a link elsewhere
// can name the section, and leaving for History or Knowledge keeps it.
function firstSection(asked: string | null): Section {
  let id = asked;
  try {
    id = sessionStorage.getItem(RETURN_TAB) ?? asked;
    sessionStorage.removeItem(RETURN_TAB);
  } catch {
    // the window then opens on General
  }
  return SECTIONS.some((s) => s.id === id) ? (id as Section) : "general";
}

export default function SettingsView() {
  const { setView, getViewCache, setViewCache } = useApp();
  const [section, setSection] = useState<Section>(() => firstSection(getViewCache("settings:tab")));
  // Below md the section list and the chosen section show one at a time.
  const [listOpen, setListOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback(() => {
    setSaved(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 1500);
  }, []);

  const go = (id: string) => {
    setSection(id as Section);
    setViewCache("settings:tab", id);
    setListOpen(false);
  };
  const item = (on: boolean) => `flex h-item w-full items-center rounded-md px-2 text-left transition-colors duration-150 ${on ? "bg-sel font-medium text-ink" : "text-ink2 hover:bg-hover"}`;

  return (
    <Saved.Provider value={flash}>
      <ViewBar title="Settings" search={false} right={<span className="text-xs text-ink3" aria-live="polite">{saved ? "Saved" : ""}</span>} />
      <div className="flex min-h-0 flex-1">
        <nav className={`flex-none overflow-y-auto px-3 py-4 md:block md:w-[208px] ${listOpen ? "block w-full" : "hidden"}`} aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} aria-current={section === s.id ? "page" : undefined} onClick={() => go(s.id)} className={item(section === s.id)}>
              {s.label}
            </button>
          ))}
          <button onClick={() => setView("history")} className={item(false)}>
            History
          </button>
        </nav>

        <div key={section} className={`min-h-0 min-w-0 flex-1 overflow-y-auto md:block ${listOpen ? "hidden" : "block"}`}>
          <div className="mx-auto max-w-[720px] px-6 pb-16 pt-8 md:px-10">
            <button className="link mb-3 md:hidden" onClick={() => setListOpen(true)}>
              All settings
            </button>
            <h2 className="mb-6 font-brand text-[28px] font-[620] leading-none text-ink">{SECTIONS.find((s) => s.id === section)!.label}</h2>
            {section === "general" && <General />}
            {section === "accounts" && <Accounts />}
            {section === "about" && <AboutYou />}
            {section === "writing" && <Writing />}
            {section === "signatures" && <SignaturesAndTemplates />}
            {section === "appearance" && <Appearance />}
            {section === "brief" && <Brief />}
            {section === "notifications" && <Notifications go={go} />}
            {section === "hours" && <HoursAndCalendar />}
            {section === "models" && <ModelSettings />}
          </div>
        </div>
      </div>
    </Saved.Provider>
  );
}
