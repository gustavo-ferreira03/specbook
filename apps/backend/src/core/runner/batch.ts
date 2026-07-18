import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { RunStatus } from "../../infra/db/schema";
import { runsRepository, type Run } from "../../infra/repositories/runs";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { projectsRepository } from "../../infra/repositories/projects";
import { runBatchesDir, runsDir } from "../paths";
import {
    deleteRunCommitRefsUnlocked,
    headSha,
    pinRunCommitUnlocked,
    projectGit,
    repoDir,
    withRepoLock,
} from "../repo/git";
import { markdownHashOf, robotHashOf, specYamlFile, specRobotFile } from "../repo/writer";
import { acquireSpecLocks } from "../specs/lifecycle";
import { finalizeRunEvidence, instrumentRobotSource, type PlannedEvidenceStep } from "./evidence";
import { runRobotProcess } from "./robot";

type XmlNode = Record<string, unknown>;
type FinalRunStatus = Exclude<RunStatus, "running">;

export interface RunBatchItem {
    runId: string;
    specId: string;
    commitSha: string;
    robotHash: string;
    markdownHash: string;
    title: string;
    status: RunStatus;
    durationMs: number | null;
    failReason: string | null;
}

export interface RunBatch {
    id: string;
    projectId: string;
    label: string;
    status: RunStatus;
    startedAt: string;
    durationMs: number | null;
    failReason: string | null;
    specs: RunBatchItem[];
}

interface PreparedSpec {
    run: Run;
    markdown: string;
    robotSource: string;
    item: RunBatchItem;
    suiteKey: string;
    plannedEvidence: PlannedEvidenceStep[];
}

interface ParsedSuiteResult {
    status: "passed" | "failed";
    durationMs: number | null;
    failReason: string | null;
}

const activeBatches = new Map<string, Promise<void>>();

function records(value: unknown): XmlNode[] {
    if (Array.isArray(value)) return value.filter((item): item is XmlNode => !!item && typeof item === "object");
    return value && typeof value === "object" ? [value as XmlNode] : [];
}

function statusOf(node: XmlNode): XmlNode | null {
    return records(node.status)[0] ?? null;
}

function statusMessage(status: XmlNode | null): string {
    const text = status?.["#text"];
    return typeof text === "string" ? text.trim() : text == null ? "" : String(text).trim();
}

function allSuites(suites: XmlNode[]): XmlNode[] {
    return suites.flatMap((suite) => [suite, ...allSuites(records(suite.suite))]);
}

function allTests(suites: XmlNode[]): XmlNode[] {
    return suites.flatMap((suite) => [...records(suite.test), ...allTests(records(suite.suite))]);
}

function parseBatchOutput(xml: string): Map<string, ParsedSuiteResult> {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const doc = parser.parse(xml) as XmlNode;
    const robot = records(doc.robot)[0];
    if (!robot) throw new Error("Robot output.xml has no robot result");
    const results = new Map<string, ParsedSuiteResult>();
    for (const suite of allSuites(records(robot.suite))) {
        const source = typeof suite["@_source"] === "string" ? suite["@_source"] : "";
        if (!source.toLowerCase().endsWith(".robot")) continue;
        const key = path.basename(source, path.extname(source));
        const suiteStatus = statusOf(suite);
        const tests = allTests([suite]);
        const failedTests = tests.filter((test) => statusOf(test)?.["@_status"] !== "PASS");
        const failures = failedTests.map((test) => {
            const status = statusOf(test);
            return `${String(test["@_name"] ?? "Unnamed test")}: ${statusMessage(status) || String(status?.["@_status"] ?? "UNKNOWN")}`;
        });
        const suiteMessage = statusMessage(suiteStatus);
        if (suiteMessage) failures.push(suiteMessage);
        const elapsed = Number(suiteStatus?.["@_elapsed"]);
        results.set(key, {
            status: suiteStatus?.["@_status"] === "PASS" && failedTests.length === 0 ? "passed" : "failed",
            durationMs: Number.isFinite(elapsed) ? Math.round(elapsed * 1000) : null,
            failReason: failures.join("\n") || null,
        });
    }
    return results;
}

function batchDirectory(id: string): string {
    const root = path.resolve(runBatchesDir);
    const directory = path.resolve(root, id);
    if (path.dirname(directory) !== root) throw new Error("Invalid run batch id");
    return directory;
}

function robotSuiteFileStem(title: string): string {
    const stem = title
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return stem.slice(0, 120).replace(/_+$/g, "") || "Spec";
}

async function writeBatch(batch: RunBatch): Promise<void> {
    const directory = batchDirectory(batch.id);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, "batch.json");
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(batch), "utf8");
    await fs.rename(temporary, target);
}

export async function getRunBatch(id: string): Promise<RunBatch | null> {
    try {
        return JSON.parse(await fs.readFile(path.join(batchDirectory(id), "batch.json"), "utf8")) as RunBatch;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export function getRunBatchDirectory(id: string): string {
    return batchDirectory(id);
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
    try {
        await fs.cp(source, destination, { recursive: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

async function finishPreparedSpec(
    batchId: string,
    batchDir: string,
    prepared: PreparedSpec,
    result: { status: FinalRunStatus; durationMs: number | null; failReason: string | null },
): Promise<void> {
    const runDir = path.join(runsDir, prepared.run.id);
    await fs.mkdir(runDir, { recursive: true });
    await Promise.all([
        copyIfPresent(path.join(batchDir, "spec-evidence", prepared.run.id), path.join(runDir, "evidence")),
        copyIfPresent(path.join(batchDir, "spec-video", prepared.run.id), path.join(runDir, "video")),
        fs.writeFile(path.join(runDir, "batch.json"), JSON.stringify({ batchId }), "utf8"),
    ]);
    await finalizeRunEvidence(runDir, result.status, prepared.plannedEvidence);
    await runsRepository.finishRun(prepared.run.id, result.status, result.durationMs, result.failReason);
    if (result.status === "passed" || result.status === "failed") {
        await specsRepository.updateSpecStatusForContent(
            prepared.item.specId,
            prepared.item.robotHash,
            prepared.item.markdownHash,
            result.status,
        );
    }
    prepared.item.status = result.status;
    prepared.item.durationMs = result.durationMs;
    prepared.item.failReason = result.failReason;
}

async function executeBatch(batch: RunBatch, prepared: PreparedSpec[], baseUrl: string): Promise<void> {
    const started = Date.now();
    const batchDir = batchDirectory(batch.id);
    const suiteDir = path.join(batchDir, "suite");
    await fs.mkdir(suiteDir, { recursive: true });
    try {
        const usedSuiteKeys = new Set<string>();
        for (const entry of prepared) {
            const baseSuiteKey = robotSuiteFileStem(entry.item.title);
            let suiteKey = baseSuiteKey;
            let suffix = 2;
            while (usedSuiteKeys.has(suiteKey.toLowerCase())) suiteKey = `${baseSuiteKey}_${suffix++}`;
            usedSuiteKeys.add(suiteKey.toLowerCase());
            entry.suiteKey = suiteKey;
            const instrumented = instrumentRobotSource(entry.robotSource, {
                evidence: `spec-evidence/${entry.run.id}`,
                video: `spec-video/${entry.run.id}`,
            });
            entry.plannedEvidence = instrumented.steps;
            await fs.mkdir(path.join(runsDir, entry.run.id), { recursive: true });
            await Promise.all([
                fs.writeFile(path.join(suiteDir, `${entry.suiteKey}.robot`), instrumented.source, "utf8"),
                fs.writeFile(path.join(runsDir, entry.run.id, "spec.robot"), instrumented.source, "utf8"),
                fs.writeFile(path.join(runsDir, entry.run.id, "spec.yml"), entry.markdown, "utf8"),
            ]);
        }

        const timeout = Math.min(30 * 60 * 1000, Math.max(120_000, prepared.length * 120_000));
        const singleSpec = prepared.length === 1 ? prepared[0] : null;
        const target = singleSpec ? `suite/${singleSpec.suiteKey}.robot` : "suite";
        const suiteName = singleSpec?.item.title ?? batch.label;
        const processResult = await runRobotProcess(batchDir, batchDir, baseUrl, target, timeout, suiteName);
        const outputXml = await fs.readFile(path.join(batchDir, "output.xml"), "utf8").catch(() => null);
        let processFailure: string | null = null;
        if (processResult.timedOut) processFailure = `Batch timed out after ${Math.round(timeout / 1000)}s`;
        else if (processResult.code === null || processResult.code >= 251) {
            processFailure = processResult.output.trim().slice(0, 2000) || `robot exited with code ${processResult.code}`;
        } else if (!outputXml) {
            processFailure = processResult.output.trim().slice(0, 2000) || "robot produced no output.xml";
        }

        const suiteResults = outputXml ? parseBatchOutput(outputXml) : new Map<string, ParsedSuiteResult>();
        for (const entry of prepared) {
            const parsed = suiteResults.get(entry.suiteKey);
            await finishPreparedSpec(batch.id, batchDir, entry, parsed
                ? parsed
                : { status: "error", durationMs: null, failReason: processFailure ?? "Robot produced no result for this Spec" });
        }
        batch.status = processFailure
            ? "error"
            : prepared.some((entry) => entry.item.status === "failed" || entry.item.status === "error")
              ? "failed"
              : "passed";
        batch.failReason = processFailure;
    } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
        for (const entry of prepared) {
            if (entry.item.status !== "running") continue;
            await finishPreparedSpec(batch.id, batchDir, entry, { status: "error", durationMs: null, failReason: message }).catch(console.error);
        }
        batch.status = "error";
        batch.failReason = message;
    } finally {
        batch.durationMs = Date.now() - started;
        await fs.rm(path.join(batchDir, "spec-evidence"), { recursive: true, force: true });
        await fs.rm(path.join(batchDir, "spec-video"), { recursive: true, force: true });
        await writeBatch(batch);
    }
}

async function prepareSpecBatch(
    projectId: string,
    ids: string[],
    label: string,
): Promise<{ batch: RunBatch; prepared: PreparedSpec[] }> {
    const { commitSha, definitions } = await withRepoLock(projectId, async () => {
        if (!(await projectGit(projectId).status()).isClean()) {
            throw new Error("The project repository has uncommitted changes; sync or commit them before running");
        }
        const commitSha = await headSha(projectId);
        const definitions: {
            spec: Spec;
            markdown: string;
            robotSource: string;
            robotHash: string;
            markdownHash: string;
        }[] = [];
        for (const id of ids) {
            const spec = await specsRepository.getSpec(id);
            if (!spec || spec.projectId !== projectId) throw new Error(`Spec ${id} not found in this project`);
            if (spec.status === "invalid") {
                throw new Error(`Spec "${spec.title}" is invalid: ${spec.invalidReason ?? "unknown reason"}`);
            }
            if (spec.status === "conflict") {
                throw new Error(`Spec "${spec.title}" has a git sync conflict`);
            }
            const [markdown, robotSource] = await Promise.all([
                fs.readFile(path.join(repoDir(projectId), specYamlFile(spec.path)), "utf8"),
                fs.readFile(path.join(repoDir(projectId), specRobotFile(spec.path)), "utf8"),
            ]);
            const robotHash = robotHashOf(robotSource);
            const markdownHash = markdownHashOf(markdown);
            if (robotHash !== spec.robotHash || markdownHash !== spec.markdownHash) {
                throw new Error(`Spec "${spec.title}" changed without being reindexed`);
            }
            definitions.push({
                spec,
                markdown,
                robotSource,
                robotHash,
                markdownHash,
            });
        }
        return { commitSha, definitions };
    });

    const createdRuns: Run[] = [];
    try {
        for (const definition of definitions) {
            const run = await runsRepository.createRun({
                specId: definition.spec.id,
                commitSha,
                robotHash: definition.robotHash,
            });
            createdRuns.push(run);
            await withRepoLock(projectId, () => pinRunCommitUnlocked(projectId, run.id, commitSha));
        }
    } catch (error) {
        await Promise.all(createdRuns.map((run) => runsRepository.deleteRun(run.id).catch(() => undefined)));
        await withRepoLock(projectId, () => deleteRunCommitRefsUnlocked(projectId, createdRuns.map((run) => run.id)));
        throw error;
    }

    const batch: RunBatch = {
        id: crypto.randomUUID(),
        projectId,
        label: label.trim().slice(0, 120) || "Run Specs",
        status: "running",
        startedAt: new Date().toISOString(),
        durationMs: null,
        failReason: null,
        specs: definitions.map((definition, index) => ({
            runId: createdRuns[index].id,
            specId: definition.spec.id,
            commitSha,
            robotHash: definition.robotHash,
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
        await withRepoLock(projectId, () => deleteRunCommitRefsUnlocked(projectId, createdRuns.map((run) => run.id)));
        throw error;
    }
    const prepared = definitions.map((definition, index): PreparedSpec => ({
        run: createdRuns[index],
        markdown: definition.markdown,
        robotSource: definition.robotSource,
        item: batch.specs[index],
        suiteKey: "",
        plannedEvidence: [],
    }));
    return { batch, prepared };
}

export async function startSpecBatch(projectId: string, specIds: string[], label: string): Promise<RunBatch> {
    const project = await projectsRepository.getProject(projectId);
    if (!project) throw new Error("Project not found");
    const ids = [...new Set(specIds)];
    if (ids.length === 0) throw new Error("Select at least one Spec");
    const releaseSpecLocks = await acquireSpecLocks(ids);
    let batch: RunBatch;
    let prepared: PreparedSpec[];
    try {
        ({ batch, prepared } = await prepareSpecBatch(projectId, ids, label));
    } catch (error) {
        await releaseSpecLocks();
        throw error;
    }
    const task = executeBatch(batch, prepared, project.baseUrl).finally(releaseSpecLocks);
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
