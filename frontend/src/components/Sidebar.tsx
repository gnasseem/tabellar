import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import Logo from "@/components/Logo";
import { Countdown } from "@/components/ui";
import { createClient } from "@/lib/db";
import { useApp } from "./AppShell";

// Levels, in the order of how much Tabellar does on its own.
export const LEVELS: { id: "observe" | "suggest" | "assist" | "autopilot"; label: string; text: string }[] = [
  { id: "observe", label: "Observe", text: "Sorts and notifies. Changes nothing." },
  { id: "suggest", label: "Suggest", text: "Proposes labels, drafts, todos and meetings for you to approve." },
  { id: "assist", label: "Assist", text: "Does those on its own. Never sends, archives or deletes." },
  { id: "autopilot", label: "Autopilot", text: "Also replies on its own to the person who wrote, inside the thread, after a wait you can cancel in." },
];

// Turning Autopilot on is the one change that lets Tabellar send mail, so it
// is confirmed first.
export function confirmLevel(level: string): boolean {
  if (level !== "autopilot") return true;
  return window.confirm(
    "Turn on Autopilot?\n\nTabellar will reply on its own to emails that need an answer it can give, only to the person who wrote and only inside the thread. " +
      "Each reply waits before sending so you can cancel it, and there is a daily limit. Pause stops everything at once.",
  );
}

function ago(iso: string | null): string {
  if (!iso) return "Not checked yet";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "Checked Gmail just now";
  if (s < 3600) return `Checked Gmail ${Math.floor(s / 60)} min ago`;
  return `Checked Gmail ${Math.floor(s / 3600)} h ago`;
}

function NavItem({ id, icon, label, count, need }: { id: string; icon: string; label: string; count?: number; need?: boolean }) {
  const { view, setView, setSidebarOpen, assistantOpen, setAssistantOpen } = useApp();
  const on = id === "ask" ? assistantOpen : view === id;
  return (
    <button
      aria-current={on ? "page" : undefined}
      onClick={() => {
        if (id === "ask") setAssistantOpen(!assistantOpen);
        else setView(id);
        setSidebarOpen(false);
      }}
      className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 ${on ? "bg-sel font-medium text-ink" : "text-ink2 hover:bg-sel/55"}`}
    >
      <Icon name={icon} size={16} className={on ? "text-ink" : "text-ink3"} />
      <span className="flex-1 truncate">{label}</span>
      {count ? <span className={`text-xs ${need ? "count-need" : "text-ink3"}`}>{count.toLocaleString()}</span> : null}
    </button>
  );
}

// Level, pause and last check: the engine's state, always in view and out of the way.
function Engine() {
  const { user, profile, updateProfile, setView, mail, addToast } = useApp();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const level = mail.engine?.level ?? (profile.autonomy_level as string) ?? "observe";
  const paused = mail.engine?.paused ?? !!profile.engine_paused;

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
    <div ref={ref} className="relative mx-2 grid grid-cols-[1fr_auto_auto] items-center gap-x-0.5 border-t border-line pb-2.5 pl-2 pr-1 pt-2">
      <button className="flex h-6 items-center gap-[7px] justify-self-start rounded-md pr-1 font-semibold" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <i className="h-[7px] w-[7px] rounded-full" style={{ background: paused ? "var(--warn)" : mail.engine?.lastError ? "var(--danger)" : "var(--run)" }} />
        {paused ? "Paused" : LEVELS.find((l) => l.id === level)?.label}
        <Icon name="expand_more" size={12} className="text-ink3" />
      </button>
      <button className="iconbtn" title={paused ? "Resume" : "Pause everything"} aria-label={paused ? "Resume" : "Pause everything"} onClick={() => save({ engine_paused: !paused })}>
        <Icon name={paused ? "play_arrow" : "pause"} size={16} />
      </button>
      <button className="iconbtn" title="Settings" aria-label="Settings" onClick={() => setView("settings")}>
        <Icon name="settings" size={16} />
      </button>
      <small className="col-span-3 truncate text-xs text-ink3">
        {paused ? "Nothing happens until you resume" : mail.engine?.lastError ? "Last check failed. See Activity" : mail.engine?.running ? "Checking Gmail now" : ago(mail.engine?.lastCycleAt ?? null)}
      </small>
      {open && (
        <div className="pop absolute bottom-full left-0 mb-1 w-[272px]" role="menu">
          <p className="label px-2 pb-1 pt-1.5">How far Tabellar goes on its own</p>
          {LEVELS.map((l) => (
            <button
              key={l.id}
              role="menuitemradio"
              aria-checked={l.id === level}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sel"
              onClick={() => {
                setOpen(false);
                if (l.id !== level && confirmLevel(l.id)) save({ autonomy_level: l.id });
              }}
            >
              <Icon name="check" size={13} className={`mt-0.5 ${l.id === level ? "text-ink" : "invisible"}`} />
              <span>
                <b className="block font-medium">{l.label}</b>
                <span className="block text-xs leading-snug text-ink2">{l.text}</span>
              </span>
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

export default function Sidebar() {
  const { view, sidebarOpen, setSidebarOpen, openCompose, briefingVersion, mail } = useApp();
  const seen = useRef(briefingVersion);
  const [newBriefing, setNewBriefing] = useState(false);
  useEffect(() => {
    if (briefingVersion > seen.current) {
      seen.current = briefingVersion;
      if (view !== "briefing") setNewBriefing(true);
    }
    if (view === "briefing") setNewBriefing(false);
  }, [briefingVersion, view]);
  const c = mail.counts;

  return (
    <>
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-56 flex-none flex-col border-r border-line bg-side transition-transform duration-200 ease-out lg:static lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-[52px] flex-none items-center pl-4 pr-2.5">
          <Logo size={22} className="flex-1" />
          <button className="iconbtn" title="New message (C)" aria-label="New message" onClick={() => openCompose()}>
            <Icon name="compose" size={16} />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-2 pt-0.5">
          <NavItem id="inbox" icon="inbox" label="Inbox" count={c.need} need />
          <p className="label px-2 pb-[5px] pt-4">From your mail</p>
          <NavItem id="replies" icon="reply" label="Replies" count={c.replies} />
          <NavItem id="todos" icon="checklist" label="Todos" count={c.todos} />
          <NavItem id="meetings" icon="event" label="Meetings" count={c.meetings} />
          <NavItem id="followups" icon="schedule_send" label="Follow-ups" count={c.followups} />
          <NavItem id="newsletters" icon="newspaper" label="Newsletters" />
          <p className="label px-2 pb-[5px] pt-4">Tabellar</p>
          <NavItem id="briefing" icon="description" label="Briefing" count={newBriefing ? 1 : 0} />
          <NavItem id="activity" icon="activity" label="Activity" count={c.proposals} need />
          <NavItem id="ask" icon="chat_bubble" label="Ask" />
          <p className="label px-2 pb-[5px] pt-4">Mail</p>
          <NavItem id="sent" icon="send" label="Sent" />
          <NavItem id="scheduled" icon="schedule" label="Scheduled" count={c.scheduled} />
          <NavItem id="categories" icon="label" label="Labels" />
        </nav>
        <GoingOut />
        <Engine />
      </aside>
    </>
  );
}
