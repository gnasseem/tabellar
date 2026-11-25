// Settings, General: the level and pause, Autopilot's limits while it is on,
// starting at login, staying awake, and the first-run steps.
import { useEffect, useState } from "react";
import { api } from "@/lib/outcomes";
import { host } from "@/lib/host";
import { useApp } from "../AppShell";
import { LevelControl } from "../Sidebar";
import { Group, Row, Switch, useProfile } from "./parts";

async function signOut(all: boolean) {
  await fetch("/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${window.__TABELLAR_TOKEN__ ?? ""}` }, body: JSON.stringify({ all }) });
  window.location.replace("/");
}

export default function General() {
  const { addToast, mail } = useApp();
  const { profile, save: keep } = useProfile();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const level = profile.autonomy_level ?? "suggest";

  useEffect(() => {
    api("/engine/status")
      .then((s) => setAutostart(!!s.autostart))
      .catch(() => setAutostart(false));
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    await keep(patch);
    mail.refreshEngine();
  };
  const toggleAutostart = async (on: boolean) => {
    try {
      const r = await api("/engine/autostart", { on });
      setAutostart(!!r.autostart);
    } catch (e) {
      addToast("error", (e as Error).message);
    }
  };
  const pick = (name: string, text: string, key: string, value: number, options: [number, string][]) => (
    <Row name={name} text={text}>
      <select className="input w-auto" aria-label={name} value={value} onChange={(e) => save({ [key]: Number(e.target.value) })}>
        {options.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </Row>
  );

  return (
    <>
      <Group title="Level">
        <div className="-mx-2 py-1">
          <LevelControl value={level} onChange={(l) => save({ autonomy_level: l })} />
        </div>
        <Row name="Pause" text="Mail still syncs">
          <Switch label="Pause" on={!!profile.engine_paused} onChange={(v) => save({ engine_paused: v })} />
        </Row>
      </Group>

      {level === "autopilot" && (
        <Group title="Autopilot limits" note="Only to the person who wrote, in the same thread, with no cc and no attachments.">
          {pick("Wait before sending", "Time to cancel each reply", "autopilot_delay_min", profile.autopilot_delay_min ?? 5, [2, 5, 10, 30, 60].map((m) => [m, `${m} minutes`]))}
          {pick("Replies per day", "Then drafts until tomorrow", "autopilot_daily_cap", profile.autopilot_daily_cap ?? 5, [1, 3, 5, 10, 20].map((n) => [n, String(n)]))}
          <Row name="Only people you have written to" text="Anyone else gets a draft">
            <Switch label="Only people you have written to" on={profile.autopilot_known_only !== false} onChange={(v) => save({ autopilot_known_only: v })} />
          </Row>
        </Group>
      )}

      <Group title={host.headless ? "Setup" : "This Mac"}>
        {!host.headless && (
          <>
            <Row name="Start at login" text="Keeps running with the window closed">
              {autostart === null ? <span className="skel block h-[18px] w-8" aria-label="Loading" /> : <Switch label="Start at login" on={autostart} onChange={toggleAutostart} />}
            </Row>
            <Row name="Stay awake on power" text="While plugged in, with the lid open">
              <Switch label="Stay awake on power" on={!!profile.keep_awake} onChange={(v) => save({ keep_awake: v })} />
            </Row>
            <Row name="Menu bar" text="What needs you, and Pause">
              <Switch label="Menu bar" on={profile.menu_bar !== false} onChange={(v) => save({ menu_bar: v })} />
            </Row>
          </>
        )}
        {host.hosted && (
          <Row name="Sign out" text="Here, or in every browser">
            <span className="flex gap-2">
              <button className="btn" onClick={() => signOut(false)}>
                Here
              </button>
              <button className="btn" onClick={() => signOut(true)}>
                Everywhere
              </button>
            </span>
          </Row>
        )}
        <Row name="First-run steps" text="Mail, model, About you, examples from your mail, people and labels, level">
          <button
            className="btn"
            onClick={() => {
              window.location.hash = "setup";
              window.location.reload();
            }}
          >
            Go through them again
          </button>
        </Row>
      </Group>
    </>
  );
}
