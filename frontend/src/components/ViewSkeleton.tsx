import { SkeletonRows } from "./ui";

// Shown while a view's code loads: the bar and rows where they will be.
export default function ViewSkeleton() {
  return (
    <>
      <div className="bar">
        <span className="skel h-3 w-24" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden pt-2">
        <SkeletonRows count={16} />
      </div>
    </>
  );
}
