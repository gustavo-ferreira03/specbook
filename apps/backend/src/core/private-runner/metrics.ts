import { z } from "zod";
import type { RunnerQueueEntry } from "@specbook/runtime/runner-protocol";

export const runnerMetricsQuerySchema = z.object({
    format: z.enum(["json", "prometheus"]).default("json"),
    group: z.string().max(80).optional(),
}).strict();

export const runnerMetricsSchema = z.object({
    groups: z.array(z.object({ group: z.string().nullable(), queued: z.number().int().nonnegative(),
        oldestWaitSeconds: z.number().nonnegative() }).strict()),
}).strict();
export const runnerMetricsJsonSchema = z.toJSONSchema(runnerMetricsSchema);

export function queueMetrics(queues: RunnerQueueEntry[]) {
    const groups = new Map<string | null, { group: string | null; queued: number; oldestWaitSeconds: number }>();
    for (const queue of queues) {
        if (queue.executor !== "runner") continue;
        const value = groups.get(queue.group) ?? { group: queue.group, queued: 0, oldestWaitSeconds: 0 };
        value.queued += queue.queued;
        value.oldestWaitSeconds = Math.max(value.oldestWaitSeconds, queue.oldestWaitMs / 1000);
        groups.set(queue.group, value);
    }
    return runnerMetricsSchema.parse({ groups: [...groups.values()].sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "")) });
}

export function prometheusQueueMetrics(metrics: z.infer<typeof runnerMetricsSchema>): string {
    const label = (value: string | null) => (value ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
    return [
        "# HELP specbook_runner_queue_depth Number of Specs waiting for a runner.",
        "# TYPE specbook_runner_queue_depth gauge",
        ...metrics.groups.map((value) => `specbook_runner_queue_depth{runner_group="${label(value.group)}"} ${value.queued}`),
        "# HELP specbook_runner_oldest_wait_seconds Age of the oldest queued run in seconds.",
        "# TYPE specbook_runner_oldest_wait_seconds gauge",
        ...metrics.groups.map((value) => `specbook_runner_oldest_wait_seconds{runner_group="${label(value.group)}"} ${value.oldestWaitSeconds}`),
        "",
    ].join("\n");
}
