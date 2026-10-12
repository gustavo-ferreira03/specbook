import { UnsafeRepoPathError } from "@specbook/runtime/safe-fs";
import { parseSpecYaml } from "@specbook/runtime/yaml";
import { readSpecRawFiles } from "../repo/manual";
import type { HumanSpec } from "../../infra/db/schema";
import { featuresRepository } from "../../infra/repositories/features";
import { runsRepository } from "../../infra/repositories/runs";
import type { Spec } from "../../infra/repositories/specs";
import { specEnvironmentsRepository } from "../../infra/repositories/spec-environments";
import { environmentsRepository } from "../../infra/repositories/environments";

export async function specDetail(spec: Spec, runLimit?: number) {
    const feature = await featuresRepository.getFeature(spec.featureId);
    const runs = await runsRepository.listRuns(spec.id, { limit: runLimit });
    const raw = await readSpecRawFiles(spec).catch((error) => {
        if (error instanceof UnsafeRepoPathError) return { yaml: null, testSource: null };
        throw error;
    });
    let humanSpec: HumanSpec | null = null;
    if (raw.yaml !== null) {
        try {
            humanSpec = parseSpecYaml(raw.yaml).humanSpec;
        } catch {
            humanSpec = null;
        }
    }
    const content =
        raw.yaml !== null || raw.testSource !== null
            ? {
                  humanSpec,
                  testSource: raw.testSource ?? "",
                  yamlSource: raw.yaml ?? "",
              }
            : null;
    const environments = await environmentsRepository.list(spec.projectId);
    const environmentStates = (await specEnvironmentsRepository.list(spec)).map((state) => ({
        ...state,
        name: environments.find((environment) => environment.id === state.environmentId)?.name,
    }));
    return { spec, feature, content, runs, environmentStates };
}

