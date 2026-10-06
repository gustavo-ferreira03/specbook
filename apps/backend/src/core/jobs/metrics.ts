import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Job } from "../../infra/repositories/jobs";
import { logger } from "../../infra/logger";
import { storageRoot } from "../paths";
import { withFileQueue } from "../operations/file-queue";

export const jobMetricsPath = path.join(storageRoot, "metrics", "agent-events.jsonl");

export interface AgentMetricDetails {
    itemId?: string;
    itemKind?: string;
    decision?: string;
    actor?: "human" | "agent";
    verificationStatus?: string;
}

let writes: Promise<void> = Promise.resolve();

/** Evaluation identifiers and outcomes only; never prompts, errors, URLs or credentials. */
export async function recordAgentMetric(job: Job, event: string, details: AgentMetricDetails = {}): Promise<void> {
    const record = {
        schemaVersion: 1, eventId: crypto.randomUUID(), at: new Date().toISOString(), event,
        projectId: job.projectId, jobId: job.id, chatId: job.chatId, specId: job.specId, runId: job.runId,
        trigger: job.trigger, kind: job.kind, status: job.status, classification: job.classification,
        tokensUsed: job.tokensUsed, actionsUsed: job.actionsUsed, elapsedMs: job.elapsedMs,
        ...details,
    };
    const write = writes.then(() => withFileQueue(jobMetricsPath, async () => {
        await fs.mkdir(path.dirname(jobMetricsPath), { recursive: true });
        await fs.appendFile(jobMetricsPath, `${JSON.stringify(record)}\n`, "utf8");
    }));
    writes = write.catch((error) => logger.warn("agent evaluation metric could not be written", { error }));
    await writes;
}
