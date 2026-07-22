import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HumanSpec, ProjectContext } from "../../infra/db/schema";
import { featuresRepository, type Feature } from "../../infra/repositories/features";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { repoGit } from "./git";
import { repoRemote } from "./remote";
import { uniqueSlug } from "./slug";
import {
    parseSpecYaml,
    serializeContextYaml,
    serializeFeatureYaml,
    serializeSpecYaml,
} from "./yaml";

export function robotHashOf(source: string): string {
    return crypto.createHash("sha256").update(source).digest("hex");
}

export function specYamlFile(specPath: string): string {
    return `${specPath}/spec.yml`;
}

export function specRobotFile(specPath: string): string {
    return `${specPath}/spec.robot`;
}

export function featureYamlFile(featurePath: string): string {
    return `${featurePath}/feature.yml`;
}

export function markdownHashOf(source: string): string {
    return crypto.createHash("sha256").update(source).digest("hex");
}

function absolute(projectId: string, relative: string): string {
    const root = repoGit.getRepoDir(projectId);
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) throw new Error("Path escapes project repo");
    return resolved;
}

async function siblingNames(projectId: string, dirRelative: string): Promise<Set<string>> {
    const entries = await fs.readdir(absolute(projectId, dirRelative), { withFileTypes: true }).catch(() => []);
    const names = new Set<string>(["feature", "context"]);
    for (const entry of entries) {
        names.add(entry.isDirectory() ? entry.name : entry.name.replace(/\.(yml|robot)$/, ""));
    }
    return names;
}

export async function createFeatureInRepo(
    projectId: string,
    parentId: string | null,
    title: string,
    description: string,
): Promise<Feature> {
    return repoGit.withRepoLock(projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(projectId);
        const parent = parentId ? await featuresRepository.getFeature(parentId) : null;
        if (parentId && (!parent || parent.projectId !== projectId)) throw new Error("Parent feature not found");
        const parentPath = parent ? parent.path : "specs";
        const id = crypto.randomUUID();
        const slug = uniqueSlug(title, await siblingNames(projectId, parentPath), id);
        const featurePath = `${parentPath}/${slug}`;
        await fs.mkdir(absolute(projectId, featurePath), { recursive: true });
        await fs.writeFile(
            absolute(projectId, featureYamlFile(featurePath)),
            serializeFeatureYaml({ title, description }),
            "utf8",
        );
        await repoGit.commitAll(projectId, `feature: create "${title}"`);
        repoRemote.schedulePush(projectId);
        return featuresRepository.createFeature(projectId, parentId, title, description, featurePath, id);
    });
}

export async function createSpecInRepo(input: {
    projectId: string;
    featureId: string;
    title: string;
    description: string;
    humanSpec: HumanSpec;
    robotSource: string;
}): Promise<{ spec: Spec; commitSha: string }> {
    return repoGit.withRepoLock(input.projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(input.projectId);
        const feature = await featuresRepository.getFeature(input.featureId);
        if (!feature || feature.projectId !== input.projectId) throw new Error("Feature not found");
        const id = crypto.randomUUID();
        const slug = uniqueSlug(input.title, await siblingNames(input.projectId, feature.path), id);
        const specPath = `${feature.path}/${slug}`;
        const markdown = serializeSpecYaml({
            title: input.title,
            description: input.description,
            humanSpec: input.humanSpec,
        });
        await fs.mkdir(absolute(input.projectId, specPath), { recursive: true });
        await fs.writeFile(absolute(input.projectId, specYamlFile(specPath)), markdown, "utf8");
        await fs.writeFile(absolute(input.projectId, specRobotFile(specPath)), input.robotSource, "utf8");
        const commitSha = await repoGit.commitAll(input.projectId, `spec: create "${input.title}"`);
        repoRemote.schedulePush(input.projectId);
        const now = new Date().toISOString();
        const spec: Spec = {
            id,
            projectId: input.projectId,
            featureId: input.featureId,
            title: input.title,
            description: input.description,
            status: "unverified",
            path: specPath,
            robotHash: robotHashOf(input.robotSource),
            markdownHash: markdownHashOf(markdown),
            invalidReason: null,
            createdAt: now,
            updatedAt: now,
        };
        await specsRepository.createSpecRecordRow(spec);
        return { spec, commitSha };
    });
}

export async function updateFeatureInRepo(
    feature: Feature,
    patch: { title?: string; description?: string },
): Promise<Feature> {
    return repoGit.withRepoLock(feature.projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(feature.projectId);
        const title = patch.title ?? feature.title;
        const description = patch.description ?? feature.description;

        const dir = path.posix.dirname(feature.path);
        const currentSlug = path.posix.basename(feature.path);
        let featurePath = feature.path;
        if (patch.title !== undefined) {
            const taken = await siblingNames(feature.projectId, dir);
            taken.delete(currentSlug);
            const slug = uniqueSlug(title, taken, feature.id);
            if (slug !== currentSlug) {
                featurePath = `${dir}/${slug}`;
                await fs.rename(absolute(feature.projectId, feature.path), absolute(feature.projectId, featurePath));
            }
        }
        await fs.writeFile(
            absolute(feature.projectId, featureYamlFile(featurePath)),
            serializeFeatureYaml({ title, description }),
            "utf8",
        );
        await repoGit.commitAll(feature.projectId, `feature: update "${title}"`);
        repoRemote.schedulePush(feature.projectId);
        await featuresRepository.updateFeatureRecord(feature.id, { title, description, path: featurePath });
        const updated = await featuresRepository.getFeature(feature.id);
        if (!updated) throw new Error("Feature disappeared during update");
        return updated;
    });
}

export async function readSpecFiles(spec: Spec): Promise<{ humanSpec: HumanSpec; robotSource: string }> {
    const markdown = await fs.readFile(absolute(spec.projectId, specYamlFile(spec.path)), "utf8");
    const robotSource = await fs.readFile(absolute(spec.projectId, specRobotFile(spec.path)), "utf8");
    return { humanSpec: parseSpecYaml(markdown).humanSpec, robotSource };
}

export async function updateSpecInRepo(
    spec: Spec,
    patch: { title?: string; description?: string; humanSpec?: HumanSpec; robotSource?: string },
): Promise<{ spec: Spec; commitSha: string }> {
    return repoGit.withRepoLock(spec.projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(spec.projectId);
        const current = await readSpecFiles(spec);
        const title = patch.title ?? spec.title;
        const description = patch.description ?? spec.description;
        const humanSpec = patch.humanSpec ?? current.humanSpec;
        const robotSource = patch.robotSource ?? current.robotSource;

        const dir = path.posix.dirname(spec.path);
        const currentSlug = path.posix.basename(spec.path);
        let specPath = spec.path;
        if (patch.title !== undefined) {
            const taken = await siblingNames(spec.projectId, dir);
            taken.delete(currentSlug);
            const slug = uniqueSlug(title, taken, spec.id);
            if (slug !== currentSlug) {
                specPath = `${dir}/${slug}`;
                await fs.rename(absolute(spec.projectId, spec.path), absolute(spec.projectId, specPath));
            }
        }
        const markdown = serializeSpecYaml({ title, description, humanSpec });
        await fs.writeFile(absolute(spec.projectId, specYamlFile(specPath)), markdown, "utf8");
        await fs.writeFile(absolute(spec.projectId, specRobotFile(specPath)), robotSource, "utf8");
        const commitSha = await repoGit.commitAll(spec.projectId, `spec: update "${title}"`);
        repoRemote.schedulePush(spec.projectId);
        const robotHash = robotHashOf(robotSource);
        await specsRepository.updateSpecRecord(spec.id, {
            title,
            description,
            path: specPath,
            robotHash,
            markdownHash: markdownHashOf(markdown),
            status: "unverified",
            invalidReason: null,
        });
        const updated = await specsRepository.getSpec(spec.id);
        if (!updated) throw new Error("Spec disappeared during update");
        return { spec: updated, commitSha };
    });
}

export async function deleteSpecFiles(spec: Spec): Promise<void> {
    await repoGit.withRepoLock(spec.projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(spec.projectId);
        await fs.rm(absolute(spec.projectId, spec.path), { recursive: true, force: true });
        await repoGit.commitAll(spec.projectId, `spec: delete "${spec.title}"`);
        repoRemote.schedulePush(spec.projectId);
    });
}

export async function deleteFeatureDirectory(projectId: string, featurePath: string, title: string): Promise<void> {
    await repoGit.withRepoLock(projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(projectId);
        await fs.rm(absolute(projectId, featurePath), { recursive: true, force: true });
        await repoGit.commitAll(projectId, `feature: delete "${title}"`);
        repoRemote.schedulePush(projectId);
    });
}

export async function writeContextToRepo(projectId: string, context: ProjectContext): Promise<void> {
    await repoGit.withRepoLock(projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(projectId);
        await fs.writeFile(absolute(projectId, "context.yml"), serializeContextYaml(context), "utf8");
        await repoGit.commitAll(projectId, "context: update");
        repoRemote.schedulePush(projectId);
    });
}
