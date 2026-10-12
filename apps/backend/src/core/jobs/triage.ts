import { getSecuritySettings } from "../chat/safety-settings";
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
import { isCredentialFailure, isInfrastructureFailure } from "./presentation-errors";
import { retryInfrastructure } from "./retry";
import { matchesCurrentSpec } from "./current-run";
import { reviewedScreenshots, reviewRunEvidence } from "../runner/evidence-review";
import { readEvidenceManifest, isStepScreenshot } from "@specbook/runtime/evidence";

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
    if (await jobsRepository.transition(job.id, job.status, "cancelled", { stopReason: "A newer run or Spec change superseded this failure.", retryAt: null })) {
        await jobsRepository.log(job.id, "superseded", "The failed run is no longer the current result for this Spec.");
    }
    return true;
}

export async function prepareTriageGoal(projectId: string, runId?: string) {
    const current = await currentFailure(projectId, runId);
    if (!current) throw new StaleTriageError("The failed run is no longer the current result for this Spec and behavior contract");
    const { run, spec } = current;
    const draft = !await runsRepository.hasPassed(spec.id)
        ? "\nThis Spec has never passed, so its spec.ts is an unproven draft: a wrong locator, attribute or assumption about the app is test drift. Call it an app bug only after confirming the app contradicts spec.yml and the draft's own action order did not cause the result (for example, an element left selected or focused by a previous step receiving the next input). Also fix assertions on things the app never exposes, without changing what spec.yml expects."

        : "";
    return { runId: run.id, specId: spec.id, goal: `Investigate failure in ${spec.title}`, message: `Investigate the failure of Spec "${spec.title}" (${spec.id}), run ${run.id}. Read get_failure_evidence and get_spec, reproduce in the browser, then classify with triage_failure before proposing anything. In get_failure_evidence, evidenceReview "assertion_wrong" means the screen showed the expected result: treat it as test drift unless you see the app fail.${draft}\n- Test drift (locator or timing): call update_spec with the smallest spec.ts change that keeps the same behavior and assertions, without asking. Candidates are verified in isolation and need a passing verification for approval.\n- App bug: report it with reproduction steps, observed versus expected behavior and evidence; leave the test untouched.\n- Environment (site down, expired session, missing credentials): retry if transient, otherwise ask in the Inbox and resume after the answer.\nNever change spec.yml or weaken the test to pass; ask if the intended behavior must change. End with an Inbox result.` };
}

export function createTriageTools(job: Job, abort: () => void) {
    const scrub = createProjectScrubber(job.projectId);
    return [
        defineTool({
            name: "get_failure_evidence", label: "get_failure_evidence",
            description: "Read the investigated failed run: failed step, error and accessibility context, console and network diagnostics, evidenceReview and screenshots.",
            parameters: Type.Unsafe(z.object({}).toJSONSchema()),
            async execute() {
                const run = job.runId ? await runsRepository.getRun(job.runId) : null;
                const spec = run ? await specsRepository.getSpec(run.specId) : null;
                if (!run || spec?.projectId !== job.projectId) throw new Error("Failure evidence is no longer available");
                const directory = path.join(runsDir, run.id);
                const evidence = await readEvidenceManifest(directory);
                const evidenceReview = await reviewRunEvidence(directory, { status: run.status, failReason: run.failReason && await scrub(run.failReason), failedStep: evidence.failedStep });
                const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
                    { type: "text", text: await scrub(JSON.stringify({ run, evidence, evidenceReview, artifactBase: `/runs/${run.id}/artifacts/` })) },
                ];
                for (const step of (await getSecuritySettings()).sendScreenshotsToModel ? reviewedScreenshots(evidence, await fs.readFile(path.join(directory, "spec.yml"), "utf8").catch(() => null)) : []) {
                    if (!isStepScreenshot(step.file)) continue;
                    const file = path.join(directory, step.file);
                    const bytes = await fs.readFile(file).catch(() => null);
                    if (bytes && bytes.byteLength <= 4 * 1024 * 1024) content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
                }
                return { content, details: undefined };
            },
        }),
        defineTool({
            name: "triage_failure", label: "triage_failure",
            description: "Record the cause, reproduction and evidence. Only test_drift allows a verified spec.ts fix. application_bug files an Inbox bug report; environment asks a question for credential problems and otherwise retries.",
            parameters: Type.Unsafe<z.infer<typeof triageSchema>>(triageSchema.toJSONSchema()),
            async execute(_id, input) {
                const triage = triageSchema.parse(input);
                const run = job.runId ? await runsRepository.getRun(job.runId) : null;
                const code = triage.errorCode ?? run?.errorCode;
                await jobsRepository.update(job.id, { classification: triage.classification, errorCode: code ?? (triage.classification === "environment" ? "environment" : "failed") });
                if (isInfrastructureFailure(triage.reason, code)) {
                    await retryInfrastructure(job, triage.reason, code ?? "infrastructure");
                    abort();
                    return { content: [{ type: "text" as const, text: "Specbook will retry its internal service. No Inbox decision was created." }], details: undefined, terminate: true };
                }
                const credentials = triage.classification === "environment" && isCredentialFailure(triage.reason, code);
                const body = await scrub(`${triage.reason}\n\nReproduction:\n${triage.reproduction.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\nEvidence:\n${triage.evidence.join("\n")}\nRun: ${job.runId}`);
                const kind = triage.classification === "application_bug" ? "bug_report" : credentials ? "question" : "note";
                const item = await jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind,
                    title: kind === "bug_report" ? "The app did not behave as expected. What should happen next?" : credentials ? "Can you restore access to the app?" : "The failure was investigated", body,
                    payload: { errorCode: credentials ? "credentials" : code ?? (triage.classification === "environment" ? "environment" : "failed"), runId: job.runId, specId: job.specId, language: "en", classification: triage.classification, ...(credentials ? { waitingFor: "credentials" } : {}) } });
                if (triage.classification === "environment" && !credentials) {
                    await jobsRepository.transition(job.id, "running", "queued", { retryAt: new Date(Date.now() + 60_000).toISOString(), systemError: null, errorCode: "environment",
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
