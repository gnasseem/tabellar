import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { Empty, Glyph, SkeletonRows, ViewBar, VirtualList, shortWhen, useSizes } from "../ui";
import { NotThis } from "../NotThis";

// Follow-ups: mail the user sent that still waits on an answer, one line
// each: who, what they were asked, how long ago. A reminder the user set and
// sent mail Tabellar suggests are the same row. Nudge opens a drafted
// follow-up in the thread; Later puts it off three days; the menu ends it for
// this email or for the address.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Followup = {
  key: string;
  reminder_id: string | null;
  email_id: string;
  thread_id: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  sent_at: string;
  asked: string;
  seen_at: string | null;
  remind_at: string | null;
};

const DAY = 86_400_000;
const LATER_DAYS = 3;

function ago(iso: string): string {
  const n = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  return n <= 0 ? "Today" : n === 1 ? "1 day" : `${n} days`;
}

export default function FollowupsView() {
  const { user, addToast, openCompose, search, mail, liveChanges } = useApp();
  const supabase = createClient();
  const [list, setList] = useState<Followup[] | null>(null);
  const [error, setError] = useState(false);
  const [cursorKey, setCursorKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = (await api("/follow-ups/list")) as { followups: Followup[] };
      setList(r.followups);
      setError(false);
    } catch {
      setError(true);
      setList((prev) => prev ?? []);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, liveChanges.follow_up_reminders]);

  const q = search.trim().toLowerCase();
  const rows = (list || []).filter((f) => !q || `${f.recipient_name} ${f.recipient_email} ${f.subject} ${f.asked}`.toLowerCase().includes(q));
  const cursor = rows.find((r) => r.key === cursorKey) || rows[0] || null;
  const due = (f: Followup) => !f.remind_at || new Date(f.remind_at).getTime() <= Date.now();

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorKey(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].key);
  };
  const leave = (f: Followup) => {
    const at = rows.indexOf(f);
    setCursorKey((rows[at + 1] || rows[at - 1])?.key ?? null);
    setList((prev) => (prev || []).filter((x) => x.key !== f.key));
  };

  // A reminder row for a suggestion, so Later and Not this stick to it.
  const ensureReminder = async (f: Followup, fields: Record<string, unknown>): Promise<string | null> => {
    if (f.reminder_id) {
      const { error: failed } = await supabase.from("follow_up_reminders").update(fields).eq("id", f.reminder_id);
      return failed ? null : f.reminder_id;
    }
    const { data, error: failed } = await supabase
      .from("follow_up_reminders")
      .upsert({ user_id: user.id, email_id: f.email_id, thread_id: f.thread_id, recipient_email: f.recipient_email, recipient_name: f.recipient_name, subject: f.subject, remind_at: new Date().toISOString(), created_at: new Date().toISOString(), ...fields }, { onConflict: "user_id,thread_id" })
      .select("id")
      .single();
    return failed || !data ? null : (data as { id: string }).id;
  };

  const later = async (f: Followup) => {
    leave(f);
    const until = new Date(Date.now() + LATER_DAYS * DAY).toISOString();
    const id = await ensureReminder(f, { status: "snoozed", snooze_until: until });
    if (!id) {
      addToast("error", "That was not saved. Try again.");
      return load();
    }
    mail.reload();
    const undo = async () => {
      if (f.reminder_id) await supabase.from("follow_up_reminders").update({ status: "waiting", snooze_until: null }).eq("id", id);
      else await supabase.from("follow_up_reminders").delete().eq("id", id);
      mail.reload();
      load();
    };
    addToast("info", `Back on ${new Date(until).toLocaleDateString([], { weekday: "long" })}`, { action: { label: "Undo", onClick: undo } });
  };

  const notThis = async (f: Followup) => {
    leave(f);
    if (!(await ensureReminder(f, { status: "dismissed", snooze_until: null }))) throw new Error("That was not saved. Try again.");
    mail.reload();
  };

  // A reply in the same thread, drafted by Tabellar from what was asked.
  const nudge = async (f: Followup) => {
    const { data } = await supabase.from("emails").select("gmail_id, account_id, body_text").eq("id", f.email_id).maybeSingle();
    const e = (data || {}) as any;
    openCompose({
      sender_email: f.recipient_email,
      subject: f.subject,
      thread_id: f.thread_id,
      gmail_id: e.gmail_id,
      account_id: e.account_id,
      body_text: e.body_text || f.asked,
      _autoGenerate: true,
      _prefillBody: `I sent this ${ago(f.sent_at) === "Today" ? "earlier today" : `${ago(f.sent_at)} ago`} and have had no answer. Write a short, friendly follow-up that asks again${f.asked ? `: ${f.asked}` : "."}`,
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[data-compose-modal]")) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if (e.key === "Enter" && cursor && !(e.target as HTMLElement).closest?.("button, a")) nudge(cursor);
      else if (k === "l" && cursor) later(cursor);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const { row } = useSizes();
  const heightOf = useCallback(() => row, [row]);
  const reveal = "opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-aria-selected:opacity-100 has-[[aria-expanded=true]]:opacity-100";

  const render = (f: Followup) => {
    const waiting = due(f);
    return (
      <div key={f.key} role="option" aria-selected={cursor?.key === f.key} className="row group" title={f.subject} onClick={() => setCursorKey(f.key)} onDoubleClick={() => nudge(f)}>
        <span className="grid w-[26px] flex-none place-items-center">{waiting && <Glyph state="need" />}</span>
        <span className={`w-[132px] flex-none truncate pr-3 text-ink md:w-[164px] ${waiting ? "font-[650]" : ""}`} title={f.recipient_email}>
          {f.recipient_name}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink2">{f.asked || f.subject}</span>
        {f.seen_at && <span className="flex-none pl-3 text-xs text-ink3 group-hover:hidden group-aria-selected:hidden">Seen {shortWhen(f.seen_at)}</span>}
        <span className={`flex flex-none items-center gap-3 pl-3 max-md:hidden max-md:group-aria-selected:flex ${reveal}`}>
          <button className="link !text-wax-ink" onClick={(e) => (e.stopPropagation(), nudge(f))}>
            Nudge
          </button>
          <button className="link" onClick={(e) => (e.stopPropagation(), later(f))}>
            Later
          </button>
          <NotThis thing="followup" sender={f.recipient_email} who={f.recipient_name} onNotThis={() => notThis(f)} onDone={load} />
        </span>
        <time className="w-[56px] flex-none text-right text-xs text-ink3 max-md:group-aria-selected:hidden md:w-[64px]" dateTime={f.sent_at}>
          {ago(f.sent_at)}
        </time>
      </div>
    );
  };

  return (
    <>
      <ViewBar title="Follow-ups" search="Search follow-ups" />
      {error && (
        <p className="px-5 pt-3 text-danger" role="alert">
          Follow-ups could not be loaded.{" "}
          <button className="link !text-danger" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {list === null ? (
        <div className="pt-2.5">
          <SkeletonRows count={10} />
        </div>
      ) : !rows.length ? (
        q ? <Empty icon="search" title="Nothing matches that search" /> : error ? null : <Empty icon="schedule_send" title="Nobody owes you an answer" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col pt-1.5" role="listbox" aria-label="Follow-ups">
          <VirtualList items={rows} heightOf={heightOf} render={render} cursor={cursor ? rows.indexOf(cursor) : -1} />
        </div>
      )}
    </>
  );
}
