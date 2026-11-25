// What a draft was written from, as one line: the thread, other emails, files,
// todos, the calendar (Source in server/replies.ts). Each opens what it names,
// the email and the file in place, over whatever is there.
import { Fragment, useEffect, useState } from "react";
import EmailBody from "@/components/EmailBody";
import FilePreview from "@/components/FilePreview";
import Icon from "@/components/Icon";
import type { Att } from "@/lib/attachments";
import { createClient } from "@/lib/db";
import { useApp } from "./AppShell";
import { clock, dayLabel } from "./ui";

export type Source = { kind: "thread" | "email" | "file" | "todos" | "meeting" | "calendar"; label: string; email_id?: string };
type Email = { gmail_id: string; account_id: string | null; sender: string | null; sender_email: string | null; recipients: string | null; subject: string | null; received_at: string; attachments: Att[] | null; body_html: string | null; body_text: string | null; snippet: string | null };

const FEW = 4;

export default function WrittenFrom({ from, className = "" }: { from: Source[] | null | undefined; className?: string }) {
  const { setView, addToast } = useApp();
  const [all, setAll] = useState(false);
  const [email, setEmail] = useState<Email | null>(null);
  const [file, setFile] = useState<{ att: Att; email: Email } | null>(null);
  if (!from?.length) return null;
  const shown = all ? from : from.slice(0, FEW);

  const open = async (s: Source) => {
    if (s.kind === "todos") return setView("todos");
    if (s.kind === "meeting" || s.kind === "calendar") return setView("meetings");
    const { data } = await createClient().from("emails").select("gmail_id, account_id, sender, sender_email, recipients, subject, received_at, attachments, body_html, body_text, snippet").eq("id", s.email_id ?? "").maybeSingle();
    const e = data as Email | null;
    const att = s.kind === "file" ? e?.attachments?.find((a) => a.filename === s.label) : undefined;
    if (!e || (s.kind === "file" && !att)) return addToast("error", "That is no longer in Tabellar");
    if (att) setFile({ att, email: e });
    else setEmail(e);
  };

  return (
    <div className={`text-xs leading-relaxed text-ink3 ${className}`}>
      Written from{" "}
      {shown.map((s, i) => (
        <Fragment key={`${s.kind} ${s.label} ${i}`}>
          {i > 0 && (i === from.length - 1 ? " and " : ", ")}
          <button type="button" className="link [overflow-wrap:anywhere]" onClick={() => open(s)}>
            {s.label}
          </button>
        </Fragment>
      ))}
      {shown.length < from.length && (
        <>
          {" and "}
          <button type="button" className="link" onClick={() => setAll(true)}>
            {from.length - shown.length} more
          </button>
        </>
      )}
      {email && <Peek email={email} onClose={() => setEmail(null)} />}
      {file && <FilePreview att={file.att} gmailId={file.email.gmail_id} accountId={file.email.account_id ?? undefined} onClose={() => setFile(null)} />}
    </div>
  );
}

// One email, looked at and left. Escape or a click beside it closes it.
function Peek({ email, onClose }: { email: Email; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={email.subject || "Email"} className="flex max-h-[85vh] w-full max-w-[680px] flex-col rounded-[12px] bg-raised text-[13px] text-ink shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-none items-start gap-2 border-b border-line-soft py-3 pl-5 pr-2">
          <div className="min-w-0 flex-1">
            <b className="block truncate text-[15px] font-[650]">{email.subject || "(no subject)"}</b>
            <span className="block truncate text-xs text-ink3">
              {email.sender || email.sender_email || `To ${email.recipients}`}, {dayLabel(email.received_at).name} {clock(email.received_at)}
            </span>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <EmailBody email={email} />
        </div>
      </div>
    </div>
  );
}
