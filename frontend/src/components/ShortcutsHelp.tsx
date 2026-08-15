"use client";

import { SHORTCUT_GROUPS } from "@/lib/shortcuts";

export default function ShortcutsHelp({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">
            Keyboard shortcuts
          </h3>
          <button
            onClick={onClose}
            className="text-[var(--muted)] hover:text-[var(--foreground)] cursor-pointer"
            aria-label="Close"
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: "18px" }}
            >
              close
            </span>
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-4 grid gap-5 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)] mb-2">
                {group.title}
              </div>
              <div className="space-y-1.5 text-xs">
                {group.shortcuts.map((s) => (
                  <div
                    key={s.keys}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="flex gap-1 shrink-0">
                      {s.keys.split(" ").map((k, i) => (
                        <kbd
                          key={i}
                          className="px-1.5 py-0.5 bg-[var(--surface-2)] border border-[var(--border)] rounded text-[var(--foreground)] font-mono text-[11px]"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                    <span className="text-[var(--muted)] text-right">
                      {s.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
