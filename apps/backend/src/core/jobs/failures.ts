import { runsRepository } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { logger } from "../../infra/logger";
import { recordFailureSignal } from "../steward/engine";

let processing = false;
let timer: ReturnType<typeof setInterval> | undefined;

export async function processRunFailures(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
        for (const run of await runsRepository.pendingAutomation()) {
            try {
                const spec = await specsRepository.getSpec(run.specId);
                if (spec && (run.status === "failed" || run.status === "error")) {
                    await recordFailureSignal(spec.projectId, run.id, spec.id, spec.title);
                }
                await runsRepository.acknowledgeAutomation(run.id);
            } catch (error) {
                logger.warn("failure triage could not start", { runId: run.id, error });
            }
        }
    } finally {
        processing = false;
    }
}

export function startFailureMonitor(): void {
    timer = setInterval(() => void processRunFailures().catch((error) => logger.error("failure monitor failed", { error })), 2000);
    timer.unref();
    void processRunFailures();
}

export function stopFailureMonitor(): void {
    clearInterval(timer);
}
