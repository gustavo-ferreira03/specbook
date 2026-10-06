import path from "node:path";
import { featuresRepository, type Feature } from "../../infra/repositories/features";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { withSpecLock } from "../specs/lifecycle";
import { repoGit } from "./git";
import { reindexProjectUnlocked } from "./indexer";
import { repoRemote } from "./remote";
import { readOptionalRepoFile, writeRepoFile } from "./safe-fs";
import { createSpecInRepo, featureYamlFile, specTestFile, specYamlFile } from "./writer";

export class RepoConflictError extends Error {}

async function assertNoSyncConflict(projectId: string): Promise<void> {
    const project = await projectsRepository.getProject(projectId);
    if (project?.gitConflictPaths?.length) {
        throw new RepoConflictError("Resolve the git sync conflict before editing this project");
    }
}

async function commitAndReindex(projectId: string, message: string): Promise<void> {
    await repoGit.commitAll(projectId, message);
    repoRemote.schedulePush(projectId);
    await reindexProjectUnlocked(projectId);
}

export async function readSpecRawFiles(
    spec: Spec,
): Promise<{ yaml: string | null; testSource: string | null }> {
    const root = repoGit.getRepoDir(spec.projectId);
    const [yaml, testSource] = await Promise.all([
        readOptionalRepoFile(root, path.join(root, specYamlFile(spec.path))),
        readOptionalRepoFile(root, path.join(root, specTestFile(spec.path))),
    ]);
    return { yaml, testSource };
}

/** A minimal valid spec.ts whose single step matches the template's spec.yml. */
export function manualSpecTemplate(title: string): { testSource: string; steps: string[] } {
    const step = "Open the application";
    const testSource = [
        'import { test, expect } from "specbook";',
        "",
        `test(${JSON.stringify(title)}, async ({ page, step }) => {`,
        `    await step(${JSON.stringify(step)}, async () => {`,
        '        await page.goto("/");',
        '        await expect(page.locator("body")).toBeVisible();',
        "    });",
        "});",
        "",
    ].join("\n");
    return { testSource, steps: [step] };
}

export async function readFeatureRaw(feature: Feature): Promise<string | null> {
    const root = repoGit.getRepoDir(feature.projectId);
    return readOptionalRepoFile(root, path.join(root, featureYamlFile(feature.path)));
}

export async function readContextRaw(projectId: string): Promise<string | null> {
    const root = repoGit.getRepoDir(projectId);
    return readOptionalRepoFile(root, path.join(root, "context.yml"));
}

export async function editSpecFiles(spec: Spec, input: { yaml?: string; testSource?: string }): Promise<Spec> {
    return withSpecLock(spec.id, () =>
        repoGit.withRepoLock(spec.projectId, async () => {
            await assertNoSyncConflict(spec.projectId);
            await repoGit.assertRepoWritableUnlocked(spec.projectId);
            const root = repoGit.getRepoDir(spec.projectId);
            if (input.yaml !== undefined) {
                await writeRepoFile(root, path.join(root, specYamlFile(spec.path)), input.yaml);
            }
            if (input.testSource !== undefined) {
                await writeRepoFile(root, path.join(root, specTestFile(spec.path)), input.testSource);

            }
            await commitAndReindex(spec.projectId, `spec: edit "${spec.title}"`);
            const updated = await specsRepository.getSpec(spec.id);
            if (!updated) throw new Error("Spec was removed during reindex");
            return updated;
        }),
    );
}

export async function createManualSpec(projectId: string, featureId: string, title: string): Promise<Spec> {
    const template = manualSpecTemplate(title);
    const { spec } = await createSpecInRepo({
        projectId,
        featureId,
        title,
        description: "",
        humanSpec: { preconditions: [], steps: template.steps, expectedResult: "", postconditions: [] },
        testSource: template.testSource,
    });
    return spec;
}

export async function editFeatureFile(feature: Feature, yaml: string): Promise<Feature> {
    return repoGit.withRepoLock(feature.projectId, async () => {
        await assertNoSyncConflict(feature.projectId);
        await repoGit.assertRepoWritableUnlocked(feature.projectId);
        const root = repoGit.getRepoDir(feature.projectId);
        await writeRepoFile(root, path.join(root, featureYamlFile(feature.path)), yaml);
        await commitAndReindex(feature.projectId, `feature: edit "${feature.title}"`);
        const updated = await featuresRepository.getFeature(feature.id);
        if (!updated) throw new Error("Feature was removed during reindex");
        return updated;
    });
}

export async function editContextFile(projectId: string, yaml: string): Promise<void> {
    await repoGit.withRepoLock(projectId, async () => {
        await assertNoSyncConflict(projectId);
        await repoGit.assertRepoWritableUnlocked(projectId);
        const root = repoGit.getRepoDir(projectId);
        await writeRepoFile(root, path.join(root, "context.yml"), yaml);
        await commitAndReindex(projectId, "context: edit");
    });
}
