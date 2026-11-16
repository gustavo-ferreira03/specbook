import { stopActiveProcesses } from "@specbook/runtime/process";

import { executeSingleSpecBatch } from "./batch";
import type { ExecutedRun, RunOptions } from "./execution";

export const executeSpec = async function executeSpec(
  specId: string,
  options: RunOptions = {}
): Promise<ExecutedRun> {
  options.signal?.throwIfAborted();
  return await executeSingleSpecBatch(specId, options);
};

export const stopActiveRunProcesses = function stopActiveRunProcesses(): void {
  stopActiveProcesses();
};

export {
  analyzeForRun,
  MAX_FAIL_REASON_CHARS,
  MAX_FAILED_STEP_CHARS,
  RUN_TIMEOUT_MS,
  StaleRunError,
} from "./execution";
export type { ExecutedRun } from "./execution";
