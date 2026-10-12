import { Clock3 } from "lucide-react";
import { Dot } from "@/components/Dot";
import { countLabel, formatWaitDuration } from "@/lib/format";
import type { RunnerQueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

export function RunnerQueueNotice({ queue, className }: { queue: RunnerQueueEntry | null | undefined; className?: string }) {
    if (!queue || queue.queued === 0) return null;
    return <div className={cn("flex items-start gap-2 text-control text-ink", className)}>
        <Clock3 size={14} className="mt-0.5 shrink-0 text-ink-subtle" aria-hidden="true" />
        <div className="min-w-0">
            <p className="break-words">{queue.reason ?? (queue.executor === "tunnel" ? "Waiting for a tunnel to connect." : "Waiting for a runner to claim this run.")}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-meta text-ink-muted"><span>{countLabel(queue.queued, "run")} waiting</span><Dot /><span>Oldest wait <span className="tabular">{formatWaitDuration(queue.oldestWaitMs)}</span></span></p>
        </div>
    </div>;
}
