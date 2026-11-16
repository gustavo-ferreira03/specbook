import { Skeleton } from "@/components/ui/skeleton";

const Loading = function Loading() {
  return (
    /* oxlint-disable jsx-a11y/prefer-tag-over-role -- Alert forwards live-region semantics to its shared native wrapper; preserve the component structure. */
    <main
      className="bg-surface min-h-dvh px-4 py-8"
      role="status"
      aria-label="Loading page"
      aria-busy="true"
    >
      <div className="max-w-reading mx-auto space-y-6">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    </main>
    /* oxlint-enable jsx-a11y/prefer-tag-over-role */
  );
};
export default Loading;
