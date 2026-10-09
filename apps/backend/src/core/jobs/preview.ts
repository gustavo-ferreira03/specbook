import type { InboxItem } from "../../infra/repositories/jobs";
import { specsRepository } from "../../infra/repositories/specs";
import { parseSpecYaml, serializeFeatureYaml, serializeSpecYaml } from "../repo/yaml";
import { featureProposalSchema, fixProposalSchema, newSpecProposalSchema } from "./schemas";

interface ProposalFile {
    path: string;
    before: string | null;
    after: string;
}

export async function proposalFiles(item: InboxItem): Promise<ProposalFile[]> {
    if (item.kind === "feature") {
        return [{ path: "feature.yml", before: null, after: serializeFeatureYaml(featureProposalSchema.parse(item.payload.params)) }];
    }
    if (item.kind === "new_spec") {
        const proposed = newSpecProposalSchema.parse(item.payload.params);
        return [
            { path: "spec.yml", before: null, after: serializeSpecYaml(proposed) },
            { path: "spec.ts", before: null, after: proposed.testSource },
        ];
    }
    if (item.kind !== "spec_fix") return [];
    const patch = fixProposalSchema.parse(item.payload.params);
    const before = item.payload.before as { yaml: string; testSource: string | null };
    const original = parseSpecYaml(before.yaml);
    const yaml = patch.title === undefined && patch.description === undefined && patch.humanSpec === undefined
        ? before.yaml
        : serializeSpecYaml({
            title: patch.title ?? original.title ?? (await specsRepository.getSpec(patch.specId))?.title ?? "",
            description: patch.description ?? original.description,
            humanSpec: patch.humanSpec ?? original.humanSpec,
        });
    return [
        { path: "spec.yml", before: before.yaml, after: yaml },
        { path: "spec.ts", before: before.testSource, after: patch.testSource ?? before.testSource ?? "" },
    ];
}
