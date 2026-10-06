import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { RunStatus } from "../../infra/db/schema";
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
import { analyzeForRun, MAX_FAIL_REASON_CHARS, RUN_TIMEOUT_MS } from "./run";
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
    ci?: CiBatchMetadata;
    status: RunStatus;
    startedAt: string;
    durationMs: number | null;
    failReason: string | null;
    specs: RunBatchItem[];
}

interface PreparedSpec {
    run: Run;
    markdown: string;
    testSource: string;
    analysis: SpecAnalysis;
    item: RunBatchItem;
}

interface BatchSecrets {
    env: Record<string, string>;
    origins: SecretOriginPolicy;
    scrub: (text: string) => string;
}

const MAX_BATCH_TIMEOUT_MS = 30 * 60 * 1000;
const activeBatches = new Map<string, Promise<void>>();
const batchIndex = new Map<string, Map<string, { startedAt: string; ci: boolean }>>();
let indexing: Promise<void> | undefined;
let indexedDirectoryStamp: string | undefined;
const indexedBatchIds = new Set<string>();

function indexBatch(batch: RunBatch): void {
    let project = batchIndex.get(batch.projectId);
    if (!project) { project = new Map(); batchIndex.set(batch.projectId, project); }
    project.set(batch.id, { startedAt: batch.startedAt, ci: Boolean(batch.ci) });
    indexedBatchIds.add(batch.id);
}

function ensureBatchIndex(): Promise<void> {
    return indexing ??= (async () => {
        const stamp = await fs.stat(runBatchesDir).then((stat) => `${stat.ino}:${stat.mtimeMs}`).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "missing";
            throw error;
        });
        if (stamp === indexedDirectoryStamp) return;
        const entries = await fs.readdir(runBatchesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
        });
        for (const entry of entries) if (entry.isDirectory() && !indexedBatchIds.has(entry.name)) await getRunBatch(entry.name);
        indexedDirectoryStamp = stamp;
    })().finally(() => { indexing = undefined; });
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
    outcome: { status: FinalRunStatus; durationMs: number | null; failReason: string | null },
    scrub: (text: string) => string,
): Promise<void> {
    const result = {
        ...outcome,
        failReason: outcome.failReason === null ? null : scrub(outcome.failReason).slice(0, MAX_FAIL_REASON_CHARS),
    };
    const runDir = path.join(runsDir, prepared.run.id);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "batch.json"), JSON.stringify({ batchId }), "utf8");
    // A Spec without a result still gets an (empty) evidence manifest.
    if (!(await fs.stat(path.join(runDir, "evidence.json")).catch(() => null))) {
        await fs.writeFile(path.join(runDir, "evidence.json"), JSON.stringify({ steps: [], video: null, failedStep: null }), "utf8");
    }
    await runsRepository.finishRun(prepared.run.id, result.status, result.durationMs, result.failReason);
    if (result.status === "passed" || result.status === "failed") {
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
): Promise<void> {
    let started = Date.now();
    const batchDir = batchDirectory(batch.id);
    await fs.mkdir(batchDir, { recursive: true });
    try {
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
                directory: batchDir,
                baseUrl,
                specs: prepared.map((entry) => ({
                    key: entry.run.id,
                    source: entry.testSource,
                    analysis: entry.analysis,
                    outputDir: path.join(runsDir, entry.run.id),
                })),
                timeoutMs: timeout,
                secretEnv: secrets.env,
                secretOrigins: secrets.origins,
                scrub: secrets.scrub,
            });
        });
        const processFailure = outcome.processFailure;
        for (const entry of prepared) {
            const result = outcome.results.get(entry.run.id);
            await finishPreparedSpec(batch.id, entry, result && result.status !== "error"
                ? { status: result.status, durationMs: result.durationMs, failReason: result.failReason }
                : { status: "error", durationMs: null, failReason: result?.failReason ?? processFailure ?? "Playwright produced no result for this Spec" }, secrets.scrub);
        }
        batch.status = processFailure
            ? "error"
            : prepared.some((entry) => entry.item.status === "failed" || entry.item.status === "error")
              ? "failed"
              : "passed";
        batch.failReason = processFailure;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of prepared) {
            if (entry.item.status !== "running") continue;
            await finishPreparedSpec(batch.id, entry, { status: "error", durationMs: null, failReason: message }, secrets.scrub)
                .catch(console.error);
        }
        batch.status = "error";
        batch.failReason = message;
    } finally {
        batch.durationMs = Date.now() - started;
        batch.failReason = batch.failReason === null ? null : secrets.scrub(batch.failReason).slice(0, MAX_FAIL_REASON_CHARS);
        await writeBatch(batch);
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
            if (!spec || spec.projectId !== projectId) throw new Error(`Spec ${id} not found in this project`);
            if (spec.status === "invalid") {
                throw new Error(`Spec "${spec.title}" is invalid: ${spec.invalidReason ?? "unknown reason"}`);
            }
            const [markdown, testSource] = await Promise.all([
                fs.readFile(path.join(repoGit.getRepoDir(projectId), specYamlFile(spec.path)), "utf8"),
                fs.readFile(path.join(repoGit.getRepoDir(projectId), specTestFile(spec.path)), "utf8"),
            ]);
            const sourceHash = sourceHashOf(testSource);
            const markdownHash = markdownHashOf(markdown);
            if (sourceHash !== spec.sourceHash || markdownHash !== spec.markdownHash) {
                throw new Error(`The check "${spec.title}" changed while it was being prepared. Run it again to use the latest version.`);
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

    const refsOf = (analysis: SpecAnalysis) => analysis.secretRefs.map((ref) => ref.envName);
    const refs = [...new Set(definitions.flatMap((definition) => refsOf(definition.analysis)))];
    const { env: secretEnv, missing } = await resolveSecretEnv(projectId, refs);
    if (missing.length > 0) {
        const titles = definitions
            .filter((definition) => refsOf(definition.analysis).some((ref) => missing.includes(ref)))
            .map((definition) => `"${definition.spec.title}"`);
        throw new Error(
            `Specs ${titles.join(", ")} reference credentials that are not configured: ${missing.join(", ")}. Add them in Settings » Credentials.`,
        );
    }
    const secrets: BatchSecrets = {
        env: secretEnv,
        origins: await resolveSecretOriginPolicy(projectId, refs),
        scrub: await projectSecretScrubber(projectId),
    };

    const createdRuns: Run[] = [];
    try {
        for (const definition of definitions) {
            const run = await runsRepository.createRun({
                specId: definition.spec.id,
                commitSha,
                sourceHash: definition.sourceHash,
                automate: true,
                healOnFailure,
                baseUrl,
            });
            createdRuns.push(run);
            await repoGit.withRepoLock(projectId, () => repoGit.pinRunCommitUnlocked(projectId, run.id, commitSha));
        }
    } catch (error) {
        await Promise.all(createdRuns.map((run) => runsRepository.deleteRun(run.id).catch(() => undefined)));
        await repoGit.withRepoLock(projectId, () => repoGit.deleteRunCommitRefsUnlocked(projectId, createdRuns.map((run) => run.id)));
        throw error;
    }

    const batch: RunBatch = {
        id: crypto.randomUUID(),
        projectId,
        label: label.trim().slice(0, 120) || "Run Specs",
        trigger,
        baseUrl,
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
        await writeBatch(batch);
    } catch (error) {
        await Promise.all(createdRuns.map((run) => runsRepository.deleteRun(run.id).catch(() => undefined)));
        await repoGit.withRepoLock(projectId, () => repoGit.deleteRunCommitRefsUnlocked(projectId, createdRuns.map((run) => run.id)));
        throw error;
    }
    const prepared = definitions.map((definition, index): PreparedSpec => ({
        run: createdRuns[index],
        markdown: definition.markdown,
        testSource: definition.testSource,
        analysis: definition.analysis,
        item: batch.specs[index],
    }));
    return { batch, prepared, secrets };
}

export async function startSpecBatch(projectId: string, specIds: string[], label: string, options: { baseUrl?: string; ci?: CiBatchMetadata; trigger?: RunBatchTrigger; healFailures?: boolean; rejectIfBusy?: boolean; onPrepared?: (batch: RunBatch) => Promise<void> } = {}): Promise<RunBatch> {
    const project = await projectsRepository.getProject(projectId);
    if (!project) throw new Error("Project not found");
    const ids = [...new Set(specIds)];
    if (ids.length === 0) throw new Error("Select at least one Spec");
    if (options.rejectIfBusy && await runsRepository.hasRunningRuns(ids)) throw new ResourceBusyError("Selected Specs are already running; retry after they finish");
    const releaseSpecLocks = await acquireSpecLocks(ids, { wait: !options.rejectIfBusy });
    let batch: RunBatch;
    let prepared: PreparedSpec[];
    let secrets: BatchSecrets;
    try {
        ({ batch, prepared, secrets } = await prepareSpecBatch(projectId, ids, label, options.baseUrl ?? project.baseUrl, options.healFailures !== false, options.ci, options.trigger ?? (options.ci ? "ci" : "manual")));
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
    const task = executeBatch(batch, prepared, options.baseUrl ?? project.baseUrl, secrets).finally(releaseSpecLocks);
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

export async function listRunBatches(projectId: string, limit = 100, ciOnly = false): Promise<RunBatch[]> {
    await ensureBatchIndex();
    const project = batchIndex.get(projectId);
    if (!project) return [];
    const candidates = [...project].filter(([, entry]) => !ciOnly || entry.ci)
        .sort(([, a], [, b]) => b.startedAt.localeCompare(a.startedAt));
    const batches: RunBatch[] = [];
    for (const [id] of candidates) {
        if (batches.length >= limit) break;
        const batch = await getRunBatch(id);
        if (!batch) { project.delete(id); continue; }
        if (batch.projectId === projectId && (!ciOnly || batch.ci)) batches.push(batch);
    }
    return batches;
}

export async function listCiBatches(projectId: string, limit = 20): Promise<RunBatch[]> {
    return listRunBatches(projectId, limit, true);
}
