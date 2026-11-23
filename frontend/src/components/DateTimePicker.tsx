// A field that opens a small calendar popover: pick a day, then the time in
// quarter hours. The value is local "YYYY-MM-DDTHH:MM".
import { useState, useEffect, useRef } from "react";
import Icon from "@/components/Icon";

interface Props {
  value: string; // "YYYY-MM-DDTHH:MM" or ""
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  showWarning?: boolean;
}

function pad(n: number) { return String(n).padStart(2, "0"); }

function toDatetimeLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseValue(v: string) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
}

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function DateTimePicker({ value, onChange, placeholder = "Select date and time", className = "", showWarning = false }: Props) {
  const [open, setOpen] = useState(false);
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const today = new Date();

  const parsed = parseValue(value);

  const [viewYear, setViewYear] = useState(() => parsed?.year ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(() => parsed?.month ?? today.getMonth());
  const [selDay, setSelDay] = useState<{ year: number; month: number; day: number } | null>(
    parsed ? { year: parsed.year, month: parsed.month, day: parsed.day } : null
  );

  function toAmPm(h: number) {
    return {
      h12: h === 0 ? 12 : h > 12 ? h - 12 : h,
      ap: (h >= 12 ? "PM" : "AM") as "AM" | "PM",
    };
  }

  const initH = parsed ? toAmPm(parsed.hour) : { h12: 9, ap: "AM" as const };
  const [hour12, setHour12] = useState(initH.h12);
  const [minute, setMinute] = useState(parsed ? Math.round((parsed.minute) / 15) * 15 % 60 : 0);
  const [ampm, setAmpm] = useState<"AM" | "PM">(initH.ap);

  useEffect(() => {
    const p = parseValue(value);
    if (p) {
      setViewYear(p.year); setViewMonth(p.month);
      setSelDay({ year: p.year, month: p.month, day: p.day });
      const { h12, ap } = toAmPm(p.hour);
      setHour12(h12); setMinute(Math.round(p.minute / 15) * 15 % 60); setAmpm(ap);
    } else { setSelDay(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        dropRef.current && !dropRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", esc);
    };
  }, []);

  function emit(day: typeof selDay, h12: number, m: number, ap: "AM" | "PM") {
    if (!day) return;
    let h24 = h12;
    if (ap === "AM" && h12 === 12) h24 = 0;
    if (ap === "PM" && h12 !== 12) h24 = h12 + 12;
    onChange(toDatetimeLocal(new Date(day.year, day.month, day.day, h24, m)));
  }

  function openPicker() {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const popH = 280;
      const top = spaceBelow >= popH ? rect.bottom + 6 : rect.top - popH - 6;
      const width = Math.min(Math.max(rect.width, 248), 280);
      setDropStyle({ position: "fixed", top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width });
    }
    setOpen(o => !o);
  }

  function selectDay(year: number, month: number, day: number) {
    const nd = { year, month, day };
    setSelDay(nd);
    emit(nd, hour12, minute, ampm);
  }

  function stepHour(dir: 1 | -1) {
    const nh = hour12 + dir;
    const next = nh < 1 ? 12 : nh > 12 ? 1 : nh;
    setHour12(next); emit(selDay, next, minute, ampm);
  }
  function stepMinute(dir: 1 | -1) {
    const nm = (minute + dir * 15 + 60) % 60;
    setMinute(nm); emit(selDay, hour12, nm, ampm);
  }
  function toggleAmPm() {
    const next: "AM" | "PM" = ampm === "AM" ? "PM" : "AM";
    setAmpm(next); emit(selDay, hour12, minute, next);
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }

  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();
  const cells: { year: number; month: number; day: number; cur: boolean }[] = [];
  for (let i = firstDow - 1; i >= 0; i--) {
    const mo = viewMonth === 0 ? 11 : viewMonth - 1;
    const yr = viewMonth === 0 ? viewYear - 1 : viewYear;
    cells.push({ year: yr, month: mo, day: daysInPrev - i, cur: false });
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ year: viewYear, month: viewMonth, day: d, cur: true });
  while (cells.length < 35) {
    const mo = viewMonth === 11 ? 0 : viewMonth + 1;
    const yr = viewMonth === 11 ? viewYear + 1 : viewYear;
    cells.push({ year: yr, month: mo, day: cells.length - firstDow - daysInMonth + 1, cur: false });
  }

  const label = parsed
    ? new Date(value).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

  const step = "grid h-5 w-5 place-items-center rounded text-ink3 transition-colors duration-150 hover:bg-sel hover:text-ink";

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={openPicker}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex h-7 w-full items-center gap-2 rounded-[7px] bg-field px-2.5 text-[13px] ${showWarning ? "ring-1 ring-warn-line" : ""} ${className}`}
      >
        <Icon name="calendar_month" size={15} className="text-ink3" />
        <span className={`flex-1 truncate text-left ${label ? "text-ink" : "text-ink3"}`}>{label || placeholder}</span>
        <Icon name={open ? "expand_less" : "expand_more"} size={13} className="text-ink3" />
      </button>

      {open && (
        <div ref={dropRef} style={{ ...dropStyle, zIndex: 9999 }} className="pop p-3" role="dialog" aria-label="Pick date and time">
          {/* Month */}
          <div className="mb-2 flex items-center justify-between">
            <button type="button" onClick={prevMonth} className="iconbtn h-6 w-6" aria-label="Previous month">
              <Icon name="chevron_left" size={15} />
            </button>
            <span className="font-semibold text-ink">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            <button type="button" onClick={nextMonth} className="iconbtn h-6 w-6" aria-label="Next month">
              <Icon name="chevron_right" size={15} />
            </button>
          </div>

          {/* Days: the chosen one is filled, today is ringed. */}
          <div className="mb-0.5 grid grid-cols-7">
            {DAY_LABELS.map((d) => (
              <div key={d} className="py-0.5 text-center text-[11px] text-ink3">
                {d}
              </div>
            ))}
          </div>
          <div className="mb-3 grid grid-cols-7 gap-0.5">
            {cells.map((cell, i) => {
              const isSel = selDay && cell.year === selDay.year && cell.month === selDay.month && cell.day === selDay.day;
              const isToday = cell.cur && cell.year === today.getFullYear() && cell.month === today.getMonth() && cell.day === today.getDate();
              return (
                <button
                  key={i}
                  type="button"
                  aria-pressed={!!isSel}
                  aria-current={isToday ? "date" : undefined}
                  onClick={() => selectDay(cell.year, cell.month, cell.day)}
                  className={`h-7 w-full rounded-md text-xs transition-colors duration-150 ${
                    isSel ? "bg-ink font-medium text-canvas" : `${isToday ? "font-medium text-ink ring-1 ring-inset ring-ink3" : cell.cur ? "text-ink" : "text-ink4"} hover:bg-sel`
                  }`}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          {/* Time, in steps of a quarter of an hour */}
          <div className="flex items-center gap-1 border-t border-line-soft pt-2.5">
            <span className="label mr-auto">Time</span>
            <button type="button" onClick={() => stepHour(-1)} className={step} aria-label="Earlier hour">
              <Icon name="chevron_left" size={13} />
            </button>
            <span className="w-6 text-center font-semibold text-ink">{pad(hour12)}</span>
            <button type="button" onClick={() => stepHour(1)} className={step} aria-label="Later hour">
              <Icon name="chevron_right" size={13} />
            </button>
            <span className="text-ink3">:</span>
            <button type="button" onClick={() => stepMinute(-1)} className={step} aria-label="Earlier minute">
              <Icon name="chevron_left" size={13} />
            </button>
            <span className="w-6 text-center font-semibold text-ink">{pad(minute)}</span>
            <button type="button" onClick={() => stepMinute(1)} className={step} aria-label="Later minute">
              <Icon name="chevron_right" size={13} />
            </button>
            <button type="button" onClick={toggleAmPm} className="btn btn-sm ml-1.5 w-10 justify-center px-0" aria-label={`${ampm}, switch to ${ampm === "AM" ? "PM" : "AM"}`}>
              {ampm}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
