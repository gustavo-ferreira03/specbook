import { jobsRepository } from "../../infra/repositories/jobs";
import { runsRepository } from "../../infra/repositories/runs";
import type { RunBatch } from "../runner/batch";

export async function knownBugSpecIds(projectId: string): Promise<string[]> {
    const [items, jobs] = await Promise.all([jobsRepository.inbox(projectId), jobsRepository.list(projectId)]);
    const ids = items.filter((item) => item.kind === "bug_report" && item.status === "pending").flatMap((item) => {
        const id = typeof item.payload.specId === "string" ? item.payload.specId : jobs.find((job) => job.id === item.jobId)?.specId;
        return id ? [id] : [];
    });
    return [...new Set(ids)];
}

export async function ciResult(batch: RunBatch) {
    const frontend = (process.env.FRONTEND_ORIGIN ?? "http://localhost:4001").replace(/\/$/, "");
    const url = `${frontend}/p/${batch.projectId}/settings?tab=ci#ci-batch-${batch.id}`;
    const known = new Set(batch.ci?.knownBugSpecIds ?? []);
    const gate = batch.ci?.qualityGate ?? { failOnFlaky: false, failOnKnownBugs: false };
    const results = await Promise.all(batch.specs.map(async (item) => {
        const run = await runsRepository.getRun(item.runId);
        const retry = await runsRepository.retryFor(item.runId);
        const flaky = run?.flaky === true || retry?.status === "passed";
        const knownBug = known.has(item.specId);
        const status = run?.status ?? item.status;
        const failed = ["failed", "error"].includes(status);
        const pending = status === "running" || retry?.status === "running" || (failed && run?.automationPending === true && !retry);
        const failsGate = !pending && ((flaky && gate.failOnFlaky) || (failed && !flaky && (!knownBug || gate.failOnKnownBugs)));
        return { ...item, status, failReason: run?.failReason ?? item.failReason, flaky, knownBug, pending, failsGate,
            retryRunId: retry?.id ?? null,
            url: `${frontend}/p/${batch.projectId}/specs/${item.specId}#run-${item.runId}`,
            evidenceUrl: `/runs/${item.runId}/evidence` };
    }));
    const complete = batch.status !== "running" && results.every((item) => !item.pending);
    const infrastructureError = batch.status === "error" && !results.some((item) => ["failed", "error"].includes(item.status));
    const failures = results.filter((item) => item.failsGate).length + (infrastructureError ? 1 : 0);
    const passed = complete && failures === 0 && !infrastructureError;
    const status = !complete ? "running" : passed ? "passed" : batch.status === "error" ? "error" : "failed";
    return { batch, status, complete, qualityGate: { passed, failures, flaky: results.filter((item) => item.flaky).length, knownBugs: results.filter((item) => item.knownBug && ["failed", "error"].includes(item.status)).length }, url, results };
}

export type CiResult = Awaited<ReturnType<typeof ciResult>>;

function xml(value: string) {
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);
}

export function junitResult(result: CiResult): string {
    const tests = result.results.map((item) => {
        const skipped = item.pending || (!item.failsGate && (item.flaky || ["failed", "error"].includes(item.status)));
        const detail = item.failsGate ? `<failure message="${xml(item.failReason ?? (item.flaky ? "Passed only after retry" : "Spec failed"))}">${xml(item.url)}</failure>`
            : skipped ? `<skipped message="${item.pending ? "Still running" : item.flaky ? "Flaky: passed on retry" : "Open bug report"}"/>` : "";
        return `  <testcase name="${xml(item.title)}" classname="Specbook" time="${((item.durationMs ?? 0) / 1000).toFixed(3)}">${detail}<system-out>${xml(item.url)}</system-out></testcase>`;
    });
    if (result.qualityGate.failures > result.results.filter((item) => item.failsGate).length) {
        tests.push(`  <testcase name="Batch execution" classname="Specbook"><failure message="${xml(result.batch.failReason ?? "Batch execution failed")}"/></testcase>`);
    }
    const skipped = result.results.filter((item) => item.pending || (!item.failsGate && (item.flaky || ["failed", "error"].includes(item.status)))).length;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(result.batch.label)}" tests="${tests.length}" failures="${result.qualityGate.failures}" skipped="${skipped}" time="${((result.batch.durationMs ?? 0) / 1000).toFixed(3)}">\n${tests.join("\n")}\n</testsuite>\n`;
}

const markdown = (value: string) => value.replace(/[\\`*_{}[\]<>|]/g, "\\$&").replace(/[\r\n]+/g, " ");

export function markdownResult(result: CiResult): string {
    const lines = [`## Specbook: ${result.status}`, "", `[View results](${result.url})`, ""];
    if (result.batch.ci?.commitSha) lines.push(`Commit: ${markdown(result.batch.ci.commitSha)}`, "");
    if (result.batch.ci?.ref) lines.push(`Ref: ${markdown(result.batch.ci.ref)}`, "");
    lines.push("| Spec | Result |", "| --- | --- |");
    for (const item of result.results) {
        const status = item.pending ? "Running" : item.flaky ? "Flaky (passed on retry)" : item.knownBug && ["failed", "error"].includes(item.status) ? "Known bug" : item.status;
        lines.push(`| [${markdown(item.title)}](${item.url}) | ${status}${item.failsGate ? " · fails gate" : ""} |`);
    }
    lines.push("", `Quality gate: ${result.complete ? result.qualityGate.passed ? "passed" : "failed" : "pending"}. ${result.qualityGate.failures} failure(s), ${result.qualityGate.flaky} flaky, ${result.qualityGate.knownBugs} known bug(s).`, "");
    return lines.join("\n");
}
