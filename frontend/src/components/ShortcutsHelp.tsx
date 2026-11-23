
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";
import Icon from "@/components/Icon";

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
        className="bg-raised border border-line rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line shrink-0">
          <h3 className="text-sm font-semibold text-ink">
            Keyboard shortcuts
          </h3>
          <button
            onClick={onClose}
            className="text-ink3 hover:text-ink cursor-pointer"
            aria-label="Close"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-4 grid gap-5 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink3 mb-2">
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
                          className="px-1.5 py-0.5 bg-field border border-line rounded text-ink font-mono text-[11px]"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                    <span className="text-ink3 text-right">
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
