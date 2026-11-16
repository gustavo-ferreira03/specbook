import { Clock3 } from "lucide-react";

import { Dot } from "@/components/dot";
import { countLabel, formatWaitDuration } from "@/lib/format";
import type { RunnerQueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

export const RunnerQueueNotice = function RunnerQueueNotice({
  queue,
  className,
}: {
  queue: RunnerQueueEntry | null | undefined;
  className?: string;
}) {
  if (!queue || queue.queued === 0) {
    return null;
  }
  return (
    <div
      className={cn("text-control text-ink flex items-start gap-2", className)}
    >
      <Clock3
        size={14}
        className="text-ink-subtle mt-0.5 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="break-words">
          {queue.reason ??
            (queue.executor === "tunnel"
              ? "Waiting for a tunnel to connect."
              : "Waiting for a runner to claim this run.")}
        </p>
        <p className="text-meta text-ink-muted mt-0.5 flex flex-wrap items-center gap-x-1.5">
          <span>{countLabel(queue.queued, "run")} waiting</span>
          <Dot />
          <span>
            Oldest wait{" "}
            <span className="tabular">
              {formatWaitDuration(queue.oldestWaitMs)}
            </span>
          </span>
        </p>
      </div>
    </div>
  );
};
