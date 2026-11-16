import { NetworkTargetError } from "@specbook/runtime/network/targets";
import type { z } from "zod";

import { ciRepository } from "../../infra/repositories/ci";
import { featuresRepository } from "../../infra/repositories/features";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository } from "../../infra/repositories/specs";
import { tokenHash } from "../accounts/tokens";
import { resolveRunEnvironment } from "../environments";
import { startSpecBatch } from "../runner/batch";
import { ResourceBusyError } from "../specs/lifecycle";
import { requireValue } from "../utils/require-value";
import { knownBugSpecIds } from "./results";
import type { ciRunSchema } from "./schemas";
import { projectRunPolicy } from "./targets";

export class CiRequestError extends Error {
  readonly retryAfter?: number;

  readonly status: 400 | 401 | 404 | 409 | 429;

  name = "CiRequestError";

  constructor(
    message: string,
    status: 400 | 401 | 404 | 409 | 429,
    retryAfter?: number
  ) {
    super(message);
    this.retryAfter = retryAfter;

    this.status = status;
  }
}

export const acceptCiTrigger = async function acceptCiTrigger(
  projectId: string,
  authorization: string,
  target?: string,
  name?: string
) {
  if (
    !(await ciRepository.consumeRequest(
      projectId,
      tokenHash(authorization.slice("Bearer ".length))
    ))
  ) {
    throw new CiRequestError(
      "CI trigger limit reached. Retry after the current minute.",
      429,
      60 - (Math.floor(Date.now() / 1000) % 60)
    );
  }
  const project = await projectsRepository.getProject(projectId);
  if (!project) {
    throw new CiRequestError("Project not found", 404);
  }
  try {
    const environment = await resolveRunEnvironment(projectId, name, target);
    await projectRunPolicy(
      project,
      environment.baseUrl,
      undefined,
      environment
    );
    return environment;
  } catch (error) {
    if (error instanceof NetworkTargetError) {
      throw new CiRequestError(error.message, 400);
    }
    throw error;
  }
};

export const startCiRun = async function startCiRun(
  projectId: string,
  authorization: string,
  input: z.infer<typeof ciRunSchema>,
  label = "CI run"
) {
  const environment = await acceptCiTrigger(
    projectId,
    authorization,
    input.baseUrl,
    input.environment
  );
  let specs = await specsRepository.listSpecs(projectId);
  if (input.featureId) {
    const feature = await featuresRepository.getFeature(input.featureId);
    if (!feature || feature.projectId !== projectId) {
      throw new CiRequestError("Feature not found in this project", 400);
    }
    const selected = new Set(
      await featuresRepository.getFeatureDeletionSpecIds(feature.id)
    );
    specs = specs.filter((spec) => selected.has(spec.id));
  }
  if (input.specIds) {
    if (input.specIds.some((id) => !specs.some((spec) => spec.id === id))) {
      throw new CiRequestError(
        "Selected Specs must belong to this project",
        400
      );
    }
    specs = specs.filter((spec) =>
      requireValue(input.specIds).includes(spec.id)
    );
  }
  if (!input.specIds) {
    specs = specs.filter((spec) => spec.status !== "invalid");
  }
  try {
    return await startSpecBatch(
      projectId,
      specs.map((spec) => spec.id),
      label,
      {
        trigger: "ci",
        environment,
        rejectIfBusy: true,
        ci: {
          commitSha: input.commitSha,
          ref: input.ref,
          buildUrl: input.buildUrl,
          qualityGate: input.qualityGate,
          knownBugSpecIds: await knownBugSpecIds(projectId),
        },
      }
    );
  } catch (error) {
    throw new CiRequestError(
      error instanceof Error ? error.message : String(error),
      error instanceof ResourceBusyError ? 409 : 400
    );
  }
};
