import { jobsRepository, type InboxItem, type Job } from "../../infra/repositories/jobs";
import { specsRepository } from "../../infra/repositories/specs";
import { featuresRepository } from "../../infra/repositories/features";
import { repoGit } from "../repo/git";
import { readSpecRawFiles } from "../repo/manual";
import { createFeatureInRepo, createSpecInRepo, updateSpecInRepo, validateSpec } from "../repo/writer";
import { parseSpecYaml } from "../repo/yaml";
import { withSpecLock } from "../specs/lifecycle";
import { featureProposalSchema, fixProposalSchema, newSpecProposalSchema } from "./schemas";

export async function proposeMutation(job: Job, name: string, input: unknown): Promise<InboxItem> {
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
            before = { yaml: raw.yaml, testSource: raw.testSource, legacyRobotSource: raw.legacyRobotSource };
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
        const payload = { baseHead, params, before };
        const existing = (await jobsRepository.inbox(job.projectId)).find((item) =>
            item.jobId === job.id && item.status === "pending" && JSON.stringify(item.payload) === JSON.stringify(payload));
        if (existing) return existing;
        return jobsRepository.addItem({ jobId: job.id, projectId: job.projectId, kind, title,
            body: "Review the proposed files below. Approval commits this change to the project repository.", payload });
    });
}

export async function applyProposal(item: InboxItem): Promise<string> {
    const marker = `inbox:${item.id}`;
    // Makes approval replay safe if the commit succeeded before the DB update.
    const git = repoGit.getProjectGit(item.projectId);
    const previous = await git.raw(["log", "--format=%H", "--fixed-strings", `--grep=${marker}`, "-1"]);
    if (previous.trim()) return previous.trim();
    const options = { expectedHead: String(item.payload.baseHead), commitMessage: `${marker} ${item.title}` };
    if (item.kind === "spec_fix") {
        const { specId, ...patch } = fixProposalSchema.parse(item.payload.params);
        return withSpecLock(specId, async () => {
            const spec = await specsRepository.getSpec(specId);
            if (!spec || spec.projectId !== item.projectId) throw new Error("Spec no longer exists in this project");
            return (await updateSpecInRepo(spec, patch, options)).commitSha;
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
