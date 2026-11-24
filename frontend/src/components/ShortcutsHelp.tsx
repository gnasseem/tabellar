import { SHORTCUT_GROUPS } from "@/lib/shortcuts";
import Icon from "@/components/Icon";

export default function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="flex max-h-[85vh] w-full max-w-[820px] flex-col rounded-[12px] bg-raised shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 flex-none items-center justify-between border-b border-line-soft pl-5 pr-2">
          <h2 className="bar-title">Keyboard shortcuts</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="columns-1 gap-9 overflow-y-auto px-5 pb-1 pt-4 sm:columns-2 lg:columns-3">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="mb-4 break-inside-avoid">
              <h3 className="label mb-1">{group.title}</h3>
              {group.shortcuts.map((s) => (
                <div key={s.keys} className="flex min-h-7 items-center justify-between gap-3 py-1">
                  <span className="text-ink2">{s.description}</span>
                  <span className="flex flex-none gap-1">
                    {s.keys.split(" ").map((k, i) => (
                      <kbd key={i} className="kbd">
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
