
import { lazy, Suspense } from "react";
import { useApp } from "./AppShell";
import ViewErrorBoundary from "./ViewErrorBoundary";
import ViewSkeleton from "./ViewSkeleton";

const InboxView = lazy(() => import("./views/InboxView"));
const SentView = lazy(() => import("./views/SentView"));
const RepliesView = lazy(() => import("./views/RepliesView"));
const ScheduledView = lazy(() => import("./views/ScheduledView"));
const TodosView = lazy(() => import("./views/TodosView"));
const MeetingsView = lazy(() => import("./views/MeetingsView"));
const LabelsView = lazy(() => import("./views/LabelsView"));
const BriefingView = lazy(() => import("./views/BriefingView"));
const SettingsView = lazy(() => import("./views/SettingsView"));
const RelationshipsView = lazy(() => import("./views/RelationshipsView"));
const FollowupsView = lazy(() => import("./views/FollowupsView"));
const HistoryView = lazy(() => import("./views/HistoryView"));
const NewslettersView = lazy(() => import("./views/NewslettersView"));
const AskView = lazy(() => import("./views/AskView"));

const views: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  inbox: InboxView,
  sent: SentView,
  replies: RepliesView,
  drafts: RepliesView,
  scheduled: ScheduledView,
  todos: TodosView,
  meetings: MeetingsView,
  labels: LabelsView,
  briefing: BriefingView,
  settings: SettingsView,
  relationships: RelationshipsView,
  followups: FollowupsView,
  history: HistoryView,
  newsletters: NewslettersView,
  ask: AskView,
};

export default function EmailDashboard() {
  const { view } = useApp();
  const View = views[view] || InboxView;
  return (
    <ViewErrorBoundary viewName={view}>
      <Suspense fallback={<ViewSkeleton />}>
        <View />
      </Suspense>
    </ViewErrorBoundary>
  );
}
