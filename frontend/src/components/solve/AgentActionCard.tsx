import { useState } from "react";
import type { AgentAction } from "@/lib/agentTypes";
import { Glyph, Seg, Tick, clock } from "../ui";

interface AgentActionCardProps {
  action: AgentAction;
  onToggle: (selected: boolean) => void;
  onEdit: (patch: Partial<AgentAction["payload"]>) => void;
  onRemove?: () => void;
  result?: { status: "success" | "error"; info?: string; error?: string };
  locked?: boolean;
}

type ReplyMode = "send" | "draft" | "resolve";

function fmtIso(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${clock(iso)}`;
}

// What happens to a reply: sent, saved as a draft, or no email at all and the
// thread only marked handled.
function replyMode(a: AgentAction): ReplyMode {
  if (a.payload.resolve_only) return "resolve";
  if (a.payload.send_now === false) return "draft";
  return "send";
}

const MODE_TEXT: Record<ReplyMode, string> = { send: "Sends the reply", draft: "Saves a draft, sends nothing", resolve: "Marks it handled, no email" };

// One proposed action in the plan: a tick to include it, what it is, why, and
// an editor for its details. After the plan runs it shows how it went.
export default function AgentActionCard({ action, onToggle, onEdit, onRemove, result, locked }: AgentActionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const included = action.selected;
  const p = action.payload;
  const quiet = !included && !result;
  const archived = (p.email_ids ?? []).length;

  const title =
    action.type === "reply" ? p.to || "No recipient" : action.type === "todo" ? p.title || "Untitled todo" : action.type === "meeting" ? p.meeting_title || "Meeting" : `Archive ${archived} ${archived === 1 ? "email" : "emails"}`;
  const rest =
    action.type === "reply"
      ? p.subject || "(no subject)"
      : action.type === "todo"
        ? p.due
          ? `Due ${p.due}`
          : ""
        : action.type === "meeting"
          ? `${fmtIso(p.start_iso)}${p.duration_mins ? `, ${p.duration_mins} min` : ""}${p.attendees?.length ? `, invites ${p.attendees.join(", ")}` : ""}`
          : p.summary || "";
  const notes = [action.type === "reply" ? MODE_TEXT[replyMode(action)] : "", action.recommended ? "Suggested" : "", action.priority === "high" ? "High priority" : action.priority === "low" ? "Low priority" : ""].filter(Boolean).join(", ");

  return (
    <div className="row2 grid grid-cols-[26px_minmax(0,1fr)_auto] gap-y-[3px]">
      <span className="row-span-2 grid justify-center self-start pt-px">
        {result ? (
          <Glyph state={result.status === "success" ? "done" : "failed"} />
        ) : locked ? (
          <Glyph state={included ? "going" : "filed"} />
        ) : (
          <Tick checked={included} onChange={(v) => onToggle(v)} label={`Include: ${title}`} />
        )}
      </span>
      <div className="flex min-w-0 items-baseline gap-2">
        <b className={`max-w-[60%] flex-none truncate ${quiet ? "font-normal text-ink3" : "font-semibold text-ink"}`}>{title}</b>
        {rest && <span className={`truncate ${quiet ? "text-ink3" : "text-ink2"}`}>{rest}</span>}
      </div>
      <span className="flex items-center justify-end gap-3 whitespace-nowrap pl-3 text-xs">
        {result ? (
          <span className={result.status === "success" ? "text-ink3" : "font-medium text-danger"}>{result.status === "success" ? "Done" : "Failed"}</span>
        ) : locked ? (
          <span className="text-ink3">{included ? "Running" : "Left out"}</span>
        ) : (
          <>
            {onRemove && (
              <button className="link" onClick={onRemove}>
                Remove
              </button>
            )}
            <button className="link" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Close" : action.type === "reply" ? "Read and edit" : action.type === "archive" ? "Show" : "Edit"}
            </button>
          </>
        )}
      </span>
      <div className="col-span-2 min-w-0 text-[12.5px] leading-snug text-ink3">
        {notes && <p>{notes}</p>}
        {action.reasoning && <p className="mt-0.5">{action.reasoning}</p>}
        {(result?.info || result?.error) && <p className={`mt-0.5 ${result.status === "error" ? "text-danger" : ""}`}>{result.info ?? result.error}</p>}
      </div>

      {expanded && !locked && (
        <div className="col-span-2 col-start-2 mt-2 grid max-w-[560px] gap-2.5 pb-1">
          {action.type === "reply" && (
            <>
              <Field label="To" value={p.to ?? ""} onChange={(to) => onEdit({ to })} />
              <Field label="Subject" value={p.subject ?? ""} onChange={(subject) => onEdit({ subject })} />
              <label className="block">
                <span className="label mb-1 block">Reply</span>
                <textarea value={p.body ?? ""} onChange={(e) => onEdit({ body: e.target.value })} rows={8} disabled={replyMode(action) === "resolve"} className="input resize-y !text-sm !leading-[1.6] disabled:opacity-50" />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="label">When the plan runs</span>
                <Seg<ReplyMode>
                  value={replyMode(action)}
                  onChange={(m) => onEdit({ send_now: m === "send", resolve_only: m === "resolve" })}
                  options={[
                    { id: "send", label: "Send" },
                    { id: "draft", label: "Save as draft" },
                    { id: "resolve", label: "Only mark handled" },
                  ]}
                />
              </div>
              {replyMode(action) === "resolve" && <p className="text-[12.5px] leading-snug text-warn">This thread will be marked handled. No email is sent or saved as a draft.</p>}
            </>
          )}
          {action.type === "todo" && (
            <>
              <Field label="Todo" value={p.title ?? ""} onChange={(title) => onEdit({ title })} />
              <Field label="Due date, as YYYY-MM-DD" value={p.due ?? ""} onChange={(due) => onEdit({ due })} />
            </>
          )}
          {action.type === "meeting" && (
            <>
              <Field label="Title" value={p.meeting_title ?? ""} onChange={(meeting_title) => onEdit({ meeting_title })} />
              <Field label="Start, as an ISO date and time" value={p.start_iso ?? ""} onChange={(start_iso) => onEdit({ start_iso })} />
              <Field label="Length in minutes" value={String(p.duration_mins ?? 30)} onChange={(v) => onEdit({ duration_mins: Number(v) || 30 })} />
              <Field
                label="Attendees, separated by commas"
                value={(p.attendees ?? []).join(", ")}
                onChange={(v) =>
                  onEdit({
                    attendees: v
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </>
          )}
          {action.type === "archive" && (
            <ul className="max-h-64 overflow-y-auto text-[12.5px] leading-relaxed text-ink2">
              {(p.emails ?? []).map((e) => (
                <li key={e.id} className="truncate">
                  <span className="text-ink">{e.sender}</span> {e.subject || "(no subject)"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="label mb-1 block">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="input" />
    </label>
  );
}
