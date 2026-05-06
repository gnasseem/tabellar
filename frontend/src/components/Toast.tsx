"use client";

import { useEffect, useState } from "react";

export type ToastItem = {
  id: string;
  type: "success" | "error" | "info";
  message: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
};

const TYPE_CONFIG = {
  success: {
    icon: "check_circle",
    barClass: "bg-green-500",
    iconClass: "text-green-500 dark:text-green-400",
    actionClass:
      "text-green-700 dark:text-green-400 bg-green-500/10 hover:bg-green-500/20",
  },
  error: {
    icon: "error",
    barClass: "bg-red-500",
    iconClass: "text-red-500 dark:text-red-400",
    actionClass:
      "text-red-700 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20",
  },
  info: {
    icon: "info",
    barClass: "bg-[var(--accent)]",
    iconClass: "text-[var(--accent)]",
    actionClass:
      "text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20",
  },
};

function SingleToast({
  toast,
  onRemove,
}: {
  toast: ToastItem;
  onRemove: () => void;
}) {
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

  const cfg = TYPE_CONFIG[toast.type];
  const progress = timeLeft / duration;

  return (
    <div className="pointer-events-auto relative overflow-hidden rounded-lg bg-[var(--sidebar-bg)] border border-[var(--border)] shadow-md">
      {/* Left accent strip */}
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${cfg.barClass}`} />

      <div className="pl-4 pr-3 pt-2.5 pb-2.5">
        {/* Icon + message + close */}
        <div className="flex items-start gap-2">
          <span
            className={`material-symbols-outlined shrink-0 mt-px ${cfg.iconClass}`}
            style={{ fontSize: "15px" }}
          >
            {cfg.icon}
          </span>
          <span className="flex-1 text-[12px] font-medium text-[var(--foreground)] leading-snug">
            {toast.message}
          </span>
          <button
            onClick={onRemove}
            className="shrink-0 opacity-40 hover:opacity-80 transition-opacity -mt-0.5 -mr-0.5"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>
              close
            </span>
          </button>
        </div>

        {/* Action row */}
        {toast.action && (
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] opacity-40 text-[var(--foreground)] tabular-nums">
              {Math.ceil(timeLeft / 1000)}s
            </span>
            <button
              onClick={() => {
                toast.action!.onClick();
                onRemove();
              }}
              className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-md transition-colors ${cfg.actionClass}`}
            >
              {toast.action.label}
            </button>
          </div>
        )}
      </div>

      {/* Draining progress bar */}
      <div
        className={`absolute bottom-0 left-0 h-[2px] ${cfg.barClass} opacity-50`}
        style={{ width: `${progress * 100}%`, transition: "width 50ms linear" }}
      />
    </div>
  );
}

export function ToastContainer({
  toasts,
  removeToast,
}: {
  toasts: ToastItem[];
  removeToast: (id: string) => void;
}) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 left-0 z-[200] flex flex-col gap-2 pointer-events-none w-52 px-2">
      {toasts.map((t) => (
        <SingleToast key={t.id} toast={t} onRemove={() => removeToast(t.id)} />
      ))}
    </div>
  );
}
