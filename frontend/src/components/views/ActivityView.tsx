import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/db";
import { useApp } from "../AppShell";

// Everything the background engine did or proposes, and what the agent and
// assistant did for you. Proposals are approved exactly as shown (the server
// checks a hash of the text); finished actions can be undone.

type LogRow = {
  id: string;
  kind: "label" | "archive" | "draft" | "todo" | "meeting" | "send" | "unsubscribe";
  status: "proposed" | "running" | "done" | "undone" | "dismissed" | "blocked" | "failed";
  source: "engine" | "agent" | "assistant" | "user";
  summary: string;
  detail: Record<string, unknown>;
  hash: string | null;
  reason: string | null;
  error: string | null;
  created_at: string;
  emails: { id: string; subject: string | null; sender: string | null } | null;
};

type EngineStatus = {
  level: "observe" | "suggest" | "assist" | "autopilot";
  paused: boolean;
  lastCycleAt: string | null;
  lastError: string | null;
  running: boolean;
  autostart: boolean;
};

const KIND_ICON: Record<string, string> = {
  label: "label",
  archive: "archive",
  draft: "edit_note",
  todo: "checklist",
  meeting: "event",
  send: "send",
  unsubscribe: "unsubscribe",
};

const UNDOABLE = new Set(["label", "archive", "draft", "todo", "meeting"]);

export const LEVELS: { id: EngineStatus["level"]; label: string; text: string }[] = [
  { id: "observe", label: "Observe", text: "Sorts and notifies. Changes nothing." },
  { id: "suggest", label: "Suggest", text: "Proposes labels, drafts, todos and meetings for you to approve." },
  { id: "assist", label: "Assist", text: "Does those on its own. Never sends, archives or deletes." },
  {
    id: "autopilot",
    label: "Autopilot",
    text: "As Assist, and also replies on its own to the person who wrote, inside the thread, after a wait you can cancel in. Never copies anyone in, forwards, archives or deletes.",
  },
];

// Turning Autopilot on is the one change that lets Tabellar send mail, so it
// is confirmed first.
export function confirmLevel(level: string): boolean {
  if (level !== "autopilot") return true;
  return window.confirm(
    "Turn on Autopilot?\n\nTabellar will reply on its own to emails that need an answer it can give, only to the person who wrote and only inside the thread. " +
      "Each reply waits before sending so you can cancel it in Activity, and there is a daily limit. Pause stops everything at once.",
  );
}

// An Autopilot reply that has not gone out yet can still be cancelled.
function pendingSend(r: LogRow): boolean {
  return r.kind === "send" && r.status === "done" && !r.detail.sentAt && typeof r.detail.sendAt === "string" && new Date(r.detail.sendAt).getTime() > Date.now();
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function plain(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const STATUS_STYLE: Record<string, string> = {
  done: "text-emerald-600 dark:text-emerald-400",
  undone: "text-[var(--muted)]",
  dismissed: "text-[var(--muted)]",
  blocked: "text-amber-600 dark:text-amber-400",
  failed: "text-red-500",
  running: "text-[var(--accent)]",
};

const STATUS_LABEL: Record<string, string> = {
  done: "Done",
  undone: "Undone",
  dismissed: "Dismissed",
  blocked: "Not allowed",
  failed: "Failed",
  running: "Working",
};

export async function engineFetch(path: string, body?: unknown) {
  const { data } = await createClient().auth.getSession();
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

export default function ActivityView() {
  const { user, addToast, liveChanges, updateProfile } = useApp();
  const supabase = createClient();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [{ data }, s] = await Promise.all([
      supabase
        .from("action_log")
        .select("*, emails(id, subject, sender)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(300),
      engineFetch("/engine/status").catch(() => null),
    ]);
    setRows((data as LogRow[]) || []);
    if (s) setStatus(s);
    setLoading(false);
  }, [supabase, user.id]);

  useEffect(() => {
    load();
  }, [load, liveChanges.action_log]);

  // The last-run time comes from the server, not the database.
  useEffect(() => {
    const id = setInterval(() => engineFetch("/engine/status").then(setStatus).catch(() => {}), 15_000);
    return () => clearInterval(id);
  }, []);

  const withBusy = async (ids: string[], fn: () => Promise<void>) => {
    setBusy((b) => new Set([...b, ...ids]));
    try {
      await fn();
    } catch (e) {
      addToast("error", (e as Error).message);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        ids.forEach((id) => n.delete(id));
        return n;
      });
      load();
    }
  };

  const approve = (r: LogRow) => withBusy([r.id], () => engineFetch("/actions/approve", { id: r.id, hash: r.hash }));
  const dismiss = (r: LogRow) => withBusy([r.id], () => engineFetch("/actions/dismiss", { id: r.id }));
  const undo = (r: LogRow) =>
    withBusy([r.id], async () => {
      await engineFetch("/actions/undo", { id: r.id });
      addToast("success", r.kind === "send" ? "Cancelled. The reply will not be sent." : "Undone");
    });

  // Oldest first, so proposals arriving while you read land at the bottom
  // instead of shifting the one under your cursor.
  const proposals = rows.filter((r) => r.status === "proposed").reverse();
  const history = rows.filter((r) => r.status !== "proposed");
  const labelProposals = proposals.filter((r) => r.kind === "label");

  const approveAllLabels = () =>
    withBusy(labelProposals.map((r) => r.id), async () => {
      for (const r of labelProposals) await engineFetch("/actions/approve", { id: r.id, hash: r.hash });
    });

  const setLevel = async (level: EngineStatus["level"]) => {
    if (!confirmLevel(level)) return;
    await supabase.from("profiles").update({ autonomy_level: level }).eq("id", user.id);
    updateProfile({ autonomy_level: level });
    setStatus((s) => (s ? { ...s, level } : s));
  };

  const togglePause = async () => {
    const paused = !status?.paused;
    await supabase.from("profiles").update({ engine_paused: paused }).eq("id", user.id);
    updateProfile({ engine_paused: paused });
    setStatus((s) => (s ? { ...s, paused } : s));
    addToast("info", paused ? "Paused. Tabellar will not act until you resume." : "Resumed");
  };

  const checkNow = async () => {
    try {
      await engineFetch("/engine/run", {});
      setStatus((s) => (s ? { ...s, running: true } : s));
    } catch (e) {
      addToast("error", (e as Error).message);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="material-symbols-outlined animate-spin text-[var(--muted)]" style={{ fontSize: "24px" }}>progress_activity</span>
      </div>
    );
  }

  const emailLine = (r: LogRow) =>
    r.emails ? `${r.emails.sender?.split("<")[0]?.trim() || "Unknown"}: ${r.emails.subject || "(no subject)"}` : null;

  return (
    <div className="h-full overflow-auto bg-[var(--background)]">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h1 className="text-xl font-bold text-[var(--foreground)]">Activity</h1>
            <p className="text-sm text-[var(--muted)] mt-0.5">
              {status?.paused
                ? "Paused. Nothing happens until you resume."
                : status?.running
                  ? "Checking mail now..."
                  : status?.lastCycleAt
                    ? `Checked mail ${timeAgo(status.lastCycleAt)}`
                    : "Checks mail every two minutes while Tabellar runs"}
            </p>
            {status?.lastError && <p className="text-xs text-red-500 mt-1">Last check failed: {status.lastError}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={checkNow}
              disabled={status?.running}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)] disabled:opacity-50 cursor-pointer"
            >
              <span className={`material-symbols-outlined${status?.running ? " animate-spin" : ""}`} style={{ fontSize: "15px" }}>
                {status?.running ? "progress_activity" : "refresh"}
              </span>
              Check now
            </button>
            <button
              onClick={togglePause}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                status?.paused ? "bg-[var(--accent)] text-white hover:opacity-90" : "bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400"
              }`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: "15px", fontVariationSettings: "'FILL' 1" }}>
                {status?.paused ? "play_arrow" : "pause"}
              </span>
              {status?.paused ? "Resume" : "Pause"}
            </button>
          </div>
        </div>

        {/* Level */}
        <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-[var(--surface-2)] mb-2">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              onClick={() => setLevel(l.id)}
              className={`py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                status?.level === l.id ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--muted)] mb-6 px-1">{LEVELS.find((l) => l.id === status?.level)?.text}</p>

        {/* Proposals */}
        {proposals.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--muted)]">Waiting for you ({proposals.length})</h2>
              {labelProposals.length > 1 && (
                <button onClick={approveAllLabels} className="text-xs font-medium text-[var(--accent)] hover:underline cursor-pointer">
                  Approve all {labelProposals.length} labels
                </button>
              )}
            </div>
            <div className="space-y-2">
              {proposals.map((r) => {
                const isOpen = open.has(r.id);
                const body = r.kind === "draft" ? String(r.detail.body ?? "") : "";
                return (
                  <div key={r.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                    <div className="flex items-start gap-2.5">
                      <span className="material-symbols-outlined text-[var(--accent)] mt-0.5" style={{ fontSize: "18px" }}>{KIND_ICON[r.kind]}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[var(--foreground)]">{r.summary}</p>
                        {emailLine(r) && <p className="text-xs text-[var(--muted)] truncate">{emailLine(r)}</p>}
                        {r.kind === "draft" && (
                          <button
                            onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                            className="text-xs text-[var(--accent)] mt-1 hover:underline cursor-pointer"
                          >
                            {isOpen ? "Hide draft" : "Read draft"}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => dismiss(r)}
                          disabled={busy.has(r.id)}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)] disabled:opacity-50 cursor-pointer"
                        >
                          Dismiss
                        </button>
                        <button
                          onClick={() => approve(r)}
                          disabled={busy.has(r.id)}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 cursor-pointer"
                        >
                          {r.kind === "draft" ? "Save draft" : "Approve"}
                        </button>
                      </div>
                    </div>
                    {isOpen && (
                      <div className="mt-2 ml-7 text-xs">
                        <p className="text-[var(--muted)] mb-1">
                          To {(r.detail.to as string[] | undefined)?.join(", ")} · {String(r.detail.subject ?? "")}
                        </p>
                        <pre className="whitespace-pre-wrap font-sans text-[var(--foreground)] bg-[var(--surface-2)] rounded-lg p-2.5">{plain(body)}</pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* History */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--muted)] mb-2">History</h2>
          {history.length === 0 ? (
            <div className="text-center py-12 text-[var(--muted)]">
              <span className="material-symbols-outlined mb-2" style={{ fontSize: "40px" }}>history</span>
              <p className="text-sm">Nothing yet. New mail is checked every two minutes.</p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {history.map((r) => (
                <div key={r.id} className="flex items-start gap-2.5 py-2.5">
                  <span className="material-symbols-outlined text-[var(--muted)] mt-0.5" style={{ fontSize: "17px" }}>{KIND_ICON[r.kind]}</span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm ${r.status === "undone" || r.status === "dismissed" ? "line-through text-[var(--muted)]" : "text-[var(--foreground)]"}`}>{r.summary}</p>
                    {emailLine(r) && <p className="text-xs text-[var(--muted)] truncate">{emailLine(r)}</p>}
                    {(r.status === "blocked" || r.status === "failed") && (r.reason || r.error) && (
                      <p className="text-xs text-[var(--muted)] mt-0.5">{r.error || r.reason}</p>
                    )}
                    {r.kind === "send" && r.status === "done" && (
                      <p className={`text-xs mt-0.5 ${pendingSend(r) ? "text-[var(--accent)] font-medium" : "text-[var(--muted)]"}`}>
                        {r.detail.sentAt
                          ? `Sent ${timeAgo(String(r.detail.sentAt))}`
                          : pendingSend(r)
                            ? `Sends at ${new Date(String(r.detail.sendAt)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} unless you cancel`
                            : "Sending..."}
                      </p>
                    )}
                    {r.kind === "send" && typeof r.detail.body === "string" && (
                      <>
                        <button
                          onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                          className="text-xs text-[var(--accent)] mt-0.5 hover:underline cursor-pointer"
                        >
                          {open.has(r.id) ? "Hide reply" : "Read reply"}
                        </button>
                        {open.has(r.id) && (
                          <div className="mt-1.5 text-xs">
                            <p className="text-[var(--muted)] mb-1">To {(r.detail.to as string[] | undefined)?.join(", ")} · {String(r.detail.subject ?? "")}</p>
                            <pre className="whitespace-pre-wrap font-sans text-[var(--foreground)] bg-[var(--surface-2)] rounded-lg p-2.5">{String(r.detail.body)}</pre>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <span className={`text-[11px] font-medium ${STATUS_STYLE[r.status] ?? ""}`}>
                      {r.kind === "send" && r.status === "undone" ? "Cancelled" : (STATUS_LABEL[r.status] ?? r.status)}
                      {r.source !== "engine" ? ` · ${r.source === "agent" ? "agent" : r.source === "assistant" ? "assistant" : "you"}` : ""}
                    </span>
                    <span className="text-[10px] text-[var(--muted)]">{timeAgo(r.created_at)}</span>
                    {pendingSend(r) && (
                      <button
                        onClick={() => undo(r)}
                        disabled={busy.has(r.id)}
                        className="mt-0.5 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 disabled:opacity-50 cursor-pointer"
                      >
                        Cancel send
                      </button>
                    )}
                    {r.status === "done" && UNDOABLE.has(r.kind) && (
                      <button
                        onClick={() => undo(r)}
                        disabled={busy.has(r.id)}
                        className="text-[11px] font-medium text-[var(--accent)] hover:underline disabled:opacity-50 cursor-pointer"
                      >
                        Undo
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
