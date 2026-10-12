import { runNetworkPolicy } from "../ci/targets";
import { CodedError, errorCodeOf, type ErrorCode } from "@specbook/runtime/errors";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { resolveRunEnvironment } from "../environments";
import type { RunEnvironment, RunStatus } from "../../infra/db/schema";
import { runsRepository, type Run } from "../../infra/repositories/runs";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { specEnvironmentsRepository } from "../../infra/repositories/spec-environments";
import { environmentsRepository } from "../../infra/repositories/environments";
import { projectsRepository } from "../../infra/repositories/projects";
import { runBatchesDir, runsDir } from "../paths";
import { repoGit } from "../repo/git";
import { prepareRunRepositoryUnlocked } from "../repo/recovery";
import { markdownHashOf, sourceHashOf, specTestFile, specYamlFile } from "../repo/writer";
import { resolveSecretEnv } from "../credentials/profiles";
import { projectSecretScrubber } from "../credentials/scrub";
import { acquireSpecLocks, ResourceBusyError, withSpecLock } from "../specs/lifecycle";
import { runPlaywrightSuite } from "@specbook/runtime/playwright";
import { withRunSlot } from "@specbook/runtime/process";
import { analyzeForRun, MAX_FAIL_REASON_CHARS, MAX_FAILED_STEP_CHARS, RUN_TIMEOUT_MS, StaleRunError, type ExecutedRun, type RunOptions } from "./execution";
import { resolveSecretOriginPolicy, type SecretOriginPolicy } from "./secrets";
import { readEvidenceManifest } from "@specbook/runtime/evidence";
import type { SpecAnalysis } from "@specbook/runtime/validate";
import type { RunnerCompletion } from "@specbook/runtime/runner-protocol";
import { cancelRunnerBatch, enqueueRunnerBatch, maintainRunnerQueue, pendingRunnerBatchIds } from "../private-runner/queue";
import { runnersRepository, type RunnerJob } from "../../infra/repositories/runners";
import { logger } from "../../infra/logger";
import { createEnvironmentTunnelProxy, TunnelWaitInterrupted, waitForTunnel } from "../tunnel/registry";

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
    awaitingDeploy?: boolean;
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
    runnerOptions?: Pick<RunOptions, "persistFailures" | "updateSpecStatus">;
    tunnelOptions?: Pick<RunOptions, "persistFailures" | "updateSpecStatus">;
    waitingForTunnelAt?: string;
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
    const current = await specsRepository.getSpec(prepared.item.specId);
    const awaitingDeploy = current ? await specEnvironmentsRepository.awaiting(current, prepared.run.environment?.id) : false;
    if (awaitingDeploy && outcome.status !== "passed") {
        await runsRepository.markAwaitingDeploy(prepared.run.id);
        prepared.run.awaitingDeploy = true;
        prepared.run.automationPending = false;
        prepared.item.awaitingDeploy = true;
    }
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
    if (options?.updateSpecStatus !== false && (options?.persistFailures !== false || result.status === "passed") && (result.status === "passed" || result.status === "failed")) {
        if (current && current.sourceHash === prepared.item.sourceHash && current.markdownHash === prepared.item.markdownHash
            && (!awaitingDeploy || result.status === "passed" && prepared.run.baseUrl === prepared.run.environment?.configuredBaseUrl)
            && (!prepared.run.awaitingDeploy || result.status === "passed" && prepared.run.baseUrl === prepared.run.environment?.configuredBaseUrl)) {
            if (prepared.run.environment) await specEnvironmentsRepository.set(current, prepared.run.environment.id, result.status);
            else await specsRepository.updateSpecStatusForContent(current.id, current.sourceHash, current.markdownHash, result.status);
        }
    }
    prepared.item.status = result.status;
    prepared.item.durationMs = result.durationMs;
    prepared.item.failReason = result.failReason;
}

async function snapshotPreparedSpecs(prepared: PreparedSpec[]): Promise<void> {
    for (const entry of prepared) {
        const directory = path.join(runsDir, entry.run.id);
        await fs.mkdir(directory, { recursive: true });
        await Promise.all([fs.writeFile(path.join(directory, "spec.ts"), entry.testSource, "utf8"), fs.writeFile(path.join(directory, "spec.yml"), entry.markdown, "utf8")]);
    }
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
    let tunnelProxy: Awaited<ReturnType<typeof createEnvironmentTunnelProxy>> | undefined;
    let suspended = false;
    try {
        await fs.mkdir(directory, { recursive: true });
        await snapshotPreparedSpecs(prepared);
        if (batch.environment?.executor === "tunnel") {
            batch.waitingForTunnelAt ??= new Date().toISOString();
            await writeBatch(batch);
            try { await waitForTunnel(batch.environment, batch.projectId, prepared.map((entry) => entry.run.id), options?.signal, batch.waitingForTunnelAt); }
            catch (error) { if (error instanceof TunnelWaitInterrupted) { suspended = true; return; } throw error; }
            tunnelProxy = await createEnvironmentTunnelProxy(batch.environment);
            delete batch.waitingForTunnelAt;
            await writeBatch(batch);
        }
        const timeout = Math.min(MAX_BATCH_TIMEOUT_MS, Math.max(RUN_TIMEOUT_MS, prepared.length * RUN_TIMEOUT_MS));
        const outcome = await withRunSlot(async () => {
            started = Date.now();
            return runPlaywrightSuite({
                networkPolicy: await runNetworkPolicy(batch.projectId, baseUrl, batch.environment),
                proxyServer: tunnelProxy?.server,
                directory,
                baseUrl,
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
            const finish = () => finishPreparedSpec(batch.id, entry, { ...result, durationMs: options ? result.durationMs ?? Date.now() - started : result.durationMs }, secrets.scrub, options, result.failedStep);
            if (batch.environment?.executor === "tunnel") await withSpecLock(entry.item.specId, finish);
            else await finish();
        }
        batch.status = processFailure ? "error" : prepared.some((entry) => entry.item.status === "failed" || entry.item.status === "error") ? "failed" : "passed";
        batch.failReason = processFailure;
    } catch (error) {
        if (options) throw error;
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of prepared) {
            if (entry.item.status !== "running") continue;
            const finish = () => finishPreparedSpec(batch.id, entry, { status: "error", durationMs: null, failReason: message }, secrets.scrub);
            await (batch.environment?.executor === "tunnel" ? withSpecLock(entry.item.specId, finish) : finish()).catch(console.error);
        }
        batch.status = "error";
        batch.failReason = message;
    } finally {
        await tunnelProxy?.close();
        if (!suspended) {
            delete batch.waitingForTunnelAt;
            batch.durationMs = Date.now() - started;
            batch.failReason = batch.failReason === null ? null : secrets.scrub(batch.failReason).slice(0, MAX_FAIL_REASON_CHARS);
            if (!options || batch.environment?.executor === "tunnel") await writeBatch(batch);
        }
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
    const remote = environment?.executor === "runner";
    const { env: secretEnv, missing } = remote ? { env: {}, missing: [] } : await resolveSecretEnv(projectId, refs, environment?.credentialOverrides);
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
        origins: remote ? { defaultOrigins: [], byRef: {} } : await resolveSecretOriginPolicy(projectId, refs, environment),
        scrub: remote ? (text) => text : await projectSecretScrubber(projectId),
    };

    const createdRuns: Run[] = [];
    const rollback = async () => {
        await Promise.all(createdRuns.map((run) => runsRepository.deleteRun(run.id).catch(() => undefined)));
        await repoGit.withRepoLock(projectId, () => repoGit.deleteRunCommitRefsUnlocked(projectId, createdRuns.map((run) => run.id))).catch(() => undefined);
    };
    try {
        for (const definition of definitions) {
            const awaitingDeploy = await specEnvironmentsRepository.awaiting(definition.spec, environment?.id);
            const run = await runsRepository.createRun({
                specId: definition.spec.id,
                commitSha,
                sourceHash: definition.sourceHash,
                automate: awaitingDeploy ? false : options ? options.automate : true,
                awaitingDeploy,
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
            awaitingDeploy: createdRuns[index].awaitingDeploy,
        })),
        ...(remote && options ? { runnerOptions: { persistFailures: options.persistFailures, updateSpecStatus: options.updateSpecStatus } } : {}),
        ...(environment?.executor === "tunnel" && options ? { tunnelOptions: { persistFailures: options.persistFailures, updateSpecStatus: options.updateSpecStatus } } : {}),
    };
    try {
        if (!options || remote || environment?.executor === "tunnel") await writeBatch(batch);
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

async function dispatchRunnerBatch(batch: RunBatch, prepared: PreparedSpec[], timeoutMs?: number): Promise<void> {
    try {
        for (const entry of prepared) {
            const directory = path.join(runsDir, entry.run.id);
            await fs.mkdir(directory, { recursive: true });
            await Promise.all([
                fs.writeFile(path.join(directory, "spec.ts"), entry.testSource, "utf8"),
                fs.writeFile(path.join(directory, "spec.yml"), entry.markdown, "utf8"),
                fs.writeFile(path.join(directory, "batch.json"), JSON.stringify({ batchId: batch.id }), "utf8"),
            ]);
        }
        await enqueueRunnerBatch(batch.id, batch.projectId, batch.environment?.runnerGroup ?? null, {
            batchId: batch.id,
            projectId: batch.projectId,
            baseUrl: batch.baseUrl!,
            networkPolicy: await runNetworkPolicy(batch.projectId, batch.baseUrl!, batch.environment),
            timeoutMs: timeoutMs ?? Math.min(MAX_BATCH_TIMEOUT_MS, Math.max(RUN_TIMEOUT_MS, prepared.length * RUN_TIMEOUT_MS)),
            specs: prepared.map((entry) => ({ runId: entry.run.id, specId: entry.run.specId, title: entry.item.title, files: { "spec.ts": entry.testSource, "spec.yml": entry.markdown } })),
        });
    } catch (error) {
        for (const entry of prepared) {
            await finishPreparedSpec(batch.id, entry, { status: "error", durationMs: 0, failReason: "Runner work could not be queued" }, (text) => text);
            await runsRepository.acknowledgeAutomation(entry.run.id);
        }
        batch.status = "error";
        batch.failReason = "Runner work could not be queued";
        batch.durationMs = 0;
        await writeBatch(batch);
        throw error;
    }
}

export async function finishRunnerBatch(batchId: string, completion: RunnerCompletion): Promise<void> {
    const batch = await getRunBatch(batchId);
    if (!batch || batch.environment?.executor !== "runner") throw new Error("Runner batch not found");
    if (batch.status !== "running") return;
    for (const item of batch.specs) {
        const run = await runsRepository.getRun(item.runId);
        const result = completion.results.find((entry) => entry.runId === item.runId);
        if (!run || !result) throw new Error("Runner result is missing a Spec");
        const directory = path.join(runsDir, run.id);
        const [markdown, testSource] = await Promise.all([
            fs.readFile(path.join(directory, "spec.yml"), "utf8"),
            fs.readFile(path.join(directory, "spec.ts"), "utf8"),
        ]);
        const prepared: PreparedSpec = { run, projectId: batch.projectId, markdown, testSource, analysis: analyzeForRun(item.title, testSource, markdown), item };
        await withSpecLock(item.specId, () => finishPreparedSpec(batch.id, prepared, result, (text) => text, batch.runnerOptions, result.failedStep));
    }
    batch.status = completion.processFailure ? "error" : batch.specs.some((entry) => entry.status === "failed" || entry.status === "error") ? "failed" : "passed";
    batch.durationMs = completion.durationMs;
    batch.failReason = completion.processFailure;
    await writeBatch(batch);
}

export async function failBrokenRunnerBatch(job: RunnerJob, reason: string): Promise<void> {
    const previous = await getRunBatch(job.batchId).catch(() => null);
    const items: RunBatchItem[] = [];
    let environment = previous?.environment;
    for (const spec of job.payload.specs) {
        const run = await runsRepository.getRun(spec.runId);
        environment ??= run?.environment ?? undefined;
        if (run) await withSpecLock(spec.specId, async () => {
            const current = await specsRepository.getSpec(spec.specId);
            if (current && await specEnvironmentsRepository.awaiting(current, run.environment?.id)) {
                await runsRepository.markAwaitingDeploy(run.id);
                run.awaitingDeploy = true;
            }
            if (run.status === "running") {
                await runsRepository.finishRun(run.id, "error", null, reason, "infrastructure")
                    .catch((error: unknown) => logger.error("could not finish interrupted runner Spec", { runId: run.id, error }));
            }
            await runsRepository.acknowledgeAutomation(run.id);
        }).catch((error: unknown) => logger.error("could not recover broken runner Spec", { runId: run.id, error }));
        items.push({ runId: spec.runId, specId: spec.specId, title: spec.title, commitSha: run?.commitSha ?? "", sourceHash: run?.sourceHash ?? "",
            markdownHash: markdownHashOf(spec.files["spec.yml"]), status: run && run.status !== "running" ? run.status : "error", durationMs: run?.durationMs ?? null, failReason: reason, awaitingDeploy: run?.awaitingDeploy });
    }
    await writeBatch({ ...previous, id: job.batchId, projectId: job.projectId, label: previous?.label ?? "Runner work", baseUrl: job.payload.baseUrl,
        environment, specs: items, status: "error", startedAt: job.createdAt, durationMs: Math.max(0, Date.now() - Date.parse(job.createdAt)), failReason: reason });
}

async function waitRunnerBatch(batch: RunBatch, signal?: AbortSignal): Promise<RunBatch> {
    try {
        while (true) {
            signal?.throwIfAborted();
            await maintainRunnerQueue();
            const completed = await getRunBatch(batch.id).catch(() => null);
            if (completed && completed.status !== "running") return completed;
            const job = await runnersRepository.jobByBatch(batch.id);
            if (job?.status === "completed") {
                const failReason = job.lastFailure ?? "Runner work could not be finalized. Check the server logs for details.";
                const specs = await Promise.all(batch.specs.map(async (item): Promise<RunBatchItem> => {
                    const run = await runsRepository.getRun(item.runId);
                    return { ...item, status: run && run.status !== "running" ? run.status : "error", durationMs: run?.durationMs ?? null,
                        failReason: run?.failReason ?? failReason, awaitingDeploy: run?.awaitingDeploy ?? item.awaitingDeploy };
                }));
                return { ...batch, status: "error", durationMs: Math.max(0, Date.now() - Date.parse(batch.startedAt)), failReason, specs };
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
        }
    } catch (error) {
        if (signal?.aborted && await cancelRunnerBatch(batch.id)) {
            await finishRunnerBatch(batch.id, { leaseId: crypto.randomUUID(), durationMs: 0, processFailure: "Runner work was cancelled", results: batch.specs.map((item) => ({ runId: item.runId, status: "error", durationMs: 0, failReason: "Runner work was cancelled", failedStep: null, errorCode: "cancelled", artifacts: [] })) });
            for (const item of batch.specs) await runsRepository.acknowledgeAutomation(item.runId);
        }
        throw error;
    }
}

export async function verifyRunnerCandidate(input: { specId: string; testSource: string; markdown: string; environment: RunEnvironment; directory: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ExecutedRun & { status: FinalRunStatus }> {
    const spec = await specsRepository.getSpec(input.specId);
    if (!spec) throw new Error("Spec no longer exists");
    input.signal?.throwIfAborted();
    const analysis = analyzeForRun(spec.title, input.testSource, input.markdown);
    const commitSha = await repoGit.getHeadSha(spec.projectId);
    const run = await runsRepository.createRun({ specId: spec.id, commitSha, sourceHash: sourceHashOf(input.testSource), environment: input.environment, baseUrl: input.environment.baseUrl, automate: false });
    const item: RunBatchItem = { runId: run.id, specId: spec.id, commitSha, sourceHash: run.sourceHash, markdownHash: markdownHashOf(input.markdown), title: spec.title, status: "running", durationMs: null, failReason: null };
    const batch: RunBatch = { id: crypto.randomUUID(), projectId: spec.projectId, label: "Verify proposed repair", environment: input.environment, baseUrl: input.environment.baseUrl, status: "running", startedAt: run.startedAt, durationMs: null, failReason: null, specs: [item], runnerOptions: { updateSpecStatus: false } };
    const prepared: PreparedSpec = { run, projectId: spec.projectId, markdown: input.markdown, testSource: input.testSource, analysis, item };
    const directory = path.join(runsDir, run.id);
    try {
        await repoGit.withRepoLock(spec.projectId, () => repoGit.pinRunCommitUnlocked(spec.projectId, run.id, commitSha));
        await writeBatch(batch);
        await dispatchRunnerBatch(batch, [prepared], input.timeoutMs);
        await waitRunnerBatch(batch, input.signal);
        const result = await runsRepository.getRun(run.id);
        if (!result) throw new Error("Runner verification result disappeared");
        if (result.status === "running") throw new Error("Runner verification is incomplete");
        const manifest = await readEvidenceManifest(directory);
        await fs.cp(directory, input.directory, { recursive: true });
        return { ...result, status: result.status, failedStep: manifest.failedStep };
    } finally {
        await cancelRunnerBatch(batch.id);
        await runsRepository.deleteRun(run.id);
        await repoGit.withRepoLock(spec.projectId, () => repoGit.deleteRunCommitRefsUnlocked(spec.projectId, [run.id]));
        await fs.rm(directory, { recursive: true, force: true });
        await fs.rm(batchDirectory(batch.id), { recursive: true, force: true });
    }
}

export async function executeSingleSpecBatch(specId: string, options: RunOptions): Promise<ExecutedRun> {
    options.signal?.throwIfAborted();
    const release = await acquireSpecLocks([specId]);
    let released = false;
    try {
        const spec = await specsRepository.getSpec(specId);
        if (!spec) throw new Error("Spec not found");
        const project = await projectsRepository.getProject(spec.projectId);
        if (!project) throw new Error("Project not found");
        const environment = typeof options.environment === "object" ? options.environment : await resolveRunEnvironment(project.id, options.environment, options.baseUrl);
        if (environment.executor !== "server" && await runsRepository.hasRunningRuns([specId])) throw new ResourceBusyError("This Spec already has a run queued or in progress; retry after it finishes");
        const { batch, prepared, secrets } = await prepareSpecBatch(project.id, [specId], spec.title, "", options.healOnFailure !== false, undefined, "manual", undefined, { ...options, environment });
        if (batch.environment?.executor === "runner") {
            await dispatchRunnerBatch(batch, prepared);
            await release();
            released = true;
            const completed = await waitRunnerBatch(batch, options.signal);
            const stored = await runsRepository.getRun(prepared[0].run.id);
            const item = completed.specs[0];
            const run = stored ?? { ...prepared[0].run, status: item.status, durationMs: item.durationMs, failReason: item.failReason };
            const manifest = await readEvidenceManifest(path.join(runsDir, run.id));
            return { ...run, failedStep: manifest.failedStep };
        }
        if (batch.environment?.executor === "tunnel") {
            await snapshotPreparedSpecs(prepared);
            await release();
            released = true;
        }
        await executeBatch(batch, prepared, batch.baseUrl!, secrets, options);
        if (!prepared[0].finished) throw new TunnelWaitInterrupted("Backend stopped while waiting for a tunnel");
        return prepared[0].finished!;
    } finally { if (!released) await release(); }
}

export async function startSpecBatch(projectId: string, specIds: string[], label: string, options: { environment?: string | RunEnvironment; baseUrl?: string; ci?: CiBatchMetadata; trigger?: RunBatchTrigger; healFailures?: boolean; rejectIfBusy?: boolean; onPrepared?: (batch: RunBatch) => Promise<void> } = {}): Promise<RunBatch> {
    const project = await projectsRepository.getProject(projectId);
    if (!project) throw new Error("Project not found");
    const environment = typeof options.environment === "object" ? options.environment : await resolveRunEnvironment(projectId, options.environment, options.baseUrl);
    const ids = [...new Set(specIds)];
    if (ids.length === 0) throw new Error("Select at least one Spec");
    if ((options.rejectIfBusy || environment.executor !== "server") && await runsRepository.hasRunningRuns(ids)) throw new ResourceBusyError("Selected Specs are already running; retry after they finish");
    const releaseSpecLocks = await acquireSpecLocks(ids, { wait: !options.rejectIfBusy });
    let batch: RunBatch;
    let prepared: PreparedSpec[];
    let secrets: BatchSecrets;
    try {
        if (environment.executor !== "server" && await runsRepository.hasRunningRuns(ids)) throw new ResourceBusyError("Selected Specs are already running; retry after they finish");
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
    if (environment.executor === "runner") {
        try { await dispatchRunnerBatch(batch, prepared); }
        finally { await releaseSpecLocks(); }
        return batch;
    }
    if (environment.executor === "tunnel") {
        try { await snapshotPreparedSpecs(prepared); }
        finally { await releaseSpecLocks(); }
    }
    const task = executeBatch(batch, prepared, environment.baseUrl, secrets).finally(environment.executor === "tunnel" ? () => undefined : releaseSpecLocks);
    activeBatches.set(batch.id, task);
    void task.catch(console.error).finally(() => activeBatches.delete(batch.id));
    return batch;
}

export async function pendingTunnelBatchRunIds(): Promise<string[]> {
    const entries = await fs.readdir(runBatchesDir, { withFileTypes: true, encoding: "utf8" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    const batches = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => getRunBatch(entry.name).catch(() => null)));
    return batches.filter((batch) => batch?.status === "running" && batch.environment?.executor === "tunnel" && batch.waitingForTunnelAt)
        .flatMap((batch) => batch!.specs.filter((item) => item.status === "running").map((item) => item.runId));
}

async function resumeTunnelBatch(batch: RunBatch): Promise<void> {
    const release = await acquireSpecLocks(batch.specs.map((item) => item.specId));
    try {
        const prepared = await Promise.all(batch.specs.map(async (item): Promise<PreparedSpec> => {
            const run = await runsRepository.getRun(item.runId);
            if (!run || run.status !== "running") throw new Error("Queued tunnel run is missing");
            const directory = path.join(runsDir, item.runId);
            const [testSource, markdown] = await Promise.all([fs.readFile(path.join(directory, "spec.ts"), "utf8"), fs.readFile(path.join(directory, "spec.yml"), "utf8")]);
            if (sourceHashOf(testSource) !== item.sourceHash || markdownHashOf(markdown) !== item.markdownHash) throw new Error("Queued tunnel Spec files changed");
            return { run, projectId: batch.projectId, markdown, testSource, analysis: analyzeForRun(item.title, testSource, markdown), item };
        }));
        const refs = [...new Set(prepared.flatMap((entry) => entry.analysis.secretRefs.map((ref) => ref.envName)))];
        const current = (await environmentsRepository.list(batch.projectId)).find((entry) => entry.id === batch.environment!.id);
        if (!current) throw new Error("The queued run's tunnel environment was removed");
        const environment = await resolveRunEnvironment(batch.projectId, current.name, batch.baseUrl);
        if (environment.executor !== "tunnel" || environment.id !== batch.environment!.id) throw new Error("The queued run's tunnel environment changed");
        batch.environment = environment;
        const { env, missing } = await resolveSecretEnv(batch.projectId, refs, environment.credentialOverrides);
        if (missing.length) throw new CodedError("credentials", `Missing credentials: ${missing.join(", ")}. Configure them in Settings → Credentials.`);
        const secrets = { env, origins: await resolveSecretOriginPolicy(batch.projectId, refs, environment), scrub: await projectSecretScrubber(batch.projectId) };
        await release();
        const task = executeBatch(batch, prepared, batch.baseUrl!, secrets, batch.tunnelOptions);
        activeBatches.set(batch.id, task);
        void task.catch(console.error).finally(() => activeBatches.delete(batch.id));
    } catch (error) {
        await release();
        const reason = error instanceof Error ? error.message : "Queued tunnel run could not resume";
        for (const item of batch.specs) {
            await runsRepository.finishRun(item.runId, "error", 0, reason, errorCodeOf(error) ?? "infrastructure");
            item.status = "error";
            item.failReason = reason;
        }
        batch.status = "error";
        batch.failReason = reason;
        delete batch.waitingForTunnelAt;
        await writeBatch(batch);
    }
}

export async function markInterruptedBatches(): Promise<void> {
    const pendingRunners = new Set(await pendingRunnerBatchIds());
    let entries: Dirent[];
    try {
        entries = await fs.readdir(runBatchesDir, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (pendingRunners.has(entry.name)) continue;
        const batch = await getRunBatch(entry.name).catch((error: unknown) => { logger.error("could not recover interrupted batch", { batchId: entry.name, error }); return null; });
        if (!batch || batch.status !== "running") continue;
        if (batch.environment?.executor === "tunnel" && batch.waitingForTunnelAt) { await resumeTunnelBatch(batch); continue; }
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
