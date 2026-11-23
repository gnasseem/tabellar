import { Component, type ReactNode } from "react";
import Icon from "@/components/Icon";

type Props = {
  children: ReactNode;
  viewName: string;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

// The view ids as the sidebar names them.
const NAMES: Record<string, string> = {
  inbox: "Inbox",
  replies: "Replies",
  drafts: "Replies",
  todos: "Todos",
  meetings: "Meetings",
  followups: "Follow-ups",
  newsletters: "Newsletters",
  briefing: "Briefing",
  activity: "Activity",
  sent: "Sent",
  scheduled: "Scheduled",
  categories: "Labels",
  relationships: "Knowledge",
  settings: "Settings",
};

export default class ViewErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[${this.props.viewName}] View error:`, error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    // Moving to another view clears the error.
    if (prevProps.viewName !== this.props.viewName && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    const name = NAMES[this.props.viewName] ?? "This page";
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="empty">
          <Icon name="error" size={22} className="text-ink3" />
          <h3>{name} could not be shown</h3>
          <p>Your mail and everything Tabellar did with it are untouched.</p>
          {this.state.error && <p className="max-w-full truncate font-mono !text-xs !text-danger">{this.state.error.message}</p>}
          <div className="mt-4 flex gap-2">
            <button className="btn btn-pri" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button className="btn" onClick={() => this.setState({ hasError: false, error: null })}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
