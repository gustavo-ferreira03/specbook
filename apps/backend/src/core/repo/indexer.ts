import fs from "node:fs/promises";
import path from "node:path";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import { featuresRepository, type Feature } from "../../infra/repositories/features";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { runsDir } from "../paths";
import { namedRobotStepsError } from "../runner/evidence";
import { validateRobotSource } from "../runner/validate";
import {
    commitAll,
    deleteRunCommitRefsUnlocked,
    ensureProjectRepo,
    projectGit,
    repoDir,
    withRepoLock,
} from "./git";
import { schedulePush } from "./remote";
import { humanizeSlug } from "./slug";
import { featureYamlFile, markdownHashOf, robotHashOf, specRobotFile, specYamlFile } from "./writer";
import {
    parseFeatureYaml,
    parseSpecYaml,
    parseContextYaml,
    parseYamlTitle,
    YamlParseError,
} from "./yaml";

export type RobotValidator = (source: string) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface ReindexResult {
    specsSeen: number;
    specsRemoved: number;
    featuresRemoved: number;
    invalidSpecs: string[];
}

interface FoundSpec {
    path: string;
    dirPath: string;
    yaml: string;
}

async function isDirectory(target: string): Promise<boolean> {
    try {
        return (await fs.stat(target)).isDirectory();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function readOptionalFile(target: string): Promise<string | null> {
    try {
        return await fs.readFile(target, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

async function walk(
    root: string,
    relative: string,
    dirs: string[],
    found: FoundSpec[],
): Promise<void> {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
        const entryRelative = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
            const specYaml = await readOptionalFile(path.join(root, specYamlFile(entryRelative)));
            if (specYaml !== null) {
                found.push({ path: entryRelative, dirPath: relative, yaml: specYaml });
            } else {
                dirs.push(entryRelative);
                await walk(root, entryRelative, dirs, found);
            }
        }
    }
}

async function upsertFeatures(
    projectId: string,
    dirs: string[],
): Promise<{ byPath: Map<string, Feature>; unseen: Feature[] }> {
    const root = repoDir(projectId);
    const existing = await featuresRepository.listFeatures(projectId);
    const byPath = new Map<string, Feature>();
    const seenIds = new Set<string>();
    const sortedDirs = [...dirs].sort();
    const docs = new Map<string, ReturnType<typeof parseFeatureYaml> | null>();

    for (const dir of sortedDirs) {
        let doc: ReturnType<typeof parseFeatureYaml> | null = null;
        const yamlSource = await readOptionalFile(path.join(root, featureYamlFile(dir)));
        if (yamlSource !== null) {
            try {
                doc = parseFeatureYaml(yamlSource);
            } catch {}
        }
        docs.set(dir, doc);
    }

    for (const dir of sortedDirs) {
        const doc = docs.get(dir) ?? null;
        const parentPath = path.posix.dirname(dir);
        const parent = parentPath === "specs" ? null : byPath.get(parentPath) ?? null;
        const title = doc?.title ?? humanizeSlug(path.posix.basename(dir));
        const description = doc?.description ?? "";
        let feature = existing.find((row) => row.path === dir);

        if (feature) {
            await featuresRepository.updateFeatureRecord(feature.id, {
                title,
                description,
                path: dir,
                parentId: parent?.id ?? null,
            });
            feature = { ...feature, title, description, path: dir, parentId: parent?.id ?? null };
        } else {
            feature = await featuresRepository.createFeature(
                projectId,
                parent?.id ?? null,
                title,
                description,
                dir,
            );
        }
        seenIds.add(feature.id);
        byPath.set(dir, feature);
    }

    return { byPath, unseen: existing.filter((feature) => !seenIds.has(feature.id)) };
}

async function removeRunDirs(projectId: string, runIds: string[]): Promise<void> {
    await deleteRunCommitRefsUnlocked(projectId, runIds);
    await Promise.allSettled(
        runIds.map((runId) => fs.rm(path.join(runsDir, runId), { recursive: true, force: true })),
    );
}

async function reconcileContext(projectId: string): Promise<void> {
    const source = await readOptionalFile(path.join(repoDir(projectId), "context.yml"));
    if (source === null) return;
    try {
        const context = parseContextYaml(source);
        const latest = await projectContextsRepository.getLatestConfirmedProjectContext(projectId);
        if (!latest || JSON.stringify(latest.context) !== JSON.stringify(context)) {
            const project = await projectsRepository.getProject(projectId);
            const brief = latest?.brief ?? {
                goal: "",
                startUrl: project?.baseUrl ?? "",
                maxActions: 0,
                safetyNotes: [],
            };
            await projectContextsRepository.insertConfirmedRevision(projectId, brief, context);
        }
        await projectsRepository.setContextSyncError(projectId, null);
    } catch (error) {
        await projectsRepository.setContextSyncError(
            projectId,
            error instanceof Error ? error.message : String(error),
        );
    }
}

export async function reindexProject(
    projectId: string,
    options: { validate?: RobotValidator; allowDirty?: boolean } = {},
): Promise<ReindexResult> {
    return withRepoLock(projectId, () => reindexProjectUnlocked(projectId, options));
}

export async function reindexProjectUnlocked(
    projectId: string,
    options: { validate?: RobotValidator; allowDirty?: boolean } = {},
): Promise<ReindexResult> {
    const validate = options.validate ?? validateRobotSource;
    const root = repoDir(projectId);
    if (
        await isDirectory(path.join(root, ".git", "rebase-merge")) ||
        await isDirectory(path.join(root, ".git", "rebase-apply"))
    ) {
        throw new Error("Cannot reindex while a git rebase is in progress");
    }
    const initialStatus = await projectGit(projectId).status();
    if (initialStatus.conflicted.length > 0) {
        throw new Error("Cannot reindex a working tree with unresolved git conflicts");
    }
    if (options.allowDirty === false && !initialStatus.isClean()) {
        throw new Error("Refusing automatic reindex of a dirty project repository");
    }
    const dirs: string[] = [];
    const found: FoundSpec[] = [];
    const hasSpecsDir = await isDirectory(path.join(root, "specs"));
    if (hasSpecsDir) await walk(root, "specs", dirs, found);

    const existingSpecs = await specsRepository.listSpecs(projectId);
    const specsByPath = new Map(existingSpecs.map((spec) => [spec.path, spec]));
    const titlesByPath = new Map<string, string | null>();
    for (const item of found) {
        titlesByPath.set(item.path, parseYamlTitle(item.yaml));
    }

    const { byPath: featuresByPath, unseen: unseenFeatures } = await upsertFeatures(projectId, dirs);
    const seenIds = new Set<string>();
    const invalidSpecs: string[] = [];

    for (const item of found) {
        const feature = featuresByPath.get(item.dirPath);
        if (!feature) continue;

        let doc: ReturnType<typeof parseSpecYaml> | null = null;
        let parseError: string | null = null;
        try {
            doc = parseSpecYaml(item.yaml);
        } catch (error) {
            parseError = error instanceof YamlParseError ? error.message : String(error);
        }

        const existing = specsByPath.get(item.path);
        const title = doc?.title ?? titlesByPath.get(item.path) ?? existing?.title ?? humanizeSlug(path.posix.basename(item.path));
        const robotSource = await readOptionalFile(path.join(root, specRobotFile(item.path)));
        const robotHash = robotSource === null ? "" : robotHashOf(robotSource);
        const markdownHash = markdownHashOf(item.yaml);
        let status: Spec["status"] = "unverified";
        let invalidReason: string | null = null;

        if (parseError) {
            status = "invalid";
            invalidReason = `Invalid spec.yml: ${parseError}`;
        } else if (robotSource === null) {
            status = "invalid";
            invalidReason = "Missing spec.robot file in the spec directory";
        } else if (
            existing &&
            existing.robotHash === robotHash &&
            existing.markdownHash === markdownHash &&
            existing.status !== "conflict" &&
            existing.status !== "invalid"
        ) {
            status = existing.status;
            invalidReason = existing.invalidReason;
        } else {
            const stepError = namedRobotStepsError(robotSource);
            const validation = stepError ? { ok: false as const, error: stepError } : await validate(robotSource);
            if (!validation.ok) {
                status = "invalid";
                invalidReason = validation.error;
            }
        }

        let spec: Spec;
        if (existing) {
            await specsRepository.updateSpecRecord(existing.id, {
                title,
                description: doc?.description ?? existing.description,
                featureId: feature.id,
                path: item.path,
                robotHash,
                markdownHash,
                status,
                invalidReason,
            });
            spec = existing;
        } else {
            spec = await specsRepository.createSpecRecord({
                projectId,
                featureId: feature.id,
                title,
                description: doc?.description ?? "",
                path: item.path,
                robotHash,
                markdownHash,
                status,
                invalidReason,
            });
        }
        seenIds.add(spec.id);
        if (status === "invalid") invalidSpecs.push(spec.id);
    }

    let specsRemoved = 0;
    for (const spec of existingSpecs) {
        if (seenIds.has(spec.id)) continue;
        const result = await specsRepository.deleteSpecWithRelations(spec.id);
        if (result.status === "deleted") {
            await removeRunDirs(projectId, result.runIds);
            specsRemoved += 1;
        }
    }

    let featuresRemoved = 0;
    for (const feature of unseenFeatures) {
        const result = await featuresRepository.deleteFeatureWithRelations(feature.id);
        if (result.status === "deleted") {
            await removeRunDirs(projectId, result.runIds);
            featuresRemoved += 1;
        }
    }

    const workingTreeChanged = !(await projectGit(projectId).status()).isClean();
    if (workingTreeChanged) {
        await commitAll(projectId, "specbook: import working tree changes");
        schedulePush(projectId);
    }

    await reconcileContext(projectId);
    return { specsSeen: found.length, specsRemoved, featuresRemoved, invalidSpecs };
}

export async function reindexAllProjects(): Promise<void> {
    for (const project of await projectsRepository.listProjects()) {
        try {
            await ensureProjectRepo(project.id);
            await reindexProject(project.id, { allowDirty: false });
        } catch (error) {
            console.error(`[specbook] reindex failed for project ${project.id}:`, error);
        }
    }
}
