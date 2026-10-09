import { CodedError } from "../errors";
import type { RunEnvironment } from "../../infra/db/schema";
import type { Run } from "../../infra/repositories/runs";
import { parseSpecYaml } from "../repo/yaml";
import { analyzeSpecSource, stepTitlesError, type SpecAnalysis } from "./validate";

export const RUN_TIMEOUT_MS = 120_000;
export const MAX_FAIL_REASON_CHARS = 2000;
export const MAX_FAILED_STEP_CHARS = 500;

export type ExecutedRun = Run & { failedStep: string | null };

export function analyzeForRun(title: string, testSource: string, markdown: string): SpecAnalysis {
    const analysis = analyzeSpecSource(testSource);
    if (!analysis.ok) throw new CodedError("invalid_spec", `Spec "${title}" is invalid: ${analysis.error}`);
    const stepsError = stepTitlesError(analysis.analysis.steps, parseSpecYaml(markdown).humanSpec.steps);
    if (stepsError) throw new CodedError("invalid_spec", `Spec "${title}" is invalid: ${stepsError}`);
    return analysis.analysis;
}

export class StaleRunError extends Error {}

export interface RunOptions {
    persistFailures?: boolean;
    automate?: boolean;
    healOnFailure?: boolean;
    retryOf?: string;
    expected?: { sourceHash: string; markdownHash: string };
    baseUrl?: string;
    environment?: string | RunEnvironment;
    signal?: AbortSignal;
}
