import fs from "node:fs/promises";
import path from "node:path";
import { runsRepository, type Run } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { logger } from "../../infra/logger";
import { runsDir } from "../paths";
import { markdownHashOf } from "../repo/writer";
import { executeSpec, StaleRunError } from "../runner/run";
import { recordFailureSignal } from "../steward/engine";

let processing = false;
let timer: ReturnType<typeof setInterval> | undefined;
const retryDelays = new Map<string, { attempts: number; retryAt: number }>();

async function failureContent(run: Run): Promise<{ sourceHash: string; markdownHash: string } | null> {
    const spec = await specsRepository.getSpec(run.specId);
    if (!spec || spec.sourceHash !== run.sourceHash) return null;
    const markdown = await fs.readFile(path.join(runsDir, run.id, "spec.yml"), "utf8").catch(() => null);
    if (markdown === null || markdownHashOf(markdown) !== spec.markdownHash) return null;
    return { sourceHash: run.sourceHash, markdownHash: spec.markdownHash };
}

export async function processRunFailures(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
        for (const run of await runsRepository.pendingAutomation()) {
            try {
                if (run.retryOf) {
                    const original = await runsRepository.getRun(run.retryOf);
                    if (!original?.automationPending) await runsRepository.acknowledgeAutomation(run.id);
                    continue;
                }
                if (run.status === "passed") {
                    retryDelays.delete(run.id);
                    await runsRepository.acknowledgeAutomation(run.id);
                    continue;
                }
                const expected = await failureContent(run);
                if (!expected) {
                    retryDelays.delete(run.id);
                    await runsRepository.acknowledgeAutomation(run.id);
                    continue;
                }
                let retry = await runsRepository.retryFor(run.id);
                if (!retry) {
                    if ((retryDelays.get(run.id)?.retryAt ?? 0) > Date.now()) continue;
                    try {
                        retry = await executeSpec(run.specId, {
                            automate: true, healOnFailure: false, retryOf: run.id, expected, baseUrl: run.baseUrl ?? undefined, environment: run.environment ?? undefined,
                        });
                    } catch (error) {
                        if (error instanceof StaleRunError) {
                            retryDelays.delete(run.id);
                            await runsRepository.acknowledgeAutomation(run.id);
                            continue;
                        }
                        logger.warn("failure retry could not start", { runId: run.id, error });
                        const attempts = (retryDelays.get(run.id)?.attempts ?? 0) + 1;
                        retryDelays.set(run.id, { attempts, retryAt: Date.now() + Math.min(15_000 * 2 ** (attempts - 1), 300_000) });
                        continue;
                    }
                }
                retryDelays.delete(run.id);
                if (retry.status === "running") continue;
                if (retry.status === "passed") {
                    await runsRepository.markFlaky(run.id, retry.id);
                } else if (run.healOnFailure && await failureContent(run)) {
                    const spec = await specsRepository.getSpec(run.specId);
                    if (spec) await recordFailureSignal(spec.projectId, retry.id, spec.id, spec.title, run.id);
                }
                await runsRepository.acknowledgeAutomation(retry.id);
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
