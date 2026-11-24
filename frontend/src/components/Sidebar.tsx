import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import Logo from "@/components/Logo";
import { Countdown } from "@/components/ui";
import { createClient } from "@/lib/db";
import { appearanceOf } from "@/lib/appearance";
import { useApp } from "./AppShell";

// Levels, in the order of how much Tabellar does on its own.
export type Level = "observe" | "suggest" | "assist" | "autopilot";
export const LEVELS: { id: Level; label: string; text: string }[] = [
  { id: "observe", label: "Observe", text: "Sorts only" },
  { id: "suggest", label: "Suggest", text: "Asks first" },
  { id: "assist", label: "Assist", text: "Drafts, todos, meetings on its own" },
  { id: "autopilot", label: "Autopilot", text: "Also sends replies" },
];

// Turning Autopilot on is the one change that lets Tabellar send mail, so it
// is confirmed first.
export function confirmLevel(level: string): boolean {
  if (level !== "autopilot") return true;
  return window.confirm(
    "Turn on Autopilot?\n\nReplies go only to the person who wrote, inside the thread. " +
      "Each one waits first so you can cancel it, and there is a daily limit. Pause stops everything.",
  );
}

// The four levels as one compact control: a line each, the current one ticked.
// Used in the sidebar's menu and in Settings.
export function LevelControl({ value, onChange }: { value: string; onChange: (level: Level) => void }) {
  return (
    <div role="radiogroup" aria-label="Level">
      {LEVELS.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={l.id === value}
          className="grid h-item w-full grid-cols-[13px_68px_minmax(0,1fr)] items-center gap-x-2 rounded-md px-2 text-left hover:bg-sel"
          onClick={() => l.id !== value && confirmLevel(l.id) && onChange(l.id)}
        >
          <Icon name="check" size={13} className={l.id === value ? "text-ink" : "invisible"} />
          <b className={l.id === value ? "font-medium text-ink" : "font-normal text-ink"}>{l.label}</b>
          <span className="truncate text-ink3">{l.text}</span>
        </button>
      ))}
    </div>
  );
}

function NavItem({ id, icon, label, count, need, on: forced }: { id: string; icon: string; label: string; count?: number; need?: boolean; on?: boolean }) {
  const { view, setView, setSidebarOpen } = useApp();
  const on = forced ?? view === id;
  return (
    <button
      aria-current={on ? "page" : undefined}
      onClick={() => {
        setView(id);
        setSidebarOpen(false);
      }}
      className={`flex h-item w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 ${on ? "bg-sel font-medium text-ink" : "text-ink2 hover:bg-sel/55"}`}
    >
      <Icon name={icon} size={16} className={on ? "text-ink" : "text-ink3"} />
      <span className="flex-1 truncate">{label}</span>
      {count ? <span className={`text-xs ${need ? "count-need" : "text-ink3"}`}>{count.toLocaleString()}</span> : null}
    </button>
  );
}

// The level, with pause beside it. A line under it only when Gmail cannot be
// reached or the last check failed.
function Engine() {
  const { user, profile, updateProfile, mail, addToast } = useApp();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const level = mail.engine?.level ?? (profile.autonomy_level as string) ?? "observe";
  const paused = mail.engine?.paused ?? !!profile.engine_paused;
  const failing = !!(mail.engine?.mailError || mail.engine?.lastError);
  const note = paused ? "" : mail.engine?.mailError ? "Can't reach your mail" : mail.engine?.lastError ? "Last check failed" : "";

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

  const save = async (patch: { autonomy_level?: string; engine_paused?: boolean }) => {
    const { error } = await supabase.from("profiles").update(patch).eq("id", user.id);
    if (error) return addToast("error", "Could not save that. Try again.");
    updateProfile(patch);
    mail.refreshEngine();
  };

  return (
    <div ref={ref} className="relative grid grid-cols-[1fr_auto] items-center pl-2 pr-1">
      <button className="flex h-item items-center gap-2 justify-self-start rounded-md pr-1 font-medium" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="grid w-4 place-items-center">
          <i className="h-[7px] w-[7px] rounded-full" style={{ background: paused ? "var(--warn)" : failing ? "var(--danger)" : "var(--run)" }} />
        </span>
        {paused ? "Paused" : LEVELS.find((l) => l.id === level)?.label}
        <Icon name="expand_more" size={12} className="text-ink3" />
      </button>
      <button className="iconbtn" title={paused ? "Resume" : "Pause"} aria-label={paused ? "Resume" : "Pause"} onClick={() => save({ engine_paused: !paused })}>
        <Icon name={paused ? "play_arrow" : "pause"} size={16} />
      </button>
      {note && <small className="col-span-2 truncate pb-1 pl-6 text-xs text-danger">{note}</small>}
      {open && (
        <div className="pop absolute bottom-full left-0 mb-1 w-[336px]" role="menu">
          <LevelControl
            value={level}
            onChange={(l) => {
              setOpen(false);
              save({ autonomy_level: l });
            }}
          />
        </div>
      )}
    </div>
  );
}

// With several accounts: which one the mail lists show, or all of them merged.
function AccountSwitch() {
  const { accounts } = useApp();
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
  if (accounts.list.length < 2) return null;
  const current = accounts.byId.get(accounts.only);
  const choose = (id: string) => {
    accounts.setOnly(id);
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <button
        className="flex h-item w-full items-center gap-2 rounded-md px-2 text-left text-ink2 transition-colors duration-150 hover:bg-sel/55"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        onClick={() => setOpen(!open)}
      >
        <span className="grid w-4 flex-none place-items-center">{current ? <span className="mark">{accounts.mark(current.id)}</span> : <Icon name="email" size={16} className="text-ink3" />}</span>
        <span className="flex-1 truncate">{current ? current.address : "All accounts"}</span>
        <Icon name="expand_more" size={12} className="text-ink3" />
      </button>
      {open && (
        <div className="pop absolute left-0 top-full z-50 mt-1 w-max min-w-full max-w-[320px]" role="menu">
          <button role="menuitemradio" aria-checked={!current} className="pop-item" onClick={() => choose("")}>
            <Icon name="check" size={13} className={!current ? "text-ink" : "invisible"} />
            All accounts
          </button>
          {accounts.list.map((a) => (
            <button key={a.id} role="menuitemradio" aria-checked={current?.id === a.id} className="pop-item" onClick={() => choose(a.id)}>
              <Icon name="check" size={13} className={current?.id === a.id ? "text-ink" : "invisible"} />
              <span className="mark">{accounts.mark(a.id)}</span>
              <span className="min-w-0 flex-1 truncate">{a.address}</span>
              {a.paused && <span className="text-xs text-ink3">Paused</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Replies Autopilot is about to send, each with its countdown and a way to stop it.
function GoingOut() {
  const { mail, setView } = useApp();
  if (!mail.outgoing.length) return null;
  return (
    <div className="mx-2 border-t border-line px-2 pb-1.5 pt-2.5">
      <button className="label mb-1 block hover:text-ink" onClick={() => setView("replies")}>
        Going out
      </button>
      {mail.outgoing.slice(0, 3).map((o) => (
        <div key={o.id} className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-px py-1">
          <b className="truncate font-medium">{o.to}</b>
          <Countdown until={o.sendAt} className="font-semibold text-wax-ink" />
          <small className="truncate text-xs text-ink3">{o.subject}</small>
          {o.actionId && (
            <button className="link" onClick={() => mail.undo(o.actionId!).catch(() => {})}>
              Cancel
            </button>
          )}
        </div>
      ))}
      {mail.outgoing.length > 3 && (
        <button className="link mt-0.5" onClick={() => setView("replies")}>
          {mail.outgoing.length - 3} more
        </button>
      )}
    </div>
  );
}

// The views in the sidebar, in their three groups. Settings, Appearance can
// hide any but the Inbox; a hidden view still shows while it is open.
type Item = { id: string; icon: string; label: string; count?: "need" | "replies" | "todos" | "meetings" | "followups" };
export const NAV: Item[][] = [
  [
    { id: "inbox", icon: "inbox", label: "Inbox", count: "need" },
    { id: "replies", icon: "reply", label: "Replies", count: "replies" },
    { id: "todos", icon: "checklist", label: "Todos", count: "todos" },
    { id: "meetings", icon: "event", label: "Meetings", count: "meetings" },
    { id: "followups", icon: "schedule_send", label: "Follow-ups", count: "followups" },
  ],
  [
    { id: "briefing", icon: "description", label: "Brief" },
    { id: "ask", icon: "chat_bubble", label: "Ask" },
  ],
  [
    { id: "sent", icon: "send", label: "Sent" },
    { id: "scheduled", icon: "schedule", label: "Scheduled" },
    { id: "files", icon: "attach_file", label: "Files" },
    { id: "labels", icon: "label", label: "Labels" },
    { id: "newsletters", icon: "newspaper", label: "Newsletters" },
  ],
];

export default function Sidebar() {
  const { view, profile, sidebarOpen, setSidebarOpen, openCompose, mail } = useApp();
  const { hidden } = appearanceOf(profile);
  const groups = NAV.map((g) => g.filter((i) => i.id === "inbox" || i.id === view || !hidden.includes(i.id))).filter((g) => g.length);

  return (
    <>
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-scrim lg:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-56 flex-none flex-col border-r border-line bg-side transition-transform duration-200 ease-out lg:static lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-bar flex-none items-center pl-4 pr-2.5">
          <Logo size={22} className="flex-1" />
          <button className="iconbtn" title="New message (C)" aria-label="New message" onClick={() => openCompose()}>
            <Icon name="compose" size={16} />
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2 pt-0.5">
          <AccountSwitch />
          {groups.map((g) => (
            <div key={g[0].id}>
              {g.map((i) => (
                <NavItem key={i.id} id={i.id} icon={i.icon} label={i.label} count={i.count && mail.counts[i.count]} need={i.id === "inbox"} />
              ))}
            </div>
          ))}
        </nav>
        <GoingOut />
        <div className="mx-2 border-t border-line pb-2 pt-1.5">
          <Engine />
          <NavItem id="settings" icon="settings" label="Settings" on={view === "settings" || view === "history" || view === "relationships"} />
        </div>
      </aside>
    </>
  );
}
