// Under a meeting: the last thread with the people in it, and what is open
// between them and the user (server/prep.ts). Nothing shows when there is
// neither.
import { useEffect, useState } from "react";
import { api } from "@/lib/outcomes";
import { shortWhen } from "./ui";

type Prep = { last: { email_id: string; who: string; subject: string; text: string; at: string } | null; open: { key: string; kind: string; text: string; email_id: string | null }[] };

const HOUR = 3_600_000;

// The meeting starting within the hour, or on now; checked again each minute.
export function useUpNext(events: { id: string; start: string; end: string; allDay: boolean; people?: string[] }[] | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const now = Date.now();
  return (events || []).find((e) => !e.allDay && e.people?.length && new Date(e.start).getTime() - now <= HOUR && new Date(e.end).getTime() > now)?.id ?? null;
}

export function MeetingPrep({ title, people, onOpen, className = "" }: { title: string; people: string[]; onOpen: (emailId: string) => void; className?: string }) {
  const [prep, setPrep] = useState<Prep | null>(null);
  const [failed, setFailed] = useState(false);
  const key = people.join();
  useEffect(() => {
    let live = true;
    (api("/calendar/prep", { title, people }) as Promise<Prep>).then((p) => live && setPrep(p)).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [title, key]);

  const line = "flex min-h-[26px] w-full items-baseline gap-2 text-left";
  if (failed) return <p className={`pb-2 text-[12.5px] text-danger ${className}`}>That could not be read. Open the meeting again.</p>;
  if (!prep)
    return (
      <div className={`pb-2 pr-5 pt-1 ${className}`} aria-busy="true" aria-label="Loading">
        <span className="skel block h-2.5 w-72 max-w-full" />
      </div>
    );
  return (
    <div className={`pb-1 pr-5 text-[12.5px] ${className}`}>
      {!prep.last && !prep.open.length && <p className="text-ink3">No mail with them in the last two months</p>}
      {prep.last && (
        <button className={`${line} group/prep`} onClick={() => onOpen(prep.last!.email_id)} title={prep.last.subject}>
          <span className="flex-none text-ink2">{prep.last.who}</span>
          <span className="min-w-0 flex-1 truncate text-ink2 group-hover/prep:text-ink">
            {prep.last.subject}
            {prep.last.text && <span className="text-ink3">, {prep.last.text}</span>}
          </span>
          <time className="flex-none text-xs text-ink3">{shortWhen(prep.last.at)}</time>
        </button>
      )}
      {prep.open.map((o) => (
        <button key={o.key} className={`${line} group/prep`} disabled={!o.email_id} onClick={() => o.email_id && onOpen(o.email_id)}>
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{o.text}</span>
        </button>
      ))}
    </div>
  );
}
