// When a snoozed email comes back: a small menu under the button (or, for the
// S key, under the selected row). Any of them also ends when someone writes
// in the thread.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "./AppShell";
import DateTimePicker from "./DateTimePicker";
import { api } from "@/lib/outcomes";

type Hours = { start?: string; days?: number[] } | null | undefined;

const pad = (n: number) => String(n).padStart(2, "0");
const toLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// "Today 18:00", "Tue 09:00", "8 Dec 09:00"
export function backAt(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  const day = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days < 7 ? d.toLocaleDateString([], { weekday: "short" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
  return `${day} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

// The times on offer, from the user's working hours.
export function snoozeTimes(hours: Hours, now = new Date()): { label: string; at: Date }[] {
  const [h, m] = (hours?.start || "09:00").split(":").map(Number);
  const days = hours?.days?.length ? hours.days : [1, 2, 3, 4, 5];
  const morning = (ahead: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, h, m);
  const out: { label: string; at: Date }[] = [];
  const evening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18);
  const later = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 3);
  if (now < new Date(evening.getTime() - 3_600_000)) out.push({ label: "Later today", at: later < evening ? later : evening });
  // Awake after midnight, "tomorrow" is this morning.
  out.push({ label: "Tomorrow", at: now.getHours() < 5 ? morning(0) : morning(1) });
  const monday = 7 - ((now.getDay() + 6) % 7);
  const first = [0, 1, 2, 3, 4, 5, 6].map((i) => morning(monday + i)).find((d) => days.includes(d.getDay())) ?? morning(monday);
  if (first.toDateString() !== out[out.length - 1].at.toDateString()) out.push({ label: "Next week", at: first });
  return out;
}

// Snooze these emails, and say so with Undo.
export function useSnooze() {
  const { addToast, mail, invalidateViewCache } = useApp();
  return async (ids: string[], until: string | null): Promise<boolean> => {
    try {
      const r = (await api("/snooze", { ids, until })) as { ids: string[] };
      invalidateViewCache("inbox");
      mail.reload();
      addToast("success", until ? `Back ${backAt(until).replace(/^T/, "t")}` : "Back when someone answers", {
        action: {
          label: "Undo",
          onClick: async () => {
            await api("/snooze/back", { ids: r.ids }).catch(() => addToast("error", "Could not bring it back."));
            invalidateViewCache("inbox");
            mail.reload();
          },
        },
      });
      return true;
    } catch (e) {
      addToast("error", `Not snoozed: ${(e as Error).message}`);
      return false;
    }
  };
}

const WIDTH = 248;

export function SnoozeMenu({ anchor, onPick, onClose }: { anchor: DOMRect; onPick: (until: string | null) => void; onClose: () => void }) {
  const { profile } = useApp();
  const times = snoozeTimes(profile.working_hours as Hours);
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [picking, setPicking] = useState(false);
  const [custom, setCustom] = useState(() => toLocal(times[times.length - 1].at));
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: 0 });

  const items: { label: string; right?: string; run: () => void }[] = [
    ...times.map((t) => ({ label: t.label, right: backAt(t.at.toISOString()).replace(/^(Today|Tomorrow) /, ""), run: () => onPick(t.at.toISOString()) })),
    { label: "Until someone answers", run: () => onPick(null) },
    { label: "Pick a time", run: () => setPicking(true) },
  ];

  // Under the anchor, its right edges lined up; above it near the bottom.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    const height = box?.height ?? 0;
    const width = box?.width ?? WIDTH;
    const below = anchor.bottom + 4;
    setPos({ left: Math.max(8, Math.min(anchor.right, window.innerWidth - 8) - width), top: below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : below });
  }, [anchor, picking]);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (picking || e.metaKey || e.ctrlKey || e.altKey) return;
      else if (e.key === "ArrowDown" || e.key === "j") setActive((i) => Math.min(items.length - 1, i + 1));
      else if (e.key === "ArrowUp" || e.key === "k") setActive((i) => Math.max(0, i - 1));
      else if (e.key === "Enter" || e.key === " ") items[active].run();
      else if (e.key === "Tab") onClose();
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", key, true);
    };
  });

  return createPortal(
    <div ref={ref} data-key-menu className="pop fixed" style={{ left: pos.left, top: pos.top, width: picking ? "18rem" : "15.5rem", zIndex: 60 }} role={picking ? "dialog" : "menu"} aria-label="Snooze">
      {picking ? (
        <div className="p-2">
          <DateTimePicker value={custom} onChange={setCustom} placeholder="Pick a day and time" />
          <div className="mt-2.5 flex gap-1.5">
            <button className="btn btn-sm btn-pri" disabled={!(new Date(custom).getTime() > Date.now())} onClick={() => onPick(new Date(custom).toISOString())}>
              Snooze
            </button>
            <button className="btn btn-sm btn-plain" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        items.map((i, n) => (
          <button key={i.label} role="menuitem" className="pop-item" data-active={n === active} onMouseEnter={() => setActive(n)} onClick={i.run}>
            <span className="flex-1">{i.label}</span>
            {i.right && <span className="text-xs text-ink3">{i.right}</span>}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}

// What a snoozed row says: when it is back.
export const snoozedText = (until: string | null | undefined) => (until ? `Back ${backAt(until).replace(/^T/, "t")}` : "Until an answer");
