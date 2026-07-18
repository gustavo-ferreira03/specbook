import fs from "node:fs/promises";
import path from "node:path";
import { featuresRepository, type Feature } from "../../infra/repositories/features";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { withSpecLock } from "../specs/lifecycle";
import { assertRepoWritableUnlocked, commitAll, repoDir, withRepoLock } from "./git";
import { reindexProjectUnlocked } from "./indexer";
import { schedulePush } from "./remote";
import { createSpecInRepo, featureYamlFile, specRobotFile, specYamlFile } from "./writer";

async function readOptional(target: string): Promise<string | null> {
    try {
        return await fs.readFile(target, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export class RepoConflictError extends Error {}

async function assertNoSyncConflict(projectId: string): Promise<void> {
    const project = await projectsRepository.getProject(projectId);
    if (project?.gitConflictPaths?.length) {
        throw new RepoConflictError("Resolve the git sync conflict before editing this project");
    }
}

async function commitAndReindex(projectId: string, message: string): Promise<void> {
    await commitAll(projectId, message);
    schedulePush(projectId);
    await reindexProjectUnlocked(projectId);
}

export async function readSpecRawFiles(spec: Spec): Promise<{ yaml: string | null; robot: string | null }> {
    const root = repoDir(spec.projectId);
    const [yaml, robot] = await Promise.all([
        readOptional(path.join(root, specYamlFile(spec.path))),
        readOptional(path.join(root, specRobotFile(spec.path))),
    ]);
    return { yaml, robot };
}

export async function readFeatureRaw(feature: Feature): Promise<string | null> {
    return readOptional(path.join(repoDir(feature.projectId), featureYamlFile(feature.path)));
}

export async function readContextRaw(projectId: string): Promise<string | null> {
    return readOptional(path.join(repoDir(projectId), "context.yml"));
}

export async function editSpecFiles(spec: Spec, input: { yaml?: string; robot?: string }): Promise<Spec> {
    return withSpecLock(spec.id, () =>
        withRepoLock(spec.projectId, async () => {
            await assertNoSyncConflict(spec.projectId);
            await assertRepoWritableUnlocked(spec.projectId);
            const root = repoDir(spec.projectId);
            if (input.yaml !== undefined) {
                await fs.writeFile(path.join(root, specYamlFile(spec.path)), input.yaml, "utf8");
            }
            if (input.robot !== undefined) {
                await fs.writeFile(path.join(root, specRobotFile(spec.path)), input.robot, "utf8");
            }
            await commitAndReindex(spec.projectId, `spec: edit "${spec.title}"`);
            const updated = await specsRepository.getSpec(spec.id);
            if (!updated) throw new Error("Spec was removed during reindex");
            return updated;
        }),
    );
}

export async function createManualSpec(projectId: string, featureId: string, title: string): Promise<Spec> {
    const robotSource = [
        "*** Settings ***",
        "Library    Browser",
        "",
        "*** Test Cases ***",
        title,
        "    Abrir a aplicação",
        "",
        "*** Keywords ***",
        "Abrir a aplicação",
        "    New Browser    chromium    headless=true",
        "    New Page    ${BASE_URL}",
        "",
    ].join("\n");
    const { spec } = await createSpecInRepo({
        projectId,
        featureId,
        title,
        description: "",
        humanSpec: { preconditions: [], steps: [], expectedResult: "", postconditions: [] },
        robotSource,
    });
    return spec;
}

export async function editFeatureFile(feature: Feature, yaml: string): Promise<Feature> {
    return withRepoLock(feature.projectId, async () => {
        await assertNoSyncConflict(feature.projectId);
        await assertRepoWritableUnlocked(feature.projectId);
        await fs.writeFile(path.join(repoDir(feature.projectId), featureYamlFile(feature.path)), yaml, "utf8");
        await commitAndReindex(feature.projectId, `feature: edit "${feature.title}"`);
        const updated = await featuresRepository.getFeature(feature.id);
        if (!updated) throw new Error("Feature was removed during reindex");
        return updated;
    });
}

export async function editContextFile(projectId: string, yaml: string): Promise<void> {
    await withRepoLock(projectId, async () => {
        await assertNoSyncConflict(projectId);
        await assertRepoWritableUnlocked(projectId);
        await fs.writeFile(path.join(repoDir(projectId), "context.yml"), yaml, "utf8");
        await commitAndReindex(projectId, "context: edit");
    });
}
