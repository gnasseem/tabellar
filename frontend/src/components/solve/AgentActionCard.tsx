
import { useState } from "react";
import Icon from "@/components/Icon";
import type { AgentAction } from "@/lib/agentTypes";

interface AgentActionCardProps {
  action: AgentAction;
  onToggle: (selected: boolean) => void;
  onEdit: (patch: Partial<AgentAction["payload"]>) => void;
  onRemove?: () => void;
  result?: { status: "success" | "error"; info?: string; error?: string };
  locked?: boolean;
}

const TYPE_META: Record<
  AgentAction["type"],
  { icon: string; label: string; accent: string; accentBg: string }
> = {
  reply: {
    icon: "send",
    label: "Reply",
    accent: "text-ok",
    accentBg: "bg-ok/10",
  },
  todo: {
    icon: "task_alt",
    label: "Todo",
    accent: "text-ok",
    accentBg: "bg-ok/10",
  },
  meeting: {
    icon: "event",
    label: "Meeting",
    accent: "text-ink2",
    accentBg: "bg-wax/10",
  },
  archive: {
    icon: "archive",
    label: "Archive",
    accent: "text-ink2",
    accentBg: "bg-ink3/10",
  },
};

function fmtIso(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

/**
 * Three-state reply intent selector: Send | Draft | Resolve only.
 * resolve_only means "mark this handled, don't create a draft and don't send".
 */
function replyMode(a: AgentAction): "send" | "draft" | "resolve" {
  if (a.payload.resolve_only) return "resolve";
  if (a.payload.send_now === false) return "draft";
  return "send";
}

export default function AgentActionCard({
  action,
  onToggle,
  onEdit,
  onRemove,
  result,
  locked,
}: AgentActionCardProps) {
  const meta = TYPE_META[action.type];
  const [expanded, setExpanded] = useState(false);
  const included = action.selected;

  const subdued = !included && !result;

  return (
    <div
      className={`solve-fade-in rounded-xl border transition-colors ${
        result?.status === "success"
          ? "border-ok-line bg-ok-soft"
          : result?.status === "error"
            ? "border-danger-line bg-danger-soft"
            : included
              ? "border-line bg-raised"
              : "border-dashed border-line bg-transparent"
      } ${subdued ? "opacity-70" : ""}`}
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${meta.accentBg} ${meta.accent}`}
          >
            <Icon name={meta.icon} size={14} />
          </span>
          <span
            className={`text-[10.5px] font-semibold uppercase tracking-[0.14em] ${meta.accent}`}
          >
            {meta.label}
          </span>
          {action.recommended && (
            <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-ok">
              <Icon name="auto_awesome" size={10} />
              Recommended
            </span>
          )}
          {action.priority && action.priority !== "medium" && (
            <span className="rounded-full border border-line bg-field px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider text-ink3">
              {action.priority}
            </span>
          )}
          {action.bucket && action.bucket !== "single" && (
            <span className="ml-auto rounded-full bg-field px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider text-ink3">
              {action.bucket}
            </span>
          )}
          {result && (
            <span
              className={`${action.bucket && action.bucket !== "single" ? "" : "ml-auto"} inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                result.status === "success"
                  ? "bg-ok/15 text-ok"
                  : "bg-danger/15 text-danger"
              }`}
            >
              <Icon name={result.status === "success" ? "check_circle" : "error"} size={12} />
              {result.status === "success" ? "Done" : "Failed"}
            </span>
          )}
        </div>

        <h4 className="mt-2 text-[13.5px] font-semibold leading-snug text-ink">
          {action.type === "reply" && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {replyMode(action) === "send" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-ok">
                  <Icon name="send" size={11} />
                  Send
                </span>
              )}
              {replyMode(action) === "draft" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-ink3/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-ink2">
                  <Icon name="drafts" size={11} />
                  Draft
                </span>
              )}
              {replyMode(action) === "resolve" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-warn">
                  <Icon name="done_all" size={11} />
                  Resolve only
                </span>
              )}
              <span>
                {`${action.payload.to ?? ""} · ${action.payload.subject ?? ""}`}
              </span>
            </span>
          )}
          {action.type === "todo" && (action.payload.title ?? "Untitled todo")}
          {action.type === "meeting" &&
            `${action.payload.meeting_title ?? "Meeting"} - ${fmtIso(action.payload.start_iso)}`}
          {action.type === "archive" &&
            `Archive ${(action.payload.email_ids ?? []).length} email${
              (action.payload.email_ids ?? []).length === 1 ? "" : "s"
            }${action.payload.summary ? ` · ${action.payload.summary}` : ""}`}
        </h4>

        {action.reasoning && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug italic text-ink3">
            <Icon name="psychology" size={13} className="mt-0.5 text-ok/70" />
            <span className="flex-1">{action.reasoning}</span>
          </p>
        )}

        {(result?.info || result?.error) && (
          <p className="mt-1.5 text-[11px] text-ink3">
            {result.info ?? result.error}
          </p>
        )}

        {/* Expanded editor */}
        {expanded && !locked && (
          <div className="mt-3 space-y-2.5 rounded-lg border border-dashed border-line bg-canvas/60 p-3">
            {action.type === "reply" && (
              <>
                <LabeledInput
                  label="To"
                  value={action.payload.to ?? ""}
                  onChange={(to) => onEdit({ to })}
                />
                <LabeledInput
                  label="Subject"
                  value={action.payload.subject ?? ""}
                  onChange={(subject) => onEdit({ subject })}
                />
                <LabeledTextarea
                  label="Body"
                  value={action.payload.body ?? ""}
                  onChange={(body) => onEdit({ body })}
                  rows={8}
                  disabled={replyMode(action) === "resolve"}
                />
                <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <span className="text-ink3">Intent:</span>
                  <div className="inline-flex rounded-full border border-line p-0.5 bg-field">
                    <TriStatePill
                      active={replyMode(action) === "send"}
                      onClick={() =>
                        onEdit({ send_now: true, resolve_only: false })
                      }
                      icon="send"
                      label="Send"
                      activeClass="bg-ok text-white"
                    />
                    <TriStatePill
                      active={replyMode(action) === "draft"}
                      onClick={() =>
                        onEdit({ send_now: false, resolve_only: false })
                      }
                      icon="drafts"
                      label="Draft"
                      activeClass="bg-ink3 text-white"
                    />
                    <TriStatePill
                      active={replyMode(action) === "resolve"}
                      onClick={() =>
                        onEdit({ send_now: false, resolve_only: true })
                      }
                      icon="done_all"
                      label="Resolve only"
                      activeClass="bg-warn text-white"
                    />
                  </div>
                </div>
                {replyMode(action) === "resolve" && (
                  <p className="text-[11px] leading-snug text-warn">
                    This thread will be marked handled. No email will be sent or
                    saved as a draft.
                  </p>
                )}
              </>
            )}
            {action.type === "todo" && (
              <>
                <LabeledInput
                  label="Title"
                  value={action.payload.title ?? ""}
                  onChange={(title) => onEdit({ title })}
                />
                <LabeledInput
                  label="Due date (YYYY-MM-DD)"
                  value={action.payload.due ?? ""}
                  onChange={(due) => onEdit({ due })}
                />
              </>
            )}
            {action.type === "meeting" && (
              <>
                <LabeledInput
                  label="Title"
                  value={action.payload.meeting_title ?? ""}
                  onChange={(meeting_title) => onEdit({ meeting_title })}
                />
                <LabeledInput
                  label="Start (ISO)"
                  value={action.payload.start_iso ?? ""}
                  onChange={(start_iso) => onEdit({ start_iso })}
                />
                <LabeledInput
                  label="Duration (minutes)"
                  value={String(action.payload.duration_mins ?? 30)}
                  onChange={(v) => onEdit({ duration_mins: Number(v) || 30 })}
                />
                <LabeledInput
                  label="Attendees (comma-separated)"
                  value={(action.payload.attendees ?? []).join(", ")}
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
              <LabeledInput
                label="Summary (what's being archived)"
                value={action.payload.summary ?? ""}
                onChange={(summary) => onEdit({ summary })}
              />
            )}
          </div>
        )}

        {/* Footer: edit + include + remove. No top-left checkbox. */}
        {!locked && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-2.5">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-ink3 transition-colors hover:bg-field hover:text-ink"
              >
                <Icon name={expanded ? "expand_less" : "tune"} size={13} />
                {expanded ? "Hide details" : "Edit"}
              </button>
              <button
                onClick={() => onToggle(!included)}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  included
                    ? "bg-ok text-white hover:bg-ok"
                    : "border border-line text-ink3 hover:bg-field hover:text-ink"
                }`}
                aria-pressed={included}
              >
                <Icon name={included ? "check_box" : "check_box_outline_blank"} size={13} />
                {included ? "Included" : "Include"}
              </button>
            </div>
            {onRemove && (
              <button
                onClick={onRemove}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-ink3 transition-colors hover:bg-danger/10 hover:text-danger"
              >
                <Icon name="delete" size={13} />
                Remove
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TriStatePill({
  active,
  onClick,
  icon,
  label,
  activeClass,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  activeClass: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
        active
          ? activeClass
          : "text-ink3 hover:text-ink"
      }`}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink3">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-line bg-field px-2.5 py-1.5 text-[12px] text-ink focus:border-ok-line focus:outline-none focus:ring-1 focus:ring-ok-line"
      />
    </label>
  );
}

function LabeledTextarea({
  label,
  value,
  onChange,
  rows = 4,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink3">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        disabled={disabled}
        className="w-full resize-y rounded-md border border-line bg-field px-2.5 py-1.5 text-[12px] text-ink focus:border-ok-line focus:outline-none focus:ring-1 focus:ring-ok-line disabled:opacity-50"
      />
    </label>
  );
}
