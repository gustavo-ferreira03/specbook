import crypto from "node:crypto";
import { jobBaseUrl } from "./environment";
import fs from "node:fs/promises";
import path from "node:path";
import { jobsRepository, type InboxItem, type Job } from "../../infra/repositories/jobs";
import { projectsRepository } from "../../infra/repositories/projects";
import { runsDir } from "../paths";
import { repoGit } from "../repo/git";
import { specsRepository } from "../../infra/repositories/specs";
import { readSpecRawFiles } from "../repo/manual";
import { sourceHashOf } from "../repo/writer";
import { parseSpecYaml } from "../repo/yaml";
import { resolveSecretEnv } from "../credentials/profiles";
import { projectSecretScrubber } from "../credentials/scrub";
import { runPlaywrightSuite } from "../runner/playwright";
import { withRunSlot } from "../runner/process";
import { analyzeSpecSource, stepTitlesError } from "../runner/validate";
import { resolveSecretOriginPolicy } from "../runner/secrets";
import { fixProposalSchema } from "./schemas";
import { isAgentPaused } from "./pause";

export interface ProposalVerification {
    id: string;
    status: "passed" | "failed" | "error";
    durationMs: number | null;
    failReason: string | null;
    failedStep: string | null;
    sourceHash: string;
    baseUrl: string;
    screenshots: string[];
}

export function proposalDirectory(item: InboxItem, verificationId: string): string {
    if (![item.projectId, item.id, verificationId].every((value) => /^[a-f0-9-]{36}$/.test(value))) throw new Error("Invalid proposal artifact id");
    return path.join(runsDir, "proposals", item.projectId, item.id, verificationId);
}

export async function verifyProposal(job: Job, item: InboxItem, signal?: AbortSignal): Promise<ProposalVerification> {
    if (item.jobId !== job.id || item.status !== "pending") throw new Error("Only this job's pending proposals can be verified");
    const patch = fixProposalSchema.parse(item.payload.params);
    const before = item.payload.before as { yaml?: string };
    if (!patch.testSource || !before.yaml) throw new Error("Proposal needs spec.ts and a behavior contract");
    const analysis = analyzeSpecSource(patch.testSource);
    if (!analysis.ok) throw new Error(analysis.error);
    const stepsError = stepTitlesError(analysis.analysis.steps, (patch.humanSpec ?? parseSpecYaml(before.yaml).humanSpec).steps);
    if (stepsError) throw new Error(stepsError);
    const project = await projectsRepository.getProject(job.projectId);
    if (!project) throw new Error("Project not found");
    const baseUrl = await jobBaseUrl(job) ?? project.baseUrl;
    const spec = await specsRepository.getSpec(patch.specId);
    if (!spec || spec.projectId !== job.projectId) throw new Error("Spec no longer exists");
    const raw = await repoGit.withRepoLock(job.projectId, () => readSpecRawFiles(spec));
    const original = item.payload.before as { yaml: string; testSource: string | null };
    if (raw.yaml !== original.yaml || raw.testSource !== original.testSource) {
        throw new Error("Proposal is stale; inspect the current Spec and propose again");
    }
    const refs = analysis.analysis.secretRefs.map((ref) => ref.envName);
    const { env: secretEnv, missing } = await resolveSecretEnv(job.projectId, refs);
    if (missing.length) throw new Error(`Missing credentials: ${missing.join(", ")}. Ask the human to configure them in Settings > Credentials.`);
    const secretOrigins = await resolveSecretOriginPolicy(job.projectId, refs);
    const scrub = await projectSecretScrubber(job.projectId);
    const id = crypto.randomUUID();
    const directory = proposalDirectory(item, id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "spec.ts"), patch.testSource);
    await fs.writeFile(path.join(directory, "spec.yml"), before.yaml);
    const outcome = await withRunSlot(async () => {
        signal?.throwIfAborted();
        const current = await jobsRepository.get(job.id);
        if (!current || current.status !== "running" || await isAgentPaused(job.projectId)) throw new Error("Job is no longer running");
        const remaining = current.limits.wallTimeMs - current.elapsedMs - Math.max(0, Date.now() - Date.parse(current.startedAt ?? new Date().toISOString()));
        if (remaining <= 0) throw new Error("The investigation has not reached a confirmed result");
        return runPlaywrightSuite({ projectId: job.projectId, directory, baseUrl,
            specs: [{ key: id, source: patch.testSource!, analysis: analysis.analysis, outputDir: directory }],
            timeoutMs: Math.min(120_000, remaining), secretEnv, secretOrigins, scrub, signal });
    }, signal);
    const result = outcome.results.get(id);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "evidence.json"), "utf8")) as { steps: { file: string }[] };
    const verification: ProposalVerification = {
        id, status: outcome.processFailure ? "error" : result?.status ?? "error", durationMs: result?.durationMs ?? null,
        failReason: scrub(outcome.processFailure ?? result?.failReason ?? "") || null, failedStep: result?.failedStep ?? null,
        sourceHash: sourceHashOf(patch.testSource), baseUrl, screenshots: manifest.steps.map((step) => step.file),
    };
    const current = await jobsRepository.item(item.id);
    if (current?.status !== "pending") throw new Error("Proposal was reviewed during verification");
    await jobsRepository.updateItem(item.id, { payload: { ...current.payload, verification } });
    await jobsRepository.log(job.id, "proposal:verified", `${item.id}: ${verification.status}`);
    return verification;
}
