import { useCallback, useEffect, useState } from "react";
import { useApp } from "../AppShell";
import { engineFetch } from "./ActivityView";

// Newsletter cleanup: senders of bulk mail, the ones filling the inbox first.
// Unsubscribe follows the sender's own unsubscribe header (the server reads it
// fresh from Gmail); an unsubscribe that sends an email is shown and confirmed
// first. Archiving a sender is one action, undone from Activity.

type Sender = {
  sender_email: string;
  name: string;
  total: number;
  inbox: number;
  unread: number;
  last_at: string;
  can_unsubscribe: boolean;
  status: "kept" | "unsubscribed" | null;
  method: string | null;
};

type Tab = "clean" | "kept" | "unsubscribed";

const TABS: { id: Tab; label: string }[] = [
  { id: "clean", label: "To clean up" },
  { id: "unsubscribed", label: "Unsubscribed" },
  { id: "kept", label: "Kept" },
];

function shortDate(iso: string): string {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${Math.floor(days)} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function NewslettersView() {
  const { addToast } = useApp();
  const [senders, setSenders] = useState<Sender[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("clean");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Unsubscribes that have to be finished on the sender's own page.
  const [pages, setPages] = useState<{ sender: string; url: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await engineFetch("/newsletters");
      setSenders(r.senders || []);
    } catch (e) {
      addToast("error", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = (addr: string, p: Partial<Sender>) => setSenders((list) => list.map((s) => (s.sender_email === addr ? { ...s, ...p } : s)));

  const withBusy = async (addrs: string[], fn: () => Promise<void>) => {
    setBusy((b) => new Set([...b, ...addrs]));
    try {
      await fn();
    } catch (e) {
      addToast("error", (e as Error).message);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        addrs.forEach((a) => n.delete(a));
        return n;
      });
    }
  };

  // Returns false when the user declined to send an unsubscribe email.
  const doUnsubscribe = async (s: Sender): Promise<boolean> => {
    let r = await engineFetch("/newsletters/unsubscribe", { sender: s.sender_email });
    if (r.confirm) {
      const yes = window.confirm(
        `${s.name} unsubscribes by email.\n\nTabellar will send an email to ${r.confirm.to} with the subject "${r.confirm.subject}" from your account. Send it?`,
      );
      if (!yes) return false;
      r = await engineFetch("/newsletters/unsubscribe", { sender: s.sender_email, confirm: r.confirm.to });
    }
    if (r.open) setPages((p) => [...p.filter((x) => x.sender !== s.sender_email), { sender: s.name, url: r.open }]);
    patch(s.sender_email, { status: "unsubscribed", method: r.method ?? (r.open ? "web" : null) });
    return true;
  };

  const doArchive = async (s: Sender) => {
    const r = await engineFetch("/newsletters/archive", { sender: s.sender_email });
    patch(s.sender_email, { inbox: 0 });
    return r.archived as number;
  };

  const unsubscribe = (s: Sender) =>
    withBusy([s.sender_email], async () => {
      if (await doUnsubscribe(s)) addToast("success", `Unsubscribed from ${s.name}`);
    });

  const archive = (s: Sender) =>
    withBusy([s.sender_email], async () => {
      const n = await doArchive(s);
      addToast("success", `Archived ${n} email${n === 1 ? "" : "s"} from ${s.name}. Undo it in Activity.`);
    });

  const keep = (s: Sender, on: boolean) =>
    withBusy([s.sender_email], async () => {
      await engineFetch("/newsletters/keep", { sender: s.sender_email, keep: on });
      patch(s.sender_email, { status: on ? "kept" : null });
    });

  const cleanSelected = () => {
    const list = senders.filter((s) => selected.has(s.sender_email));
    withBusy(list.map((s) => s.sender_email), async () => {
      let unsubscribed = 0;
      let archived = 0;
      for (const s of list) {
        try {
          if (s.can_unsubscribe && s.status !== "unsubscribed" && (await doUnsubscribe(s))) unsubscribed++;
          if (s.inbox > 0) archived += await doArchive(s);
        } catch (e) {
          addToast("error", `${s.name}: ${(e as Error).message}`);
        }
      }
      setSelected(new Set());
      addToast("success", `Unsubscribed from ${unsubscribed} sender${unsubscribed === 1 ? "" : "s"} and archived ${archived} email${archived === 1 ? "" : "s"}`);
    });
  };

  const shown = senders.filter((s) => (tab === "clean" ? s.status === null : s.status === tab));
  const counts = { clean: 0, kept: 0, unsubscribed: 0 } as Record<Tab, number>;
  for (const s of senders) counts[s.status ?? "clean"]++;
  const inboxTotal = senders.filter((s) => s.status === null).reduce((n, s) => n + s.inbox, 0);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="material-symbols-outlined animate-spin text-[var(--muted)]" style={{ fontSize: "24px" }}>progress_activity</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-[var(--background)]">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <h1 className="text-xl font-bold text-[var(--foreground)]">Newsletters</h1>
        <p className="text-sm text-[var(--muted)] mt-0.5 mb-5">
          {counts.clean
            ? `${counts.clean} sender${counts.clean === 1 ? "" : "s"} of bulk mail, with ${inboxTotal} email${inboxTotal === 1 ? "" : "s"} in your inbox.`
            : "No bulk mail left to clean up."}
        </p>

        {pages.length > 0 && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 mb-5">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-sm font-medium text-[var(--foreground)]">Finish on their page</p>
              <button onClick={() => setPages([])} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] cursor-pointer">
                Done
              </button>
            </div>
            <p className="text-xs text-[var(--muted)] mb-2">These senders only unsubscribe through their website.</p>
            <ul className="space-y-1">
              {pages.map((p) => (
                <li key={p.url}>
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--accent)] hover:underline">
                    Unsubscribe from {p.sender}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex gap-1 p-1 rounded-xl bg-[var(--surface-2)]">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  setSelected(new Set());
                }}
                className={`px-3 py-1 rounded-lg text-xs font-semibold cursor-pointer ${
                  tab === t.id ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {t.label} {counts[t.id] > 0 && <span className="opacity-60">{counts[t.id]}</span>}
              </button>
            ))}
          </div>
          {tab === "clean" && selected.size > 0 && (
            <button
              onClick={cleanSelected}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--accent)] text-white hover:opacity-90 cursor-pointer"
            >
              Unsubscribe and archive {selected.size}
            </button>
          )}
        </div>

        {shown.length === 0 ? (
          <div className="text-center py-12 text-[var(--muted)]">
            <span className="material-symbols-outlined mb-2" style={{ fontSize: "40px" }}>mark_email_read</span>
            <p className="text-sm">{tab === "clean" ? "Nothing to clean up." : tab === "kept" ? "Senders you keep show up here." : "Senders you unsubscribe from show up here."}</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {shown.map((s) => {
              const isBusy = busy.has(s.sender_email);
              return (
                <div key={s.sender_email} className="flex items-center gap-3 py-2.5">
                  {tab === "clean" && (
                    <input
                      type="checkbox"
                      checked={selected.has(s.sender_email)}
                      onChange={(e) =>
                        setSelected((sel) => {
                          const n = new Set(sel);
                          if (e.target.checked) n.add(s.sender_email);
                          else n.delete(s.sender_email);
                          return n;
                        })
                      }
                      className="accent-[var(--accent)] cursor-pointer"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--foreground)] truncate">{s.name}</p>
                    <p className="text-xs text-[var(--muted)] truncate">
                      {s.sender_email} · {s.inbox} in inbox · {s.total} in all · last {shortDate(s.last_at)}
                      {s.status === "unsubscribed" && s.method === "web" ? " · finished on their page?" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {isBusy && <span className="material-symbols-outlined animate-spin text-[var(--muted)]" style={{ fontSize: "16px" }}>progress_activity</span>}
                    {s.status !== "kept" && s.can_unsubscribe && s.status !== "unsubscribed" && (
                      <button
                        onClick={() => unsubscribe(s)}
                        disabled={isBusy}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 cursor-pointer"
                      >
                        Unsubscribe
                      </button>
                    )}
                    {s.inbox > 0 && (
                      <button
                        onClick={() => archive(s)}
                        disabled={isBusy}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--surface-2)] disabled:opacity-50 cursor-pointer"
                      >
                        Archive {s.inbox}
                      </button>
                    )}
                    {s.status === null && (
                      <button
                        onClick={() => keep(s, true)}
                        disabled={isBusy}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)] disabled:opacity-50 cursor-pointer"
                      >
                        Keep
                      </button>
                    )}
                    {s.status !== null && (
                      <button
                        onClick={() => keep(s, false)}
                        disabled={isBusy}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)] disabled:opacity-50 cursor-pointer"
                      >
                        Move back
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
