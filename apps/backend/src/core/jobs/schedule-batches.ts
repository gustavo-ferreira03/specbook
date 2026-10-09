import { projectsRepository } from "../../infra/repositories/projects";
import { schedulesRepository, type ProjectAutomation } from "../../infra/repositories/schedules";
import { projectSecretScrubber } from "../credentials/scrub";
import type { RunBatch } from "../runner/batch";

export async function recordBatch(automation: ProjectAutomation, batch: RunBatch): Promise<void> {
    let notification: { webhookUrl: string; payload: Record<string, unknown> } | null = null;
    if (automation.webhookUrl) {
        const project = await projectsRepository.getProject(automation.projectId);
        if (!project) return;
        const scrub = await projectSecretScrubber(project.id);
        const name = scrub(project.name).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        notification = { webhookUrl: automation.webhookUrl, payload: {
            text: `Specbook: ${name} — scheduled run ${batch.status} (${batch.specs.length} Specs)`,
            event: "run_batch.status_changed", eventId: `${batch.id}:${batch.status}`,
            projectId: project.id, batchId: batch.id, status: batch.status, total: batch.specs.length,
            passed: batch.specs.filter((spec) => spec.status === "passed").length,
            failed: batch.specs.filter((spec) => spec.status === "failed").length,
            errors: batch.specs.filter((spec) => spec.status === "error").length,
        } };
    }
    await schedulesRepository.recordBatch(automation.projectId, batch.id, batch.status, notification);
}

export async function recordScheduledBatch(batch: RunBatch): Promise<void> {
    const automation = await schedulesRepository.get(batch.projectId);
    if (automation) await recordBatch(automation, batch);
}

