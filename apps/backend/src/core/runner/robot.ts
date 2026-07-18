import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { RunStatus } from "../../infra/db/schema";
import { projectsRepository } from "../../infra/repositories/projects";
import { runsRepository, type Run } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { runsDir } from "../paths";
import { readSpecExecutable } from "../specs/files";
import { withSpecLock } from "../specs/lifecycle";
import { finalizeRunEvidence, instrumentRobotSource, type PlannedEvidenceStep } from "./evidence";

const RUN_TIMEOUT_MS = 120_000;
const activeRobotProcesses = new Set<ChildProcess>();

interface ParsedResult {
    passed: boolean;
    failReason: string | null;
}

type XmlNode = Record<string, unknown>;
type FinalRunStatus = Exclude<RunStatus, "running">;

function records(value: unknown): XmlNode[] {
    if (Array.isArray(value)) return value.filter((item): item is XmlNode => !!item && typeof item === "object");
    return value && typeof value === "object" ? [value as XmlNode] : [];
}

function statusOf(node: XmlNode): XmlNode | null {
    return records(node.status)[0] ?? null;
}

function statusMessage(status: XmlNode | null): string {
    if (!status) return "";
    const text = status["#text"];
    return typeof text === "string" ? text.trim() : text == null ? "" : String(text).trim();
}

function allSuites(suites: XmlNode[]): XmlNode[] {
    return suites.flatMap((suite) => [suite, ...allSuites(records(suite.suite))]);
}

function allTests(suites: XmlNode[]): XmlNode[] {
    return suites.flatMap((suite) => [...records(suite.test), ...allTests(records(suite.suite))]);
}

export function parseOutputXml(xml: string): ParsedResult {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const doc = parser.parse(xml) as XmlNode;
    const robot = records(doc.robot)[0];
    if (!robot) throw new Error("Robot output.xml has no robot result");
    const rootSuites = records(robot.suite);
    if (rootSuites.length === 0) throw new Error("Robot output.xml has no suite result");
    const suites = allSuites(rootSuites);
    const tests = allTests(rootSuites);
    if (tests.length === 0) return { passed: false, failReason: "Robot did not execute any tests" };

    const failedTests = tests.filter((test) => statusOf(test)?.["@_status"] !== "PASS");
    const failedSuites = suites.filter((suite) => statusOf(suite)?.["@_status"] !== "PASS");
    if (failedTests.length === 0 && failedSuites.length === 0) return { passed: true, failReason: null };

    const failures = failedTests.map((test) => {
        const status = statusOf(test);
        const name = String(test["@_name"] ?? "Unnamed test");
        const message = statusMessage(status) || String(status?.["@_status"] ?? "UNKNOWN");
        return `${name}: ${message}`;
    });
    for (const suite of failedSuites) {
        const status = statusOf(suite);
        const message = statusMessage(status);
        if (message) failures.push(`${String(suite["@_name"] ?? "Suite")}: ${message}`);
    }
    return { passed: false, failReason: failures.join("\n") || "Robot suite failed without a message" };
}

function terminateProcessTree(proc: ChildProcess): void {
    if (process.platform === "linux" && proc.pid) {
        try {
            process.kill(-proc.pid, "SIGKILL");
            return;
        } catch {}
    }
    try {
        proc.kill("SIGKILL");
    } catch {}
}

export async function runRobotProcess(
    workDir: string,
    outputDir: string,
    baseUrl: string,
    target = "spec.robot",
    timeoutMs = RUN_TIMEOUT_MS,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
        const proc = spawn("robot", ["--outputdir", outputDir, "--variable", `BASE_URL:${baseUrl}`, target], {
            cwd: workDir,
            detached: process.platform === "linux",
            stdio: ["ignore", "pipe", "pipe"],
        });
        activeRobotProcesses.add(proc);
        let output = "";
        let settled = false;
        const finish = (result: { code: number | null; output: string; timedOut: boolean }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            terminateProcessTree(proc);
            finish({ code: null, output, timedOut: true });
        }, timeoutMs);
        proc.stdout.on("data", (data: Buffer) => (output += data.toString()));
        proc.stderr.on("data", (data: Buffer) => (output += data.toString()));
        proc.once("error", (error) => {
            activeRobotProcesses.delete(proc);
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        proc.once("exit", (code) => {
            activeRobotProcesses.delete(proc);
            finish({ code, output, timedOut: false });
        });
    });
}

function errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

async function executeSpecLocked(specId: string, options: { persistFailures?: boolean }): Promise<Run> {
    const spec = await specsRepository.getSpec(specId);
    if (!spec) throw new Error("Spec not found");
    if (!spec.currentVersionId) throw new Error("Spec has no executable version yet");
    const version = await specsRepository.getSpecVersion(spec.currentVersionId);
    if (!version) throw new Error("Spec version not found");
    const project = await projectsRepository.getProject(spec.projectId);
    if (!project) throw new Error("Project not found");

    const run = await runsRepository.createRun({ specId: spec.id, specVersionId: version.id });
    const started = Date.now();
    let status: FinalRunStatus = "error";
    let failReason: string | null = "Run did not complete";
    let plannedEvidence: PlannedEvidenceStep[] = [];

    try {
        const outputDir = path.join(runsDir, run.id);
        await fs.mkdir(outputDir, { recursive: true });
        const instrumented = instrumentRobotSource(await readSpecExecutable(version.executablePath));
        plannedEvidence = instrumented.steps;
        await fs.writeFile(path.join(outputDir, "spec.robot"), instrumented.source, "utf8");
        await fs.mkdir(path.join(outputDir, "evidence"), { recursive: true });
        const result = await runRobotProcess(outputDir, outputDir, project.baseUrl);
        if (result.timedOut) {
            failReason = `Run timed out after ${RUN_TIMEOUT_MS / 1000}s`;
        } else if (result.code === null || result.code >= 251) {
            failReason = result.output.trim().slice(0, 2000) || `robot exited with code ${result.code}`;
        } else {
            const xml = await fs.readFile(path.join(outputDir, "output.xml"), "utf8").catch(() => null);
            if (!xml) {
                failReason = result.output.trim().slice(0, 2000) || "robot produced no output.xml";
            } else {
                const parsed = parseOutputXml(xml);
                status = parsed.passed ? "passed" : "failed";
                failReason = parsed.failReason?.slice(0, 2000) ?? null;
            }
        }
    } catch (error) {
        status = "error";
        failReason = errorMessage(error);
    } finally {
        await finalizeRunEvidence(path.join(runsDir, run.id), status, plannedEvidence).catch(console.error);
        await runsRepository.finishRun(run.id, status, Date.now() - started, failReason);
    }

    const finished = await runsRepository.getRun(run.id);
    if (!finished) throw new Error("Run disappeared");
    if (options.persistFailures === false && finished.status !== "passed") {
        await fs.rm(path.join(runsDir, finished.id), { recursive: true, force: true });
        await runsRepository.deleteRun(finished.id);
        return finished;
    }
    if (finished.status === "passed" || finished.status === "failed") {
        await specsRepository.updateSpecStatusForVersion(spec.id, version.id, finished.status);
    }
    return finished;
}

export async function executeSpec(specId: string, options: { persistFailures?: boolean } = {}): Promise<Run> {
    return withSpecLock(specId, () => executeSpecLocked(specId, options));
}

export function stopActiveRobotProcesses(): void {
    for (const process of activeRobotProcesses) terminateProcessTree(process);
}
