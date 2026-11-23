import { useEffect, useState } from "react";
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
   * Standalone mode (default): the question has its own Continue button and
   * calls onAnswer once the user is ready.
   *
   * Batched mode: a parent collects answers across several questions through
   * onChange and owns the Continue button.
   */
  onAnswer?: (answer: QuestionAnswer) => Promise<void> | void;
  onChange?: (answer: QuestionAnswer | null) => void;
  /** Pre-fill the choice or custom text from a parent-controlled batch. */
  initialAnswer?: QuestionAnswer;
  /** In batched mode, hide the Continue row. */
  hideContinue?: boolean;
  disabled?: boolean;
  compact?: boolean;
}

// A question the plan cannot settle on its own: the question in plain text,
// each answer as a button with why it might be right, and room to say
// something else. The suggested answer starts chosen.
export default function QuestionCard({ question, onAnswer, onChange, initialAnswer, hideContinue, disabled, compact }: QuestionCardProps) {
  const recommended = question.options.find((o) => o.recommended);
  const [custom, setCustom] = useState(initialAnswer?.custom_text ?? "");
  const [selected, setSelected] = useState<string | null>(initialAnswer?.option_id ?? recommended?.id ?? null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setCustom(initialAnswer?.custom_text ?? "");
    setSelected(initialAnswer?.option_id ?? question.options.find((o) => o.recommended)?.id ?? null);
    // Depends on question.id only, so a parent re-render does not undo what
    // the user typed or chose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id]);

  useEffect(() => {
    if (!onChange) return;
    if (custom.trim()) onChange({ custom_text: custom.trim() });
    else if (selected) onChange({ option_id: selected });
    else onChange(null);
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

  const off = submitting || disabled;

  return (
    <div className={compact ? "border-b border-line-soft py-4 last:border-0" : "py-1"} role="group" aria-label={question.question}>
      <h3 className="text-[15px] font-[650] leading-snug tracking-[-0.01em] text-ink">{question.question}</h3>
      {question.brief && <p className="mt-1 max-w-[68ch] leading-normal text-ink2">{question.brief}</p>}

      <div className="mt-3 grid gap-2.5">
        {question.options.map((opt: QuestionOption) => {
          const active = selected === opt.id;
          return (
            <div key={opt.id}>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <button
                  type="button"
                  aria-pressed={active}
                  disabled={off}
                  onClick={() => setSelected(opt.id)}
                  className={`btn !h-auto min-h-7 max-w-full !whitespace-normal py-1 text-left ${active ? "!bg-sel" : ""}`}
                >
                  {opt.label}
                </button>
                {(opt.recommended || opt.no_reply) && <span className="text-xs text-ink3">{[opt.recommended ? "Suggested" : "", opt.no_reply ? "No email is sent" : ""].filter(Boolean).join(", ")}</span>}
              </div>
              {opt.rationale && <p className="mt-1 max-w-[68ch] text-[12.5px] leading-snug text-ink3">{opt.rationale}</p>}
              {opt.preview && active && <pre className="inset mt-1.5 max-w-[68ch] whitespace-pre-wrap break-words font-sans text-[13px] leading-normal text-ink2">{opt.preview}</pre>}
            </div>
          );
        })}
      </div>

      {question.allow_custom && (
        <label className="mt-3.5 block max-w-[68ch]">
          <span className="label mb-1 block">Or say what to do instead</span>
          <textarea
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            disabled={off}
            placeholder="For example: reply that I will confirm by Thursday"
            rows={2}
            className="input resize-none"
          />
        </label>
      )}

      {/* Standalone mode has its own action row; batched mode leaves it to the parent. */}
      {onAnswer && !hideContinue && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            className="btn btn-pri"
            disabled={off || (!selected && !custom.trim())}
            onClick={() => {
              if (custom.trim()) return submit({ custom_text: custom.trim() });
              if (selected) return submit({ option_id: selected });
            }}
          >
            {submitting ? "Sending" : "Continue"}
          </button>
          <button className="btn" disabled={off} onClick={() => submit({ not_sure: true })}>
            Not sure, you choose
          </button>
          <button className="btn btn-plain" disabled={off} onClick={() => submit({ skip: true })}>
            Skip
          </button>
        </div>
      )}
    </div>
  );
}
