import fs from "node:fs/promises";
import path from "node:path";
import type { HumanSpec } from "../../infra/db/schema";
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
import { parseFeatureMarkdown, parseMarkdownIdentity, parseSpecMarkdown } from "./markdown";
import { schedulePush } from "./remote";
import { humanizeSlug } from "./slug";
import { featureYamlFile, markdownHashOf, robotHashOf, specRobotFile, specYamlFile } from "./writer";
import {
    parseFeatureYaml,
    parseSpecYaml,
    parseContextYaml,
    parseYamlIdentity,
    serializeContextYaml,
    serializeFeatureYaml,
    serializeSpecYaml,
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

async function migrateFlatSpec(root: string, dirRelative: string, fileName: string): Promise<string | null> {
    const base = fileName.slice(0, -3);
    const specDir = `${dirRelative}/${base}`;
    if (await isDirectory(path.join(root, specDir))) {
        console.error(`[specbook] cannot migrate flat spec "${dirRelative}/${fileName}": directory "${specDir}" already exists`);
        return null;
    }
    await fs.mkdir(path.join(root, specDir), { recursive: true });
    await fs.rename(path.join(root, `${specDir}.md`), path.join(root, `${specDir}/spec.md`));
    const robotFlat = path.join(root, `${specDir}.robot`);
    const hasRobot = await fs.stat(robotFlat).then((stat) => stat.isFile()).catch(() => false);
    if (hasRobot) await fs.rename(robotFlat, path.join(root, specRobotFile(specDir)));
    return specDir;
}

async function convertLegacySpecMarkdown(root: string, specDir: string): Promise<boolean> {
    const legacyPath = path.join(root, `${specDir}/spec.md`);
    const legacy = await readOptionalFile(legacyPath);
    if (legacy === null) return false;
    let identity: { id: string | null; title: string | null } = { id: null, title: null };
    try {
        identity = parseMarkdownIdentity(legacy);
    } catch {}
    let doc: { id: string | null; title: string | null; description: string; humanSpec: HumanSpec };
    try {
        doc = parseSpecMarkdown(legacy);
    } catch {
        doc = {
            id: identity.id,
            title: identity.title,
            description: legacy.trim(),
            humanSpec: { preconditions: [], steps: [], expectedResult: "", postconditions: [] },
        };
    }
    await fs.writeFile(
        path.join(root, specYamlFile(specDir)),
        serializeSpecYaml({
            id: doc.id ?? "",
            title: doc.title ?? "",
            description: doc.description,
            humanSpec: doc.humanSpec,
        }),
        "utf8",
    );
    await fs.rm(legacyPath, { force: true });
    return true;
}

async function walk(
    root: string,
    relative: string,
    dirs: string[],
    found: FoundSpec[],
    migrated: { count: number },
): Promise<void> {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
        const entryRelative = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
            let specYaml = await readOptionalFile(path.join(root, specYamlFile(entryRelative)));
            if (specYaml === null && (await convertLegacySpecMarkdown(root, entryRelative))) {
                migrated.count += 1;
                specYaml = await readOptionalFile(path.join(root, specYamlFile(entryRelative)));
            }
            if (specYaml !== null) {
                found.push({ path: entryRelative, dirPath: relative, yaml: specYaml });
            } else {
                dirs.push(entryRelative);
                await walk(root, entryRelative, dirs, found, migrated);
            }
        } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "feature.md") {
            const specDir = await migrateFlatSpec(root, relative, entry.name);
            if (specDir === null) continue;
            migrated.count += 1;
            await convertLegacySpecMarkdown(root, specDir);
            found.push({
                path: specDir,
                dirPath: relative,
                yaml: await fs.readFile(path.join(root, specYamlFile(specDir)), "utf8"),
            });
        }
    }
}

async function upsertFeatures(
    projectId: string,
    dirs: string[],
    migrated: { count: number },
): Promise<{ byPath: Map<string, Feature>; unseen: Feature[] }> {
    const root = repoDir(projectId);
    const existing = await featuresRepository.listFeatures(projectId);
    const byId = new Map(existing.map((feature) => [feature.id, feature]));
    const byPath = new Map<string, Feature>();
    const seenIds = new Set<string>();
    const sortedDirs = [...dirs].sort();
    const docs = new Map<string, ReturnType<typeof parseFeatureYaml> | null>();
    const pathsById = new Map<string, string[]>();

    for (const dir of sortedDirs) {
        let doc: ReturnType<typeof parseFeatureYaml> | null = null;
        const yamlSource = await readOptionalFile(path.join(root, featureYamlFile(dir)));
        if (yamlSource !== null) {
            try {
                doc = parseFeatureYaml(yamlSource);
            } catch {}
        } else {
            const legacy = await readOptionalFile(path.join(root, dir, "feature.md"));
            if (legacy !== null) {
                try {
                    doc = parseFeatureMarkdown(legacy);
                } catch {}
                await fs.writeFile(
                    path.join(root, featureYamlFile(dir)),
                    serializeFeatureYaml({
                        id: doc?.id ?? "",
                        title: doc?.title ?? humanizeSlug(path.posix.basename(dir)),
                        description: doc?.description ?? "",
                    }),
                    "utf8",
                );
                await fs.rm(path.join(root, dir, "feature.md"), { force: true });
                migrated.count += 1;
            }
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

async function migrateContextMarkdown(projectId: string, migrated: { count: number }): Promise<void> {
    const root = repoDir(projectId);
    const legacy = await readOptionalFile(path.join(root, "context.md"));
    if (legacy === null) return;
    if ((await readOptionalFile(path.join(root, "context.yml"))) === null) {
        try {
            const context = parseContextMarkdown(legacy);
            await fs.writeFile(path.join(root, "context.yml"), serializeContextYaml(context), "utf8");
        } catch (error) {
            await projectsRepository.setContextSyncError(
                projectId,
                `Could not convert context.md to yaml: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }
    }
    await fs.rm(path.join(root, "context.md"), { force: true });
    migrated.count += 1;
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
    const migrated = { count: 0 };
    await migrateContextMarkdown(projectId, migrated);
    const hasSpecsDir = await isDirectory(path.join(root, "specs"));
    if (hasSpecsDir) await walk(root, "specs", dirs, found, migrated);

    const existingSpecs = await specsRepository.listSpecs(projectId);
    const specsById = new Map(existingSpecs.map((spec) => [spec.id, spec]));
    const specsByPath = new Map(existingSpecs.map((spec) => [spec.path, spec]));
    const identities = new Map<string, ReturnType<typeof parseYamlIdentity> | null>();
    const pathsById = new Map<string, string[]>();
    for (const item of found) {
        const identity = parseYamlIdentity(item.yaml);
        identities.set(item.path, identity);
        if (isUuid(identity?.id)) pathsById.set(identity.id, [...(pathsById.get(identity.id) ?? []), item.path]);
    }
    const ignoredIds = new Set<string>();
    for (const [id, paths] of pathsById) {
        if (paths.length < 2) continue;
        const preferred = existingSpecs.find((spec) => spec.id === id && paths.includes(spec.path))?.path ?? paths.sort()[0];
        for (const specPath of paths) if (specPath !== preferred) ignoredIds.add(specPath);
    }

    const { byPath: featuresByPath, unseen: unseenFeatures } = await upsertFeatures(projectId, dirs, migrated);
    const seenIds = new Set<string>();
    const invalidSpecs: string[] = [];
    let needsMetadataCommit = false;

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

        const identity = identities.get(item.path) ?? null;
        const docId = isUuid(identity?.id) && !ignoredIds.has(item.path) ? identity.id : null;
        const existing = (docId ? specsById.get(docId) : undefined) ?? specsByPath.get(item.path);
        const title = doc?.title ?? identity?.title ?? existing?.title ?? humanizeSlug(path.posix.basename(item.path));
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
            const normalized = serializeSpecYaml({
                id: spec.id,
                title,
                description: doc.description,
                humanSpec: doc.humanSpec,
            });
            await fs.writeFile(
                path.join(root, specYamlFile(item.path)),
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
        const message = migrated.count > 0
            ? "specbook: convert specs to yaml"
            : needsMetadataCommit
              ? "specbook: normalize metadata"
              : "specbook: import working tree changes";
        await commitAll(projectId, message);
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
