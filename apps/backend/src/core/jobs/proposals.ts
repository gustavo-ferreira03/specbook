import type { z } from "zod";
import { jobBaseUrl } from "./environment";
import { jobsRepository, type InboxItem, type Job } from "../../infra/repositories/jobs";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository } from "../../infra/repositories/specs";
import { featuresRepository } from "../../infra/repositories/features";
import { repoGit } from "../repo/git";
import { readSpecRawFiles } from "../repo/manual";
import { createFeatureInRepo, createSpecInRepo, updateSpecInRepo, validateSpec, sourceHashOf } from "../repo/writer";
import { parseSpecYaml } from "../repo/yaml";
import { withSpecLock } from "../specs/lifecycle";
import { featureProposalSchema, fixProposalSchema, newSpecProposalSchema } from "./schemas";

type FixProposal = z.infer<typeof fixProposalSchema>;

export function isImplementationOnly(patch: FixProposal): patch is FixProposal & { testSource: string } {
    return Boolean(patch.testSource) && !patch.humanSpec && patch.title === undefined && patch.description === undefined;
}

export async function proposeMutation(job: Job, name: string, input: unknown): Promise<InboxItem> {
    if (job.kind === "failure_triage" && (await jobsRepository.get(job.id))?.classification !== "test_drift") {
        throw new Error("Investigate and classify the failure as test_drift before proposing an implementation fix.");
    }
    if (job.kind === "failure_triage" || job.kind === "regenerate") {
        const patch = fixProposalSchema.parse(input);
        if (name !== "update_spec" || patch.specId !== job.specId || !isImplementationOnly(patch)) {
            throw new Error(job.kind === "failure_triage"
                ? "Healing changes only this Spec’s implementation. Propose any behavior change as an Inbox question."
                : "Regeneration changes only spec.ts. Ask the human about changes to spec.yml.");
        }
    }
    return repoGit.withRepoLock(job.projectId, async () => {
        const baseHead = await repoGit.getHeadSha(job.projectId);
        let kind: InboxItem["kind"];
        let title: string;
        let params: Record<string, unknown>;
        let before: Record<string, unknown> = {};
        if (name === "update_spec") {
            const patch = fixProposalSchema.parse(input);
            const spec = await specsRepository.getSpec(patch.specId);
            if (!spec || spec.projectId !== job.projectId) throw new Error("Spec not found in this project");
            const raw = await readSpecRawFiles(spec);
            if (!raw.yaml) throw new Error("Spec has no behavior contract. Ask the human to repair spec.yml.");
            const humanSpec = patch.humanSpec ?? parseSpecYaml(raw.yaml).humanSpec;
            const validation = validateSpec(patch.testSource ?? raw.testSource ?? "", humanSpec);
            if (!validation.ok) throw new Error(validation.error);
            kind = "spec_fix";
            title = `Proposed fix: ${spec.title}`;
            params = patch;
            before = { yaml: raw.yaml, testSource: raw.testSource };
        } else if (name === "create_spec") {
            const proposed = newSpecProposalSchema.parse(input);
            const feature = await featuresRepository.getFeature(proposed.featureId);
            if (!feature || feature.projectId !== job.projectId) throw new Error("Feature not found in this project");
            const validation = validateSpec(proposed.testSource, proposed.humanSpec);
            if (!validation.ok) throw new Error(validation.error);
            kind = "new_spec";
            title = `Proposed Spec: ${proposed.title}`;
            params = proposed;
        } else {
            const proposed = featureProposalSchema.parse(input);
            if (proposed.parentId) {
                const parent = await featuresRepository.getFeature(proposed.parentId);
                if (!parent || parent.projectId !== job.projectId) throw new Error("Parent feature not found in this project");
            }
            kind = "feature";
            title = `Proposed Feature: ${proposed.title}`;
            params = proposed;
        }
        const rejected = (await jobsRepository.inbox(job.projectId)).find((item) =>
            item.status === "rejected" && item.kind === kind && JSON.stringify(item.payload.params) === JSON.stringify(params));
        if (rejected) throw new Error("The human rejected this proposal. Respect that decision; ask a question if new evidence changes the recommendation.");
        const payload = { baseHead, params, before, requiresVerification: ["failure_triage", "regenerate"].includes(job.kind) };
        const existing = (await jobsRepository.inbox(job.projectId)).find((item) =>
            item.jobId === job.id && item.status === "pending" && item.payload.baseHead === baseHead && JSON.stringify(item.payload.params) === JSON.stringify(params));
        if (existing) return existing;
        return jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind, title,
            body: "Review the proposed files below. Approval commits this change to the project repository.", payload });
    });
}

export async function applyProposal(item: InboxItem, checkPolicy?: () => Promise<void>): Promise<string> {
    const marker = `inbox:${item.id}`;
    const git = repoGit.getProjectGit(item.projectId);
    const previous = await git.raw(["log", "--format=%H", "--fixed-strings", `--grep=${marker}`, "-1"]);
    if (previous.trim()) return previous.trim();
    if (item.payload.requiresVerification && (item.payload.verification as { status?: string } | undefined)?.status !== "passed") {
        throw new Error("This proposal needs a passing verification before approval");
    }
    const options = { expectedHead: String(item.payload.baseHead), commitMessage: `${marker} ${item.title}`, checkPolicy };
    if (item.kind === "spec_fix") {
        const { specId, ...patch } = fixProposalSchema.parse(item.payload.params);
        if (item.payload.requiresVerification) {
            const verified = item.payload.verification as { sourceHash: string; baseUrl: string };
            const project = await projectsRepository.getProject(item.projectId);
            const job = await jobsRepository.get(item.jobId);
            const override = job ? await jobBaseUrl(job) : undefined;
            if (verified.sourceHash !== sourceHashOf(patch.testSource ?? "") || verified.baseUrl !== (override ?? project?.baseUrl)) {
                throw new Error("Proposal source or project URL changed; verify again before approval");
            }
        }
        return withSpecLock(specId, async () => {
            const spec = await specsRepository.getSpec(specId);
            if (!spec || spec.projectId !== item.projectId) throw new Error("Spec no longer exists in this project");
            return (await updateSpecInRepo(spec, patch, { ...options, expectedHead: undefined, expectedSpec: item.payload.before as { yaml: string; testSource: string | null } })).commitSha;
        });
    }
    if (item.kind === "new_spec") {
        const input = newSpecProposalSchema.parse(item.payload.params);
        return (await createSpecInRepo({ ...input, projectId: item.projectId }, options)).commitSha;
    }
    if (item.kind === "feature") {
        const input = featureProposalSchema.parse(item.payload.params);
        await createFeatureInRepo(item.projectId, input.parentId ?? null, input.title, input.description, options);
        return (await git.raw(["log", "--format=%H", "--fixed-strings", `--grep=${marker}`, "-1"])).trim();
    }
    throw new Error("This Inbox item has no repository change to approve");
}
