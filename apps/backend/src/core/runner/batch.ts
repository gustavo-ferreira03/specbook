import { CodedError, errorCodeOf, type ErrorCode } from "../errors";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { resolveRunEnvironment } from "../environments";
import type { RunEnvironment, RunStatus } from "../../infra/db/schema";
import { runsRepository, type Run } from "../../infra/repositories/runs";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { projectsRepository } from "../../infra/repositories/projects";
import { runBatchesDir, runsDir } from "../paths";
import { repoGit } from "../repo/git";
import { prepareRunRepositoryUnlocked } from "../repo/recovery";
import { markdownHashOf, sourceHashOf, specTestFile, specYamlFile } from "../repo/writer";
import { resolveSecretEnv } from "../credentials/profiles";
import { projectSecretScrubber } from "../credentials/scrub";
import { acquireSpecLocks, ResourceBusyError } from "../specs/lifecycle";
import { runPlaywrightSuite } from "./playwright";
import { withRunSlot } from "./process";
import { analyzeForRun, MAX_FAIL_REASON_CHARS, MAX_FAILED_STEP_CHARS, RUN_TIMEOUT_MS, StaleRunError, type ExecutedRun, type RunOptions } from "./execution";
import { resolveSecretOriginPolicy, type SecretOriginPolicy } from "./secrets";
import type { SpecAnalysis } from "./validate";

type FinalRunStatus = Exclude<RunStatus, "running">;
export type RunBatchTrigger = "deploy" | "ci" | "schedule" | "manual" | "spec_change";

export interface RunBatchItem {
    runId: string;
    specId: string;
    commitSha: string;
    sourceHash: string;
    markdownHash: string;
    title: string;
    status: RunStatus;
    durationMs: number | null;
    failReason: string | null;
}

export interface CiBatchMetadata {
    commitSha?: string;
    ref?: string;
    buildUrl?: string;
    qualityGate: { failOnFlaky: boolean; failOnKnownBugs: boolean };
    knownBugSpecIds: string[];
}

export interface RunBatch {
    id: string;
    projectId: string;
    label: string;
    trigger?: RunBatchTrigger;
    baseUrl?: string;
    environment?: RunEnvironment;
    ci?: CiBatchMetadata;
    status: RunStatus;
    startedAt: string;
    durationMs: number | null;
    failReason: string | null;
    specs: RunBatchItem[];
}

interface PreparedSpec {
    run: Run;
    projectId: string;
    markdown: string;
    testSource: string;
    analysis: SpecAnalysis;
    item: RunBatchItem;
    finished?: ExecutedRun;
}

interface BatchSecrets {
    env: Record<string, string>;
    origins: SecretOriginPolicy;
    scrub: (text: string) => string;
}

const MAX_BATCH_TIMEOUT_MS = 30 * 60 * 1000;
const activeBatches = new Map<string, Promise<void>>();
const MAX_CACHED_BATCHES = 300;
const batchIndex = new Map<string, Map<string, { startedAt: string; ci: boolean }>>();
const indexedBatchIds = new Map<string, string>();

function indexBatch(batch: RunBatch): void {
    const previousProject = indexedBatchIds.get(batch.id);
    if (previousProject && previousProject !== batch.projectId) {
        const previous = batchIndex.get(previousProject);
        previous?.delete(batch.id);
        if (!previous?.size) batchIndex.delete(previousProject);
    }
    let project = batchIndex.get(batch.projectId);
    if (!project) { project = new Map(); batchIndex.set(batch.projectId, project); }
    project.set(batch.id, { startedAt: batch.startedAt, ci: Boolean(batch.ci) });
    indexedBatchIds.delete(batch.id);
    indexedBatchIds.set(batch.id, batch.projectId);
    while (indexedBatchIds.size > MAX_CACHED_BATCHES) {
        const [id, projectId] = indexedBatchIds.entries().next().value!;
        indexedBatchIds.delete(id);
        const entries = batchIndex.get(projectId)!;
        entries.delete(id);
        if (!entries.size) batchIndex.delete(projectId);
    }
}

async function ensureBatchIndex(projectId: string): Promise<Map<string, { startedAt: string; ci: boolean }>> {
    const entries = await fs.readdir(runBatchesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    const project = new Map<string, { startedAt: string; ci: boolean }>();
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        let indexedProject = indexedBatchIds.get(entry.name);
        let metadata = indexedProject ? batchIndex.get(indexedProject)?.get(entry.name) : undefined;
        if (!metadata) {
            const batch = await getRunBatch(entry.name);
            if (!batch) continue;
            indexedProject = batch.projectId;
            metadata = { startedAt: batch.startedAt, ci: Boolean(batch.ci) };
        } else {
            indexedBatchIds.delete(entry.name);
            indexedBatchIds.set(entry.name, indexedProject!);
        }
        if (indexedProject === projectId) project.set(entry.name, metadata);
    }
    return project;
}

function batchDirectory(id: string): string {
    const root = path.resolve(runBatchesDir);
    const directory = path.resolve(root, id);
    if (path.dirname(directory) !== root) throw new Error("Invalid run batch id");
    return directory;
}

async function writeBatch(batch: RunBatch): Promise<void> {
    const directory = batchDirectory(batch.id);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, "batch.json");
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(batch), "utf8");
    await fs.rename(temporary, target);
    indexBatch(batch);
}

export async function getRunBatch(id: string): Promise<RunBatch | null> {
    try {
        const batch = JSON.parse(await fs.readFile(path.join(batchDirectory(id), "batch.json"), "utf8")) as RunBatch;
        indexBatch(batch);
        return batch;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export function getRunBatchDirectory(id: string): string {
    return batchDirectory(id);
}

async function finishPreparedSpec(
    batchId: string,
    prepared: PreparedSpec,
    outcome: { status: FinalRunStatus; durationMs: number | null; failReason: string | null; errorCode?: ErrorCode | null },
    scrub: (text: string) => string,
    options?: RunOptions,
    failedStep: string | null = null,
): Promise<void> {
    const result = {
        ...outcome,
        failReason: outcome.failReason === null || options && outcome.status === "passed" ? null : scrub(outcome.failReason).slice(0, MAX_FAIL_REASON_CHARS),
    };
    const runDir = path.join(runsDir, prepared.run.id);
    try {
        await fs.mkdir(runDir, { recursive: true });
        if (!options) await fs.writeFile(path.join(runDir, "batch.json"), JSON.stringify({ batchId }), "utf8");
        if (!(await fs.stat(path.join(runDir, "evidence.json")).catch(() => null))) {
            await fs.writeFile(path.join(runDir, "evidence.json"), JSON.stringify({ steps: [], video: null, failedStep: null }), "utf8");
        }
    } catch (error) {
        if (!options) throw error;
    }
    await runsRepository.finishRun(prepared.run.id, result.status, result.durationMs, result.failReason, result.errorCode ?? (result.status === "passed" ? null : "infrastructure"));
    if (options) {
        const stored = await runsRepository.getRun(prepared.run.id);
        if (!stored) throw new Error("Run disappeared");
        prepared.finished = { ...stored, failedStep: failedStep === null ? null : scrub(failedStep).slice(0, MAX_FAILED_STEP_CHARS) };
        if (options.persistFailures === false && stored.status !== "passed") {
            await fs.rm(runDir, { recursive: true, force: true });
            await runsRepository.deleteRun(stored.id);
            await repoGit.withRepoLock(prepared.projectId, () => repoGit.deleteRunCommitRefsUnlocked(prepared.projectId, [stored.id]));
        }
    }
    if ((options?.persistFailures !== false || result.status === "passed") && (result.status === "passed" || result.status === "failed")) {
        await specsRepository.updateSpecStatusForContent(
            prepared.item.specId,
            prepared.item.sourceHash,
            prepared.item.markdownHash,
            result.status,
        );
    }
    prepared.item.status = result.status;
    prepared.item.durationMs = result.durationMs;
    prepared.item.failReason = result.failReason;
}

async function executeBatch(
    batch: RunBatch,
    prepared: PreparedSpec[],
    baseUrl: string,
    secrets: BatchSecrets,
    options?: RunOptions,
): Promise<void> {
    let started = Date.now();
    const directory = options ? path.join(runsDir, prepared[0].run.id) : batchDirectory(batch.id);
    const results = new Map<string, { status: FinalRunStatus; durationMs: number | null; failReason: string | null; failedStep: string | null; errorCode?: ErrorCode | null }>();
    let processFailure: string | null = null;
    try {
        await fs.mkdir(directory, { recursive: true });
        for (const entry of prepared) {
            await fs.mkdir(path.join(runsDir, entry.run.id), { recursive: true });
            await Promise.all([
                fs.writeFile(path.join(runsDir, entry.run.id, "spec.ts"), entry.testSource, "utf8"),
                fs.writeFile(path.join(runsDir, entry.run.id, "spec.yml"), entry.markdown, "utf8"),
            ]);
        }
        const timeout = Math.min(MAX_BATCH_TIMEOUT_MS, Math.max(RUN_TIMEOUT_MS, prepared.length * RUN_TIMEOUT_MS));
        const outcome = await withRunSlot(() => {
            started = Date.now();
            return runPlaywrightSuite({
                projectId: batch.projectId,
                directory,
                baseUrl,
                environment: batch.environment,
                specs: prepared.map((entry) => ({ key: entry.run.id, source: entry.testSource, analysis: entry.analysis, outputDir: path.join(runsDir, entry.run.id) })),
                timeoutMs: timeout,
                secretEnv: secrets.env,
                secretOrigins: secrets.origins,
                scrub: secrets.scrub,
                signal: options?.signal,
            });
        }, options?.signal);
        processFailure = outcome.processFailure;
        for (const entry of prepared) {
            const result = outcome.results.get(entry.run.id);
            if (result && (options ? !processFailure : result.status !== "error")) {
                results.set(entry.run.id, result);
            } else {
                results.set(entry.run.id, {
                    status: "error", durationMs: null, failedStep: null, errorCode: "infrastructure",
                    failReason: options
                        ? processFailure ?? "Playwright produced no result"
                        : result?.failReason ?? processFailure ?? "Playwright produced no result for this Spec",
                });
            }
        }
    } catch (error) {
        processFailure = error instanceof Error ? error.message : String(error);
        for (const entry of prepared) results.set(entry.run.id, { status: "error", durationMs: null, failReason: processFailure, failedStep: null, errorCode: options?.signal?.aborted ? "cancelled" : errorCodeOf(error) ?? "infrastructure" });
    }
    try {
        for (const entry of prepared) {
            const result = results.get(entry.run.id)!;
            await finishPreparedSpec(batch.id, entry, { ...result, durationMs: options ? result.durationMs ?? Date.now() - started : result.durationMs }, secrets.scrub, options, result.failedStep);
        }
        batch.status = processFailure ? "error" : prepared.some((entry) => entry.item.status === "failed" || entry.item.status === "error") ? "failed" : "passed";
        batch.failReason = processFailure;
    } catch (error) {
        if (options) throw error;
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of prepared) {
            if (entry.item.status !== "running") continue;
            await finishPreparedSpec(batch.id, entry, { status: "error", durationMs: null, failReason: message }, secrets.scrub).catch(console.error);
        }
        batch.status = "error";
        batch.failReason = message;
    } finally {
        batch.durationMs = Date.now() - started;
        batch.failReason = batch.failReason === null ? null : secrets.scrub(batch.failReason).slice(0, MAX_FAIL_REASON_CHARS);
        if (!options) await writeBatch(batch);
    }
}

async function prepareSpecBatch(
    projectId: string,
    ids: string[],
    label: string,
    baseUrl: string,
    healOnFailure: boolean,
    ci?: CiBatchMetadata,
    trigger: RunBatchTrigger = "manual",
    environment?: RunEnvironment,
    options?: RunOptions,
): Promise<{ batch: RunBatch; prepared: PreparedSpec[]; secrets: BatchSecrets }> {
    const { commitSha, definitions } = await repoGit.withRepoLock(projectId, async () => {
        await prepareRunRepositoryUnlocked(projectId);
        const commitSha = await repoGit.getHeadSha(projectId);
        const definitions: {
            spec: Spec;
            markdown: string;
            testSource: string;
            sourceHash: string;
            markdownHash: string;
            analysis: SpecAnalysis;
        }[] = [];
        for (const id of ids) {
            const spec = await specsRepository.getSpec(id);
            if (!spec || spec.projectId !== projectId) throw new Error(options ? "This Spec was removed. Refresh the project to see its current Specs." : `Spec ${id} not found in this project`);
            if (spec.status === "invalid") {
                throw new CodedError("invalid_spec", options ? `This Spec needs repair before it can run. ${spec.invalidReason ?? "Open the Spec and choose Repair in chat."}` : `Spec "${spec.title}" is invalid: ${spec.invalidReason ?? "unknown reason"}`);
            }
            const [markdown, testSource] = await Promise.all([
                fs.readFile(path.join(repoGit.getRepoDir(projectId), specYamlFile(spec.path)), "utf8"),
                fs.readFile(path.join(repoGit.getRepoDir(projectId), specTestFile(spec.path)), "utf8"),
            ]);
            const sourceHash = sourceHashOf(testSource);
            const markdownHash = markdownHashOf(markdown);
            if (sourceHash !== spec.sourceHash || markdownHash !== spec.markdownHash) {
                throw new Error(options ? "The Spec changed while it was being prepared. Run it again to use the latest version." : `The Spec "${spec.title}" changed while it was being prepared. Run it again to use the latest version.`);
            }
            if (options?.expected && (sourceHash !== options.expected.sourceHash || markdownHash !== options.expected.markdownHash)) {
                throw new StaleRunError("Spec changed after the failed run; retry skipped");
            }
            definitions.push({
                spec,
                markdown,
                testSource,
                sourceHash,
                markdownHash,
                analysis: analyzeForRun(spec.title, testSource, markdown),
            });
        }
        return { commitSha, definitions };
    });

    if (options) {
        environment = typeof options.environment === "object" ? options.environment : await resolveRunEnvironment(projectId, options.environment, options.baseUrl);
        baseUrl = environment.baseUrl;
    }
    const refsOf = (analysis: SpecAnalysis) => analysis.secretRefs.map((ref) => ref.envName);
    const refs = [...new Set(definitions.flatMap((definition) => refsOf(definition.analysis)))];
    const { env: secretEnv, missing } = await resolveSecretEnv(projectId, refs, environment?.credentialOverrides);
    if (missing.length > 0) {
        const titles = definitions
            .filter((definition) => refsOf(definition.analysis).some((ref) => missing.includes(ref)))
            .map((definition) => `"${definition.spec.title}"`);
        throw new CodedError("credentials",
            `${options ? `Spec ${titles[0]} references` : `Specs ${titles.join(", ")} reference`} credentials that are not configured: ${missing.join(", ")}. Add them in Settings » Credentials.`,
        );
    }
    const secrets: BatchSecrets = {
        env: secretEnv,
        origins: await resolveSecretOriginPolicy(projectId, refs, environment),
        scrub: await projectSecretScrubber(projectId),
    };

    const createdRuns: Run[] = [];
    const rollback = async () => {
        await Promise.all(createdRuns.map((run) => runsRepository.deleteRun(run.id).catch(() => undefined)));
        await repoGit.withRepoLock(projectId, () => repoGit.deleteRunCommitRefsUnlocked(projectId, createdRuns.map((run) => run.id))).catch(() => undefined);
    };
    try {
        for (const definition of definitions) {
            const run = await runsRepository.createRun({
                specId: definition.spec.id,
                commitSha,
                sourceHash: definition.sourceHash,
                automate: options ? options.automate : true,
                retryOf: options?.retryOf,
                healOnFailure,
                baseUrl,
                environment,
            });
            createdRuns.push(run);
            await repoGit.withRepoLock(projectId, () => repoGit.pinRunCommitUnlocked(projectId, run.id, commitSha));
        }
    } catch (error) {
        await rollback();
        throw error;
    }

    const batch: RunBatch = {
        id: crypto.randomUUID(),
        projectId,
        label: label.trim().slice(0, 120) || "Run Specs",
        trigger,
        baseUrl,
        environment,
        ...(ci ? { ci } : {}),
        status: "running",
        startedAt: new Date().toISOString(),
        durationMs: null,
        failReason: null,
        specs: definitions.map((definition, index) => ({
            runId: createdRuns[index].id,
            specId: definition.spec.id,
            commitSha,
            sourceHash: definition.sourceHash,
            markdownHash: definition.markdownHash,
            title: definition.spec.title,
            status: "running",
            durationMs: null,
            failReason: null,
        })),
    };
    try {
        if (!options) await writeBatch(batch);
    } catch (error) {
        await rollback();
        throw error;
    }
    const prepared = definitions.map((definition, index): PreparedSpec => ({
        run: createdRuns[index],
        projectId,
        markdown: definition.markdown,
        testSource: definition.testSource,
        analysis: definition.analysis,
        item: batch.specs[index],
    }));
    return { batch, prepared, secrets };
}

export async function executeSingleSpecBatch(specId: string, options: RunOptions): Promise<ExecutedRun> {
    options.signal?.throwIfAborted();
    const spec = await specsRepository.getSpec(specId);
    if (!spec) throw new Error("Spec not found");
    const project = await projectsRepository.getProject(spec.projectId);
    if (!project) throw new Error("Project not found");
    const { batch, prepared, secrets } = await prepareSpecBatch(project.id, [specId], spec.title, "", options.healOnFailure !== false, undefined, "manual", undefined, options);
    await executeBatch(batch, prepared, batch.baseUrl!, secrets, options);
    return prepared[0].finished!;
}

export async function startSpecBatch(projectId: string, specIds: string[], label: string, options: { environment?: string | RunEnvironment; baseUrl?: string; ci?: CiBatchMetadata; trigger?: RunBatchTrigger; healFailures?: boolean; rejectIfBusy?: boolean; onPrepared?: (batch: RunBatch) => Promise<void> } = {}): Promise<RunBatch> {
    const project = await projectsRepository.getProject(projectId);
    if (!project) throw new Error("Project not found");
    const environment = typeof options.environment === "object" ? options.environment : await resolveRunEnvironment(projectId, options.environment, options.baseUrl);
    const ids = [...new Set(specIds)];
    if (ids.length === 0) throw new Error("Select at least one Spec");
    if (options.rejectIfBusy && await runsRepository.hasRunningRuns(ids)) throw new ResourceBusyError("Selected Specs are already running; retry after they finish");
    const releaseSpecLocks = await acquireSpecLocks(ids, { wait: !options.rejectIfBusy });
    let batch: RunBatch;
    let prepared: PreparedSpec[];
    let secrets: BatchSecrets;
    try {
        ({ batch, prepared, secrets } = await prepareSpecBatch(projectId, ids, label, environment.baseUrl, options.healFailures !== false, options.ci, options.trigger ?? (options.ci ? "ci" : "manual"), environment));
        try {
            await options.onPrepared?.(batch);
        } catch (error) {
            for (const entry of prepared) {
                await finishPreparedSpec(batch.id, entry, { status: "error", durationMs: 0, failReason: "Batch could not start" }, secrets.scrub);
                await runsRepository.acknowledgeAutomation(entry.run.id);
            }
            batch.status = "error";
            batch.failReason = "Batch could not start";
            batch.durationMs = 0;
            await writeBatch(batch);
            throw error;
        }
    } catch (error) {
        await releaseSpecLocks();
        throw error;
    }
    const task = executeBatch(batch, prepared, environment.baseUrl, secrets).finally(releaseSpecLocks);
    activeBatches.set(batch.id, task);
    void task.catch(console.error).finally(() => activeBatches.delete(batch.id));
    return batch;
}

export async function markInterruptedBatches(): Promise<void> {
    let entries: Dirent[];
    try {
        entries = await fs.readdir(runBatchesDir, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const batch = await getRunBatch(entry.name);
        if (!batch || batch.status !== "running") continue;
        batch.status = "error";
        batch.failReason = "Backend stopped before the batch completed";
        batch.specs = batch.specs.map((spec) => spec.status === "running" ? { ...spec, status: "error", failReason: batch.failReason } : spec);
        await writeBatch(batch);
    }
}

const finishedBatches = new Map<string, { stamp: string; batch: RunBatch }>();

async function readListedBatch(id: string): Promise<RunBatch | null> {
    const stamp = await fs.stat(path.join(batchDirectory(id), "batch.json")).then((stat) => `${stat.ino}:${stat.mtimeMs}:${stat.size}`).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    const cached = finishedBatches.get(id);
    if (stamp && cached?.stamp === stamp) {
        finishedBatches.delete(id);
        finishedBatches.set(id, cached);
        return cached.batch;
    }
    finishedBatches.delete(id);
    if (!stamp) return null;
    const batch = await getRunBatch(id);
    if (batch && batch.status !== "running") {
        finishedBatches.set(id, { stamp, batch });
        while (finishedBatches.size > MAX_CACHED_BATCHES) finishedBatches.delete(finishedBatches.keys().next().value!);
    }
    return batch;
}

export async function listRunBatches(projectId: string, limit = 100, ciOnly = false): Promise<RunBatch[]> {
    const project = await ensureBatchIndex(projectId);
    const candidates = [...project].filter(([, entry]) => !ciOnly || entry.ci)
        .sort(([, a], [, b]) => b.startedAt.localeCompare(a.startedAt));
    const batches: RunBatch[] = [];
    let next = 0;
    while (batches.length < limit && next < candidates.length) {
        const window = candidates.slice(next, next += limit - batches.length);
        const loaded = await Promise.all(window.map(([id]) => readListedBatch(id)));
        window.forEach(([id], index) => {
            const batch = loaded[index];
            if (!batch) project.delete(id);
            else if (batch.projectId === projectId && (!ciOnly || batch.ci)) batches.push(batch);
        });
    }
    return batches;
}

export async function listCiBatches(projectId: string, limit = 20): Promise<RunBatch[]> {
    return listRunBatches(projectId, limit, true);
}
