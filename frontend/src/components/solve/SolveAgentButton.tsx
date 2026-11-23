import { useApp } from "../AppShell";

interface SolveAgentButtonProps {
  disabled?: boolean;
  size?: "sm" | "md";
}

// Starts a cleanup plan from the briefing, or reopens the one in progress.
// The plan keeps running in the background if the user goes elsewhere, and
// the label says where it stands.
export default function SolveAgentButton({ disabled, size = "md" }: SolveAgentButtonProps) {
  const { agentSession, startSolveAgent, openAgentWorkspace } = useApp();
  const status = agentSession?.status;
  const working = status === "planning" || status === "executing";

  const label =
    status === "planning" ? "Planning" : status === "asking" ? "Answer a question" : status === "executing" ? "Running the plan" : status === "ready" ? "Review the plan" : "Plan a cleanup";

  const handleClick = () => {
    if (disabled) return;
    if (agentSession) openAgentWorkspace();
    else void startSolveAgent();
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      title={agentSession ? "Open the cleanup plan" : "Tabellar proposes replies, todos, meetings and archiving from this briefing. Nothing runs until you approve it."}
      className={`btn ${size === "sm" ? "btn-sm" : ""}`}
    >
      {label}
      {working && (
        <span className="solve-dot-wave inline-flex text-ink3" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      )}
    </button>
  );
}
