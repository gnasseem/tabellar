import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { useApp } from "./AppShell";

export type ToastItem = {
  id: string;
  type: "success" | "error" | "info";
  message: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
};

// The toast sits on an ink ground, which is dark in the light theme and light
// in the dark one. Mixing danger with the canvas gives a red that reads on both.
const DANGER_ON_INK = "color-mix(in oklch, var(--danger) 45%, var(--bg))";

function SingleToast({ toast, onRemove }: { toast: ToastItem; onRemove: () => void }) {
  const duration = toast.duration ?? 3500;
  const [timeLeft, setTimeLeft] = useState(duration);

  useEffect(() => {
    const t = setTimeout(onRemove, duration);
    return () => clearTimeout(t);
  }, [onRemove, duration]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeLeft((prev) => Math.max(0, prev - 50));
    }, 50);
    return () => clearInterval(interval);
  }, []);

  const failed = toast.type === "error";

  return (
    <div
      role={failed ? "alert" : "status"}
      className="pointer-events-auto relative flex min-h-9 max-w-full items-center gap-2.5 overflow-hidden rounded-[9px] bg-ink pl-3 pr-1 text-[13px] text-canvas shadow-pop"
    >
      {failed && <Icon name="error" size={15} style={{ color: DANGER_ON_INK }} />}
      <span className="min-w-0 py-2 leading-snug">{toast.message}</span>
      {toast.action && (
        <>
          <span className="flex-none text-xs text-canvas/60">{Math.ceil(timeLeft / 1000)}s</span>
          <button
            className="flex-none font-medium underline decoration-canvas/50 underline-offset-[2.5px] hover:decoration-canvas"
            onClick={() => {
              toast.action!.onClick();
              onRemove();
            }}
          >
            {toast.action.label}
          </button>
        </>
      )}
      <button className="iconbtn !text-canvas/70 hover:!bg-canvas/15 hover:!text-canvas" onClick={onRemove} aria-label="Dismiss">
        <Icon name="close" size={14} />
      </button>
      {/* Time left to use the action, drawn as a thin bar that runs out. */}
      {toast.action && (
        <span
          className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-canvas/45"
          style={{ transform: `scaleX(${timeLeft / duration})`, transition: "transform 50ms linear" }}
        />
      )}
    </div>
  );
}

export function ToastContainer({ toasts, removeToast }: { toasts: ToastItem[]; removeToast: (id: string) => void }) {
  // An open compose window has its Send row along the bottom: stay above it.
  const [overCompose, setOverCompose] = useState(false);
  useEffect(() => {
    setOverCompose(!!document.querySelector("[data-compose-modal]"));
  }, [toasts]);

  if (!toasts.length) return null;
  return (
    <div
      className="pointer-events-none fixed left-0 z-[200] flex flex-col items-center gap-2 px-4 lg:left-56"
      style={{ right: 0, bottom: overCompose ? 76 : 16 }}
    >
      {toasts.map((t) => (
        <SingleToast key={t.id} toast={t} onRemove={() => removeToast(t.id)} />
      ))}
    </div>
  );
}
