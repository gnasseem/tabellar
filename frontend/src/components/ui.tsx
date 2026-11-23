// The parts every view is built from. Styling lives in the components layer
// of index.css (.bar, .seg, .row, .btn, ...); these wrap the ones that carry
// behaviour.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Icon from "./Icon";
import { useApp } from "./AppShell";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

// The state of a piece of mail, drawn as the seal: filled when it needs the
// user, a ring while a reply is on its way out, a check once handled, a
// triangle when held back.
export type MailState = "need" | "going" | "done" | "held" | "failed" | "filed" | "info";

export function Glyph({ state, className = "" }: { state: MailState; className?: string }) {
  const c = `h-4 w-4 flex-none ${className}`;
  if (state === "need") return <svg className={c} viewBox="0 0 16 16" aria-label="Needs you"><circle cx="8" cy="8" r="4" fill="var(--wax)" /></svg>;
  if (state === "going") return <svg className={c} viewBox="0 0 16 16" aria-label="Going out"><circle cx="8" cy="8" r="3.4" fill="none" stroke="var(--wax)" strokeWidth="1.5" /></svg>;
  if (state === "done") return <svg className={c} viewBox="0 0 16 16" aria-label="Handled"><path d="M4.4 8.3l2.4 2.4 4.800-5.200" fill="none" stroke="var(--ink3)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (state === "held" || state === "failed")
    return <svg className={c} viewBox="0 0 16 16" aria-label={state === "held" ? "Held" : "Failed"}><path d="M8 4.200 12 11.400H4z" fill="none" stroke={state === "held" ? "var(--warn)" : "var(--danger)"} strokeWidth="1.4" strokeLinejoin="round" /></svg>;
  if (state === "info")
    return <svg className={c} viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="4.600" fill="none" stroke="var(--ink3)" strokeWidth="1.3" /><path d="M8 7.400v3M8 5.400h.01" stroke="var(--ink3)" strokeWidth="1.4" strokeLinecap="round" /></svg>;
  return <span className={c} />;
}

// Search field bound to the window's one search string. "/" focuses it.
export function SearchBox({ placeholder = "Search" }: { placeholder?: string }) {
  const { search, setSearch } = useApp();
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  const shut = !open && !search;
  return (
    <>
      {shut && (
        <button className="iconbtn md:hidden" aria-label={placeholder} onClick={() => setOpen(true)}>
          <Icon name="search" size={16} />
        </button>
      )}
      <label className={`searchbox ${shut ? "!hidden md:!flex" : "max-md:flex-1"}`}>
      <Icon name="search" size={15} />
      <input
        ref={field}
        data-search-input
        value={search}
        onBlur={() => setOpen(false)}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setSearch("");
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
      />
      {search ? (
        <button type="button" className="text-ink3 hover:text-ink" onClick={() => setSearch("")} aria-label="Clear search">
          <Icon name="close" size={13} />
        </button>
      ) : (
        <kbd className="kbd hidden !bg-transparent md:inline-block">/</kbd>
      )}
      </label>
    </>
  );
}

// The bar at the top of a view. Children sit after the title (filters), `right`
// after the search field.
export function ViewBar({ title, children, right, search }: { title: ReactNode; children?: ReactNode; right?: ReactNode; search?: string | false }) {
  const { setSidebarOpen } = useApp();
  return (
    <header className="bar">
      <button className="iconbtn -ml-2 lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Show sidebar">
        <Icon name="menu" size={16} />
      </button>
      {typeof title === "string" ? <h1 className="bar-title flex-none">{title}</h1> : title}
      {children}
      <span className="flex-1" />
      {search !== false && <SearchBox placeholder={search || "Search"} />}
      {right}
    </header>
  );
}

export type SegOption<T extends string> = { id: T; label: string; count?: number; need?: boolean };

export function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: SegOption<T>[] }) {
  const current = options.find((o) => o.id === value);
  return (
    <>
      <div className="md:hidden">
        <Menu label="" align="left" value={value} onChange={onChange} options={options.map((o) => ({ id: o.id, label: o.count ? `${o.label} ${o.count.toLocaleString()}` : o.label }))} />
        <span className="sr-only">{current?.label}</span>
      </div>
      <SegButtons value={value} onChange={onChange} options={options} />
    </>
  );
}

function SegButtons<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: SegOption<T>[] }) {
  return (
    <div className="seg !hidden md:!flex" role="group">
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
          {o.count ? <em className={o.need ? "need" : ""}>{o.count.toLocaleString()}</em> : null}
        </button>
      ))}
    </div>
  );
}

export function Tick({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean, e: React.MouseEvent) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className="tick"
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked, e);
      }}
    >
      <Icon name="check" size={11} />
    </button>
  );
}

// A labelled choice in the bar: "Group Day". Opens a small menu.
export function Menu<T extends string>({ label, value, onChange, options, align = "right" }: { label: string; value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className="btn btn-plain gap-1 pr-1.5" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="hidden md:inline">{label}</span> <b className="font-medium text-ink">{options.find((o) => o.id === value)?.label}</b>
        <Icon name="expand_more" size={13} className="text-ink3" />
      </button>
      {open && (
        <div className={`pop absolute top-8 min-w-[140px] ${align === "left" ? "left-0" : "right-0"}`} role="menu">
          {options.map((o) => (
            <button
              key={o.id}
              role="menuitemradio"
              aria-checked={o.id === value}
              className="pop-item"
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              <Icon name="check" size={13} className={o.id === value ? "text-ink" : "invisible"} />
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={22} className="text-ink3" />}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

// Loading placeholder for a list: rows of the right height, no spinner.
export function SkeletonRows({ count = 12, tall = false }: { count?: number; tall?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`mx-2 flex items-center gap-3 px-3 ${tall ? "h-[58px]" : "h-8"}`}>
          <span className="skel h-2.5 w-28" />
          <span className="skel h-2.5 flex-1" style={{ maxWidth: `${38 + ((i * 37) % 45)}%` }} />
        </div>
      ))}
    </div>
  );
}

// The footer line: a count on the left, the keys that work here on the right.
export function KeyHints({ left, keys }: { left?: ReactNode; keys: [string, string][] }) {
  return (
    <footer className="foot">
      <span className="truncate">{left}</span>
      <span className="flex-1" />
      {keys.map(([k, label]) => (
        <span key={label} className="k">
          {k.split(" ").map((x) => (
            <kbd key={x} className="kbd">{x}</kbd>
          ))}
          {label}
        </span>
      ))}
    </footer>
  );
}

// A windowed list: only the rows on screen are in the page, so ten thousand
// rows scroll like fifty. Row heights are known up front (rows and group
// headers), so positions are exact and nothing is measured.
export function VirtualList<T>({
  items,
  heightOf,
  render,
  cursor,
  onEnd,
  sticky,
  className = "",
}: {
  items: T[];
  heightOf: (item: T) => number;
  render: (item: T, index: number) => ReactNode;
  cursor?: number; // index kept in view (keyboard position)
  onEnd?: () => void; // called when the last rows come into view
  sticky?: (firstVisible: number) => ReactNode; // header pinned above the rows
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(800);
  const offsets = useMemo(() => {
    const o = new Array<number>(items.length + 1);
    o[0] = 0;
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + heightOf(items[i]);
    return o;
  }, [items, heightOf]);
  const total = offsets[items.length];

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // first item whose bottom edge is below the top of the viewport
  const first = useMemo(() => {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= scroll) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }, [offsets, scroll, items.length]);
  let last = first;
  while (last < items.length && offsets[last] < scroll + height) last++;
  const from = Math.max(0, first - 8);
  const to = Math.min(items.length, last + 8);

  useEffect(() => {
    if (onEnd && items.length && last >= items.length - 4) onEnd();
  }, [last, items.length, onEnd]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !el.clientHeight || cursor === undefined || cursor < 0 || cursor >= items.length) return;
    const top = offsets[cursor];
    const bottom = offsets[cursor + 1];
    const pinned = sticky ? 34 : 0;
    if (top < el.scrollTop + pinned) el.scrollTop = Math.max(0, top - pinned);
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [cursor]);

  const slice: ReactNode[] = [];
  for (let i = from; i < to; i++) slice.push(render(items[i], i));

  return (
    <div className={`relative min-h-0 flex-1 ${className}`}>
      {sticky && <div className="pointer-events-none absolute inset-x-0 top-0 z-[3] [&>*]:pointer-events-auto">{sticky(first)}</div>}
      <div ref={ref} className="h-full overflow-y-auto" onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
        <div style={{ height: total, paddingTop: offsets[from] }}>{slice}</div>
      </div>
    </div>
  );
}

// Minutes and seconds until a time, ticking once a second while mounted.
export function Countdown({ until, className = "" }: { until: string; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000));
  return <time className={className}>{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</time>;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: false });
}

// Time for a list row: the clock today, the weekday this week, else the date.
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (days <= 0) return clock(iso);
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function dayLabel(iso: string): { name: string; date: string; key: string } {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  const date = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (days <= 0) return { name: "Today", date, key };
  if (days === 1) return { name: "Yesterday", date, key };
  return { name: d.toLocaleDateString([], { weekday: "long" }), date: d.toLocaleDateString([], { day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }), key };
}
