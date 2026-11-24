// Settings, Notifications, and Hours and calendar, whose working hours are
// also the notifications' quiet hours.
import { ChoiceRow, Group, Row, Switch, useProfile } from "./parts";

// Monday first, as the week is read; the stored numbers keep Sunday as 0.
const WEEK: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
type Hours = { start: string; end: string; days: number[] };

const hoursOf = (profile: { working_hours?: Record<string, unknown> | null }): Hours => ({ start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5], ...((profile.working_hours as Partial<Hours> | null) ?? {}) });

// "Mon to Fri, 09:00 to 17:00"; days that do not follow each other are listed.
function hoursLine(h: Hours): string {
  const on = WEEK.map(([n], i) => (h.days.includes(n) ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return "No working days";
  const run = on.length > 2 && on[on.length - 1] - on[0] === on.length - 1;
  const days = on.length === 7 ? "Every day" : run ? `${WEEK[on[0]][1]} to ${WEEK[on[on.length - 1]][1]}` : on.map((i) => WEEK[i][1]).join(", ");
  return `${days}, ${h.start} to ${h.end}`;
}

export function Notifications({ go }: { go: (section: string) => void }) {
  const { profile, save } = useProfile();
  const level = profile.notification_level ?? "needs";
  return (
    <>
      <Group title="Notify about">
        <div role="radiogroup" aria-label="Notify about" className="divide-y divide-line-soft">
          <ChoiceRow on={level === "needs"} onClick={() => save({ notification_level: "needs" })} name="Anything that needs you" text="A reply to send, something to do, approve or answer, and the people marked most important" />
          <ChoiceRow on={level === "vip"} onClick={() => save({ notification_level: "vip" })} name="Only the most important people" text="Those marked so in About you" />
          <ChoiceRow on={level === "none"} onClick={() => save({ notification_level: "none" })} name="Nothing" text="A reply Autopilot is about to send is still announced, so it can be cancelled" />
        </div>
      </Group>
      <Group title="When and what">
        <Row
          name="Quiet outside working hours"
          text={
            <>
              {hoursLine(hoursOf(profile))}{" "}
              <button className="link ml-1" onClick={() => go("hours")}>
                Change
              </button>
            </>
          }
        >
          <Switch label="Quiet outside working hours" on={!!profile.notification_quiet} onChange={(v) => save({ notification_quiet: v })} />
        </Row>
        <Row name="Show sender and summary" text="Off shows only that mail arrived">
          <Switch label="Show sender and summary" on={profile.notification_preview !== false} onChange={(v) => save({ notification_preview: v })} />
        </Row>
      </Group>
    </>
  );
}

export function HoursAndCalendar() {
  const { profile, save } = useProfile();
  const h = hoursOf(profile);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const set = (patch: Partial<Hours>) => save({ working_hours: { start: h.start, end: h.end, days: h.days, ...patch, timezone: zone } });
  return (
    <>
      <Group title="Working hours" note={zone}>
        <Row name="Work days">
          <div className="seg" role="group" aria-label="Work days">
            {WEEK.map(([n, label]) => (
              <button key={n} type="button" aria-pressed={h.days.includes(n)} onClick={() => set({ days: h.days.includes(n) ? h.days.filter((d) => d !== n) : [...h.days, n] })}>
                {label}
              </button>
            ))}
          </div>
        </Row>
        <Row name="Day starts">
          <input type="time" className="input w-[120px]" value={h.start} onChange={(e) => e.target.value && set({ start: e.target.value })} aria-label="Day starts" />
        </Row>
        <Row name="Day ends" text={h.end <= h.start ? <span className="text-warn">The day ends before it starts</span> : undefined}>
          <input type="time" className="input w-[120px]" value={h.end} onChange={(e) => e.target.value && set({ end: e.target.value })} aria-label="Day ends" />
        </Row>
      </Group>
      <Group title="Calendar">
        <Row name="Send invitations to attendees" text="The calendar emails the people invited">
          <Switch label="Send invitations to attendees" on={profile.calendar_send_invites !== false} onChange={(v) => save({ calendar_send_invites: v })} />
        </Row>
      </Group>
    </>
  );
}
