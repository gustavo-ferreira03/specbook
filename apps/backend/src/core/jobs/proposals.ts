import { parseSpecYaml } from "@specbook/runtime/yaml";
import type { z } from "zod";

import { featuresRepository } from "../../infra/repositories/features";
import { jobsRepository } from "../../infra/repositories/jobs";
import type { InboxItem, Job } from "../../infra/repositories/jobs";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository } from "../../infra/repositories/specs";
import { repoGit } from "../repo/git";
import { readSpecRawFiles } from "../repo/manual";
import {
  createFeatureInRepo,
  createSpecInRepo,
  updateSpecInRepo,
  validateSpec,
  sourceHashOf,
} from "../repo/writer";
import { withSpecLock } from "../specs/lifecycle";
import { requireValue } from "../utils/require-value";
import { jobBaseUrl } from "./environment";
import {
  payloadOf,
  verificationOf,
  featureProposalSchema,
  fixProposalSchema,
  newSpecProposalSchema,
} from "./schemas";

export const isImplementationOnly = function isImplementationOnly(
  patch: FixProposal
): patch is FixProposal & { testSource: string } {
  return (
    Boolean(patch.testSource) &&
    !patch.humanSpec &&
    patch.title === undefined &&
    patch.description === undefined
  );
};

export const proposeMutation = async function proposeMutation(
  job: Job,
  name: string,
  input: unknown
): Promise<InboxItem> {
  if (
    job.kind === "failure_triage" &&
    (await (async () => {
      const resolvedValue1396 = await jobsRepository.get(job.id);
      return resolvedValue1396?.classification;
    })()) !== "test_drift"
  ) {
    throw new Error(
      "Investigate and classify the failure as test_drift before proposing an implementation fix."
    );
  }
  if (job.kind === "failure_triage" || job.kind === "regenerate") {
    const patch = fixProposalSchema.parse(input);
    if (
      name !== "update_spec" ||
      patch.specId !== job.specId ||
      !isImplementationOnly(patch)
    ) {
      throw new Error(
        job.kind === "failure_triage"
          ? "Healing changes only this Spec’s implementation. Propose any behavior change as an Inbox question."
          : "Regeneration changes only spec.ts. Ask the human about changes to spec.yml."
      );
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
      if (!spec || spec.projectId !== job.projectId) {
        throw new Error("Spec not found in this project");
      }
      const raw = await readSpecRawFiles(spec);
      if (!raw.yaml) {
        throw new Error(
          "Spec has no behavior contract. Ask the human to repair spec.yml."
        );
      }
      const humanSpec = patch.humanSpec ?? parseSpecYaml(raw.yaml).humanSpec;
      const validation = validateSpec(
        patch.testSource ?? raw.testSource ?? "",
        humanSpec
      );
      if (!validation.ok) {
        throw new Error(validation.error);
      }
      kind = "spec_fix";
      title = `Proposed fix: ${spec.title}`;
      params = patch;
      before = { yaml: raw.yaml, testSource: raw.testSource };
    } else if (name === "create_spec") {
      const proposed = newSpecProposalSchema.parse(input);
      const feature = await featuresRepository.getFeature(proposed.featureId);
      if (!feature || feature.projectId !== job.projectId) {
        throw new Error("Feature not found in this project");
      }
      const validation = validateSpec(proposed.testSource, proposed.humanSpec);
      if (!validation.ok) {
        throw new Error(validation.error);
      }
      kind = "new_spec";
      title = `Proposed Spec: ${proposed.title}`;
      params = proposed;
    } else {
      const proposed = featureProposalSchema.parse(input);
      if (proposed.parentId) {
        const parent = await featuresRepository.getFeature(proposed.parentId);
        if (!parent || parent.projectId !== job.projectId) {
          throw new Error("Parent feature not found in this project");
        }
      }
      kind = "feature";
      title = `Proposed Feature: ${proposed.title}`;
      params = proposed;
    }
    const rejected = await (async () => {
      const awaitedValue4254 = await jobsRepository.itemsByKind(
        job.projectId,
        kind,
        ["rejected"]
      );
      return awaitedValue4254.find(
        (item) =>
          item.status === "rejected" &&
          item.kind === kind &&
          JSON.stringify(payloadOf(item).params) === JSON.stringify(params)
      );
    })();
    if (rejected) {
      throw new Error(
        "The human rejected this proposal. Respect that decision; ask a question if new evidence changes the recommendation."
      );
    }
    const payload = {
      errorCode: "failed",
      baseHead,
      params,
      before,
      requiresVerification: ["failure_triage", "regenerate"].includes(job.kind),
    };
    const existing = await (async () => {
      const awaitedValue4893 = await jobsRepository.itemsForJob(job.id, {
        statuses: ["pending"],
      });
      return awaitedValue4893.find(
        (item) =>
          item.jobId === job.id &&
          item.status === "pending" &&
          payloadOf(item).baseHead === baseHead &&
          JSON.stringify(payloadOf(item).params) === JSON.stringify(params)
      );
    })();
    if (existing) {
      return existing;
    }
    return jobsRepository.addItem({
      jobId: job.id,
      projectId: job.projectId,
      kind,
      title,
      body: "Review the proposed files below. Approval commits this change to the project repository.",
      payload,
    });
  });
};

export const applyProposal = async function applyProposal(
  item: InboxItem,
  checkPolicy?: () => Promise<void>
): Promise<string> {
  const marker = `inbox:${item.id}`;
  const git = repoGit.getProjectGit(item.projectId);
  const previous = await git.raw([
    "log",
    "--format=%H",
    "--fixed-strings",
    `--grep=${marker}`,
    "-1",
  ]);
  if (previous.trim()) {
    return previous.trim();
  }
  if (
    payloadOf(item).requiresVerification &&
    verificationOf(item)?.status !== "passed"
  ) {
    throw new Error(
      "This proposal needs a passing verification before approval"
    );
  }
  const options = {
    expectedHead: String(payloadOf(item).baseHead),
    commitMessage: `${marker} ${item.title}`,
    checkPolicy,
  };
  if (item.kind === "spec_fix") {
    const { specId, ...patch } = fixProposalSchema.parse(
      payloadOf(item).params
    );
    if (payloadOf(item).requiresVerification) {
      const verified = requireValue(verificationOf(item));
      const project = await projectsRepository.getProject(item.projectId);
      const job = await jobsRepository.get(item.jobId);
      const override = job ? await jobBaseUrl(job) : undefined;
      if (
        verified.sourceHash !== sourceHashOf(patch.testSource ?? "") ||
        verified.baseUrl !== (override ?? project?.baseUrl)
      ) {
        throw new Error(
          "Proposal source or project URL changed; verify again before approval"
        );
      }
    }
    return withSpecLock(specId, async () => {
      const spec = await specsRepository.getSpec(specId);
      if (!spec || spec.projectId !== item.projectId) {
        throw new Error("Spec no longer exists in this project");
      }
      return await (async () => {
        const awaitedValue7197 = await updateSpecInRepo(spec, patch, {
          ...options,
          expectedHead: undefined,
          expectedSpec: {
            yaml: payloadOf(item).before?.yaml ?? "",
            testSource: payloadOf(item).before?.testSource ?? null,
          },
        });
        return awaitedValue7197.commitSha;
      })();
    });
  }
  if (item.kind === "new_spec") {
    const input = newSpecProposalSchema.parse(payloadOf(item).params);
    return await (async () => {
      const awaitedValue7621 = await createSpecInRepo(
        { ...input, projectId: item.projectId },
        options
      );
      return awaitedValue7621.commitSha;
    })();
  }
  if (item.kind === "feature") {
    const input = featureProposalSchema.parse(payloadOf(item).params);
    await createFeatureInRepo(
      item.projectId,
      input.parentId ?? null,
      input.title,
      input.description,
      options
    );
    return await (async () => {
      const awaitedValue7986 = await git.raw([
        "log",
        "--format=%H",
        "--fixed-strings",
        `--grep=${marker}`,
        "-1",
      ]);
      return awaitedValue7986.trim();
    })();
  }
  throw new Error("This Inbox item has no repository change to approve");
};

type FixProposal = z.infer<typeof fixProposalSchema>;
