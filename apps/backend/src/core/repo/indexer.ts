import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { db, runBatch, type DbQuery } from "../../infra/db/client";
import { runs, type HumanSpec, type ProjectContext } from "../../infra/db/schema";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import { featuresRepository, type Feature } from "../../infra/repositories/features";
import { projectsRepository } from "../../infra/repositories/projects";
import { specsRepository, type Spec, type SpecPatch } from "../../infra/repositories/specs";
import { runsDir } from "../paths";
import { repoBare } from "./bare";
import { repoGit } from "./git";
import { repoRemote } from "./remote";
import { readOptionalRepoFile, UnsafeRepoPathError } from "./safe-fs";
import { humanizeSlug } from "./slug";
import {
    featureYamlFile,
    markdownHashOf,
    sourceHashOf,
    specTestFile,
    specYamlFile,
    validateSpec,
} from "./writer";
import {
    parseFeatureYaml,
    parseSpecYaml,
    parseContextYaml,
    parseYamlTitle,
    sameProjectContext,
    YamlParseError,
} from "./yaml";

export interface ReindexResult {
    specsSeen: number;
    specsRemoved: number;
    featuresRemoved: number;
    invalidSpecs: string[];
}

interface FoundSpec {
    path: string;
    dirPath: string;
    yaml: string | null;
    testSource: string | null;
    unsafeReason: string | null;
}

interface PlannedSpec {
    item: FoundSpec;
    feature: Feature;
    existing: Spec | undefined;
    title: string;
    description: string;
    humanSpec: HumanSpec | null;
    sourceHash: string;
    markdownHash: string;
    status: Spec["status"];
    invalidReason: string | null;
    needsValidation: boolean;
}

async function isDirectory(target: string): Promise<boolean> {
    try {
        return (await fs.stat(target)).isDirectory();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/** Reads a repo file, reporting a symlink (or other unsafe path) instead of throwing. */
async function readRepoEntry(root: string, relative: string): Promise<{ content: string | null; unsafe: string | null }> {
    try {
        return { content: await readOptionalRepoFile(root, path.join(root, relative)), unsafe: null };
    } catch (error) {
        if (error instanceof UnsafeRepoPathError) return { content: null, unsafe: `${relative} is a symbolic link, which is not allowed` };
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EISDIR" || code === "ELOOP") return { content: null, unsafe: `${relative} is not a regular file` };
        throw error;
    }
}

async function walk(root: string, relative: string, dirs: string[], found: FoundSpec[]): Promise<void> {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
        // Dirent.isDirectory() is false for symlinks, so linked directories are never followed.
        if (!entry.isDirectory()) continue;
        const entryRelative = `${relative}/${entry.name}`;
        const specYaml = await readRepoEntry(root, specYamlFile(entryRelative));
        if (specYaml.content !== null || specYaml.unsafe !== null) {
            const test = specYaml.unsafe ? { content: null, unsafe: null } : await readRepoEntry(root, specTestFile(entryRelative));
            found.push({
                path: entryRelative,
                dirPath: relative,
                yaml: specYaml.content,
                testSource: test.content,
                unsafeReason: specYaml.unsafe ?? test.unsafe,
            });
        } else {
            dirs.push(entryRelative);
            await walk(root, entryRelative, dirs, found);
        }
    }
}

async function planFeatures(
    projectId: string,
    root: string,
    dirs: string[],
    existing: Feature[],
): Promise<{ byPath: Map<string, Feature>; unseen: Feature[]; queries: DbQuery[] }> {
    const existingByPath = new Map(existing.map((feature) => [feature.path, feature]));
    const byPath = new Map<string, Feature>();
    const seenIds = new Set<string>();
    const queries: DbQuery[] = [];

    for (const dir of [...dirs].sort()) {
        let doc: ReturnType<typeof parseFeatureYaml> | null = null;
        const yaml = await readRepoEntry(root, featureYamlFile(dir));
        if (yaml.unsafe) console.warn(`[specbook] ignoring ${dir}/feature.yml in project ${projectId}: ${yaml.unsafe}`);
        if (yaml.content !== null) {
            try {
                doc = parseFeatureYaml(yaml.content);
            } catch {}
        }
        const parentPath = path.posix.dirname(dir);
        const parentId = parentPath === "specs" ? null : byPath.get(parentPath)?.id ?? null;
        const title = doc?.title ?? humanizeSlug(path.posix.basename(dir));
        const description = doc?.description ?? "";
        const current = existingByPath.get(dir);
        let feature: Feature;
        if (current) {
            feature = { ...current, title, description, parentId };
            if (current.title !== title || current.description !== description || current.parentId !== parentId) {
                queries.push(featuresRepository.updateFeatureQuery(current.id, { title, description, parentId }));
            }
        } else {
            feature = {
                id: crypto.randomUUID(),
                projectId,
                parentId,
                title,
                description,
                path: dir,
                createdAt: new Date().toISOString(),
            };
            queries.push(featuresRepository.insertFeatureQuery(feature));
        }
        seenIds.add(feature.id);
        byPath.set(dir, feature);
    }

    return { byPath, unseen: existing.filter((feature) => !seenIds.has(feature.id)), queries };
}

function planSpecs(found: FoundSpec[], featuresByPath: Map<string, Feature>, existingSpecs: Spec[]): PlannedSpec[] {
    const specsByPath = new Map(existingSpecs.map((spec) => [spec.path, spec]));
    const claimed = new Set<string>();
    const planned: PlannedSpec[] = [];

    for (const item of found) {
        const feature = featuresByPath.get(item.dirPath);
        if (!feature) continue;
        const existing = specsByPath.get(item.path);
        if (existing) claimed.add(existing.id);
        planned.push({
            item,
            feature,
            existing,
            title: "",
            description: "",
            humanSpec: null,
            sourceHash: item.testSource === null ? "" : sourceHashOf(item.testSource),
            markdownHash: item.yaml === null ? "" : markdownHashOf(item.yaml),
            status: "unverified",
            invalidReason: null,
            needsValidation: false,
        });
    }

    // A Spec that vanished from one path while identical content appeared at
    // another was moved (a Feature renamed through a push or a GitHub pull):
    // keep its row, runs and status instead of recreating it.
    for (const entry of planned) {
        if (entry.existing || !entry.sourceHash || !entry.markdownHash) continue;
        const moved = existingSpecs.find(
            (spec) =>
                !claimed.has(spec.id) &&
                spec.sourceHash === entry.sourceHash &&
                spec.markdownHash === entry.markdownHash,
        );
        if (moved) {
            claimed.add(moved.id);
            entry.existing = moved;
        }
    }

    for (const entry of planned) {
        const { item, existing } = entry;
        let doc: ReturnType<typeof parseSpecYaml> | null = null;
        let parseError: string | null = null;
        if (item.yaml !== null) {
            try {
                doc = parseSpecYaml(item.yaml);
            } catch (error) {
                parseError = error instanceof YamlParseError ? error.message : String(error);
            }
        }
        entry.title =
            doc?.title ??
            (item.yaml === null ? null : parseYamlTitle(item.yaml)) ??
            existing?.title ??
            humanizeSlug(path.posix.basename(item.path));
        entry.description = doc?.description ?? existing?.description ?? "";
        entry.humanSpec = doc?.humanSpec ?? null;

        if (item.unsafeReason) {
            entry.status = "invalid";
            entry.invalidReason = item.unsafeReason;
        } else if (parseError) {
            entry.status = "invalid";
            entry.invalidReason = `Invalid spec.yml: ${parseError}`;
        } else if (item.testSource === null) {
            entry.status = "invalid";
            entry.invalidReason = "Missing spec.ts file in the spec directory";
        } else if (
            existing &&
            existing.sourceHash === entry.sourceHash &&
            existing.markdownHash === entry.markdownHash &&
            existing.status !== "conflict" &&
            existing.status !== "invalid"
        ) {
            entry.status = existing.status;
            entry.invalidReason = existing.invalidReason;
            // Validation is cheap and in-process: re-check in case the rules changed.
            entry.needsValidation = true;
        } else {
            entry.needsValidation = true;
        }
    }
    return planned;
}

/** In-process AST validation of spec.ts against its spec.yml steps; no subprocess involved. */
function validatePlanned(planned: PlannedSpec[]): void {
    for (const entry of planned) {
        if (!entry.needsValidation) continue;
        let validation: ReturnType<typeof validateSpec>;
        try {
            validation = validateSpec(entry.item.testSource ?? "", entry.humanSpec);
        } catch (error) {
            validation = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (!validation.ok) {
            entry.status = "invalid";
            entry.invalidReason = validation.error;
        }
    }
}

function specQuery(projectId: string, entry: PlannedSpec): { id: string; query: DbQuery | null } {
    const values = {
        title: entry.title,
        description: entry.description,
        featureId: entry.feature.id,
        path: entry.item.path,
        sourceHash: entry.sourceHash,
        markdownHash: entry.markdownHash,
        status: entry.status,
        invalidReason: entry.invalidReason,
    };
    const existing = entry.existing;
    if (!existing) {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        return {
            id,
            query: specsRepository.insertSpecQuery({ id, projectId, ...values, createdAt: now, updatedAt: now }),
        };
    }
    const patch: SpecPatch = {};
    for (const key of Object.keys(values) as (keyof typeof values)[]) {
        if (existing[key] !== values[key]) Object.assign(patch, { [key]: values[key] });
    }
    return { id: existing.id, query: Object.keys(patch).length ? specsRepository.updateSpecQuery(existing.id, patch) : null };
}

async function planContext(
    projectId: string,
    root: string,
): Promise<{ queries: DbQuery[]; syncError: string | null | undefined }> {
    const source = await readRepoEntry(root, "context.yml");
    if (source.unsafe) return { queries: [], syncError: source.unsafe };
    if (source.content === null) return { queries: [], syncError: undefined };
    let context: ProjectContext;
    try {
        context = parseContextYaml(source.content);
    } catch (error) {
        return { queries: [], syncError: error instanceof Error ? error.message : String(error) };
    }
    const latest = await projectContextsRepository.getLatestConfirmedProjectContext(projectId);
    if (latest && sameProjectContext(latest.context, context)) return { queries: [], syncError: null };
    const project = await projectsRepository.getProject(projectId);
    const brief = latest?.brief ?? { goal: "", startUrl: project?.baseUrl ?? "", safetyNotes: [] };
    return { queries: [projectContextsRepository.insertConfirmedRevisionQuery(projectId, brief, context)], syncError: null };
}

async function removeRunDirs(projectId: string, runIds: string[]): Promise<void> {
    if (runIds.length === 0) return;
    await repoGit.deleteRunCommitRefsUnlocked(projectId, runIds);
    await Promise.allSettled(
        runIds.map((runId) => fs.rm(path.join(runsDir, runId), { recursive: true, force: true })),
    );
}

function withAncestors(ids: Set<string>, features: Feature[]): Set<string> {
    const byId = new Map(features.map((feature) => [feature.id, feature]));
    const result = new Set<string>();
    for (const id of ids) {
        for (let current = byId.get(id); current && !result.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
            result.add(current.id);
        }
    }
    return result;
}

export async function reindexProject(
    projectId: string,
    options: { allowDirty?: boolean } = {},
): Promise<ReindexResult> {
    return repoGit.withRepoLock(projectId, () => reindexProjectUnlocked(projectId, options));
}

/**
 * Reconciles the DB with the working tree. Reading the files and validating
 * spec.ts happen first; every DB write is then applied in one atomic
 * batch, so a failure never leaves the index half-updated.
 */
export async function reindexProjectUnlocked(
    projectId: string,
    options: { allowDirty?: boolean } = {},
): Promise<ReindexResult> {
    const root = repoGit.getRepoDir(projectId);
    if (
        await isDirectory(path.join(root, ".git", "rebase-merge")) ||
        await isDirectory(path.join(root, ".git", "rebase-apply"))
    ) {
        throw new Error("Cannot reindex while a git rebase is in progress");
    }
    const initialStatus = await repoGit.getProjectGit(projectId).status();
    if (initialStatus.conflicted.length > 0) {
        throw new Error("Cannot reindex a working tree with unresolved git conflicts");
    }
    if (options.allowDirty === false && !initialStatus.isClean()) {
        throw new Error("Refusing automatic reindex of a dirty project repository");
    }

    const dirs: string[] = [];
    const found: FoundSpec[] = [];
    const specsRoot = await fs.lstat(path.join(root, "specs")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    if (specsRoot?.isSymbolicLink()) {
        throw new Error("The specs directory is a symbolic link, which is not allowed");
    }
    if (specsRoot?.isDirectory()) await walk(root, "specs", dirs, found);

    const [existingFeatures, existingSpecs] = await Promise.all([
        featuresRepository.listFeatures(projectId),
        specsRepository.listSpecs(projectId),
    ]);
    const featurePlan = await planFeatures(projectId, root, dirs, existingFeatures);
    const planned = planSpecs(found, featurePlan.byPath, existingSpecs);
    validatePlanned(planned);
    const contextPlan = await planContext(projectId, root);

    const queries: DbQuery[] = [...featurePlan.queries];
    const seenIds = new Set<string>();
    const invalidSpecs: string[] = [];
    for (const entry of planned) {
        const { id, query } = specQuery(projectId, entry);
        if (query) queries.push(query);
        seenIds.add(id);
        if (entry.status === "invalid") invalidSpecs.push(id);
    }

    const unseenSpecs = existingSpecs.filter((spec) => !seenIds.has(spec.id));
    const unseenRuns = unseenSpecs.length
        ? await db
              .select({ id: runs.id, specId: runs.specId, status: runs.status })
              .from(runs)
              .where(inArray(runs.specId, unseenSpecs.map((spec) => spec.id)))
        : [];
    // A Spec whose run is still executing stays until the next reindex, and so
    // does its Feature chain.
    const busySpecIds = new Set(unseenRuns.filter((run) => run.status === "running").map((run) => run.specId));
    const removedSpecIds = unseenSpecs.filter((spec) => !busySpecIds.has(spec.id)).map((spec) => spec.id);
    const removedRunIds = unseenRuns.filter((run) => !busySpecIds.has(run.specId)).map((run) => run.id);
    const keptFeatureIds = withAncestors(
        new Set(unseenSpecs.filter((spec) => busySpecIds.has(spec.id)).map((spec) => spec.featureId)),
        existingFeatures,
    );
    const removedFeatureIds = featurePlan.unseen.filter((feature) => !keptFeatureIds.has(feature.id)).map((feature) => feature.id);

    queries.push(
        ...specsRepository.deleteSpecsQueries(removedSpecIds),
        ...featuresRepository.deleteFeaturesQuery(removedFeatureIds),
        ...contextPlan.queries,
    );
    await runBatch(queries);

    if (contextPlan.syncError !== undefined) {
        await projectsRepository.setContextSyncError(projectId, contextPlan.syncError);
    }
    await removeRunDirs(projectId, removedRunIds);

    const workingTreeChanged = !(await repoGit.getProjectGit(projectId).status()).isClean();
    if (workingTreeChanged) {
        await repoGit.commitAll(projectId, "specbook: import working tree changes");
        repoRemote.schedulePush(projectId);
    }

    await repoGit.publishToBareUnlocked(projectId).catch((error: unknown) => {
        console.error(`[specbook] publishing ${projectId} to its canonical repository failed:`, error);
    });
    return {
        specsSeen: found.length,
        specsRemoved: removedSpecIds.length,
        featuresRemoved: removedFeatureIds.length,
        invalidSpecs,
    };
}

export async function reindexAllProjects(): Promise<void> {
    for (const project of await projectsRepository.listProjects()) {
        try {
            await repoGit.ensureProjectRepo(project.id);
            await repoBare.ensureBareRepo(project.id, repoGit.getRepoDir(project.id));
            await reindexProject(project.id, { allowDirty: false });
        } catch (error) {
            console.error(`[specbook] reindex failed for project ${project.id}:`, error);
        }
    }
}
