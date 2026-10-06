import fs from "node:fs/promises";
import path from "node:path";
import type { RunStatus } from "../../infra/db/schema";
import { projectsRepository } from "../../infra/repositories/projects";
import { runsRepository, type Run } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { runsDir } from "../paths";
import { repoGit } from "../repo/git";
import { markdownHashOf, sourceHashOf, specTestFile, specYamlFile } from "../repo/writer";
import { parseSpecYaml } from "../repo/yaml";
import { resolveSecretEnv } from "../credentials/profiles";
import { projectSecretScrubber } from "../credentials/scrub";
import { withSpecLock } from "../specs/lifecycle";
import { runPlaywrightSuite } from "./playwright";
import { stopActiveProcesses, withRunSlot } from "./process";
import { resolveSecretOriginPolicy } from "./secrets";
import { analyzeSpecSource, stepTitlesError, type SpecAnalysis } from "./validate";

export const RUN_TIMEOUT_MS = 120_000;
export const MAX_FAIL_REASON_CHARS = 2000;
export const MAX_FAILED_STEP_CHARS = 500;

type FinalRunStatus = Exclude<RunStatus, "running">;

/** Run as persisted plus details that only live in memory (not stored in the DB). */
export type ExecutedRun = Run & { failedStep: string | null };

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Re-validates a Spec's files right before running them: the index may be older than
 * the validator, and the file is executed, so it is never trusted on the index alone.
 */
export function analyzeForRun(title: string, testSource: string, markdown: string): SpecAnalysis {
    const analysis = analyzeSpecSource(testSource);
    if (!analysis.ok) throw new Error(`Spec "${title}" is invalid: ${analysis.error}`);
    const stepsError = stepTitlesError(analysis.analysis.steps, parseSpecYaml(markdown).humanSpec.steps);
    if (stepsError) throw new Error(`Spec "${title}" is invalid: ${stepsError}`);
    return analysis.analysis;
}

export class StaleRunError extends Error {}

interface RunOptions {
    persistFailures?: boolean;
    automate?: boolean;
    healOnFailure?: boolean;
    retryOf?: string;
    expected?: { sourceHash: string; markdownHash: string };
    baseUrl?: string;
    signal?: AbortSignal;
}

async function executeSpecLocked(specId: string, options: RunOptions): Promise<ExecutedRun> {
    options.signal?.throwIfAborted();
    const spec = await specsRepository.getSpec(specId);
    if (!spec) throw new Error("Spec not found");
    if (spec.status === "invalid") throw new Error(`Spec is invalid: ${spec.invalidReason ?? "unknown reason"}`);
    const project = await projectsRepository.getProject(spec.projectId);
    if (!project) throw new Error("Project not found");
    const snapshot = await repoGit.withRepoLock(spec.projectId, async () => {
        if (!(await repoGit.getProjectGit(spec.projectId).status()).isClean()) {
            throw new Error("The project repository has uncommitted changes; sync or commit them before running");
        }
        const [testSource, markdown, commitSha] = await Promise.all([
            fs.readFile(path.join(repoGit.getRepoDir(spec.projectId), specTestFile(spec.path)), "utf8"),
            fs.readFile(path.join(repoGit.getRepoDir(spec.projectId), specYamlFile(spec.path)), "utf8"),
            repoGit.getHeadSha(spec.projectId),
        ]);
        return { testSource, markdown, commitSha };
    });
    const { testSource, markdown, commitSha } = snapshot;
    const sourceHash = sourceHashOf(testSource);
    const markdownHash = markdownHashOf(markdown);
    if (sourceHash !== spec.sourceHash || markdownHash !== spec.markdownHash) {
        throw new Error("Spec files changed without being reindexed");
    }
    if (options.expected && (sourceHash !== options.expected.sourceHash || markdownHash !== options.expected.markdownHash)) {
        throw new StaleRunError("Spec changed after the failed run; retry skipped");
    }
    const analysis = analyzeForRun(spec.title, testSource, markdown);

    const refs = analysis.secretRefs.map((ref) => ref.envName);
    const { env: secretEnv, missing } = await resolveSecretEnv(spec.projectId, refs);
    if (missing.length > 0) {
        throw new Error(
            `Spec "${spec.title}" references credentials that are not configured: ${missing.join(", ")}. Add them in Settings » Credentials.`,
        );
    }
    const baseUrl = options.baseUrl ?? project.baseUrl;
    const secretOrigins = await resolveSecretOriginPolicy(spec.projectId, baseUrl, refs);
    const scrub = await projectSecretScrubber(spec.projectId);

    const run = await runsRepository.createRun({
        specId: spec.id, commitSha, sourceHash, automate: options.automate,
        healOnFailure: options.healOnFailure, retryOf: options.retryOf, baseUrl,
    });
    try {
        await repoGit.withRepoLock(spec.projectId, () => repoGit.pinRunCommitUnlocked(spec.projectId, run.id, commitSha));
    } catch (error) {
        await runsRepository.deleteRun(run.id);
        await repoGit.withRepoLock(spec.projectId, () => repoGit.deleteRunCommitRefsUnlocked(spec.projectId, [run.id])).catch(() => undefined);
        throw error;
    }
    let started = Date.now();
    let status: FinalRunStatus = "error";
    let failReason: string | null = "Run did not complete";
    let failedStep: string | null = null;
    let durationMs: number | null = null;
    const outputDir = path.join(runsDir, run.id);

    try {
        await fs.mkdir(outputDir, { recursive: true });
        await Promise.all([
            fs.writeFile(path.join(outputDir, "spec.ts"), testSource, "utf8"),
            fs.writeFile(path.join(outputDir, "spec.yml"), markdown, "utf8"),
        ]);
        const outcome = await withRunSlot(() => {
            started = Date.now();
            return runPlaywrightSuite({
                directory: outputDir,
                baseUrl,
                specs: [{ key: run.id, source: testSource, analysis, outputDir }],
                timeoutMs: RUN_TIMEOUT_MS,
                secretEnv,
                secretOrigins,
                scrub,
                signal: options.signal,
            });
        }, options.signal);
        const result = outcome.results.get(run.id);
        if (outcome.processFailure || !result) {
            failReason = outcome.processFailure ?? result?.failReason ?? "Playwright produced no result";
        } else {
            status = result.status;
            failReason = result.failReason;
            failedStep = result.failedStep === null ? null : scrub(result.failedStep).slice(0, MAX_FAILED_STEP_CHARS);
            durationMs = result.durationMs;
        }
    } catch (error) {
        status = "error";
        failReason = errorMessage(error);
    } finally {
        const cleanReason = failReason === null || status === "passed" ? null : scrub(failReason).slice(0, MAX_FAIL_REASON_CHARS);
        await runsRepository.finishRun(run.id, status, durationMs ?? Date.now() - started, cleanReason);
    }

    const stored = await runsRepository.getRun(run.id);
    if (!stored) throw new Error("Run disappeared");
    const finished: ExecutedRun = { ...stored, failedStep };
    if (options.persistFailures === false && finished.status !== "passed") {
        await fs.rm(outputDir, { recursive: true, force: true });
        await runsRepository.deleteRun(finished.id);
        await repoGit.withRepoLock(spec.projectId, () => repoGit.deleteRunCommitRefsUnlocked(spec.projectId, [finished.id]));
        return finished;
    }
    if (finished.status === "passed" || finished.status === "failed") {
        await specsRepository.updateSpecStatusForContent(spec.id, sourceHash, markdownHash, finished.status);
    }
    return finished;
}

export async function executeSpec(specId: string, options: RunOptions = {}): Promise<ExecutedRun> {
    options.signal?.throwIfAborted();
    return withSpecLock(specId, () => executeSpecLocked(specId, options));
}

export function stopActiveRunProcesses(): void {
    stopActiveProcesses();
}
