import fs from "node:fs/promises";
import path from "node:path";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import { featuresRepository, type Feature } from "../../infra/repositories/features";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { runsDir } from "../paths";
import { namedRobotStepsError } from "../runner/evidence";
import { validateRobotSource } from "../runner/validate";
import { parseContextMarkdown } from "./contextMarkdown";
import {
    commitAll,
    deleteRunCommitRefsUnlocked,
    ensureProjectRepo,
    projectGit,
    repoDir,
    withRepoLock,
} from "./git";
import {
    MarkdownParseError,
    parseFeatureMarkdown,
    parseMarkdownIdentity,
    parseSpecMarkdown,
    serializeSpecMarkdown,
} from "./markdown";
import { schedulePush } from "./remote";
import { humanizeSlug } from "./slug";
import { markdownHashOf, robotHashOf } from "./writer";

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
    markdown: string;
}

function isUuid(value: string | null | undefined): value is string {
    return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
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

async function walk(root: string, relative: string, dirs: string[], found: FoundSpec[]): Promise<void> {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
        const entryRelative = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
            dirs.push(entryRelative);
            await walk(root, entryRelative, dirs, found);
        } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "feature.md") {
            found.push({
                path: entryRelative.slice(0, -3),
                dirPath: relative,
                markdown: await fs.readFile(path.join(root, entryRelative), "utf8"),
            });
        }
    }
}

async function upsertFeatures(
    projectId: string,
    dirs: string[],
): Promise<{ byPath: Map<string, Feature>; unseen: Feature[] }> {
    const root = repoDir(projectId);
    const existing = await featuresRepository.listFeatures(projectId);
    const byId = new Map(existing.map((feature) => [feature.id, feature]));
    const byPath = new Map<string, Feature>();
    const seenIds = new Set<string>();
    const sortedDirs = [...dirs].sort();
    const docs = new Map<string, ReturnType<typeof parseFeatureMarkdown> | null>();
    const pathsById = new Map<string, string[]>();

    for (const dir of sortedDirs) {
        const source = await readOptionalFile(path.join(root, dir, "feature.md"));
        let doc: ReturnType<typeof parseFeatureMarkdown> | null = null;
        if (source !== null) {
            try {
                doc = parseFeatureMarkdown(source);
            } catch {}
        }
        docs.set(dir, doc);
        if (isUuid(doc?.id)) pathsById.set(doc.id, [...(pathsById.get(doc.id) ?? []), dir]);
    }

    const ignoredIds = new Set<string>();
    for (const [id, paths] of pathsById) {
        if (paths.length < 2) continue;
        const preferred = existing.find((feature) => feature.id === id && paths.includes(feature.path))?.path ?? paths[0];
        for (const featurePath of paths) if (featurePath !== preferred) ignoredIds.add(featurePath);
    }

    for (const dir of sortedDirs) {
        const doc = docs.get(dir) ?? null;
        const docId = isUuid(doc?.id) && !ignoredIds.has(dir) ? doc.id : null;
        const parentPath = path.posix.dirname(dir);
        const parent = parentPath === "specs" ? null : byPath.get(parentPath) ?? null;
        const title = doc?.title ?? humanizeSlug(path.posix.basename(dir));
        const description = doc?.description ?? "";
        let feature = (docId ? byId.get(docId) : undefined) ?? existing.find((row) => row.path === dir);

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
                docId ?? undefined,
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
    const source = await readOptionalFile(path.join(repoDir(projectId), "context.md"));
    if (source === null) return;
    try {
        const context = parseContextMarkdown(source);
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
    const specsById = new Map(existingSpecs.map((spec) => [spec.id, spec]));
    const specsByPath = new Map(existingSpecs.map((spec) => [spec.path, spec]));
    const identities = new Map<string, ReturnType<typeof parseMarkdownIdentity> | null>();
    const pathsById = new Map<string, string[]>();
    for (const item of found) {
        let identity: ReturnType<typeof parseMarkdownIdentity> | null = null;
        try {
            identity = parseMarkdownIdentity(item.markdown);
        } catch {}
        identities.set(item.path, identity);
        if (isUuid(identity?.id)) pathsById.set(identity.id, [...(pathsById.get(identity.id) ?? []), item.path]);
    }
    const ignoredIds = new Set<string>();
    for (const [id, paths] of pathsById) {
        if (paths.length < 2) continue;
        const preferred = existingSpecs.find((spec) => spec.id === id && paths.includes(spec.path))?.path ?? paths.sort()[0];
        for (const specPath of paths) if (specPath !== preferred) ignoredIds.add(specPath);
    }

    const { byPath: featuresByPath, unseen: unseenFeatures } = await upsertFeatures(projectId, dirs);
    const seenIds = new Set<string>();
    const invalidSpecs: string[] = [];
    let needsMetadataCommit = false;

    for (const item of found) {
        const feature = featuresByPath.get(item.dirPath);
        if (!feature) continue;

        let doc: ReturnType<typeof parseSpecMarkdown> | null = null;
        let parseError: string | null = null;
        try {
            doc = parseSpecMarkdown(item.markdown);
        } catch (error) {
            parseError = error instanceof MarkdownParseError ? error.message : String(error);
        }

        const identity = identities.get(item.path) ?? null;
        const docId = isUuid(identity?.id) && !ignoredIds.has(item.path) ? identity.id : null;
        const existing = (docId ? specsById.get(docId) : undefined) ?? specsByPath.get(item.path);
        const title = doc?.title ?? identity?.title ?? existing?.title ?? humanizeSlug(path.posix.basename(item.path));
        const robotSource = await readOptionalFile(path.join(root, `${item.path}.robot`));
        const robotHash = robotSource === null ? "" : robotHashOf(robotSource);
        const markdownHash = markdownHashOf(item.markdown);
        let status: Spec["status"] = "unverified";
        let invalidReason: string | null = null;

        if (parseError) {
            status = "invalid";
            invalidReason = `Invalid spec markdown: ${parseError}`;
        } else if (robotSource === null) {
            status = "invalid";
            invalidReason = "Missing .robot file next to the spec markdown";
        } else if (
            existing &&
            existing.robotHash === robotHash &&
            existing.markdownHash === markdownHash &&
            existing.status !== "conflict"
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
                id: docId ?? undefined,
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

        if (doc && doc.id !== spec.id) {
            const normalized = serializeSpecMarkdown({
                id: spec.id,
                title,
                description: doc.description,
                humanSpec: doc.humanSpec,
            });
            await fs.writeFile(
                path.join(root, `${item.path}.md`),
                normalized,
                "utf8",
            );
            await specsRepository.updateSpecRecord(spec.id, { markdownHash: markdownHashOf(normalized) });
            needsMetadataCommit = true;
        }
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
        await commitAll(
            projectId,
            needsMetadataCommit ? "specbook: normalize metadata" : "specbook: import working tree changes",
        );
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
