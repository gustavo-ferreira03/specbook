import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { runsRepository } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { runsDir } from "../paths";
import { createProjectScrubber } from "../credentials/scrub";
import { triageSchema } from "./schemas";
import { isInfrastructureFailure } from "./presentation-errors";
import { retryInfrastructure } from "./retry";
import { matchesCurrentSpec } from "./current-run";

export class StaleTriageError extends Error {}

export async function currentFailure(projectId: string, runId?: string) {
    const run = runId ? await runsRepository.getRun(runId) : null;
    const spec = run ? await specsRepository.getSpec(run.specId) : null;
    if (!run || !spec || spec.projectId !== projectId || run.flaky || !["failed", "error"].includes(run.status)) return null;
    if ((await runsRepository.listRuns(spec.id, { limit: 1 }))[0]?.id !== run.id || !await matchesCurrentSpec(run, spec)) return null;
    return { run, spec };
}

export async function cancelStaleTriage(job: Job): Promise<boolean> {
    if (job.kind !== "failure_triage" || await currentFailure(job.projectId, job.runId ?? undefined)) return false;
    if (await jobsRepository.transition(job.id, job.status, "cancelled", { stopReason: "A newer check or Spec change superseded this failure.", retryAt: null })) {
        await jobsRepository.log(job.id, "superseded", "The failed run is no longer the current result for this check.");
    }
    return true;
}

export async function prepareTriageGoal(projectId: string, runId?: string) {
    const current = await currentFailure(projectId, runId);
    if (!current) throw new StaleTriageError("The failed run is no longer the current result for this Spec and behavior contract");
    const { run, spec } = current;
    return { runId: run.id, specId: spec.id, goal: `Investigate failure in ${spec.title}`, message: `Investigate the failure of Spec "${spec.title}" (${spec.id}), run ${run.id}. Read get_failure_evidence and get_spec, then investigate the application in the browser. Classify with triage_failure before proposing a fix.\nTest drift (locator or timing): propose the smallest spec.ts change that restores the SAME behavior and assertions. update_spec verifies candidates in isolation; a passing verification is required for approval.\nApplication bug: submit a bug report with precise repro steps, observed versus expected behavior and evidence; leave the test untouched.\nEnvironment (unavailable site, expired session, missing credentials): retry if transient, otherwise ask a question through the Inbox and resume after the answer.\nNever change spec.yml or weaken the test to make it pass. Ask the human if the intended behavior must change. Do not claim drift when the app violates the contract. End with an Inbox result.` };
}

export function createTriageTools(job: Job, abort: () => void) {
    const scrub = createProjectScrubber(job.projectId);
    return [
        defineTool({
            name: "get_failure_evidence", label: "get_failure_evidence",
            description: "Read the failed run, step, ARIA/error context, console/network diagnostics and screenshots being investigated.",
            parameters: Type.Unsafe(z.object({}).toJSONSchema()),
            async execute() {
                const run = job.runId ? await runsRepository.getRun(job.runId) : null;
                const spec = run ? await specsRepository.getSpec(run.specId) : null;
                if (!run || spec?.projectId !== job.projectId) throw new Error("Failure evidence is no longer available");
                const directory = path.join(runsDir, run.id);
                const evidence = JSON.parse(await fs.readFile(path.join(directory, "evidence.json"), "utf8").catch(() => "{}")) as { steps?: { file: string }[] };
                const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
                    { type: "text", text: await scrub(JSON.stringify({ run, evidence, artifactBase: `/runs/${run.id}/artifacts/` })) },
                ];
                for (const step of (evidence.steps ?? []).slice(-2)) {
                    if (!/^evidence\/step-\d{2,3}\.png$/.test(step.file)) continue;
                    const file = path.join(directory, step.file);
                    const bytes = await fs.readFile(file).catch(() => null);
                    if (bytes && bytes.byteLength <= 4 * 1024 * 1024) content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
                }
                return { content, details: undefined };
            },
        }),
        defineTool({
            name: "triage_failure", label: "triage_failure",
            description: "Record the investigated cause, reproduction and evidence. Only test_drift allows a verified implementation fix. Application bugs create an Inbox bug report; environment issues create a question.",
            parameters: Type.Unsafe<z.infer<typeof triageSchema>>(triageSchema.toJSONSchema()),
            async execute(_id, input) {
                const triage = triageSchema.parse(input);
                await jobsRepository.update(job.id, { classification: triage.classification });
                if (isInfrastructureFailure(triage.reason)) {
                    await retryInfrastructure(job, triage.reason);
                    abort();
                    return { content: [{ type: "text" as const, text: "Specbook will retry its internal service. No Inbox decision was created." }], details: undefined, terminate: true };
                }
                const credentials = triage.classification === "environment" && /credential|session|login|sign.in|authentication|credencia|sessão/i.test(triage.reason);
                const body = await scrub(`${triage.reason}\n\nReproduction:\n${triage.reproduction.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\nEvidence:\n${triage.evidence.join("\n")}\nRun: ${job.runId}`);
                const kind = triage.classification === "application_bug" ? "bug_report" : credentials ? "question" : "note";
                const item = await jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind,
                    title: kind === "bug_report" ? "The app did not behave as expected. What should happen next?" : credentials ? "Can you restore access to the app?" : "The failure was investigated", body,
                    payload: { runId: job.runId, specId: job.specId, language: "en", classification: triage.classification, ...(credentials ? { waitingFor: "credentials" } : {}) } });
                if (triage.classification === "environment" && !credentials) {
                    await jobsRepository.transition(job.id, "running", "queued", { retryAt: new Date(Date.now() + 60_000).toISOString(), systemError: null,
                        pendingMessage: "Check whether the app is available again. Retry the original investigation without changing its intended behavior. Availability failures are progress updates, not questions for the human." });
                    abort();
                }
                if (kind === "question") {
                    await jobsRepository.transition(job.id, "running", "blocked");
                    abort();
                }
                return { content: [{ type: "text" as const, text: JSON.stringify({ inboxId: item.id, classification: triage.classification }) }], details: undefined, terminate: kind === "question" || triage.classification === "environment" };
            },
        }),
    ];
}
