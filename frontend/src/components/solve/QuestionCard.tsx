
import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import type { AgentQuestion, QuestionOption } from "@/lib/agentTypes";

export interface QuestionAnswer {
  option_id?: string;
  custom_text?: string;
  skip?: boolean;
  not_sure?: boolean;
}

interface QuestionCardProps {
  question: AgentQuestion;
  /**
   * Standalone mode (default): the card manages its own submit button and
   * calls onAnswer once the user is ready.
   *
   * Batched mode: the card lets a parent collect answers across multiple
   * questions via onChange. Parent owns the submit button.
   */
  onAnswer?: (answer: QuestionAnswer) => Promise<void> | void;
  onChange?: (answer: QuestionAnswer | null) => void;
  /** Pre-fill selection/custom text from a parent-controlled batch. */
  initialAnswer?: QuestionAnswer;
  /** In batched mode, hide the inline Continue button. */
  hideContinue?: boolean;
  disabled?: boolean;
  compact?: boolean;
}

/**
 * Immersive decision card. The agent calls ask_user and surfaces a brief,
 * a question, 2-4 concrete options each with its own preview/rationale, plus
 * a custom input. The user picks one and we return control to the agent.
 * The option flagged `recommended` is pre-selected and badge-highlighted.
 */
export default function QuestionCard({
  question,
  onAnswer,
  onChange,
  initialAnswer,
  hideContinue,
  disabled,
  compact,
}: QuestionCardProps) {
  const recommended = question.options.find((o) => o.recommended);
  const [custom, setCustom] = useState(initialAnswer?.custom_text ?? "");
  const [selected, setSelected] = useState<string | null>(
    initialAnswer?.option_id ?? recommended?.id ?? null,
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setCustom(initialAnswer?.custom_text ?? "");
    setSelected(
      initialAnswer?.option_id ??
        question.options.find((o) => o.recommended)?.id ??
        null,
    );
    // Intentionally depend on question.id and the initialAnswer id/text only
    // so parent re-renders don't stomp user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id]);

  useEffect(() => {
    if (!onChange) return;
    if (custom.trim()) {
      onChange({ custom_text: custom.trim() });
    } else if (selected) {
      onChange({ option_id: selected });
    } else {
      onChange(null);
    }
  }, [custom, selected, onChange]);

  const submit = async (args: QuestionAnswer) => {
    if (!onAnswer || submitting || disabled) return;
    setSubmitting(true);
    try {
      await onAnswer(args);
    } finally {
      setSubmitting(false);
    }
  };

  const padding = compact ? "p-4" : "p-5";
  const questionSize = compact ? "text-[14.5px]" : "text-[16.5px]";

  return (
    <div
      className={`solve-fade-in rounded-2xl border border-line bg-raised ${padding} ${compact ? "" : "shadow-[0_2px_16px_-8px_rgba(5,150,105,0.22)]"}`}
      role="dialog"
      aria-label={question.question}
    >
      {question.eyebrow && (
        <div className="mb-2 flex items-center gap-2">
          <Icon name="help" size={14} className="text-ok" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ok">
            {question.eyebrow}
          </span>
          {question.bucket && question.bucket !== "single" && (
            <span className="rounded-full bg-field px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink3">
              {question.bucket}
            </span>
          )}
        </div>
      )}
      <h3
        className={`${questionSize} font-semibold leading-snug text-ink`}
      >
        {question.question}
      </h3>
      {question.brief && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink3">
          {question.brief}
        </p>
      )}

      <div className="mt-3.5 grid gap-1.5">
        {question.options.map((opt: QuestionOption) => {
          const active = selected === opt.id;
          const isRec = !!opt.recommended;
          return (
            <button
              key={opt.id}
              onClick={() => setSelected(opt.id)}
              disabled={submitting || disabled}
              className={`group cursor-pointer text-left rounded-xl border px-3 py-2.5 transition-colors duration-150 ${
                active
                  ? "border-ok/80 bg-ok-soft"
                  : "border-line bg-field/50 hover:border-ok-line hover:bg-ok-soft"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <div
                  className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 transition-colors ${
                    active
                      ? "border-ok bg-ok"
                      : "border-line bg-transparent group-hover:border-ok-line"
                  }`}
                >
                  {active && (
                    <div className="h-full w-full rounded-full border-2 border-white" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium text-ink">
                      {opt.label}
                    </span>
                    {isRec && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ok">
                        <Icon name="auto_awesome" size={10} />
                        Recommended
                      </span>
                    )}
                    {opt.no_reply && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warn">
                        <Icon name="done_all" size={10} />
                        No email
                      </span>
                    )}
                  </div>
                  {opt.rationale && (
                    <p className="mt-0.5 text-[11.5px] leading-snug text-ink3">
                      {opt.rationale}
                    </p>
                  )}
                  {opt.preview && (
                    <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-md border border-dashed border-line bg-canvas/60 px-2 py-1 text-[11px] font-mono leading-snug text-ink3">
                      {opt.preview}
                    </pre>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {question.allow_custom && (
        <div className="mt-3">
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-ink3">
            Or tell the agent exactly what to do
          </label>
          <textarea
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            disabled={submitting || disabled}
            placeholder="e.g. Reply saying I'll confirm by Thursday..."
            rows={2}
            className="w-full resize-none rounded-xl border border-line bg-field px-3 py-2 text-[12.5px] text-ink placeholder:text-ink3 focus:border-ok-line focus:outline-none focus:ring-2 focus:ring-ok-line"
          />
        </div>
      )}

      {/* Standalone mode renders its own action row. Batched mode delegates. */}
      {onAnswer && !hideContinue && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => submit({ not_sure: true })}
              disabled={submitting || disabled}
              className="cursor-pointer rounded-full border border-line px-3 py-1.5 text-[11.5px] text-ink3 transition-colors hover:border-ink hover:text-ink disabled:opacity-40"
            >
              I&apos;m not sure, you choose
            </button>
            <button
              onClick={() => submit({ skip: true })}
              disabled={submitting || disabled}
              className="cursor-pointer rounded-full border border-line px-3 py-1.5 text-[11.5px] text-ink3 transition-colors hover:border-ink hover:text-ink disabled:opacity-40"
            >
              Skip
            </button>
          </div>
          <button
            onClick={() => {
              if (custom.trim()) return submit({ custom_text: custom.trim() });
              if (selected) return submit({ option_id: selected });
            }}
            disabled={submitting || disabled || (!selected && !custom.trim())}
            className="group cursor-pointer inline-flex items-center gap-1.5 rounded-full bg-ok hover:bg-ok px-4 py-1.5 text-[12px] font-semibold text-white transition-colors disabled:opacity-40"
          >
            <Icon name={submitting ? "hourglass_empty" : "arrow_forward"} size={14} />
            {submitting ? "Sending..." : "Continue"}
          </button>
        </div>
      )}
    </div>
  );
}
