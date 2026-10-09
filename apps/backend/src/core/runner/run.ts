import { withSpecLock } from "../specs/lifecycle";
import { executeSingleSpecBatch } from "./batch";
import type { ExecutedRun, RunOptions } from "./execution";
import { stopActiveProcesses } from "./process";

export { analyzeForRun, MAX_FAIL_REASON_CHARS, MAX_FAILED_STEP_CHARS, RUN_TIMEOUT_MS, StaleRunError } from "./execution";
export type { ExecutedRun } from "./execution";

export async function executeSpec(specId: string, options: RunOptions = {}): Promise<ExecutedRun> {
    options.signal?.throwIfAborted();
    return withSpecLock(specId, () => executeSingleSpecBatch(specId, options));
}

export function stopActiveRunProcesses(): void {
    stopActiveProcesses();
}
