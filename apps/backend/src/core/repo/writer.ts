import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runBatch } from "../../infra/db/client";
import type { HumanSpec, ProjectContext } from "../../infra/db/schema";
import { featuresRepository, type Feature } from "../../infra/repositories/features";
import { projectContextsRepository, type ProjectContextRevisionRow } from "../../infra/repositories/project-contexts";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { validateSpecSource, type SpecSourceValidation } from "../runner/validate";
import { acquireSpecLocks, areSpecsLocked, ResourceBusyError, withSpecLock } from "../specs/lifecycle";
import { repoGit } from "./git";
import { reindexProjectUnlocked } from "./indexer";
import { assertRepoPathSafe, readOptionalRepoFile, readRepoFile, writeRepoFile } from "./safe-fs";
import { uniqueSlug } from "./slug";
import {
    parseSpecYaml,
    serializeContextYaml,
    serializeFeatureYaml,
    serializeSpecYaml,
} from "./yaml";

export type SpecValidation = SpecSourceValidation;

/** Hash of a Spec's executable (spec.ts); stored as sourceHash on Specs and Runs. */
export function sourceHashOf(source: string): string {
    return crypto.createHash("sha256").update(source).digest("hex");
}

export function specYamlFile(specPath: string): string {
    return `${specPath}/spec.yml`;
}

export function specTestFile(specPath: string): string {
    return `${specPath}/spec.ts`;
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

async function safePath(projectId: string, relative: string): Promise<string> {
    const target = absolute(projectId, relative);
    await assertRepoPathSafe(repoGit.getRepoDir(projectId), target);
    return target;
}

async function readFile(projectId: string, relative: string): Promise<string> {
    return readRepoFile(repoGit.getRepoDir(projectId), absolute(projectId, relative));
}

async function writeFile(projectId: string, relative: string, content: string): Promise<void> {
    await writeRepoFile(repoGit.getRepoDir(projectId), absolute(projectId, relative), content);
}

async function siblingNames(projectId: string, dirRelative: string): Promise<Set<string>> {
    const entries = await fs.readdir(absolute(projectId, dirRelative), { withFileTypes: true }).catch(() => []);
    const names = new Set<string>(["feature", "context"]);
    for (const entry of entries) {
        names.add(entry.isDirectory() ? entry.name : entry.name.replace(/\.(yml|ts)$/, ""));
    }
    return names;
}

function isUnder(candidate: string, prefix: string): boolean {
    return candidate.startsWith(`${prefix}/`);
}

function movedPath(candidate: string, from: string, to: string): string {
    return `${to}${candidate.slice(from.length)}`;
}

/** The allowlist check of spec.ts plus the named-steps rule; the same validation the indexer applies. */
export function validateSpec(source: string, humanSpec: HumanSpec | null): SpecValidation {
    return validateSpecSource(source, humanSpec);
}

// Discards everything a failed mutation left in the working tree. Only called
// after assertRepoWritableUnlocked proved the tree was clean, under the repo lock.
async function rollbackWorkingTree(projectId: string): Promise<void> {
    const git = repoGit.getProjectGit(projectId);
    await git.raw(["reset", "--hard", "--quiet", "HEAD"]);
    await git.raw(["clean", "-fd", "--quiet"]);
}

/**
 * Shared path for every Specbook-initiated repository mutation. Must run under
 * the repo lock. `work` writes files and the matching DB rows; if it throws, the
 * working tree is restored so disk and DB never disagree. The commit happens only
 * after the DB write succeeded.
 */
export interface RepoMutationOptions {
    expectedHead?: string;
    expectedSpec?: { yaml: string; testSource: string | null };
    commitMessage?: string;
    checkPolicy?: () => Promise<void>;
}

async function mutateRepoUnlocked<T>(
    projectId: string,
    message: string,
    work: () => Promise<T>,
    options: RepoMutationOptions = {},
): Promise<{ result: T; commitSha: string }> {
    await repoGit.assertRepoWritableUnlocked(projectId);
    if (options.expectedHead && options.expectedHead !== await repoGit.getHeadSha(projectId)) {
        throw new Error("The repository changed since this proposal. Ask the job to prepare a new proposal.");
    }
    let result: T;
    try {
        await options.checkPolicy?.();
        result = await work();
        await options.checkPolicy?.();
    } catch (error) {
        await rollbackWorkingTree(projectId).catch((rollbackError: unknown) => {
            console.error(`[specbook] restoring the working tree of ${projectId} failed:`, rollbackError);
        });
        if (options.checkPolicy) await reindexProjectUnlocked(projectId);
        throw error;
    }
    const commitSha = await repoGit.commitAll(projectId, options.commitMessage ?? message);
    return { result, commitSha };
}

export async function createFeatureInRepo(
    projectId: string,
    parentId: string | null,
    title: string,
    description: string,
    options: RepoMutationOptions = {},
): Promise<Feature> {
    return repoGit.withRepoLock(projectId, async () => {
        const { result } = await mutateRepoUnlocked(projectId, `feature: create "${title}"`, async () => {
            const parent = parentId ? await featuresRepository.getFeature(parentId) : null;
            if (parentId && (!parent || parent.projectId !== projectId)) throw new Error("Parent feature not found");
            const parentPath = parent ? parent.path : "specs";
            const id = crypto.randomUUID();
            const slug = uniqueSlug(title, await siblingNames(projectId, parentPath), id);
            const featurePath = `${parentPath}/${slug}`;
            await fs.mkdir(await safePath(projectId, featurePath), { recursive: true });
            await writeFile(projectId, featureYamlFile(featurePath), serializeFeatureYaml({ title, description }));
            return featuresRepository.createFeature(projectId, parentId, title, description, featurePath, id);
        }, options);
        return result;
    });
}

/** Gives every area of a confirmed context a feature with the same title. Existing features are never renamed or removed. */
export async function createAreaFeatures(projectId: string, context: ProjectContext): Promise<void> {
    const titles = new Set((await featuresRepository.listFeatures(projectId)).map((feature) => feature.title.trim().toLowerCase()));
    for (const area of context.areas) {
        const key = area.name.trim().toLowerCase();
        if (!key || titles.has(key)) continue;
        titles.add(key);
        await createFeatureInRepo(projectId, null, area.name.trim(), area.description);
    }
}

export async function createSpecInRepo(input: {
    id?: string;
    projectId: string;
    featureId: string;
    title: string;
    description: string;
    humanSpec: HumanSpec;
    testSource: string;
}, options: RepoMutationOptions = {}): Promise<{ spec: Spec; commitSha: string }> {
    const validation = validateSpec(input.testSource, input.humanSpec);
    return repoGit.withRepoLock(input.projectId, async () => {
        const { result: spec, commitSha } = await mutateRepoUnlocked(
            input.projectId,
            `spec: create "${input.title}"`,
            async () => {
                const feature = await featuresRepository.getFeature(input.featureId);
                if (!feature || feature.projectId !== input.projectId) throw new Error("Feature not found");
                const id = input.id ?? crypto.randomUUID();
                const slug = uniqueSlug(input.title, await siblingNames(input.projectId, feature.path), id);
                const specPath = `${feature.path}/${slug}`;
                const markdown = serializeSpecYaml({
                    title: input.title,
                    description: input.description,
                    humanSpec: input.humanSpec,
                });
                await fs.mkdir(await safePath(input.projectId, specPath), { recursive: true });
                await writeFile(input.projectId, specYamlFile(specPath), markdown);
                await writeFile(input.projectId, specTestFile(specPath), input.testSource);
                const now = new Date().toISOString();
                const row: Spec = {
                    id,
                    projectId: input.projectId,
                    featureId: input.featureId,
                    title: input.title,
                    description: input.description,
                    status: validation.ok ? "unverified" : "invalid",
                    path: specPath,
                    sourceHash: sourceHashOf(input.testSource),
                    markdownHash: markdownHashOf(markdown),
                    invalidReason: validation.ok ? null : validation.error,
                    createdAt: now,
                    updatedAt: now,
                };
                await specsRepository.createSpecRecordRow(row);
                return row;
            },
            options,
        );
        return { spec, commitSha };
    });
}

export async function updateFeatureInRepo(
    feature: Feature,
    patch: { title?: string; description?: string },
): Promise<Feature> {
    // A rename moves every descendant Spec directory, so no run or edit may be
    // reading those paths while it happens.
    const descendantSpecIds =
        patch.title === undefined
            ? []
            : (await specsRepository.listSpecs(feature.projectId))
                  .filter((spec) => isUnder(spec.path, feature.path))
                  .map((spec) => spec.id);
    if (areSpecsLocked(descendantSpecIds)) {
        throw new ResourceBusyError("Wait for active Spec operations in this Feature to finish before renaming it");
    }
    const release = await acquireSpecLocks(descendantSpecIds);
    try {
        return await repoGit.withRepoLock(feature.projectId, async () => {
            let renamed = false;
            await mutateRepoUnlocked(feature.projectId, `feature: update "${patch.title ?? feature.title}"`, async () => {
                const current = await featuresRepository.getFeature(feature.id);
                if (!current) throw new Error("Feature not found");
                const title = patch.title ?? current.title;
                const description = patch.description ?? current.description;
                const dir = path.posix.dirname(current.path);
                const currentSlug = path.posix.basename(current.path);
                let featurePath = current.path;
                if (patch.title !== undefined) {
                    const taken = await siblingNames(feature.projectId, dir);
                    taken.delete(currentSlug);
                    const slug = uniqueSlug(title, taken, current.id);
                    if (slug !== currentSlug) {
                        featurePath = `${dir}/${slug}`;
                        const from = await safePath(feature.projectId, current.path);
                        const to = await safePath(feature.projectId, featurePath);
                        await fs.rename(from, to);
                        renamed = true;
                    }
                }
                await writeFile(feature.projectId, featureYamlFile(featurePath), serializeFeatureYaml({ title, description }));
                const queries = [featuresRepository.updateFeatureQuery(current.id, { title, description, path: featurePath })];
                if (featurePath !== current.path) {
                    // Spec directories live inside their Feature directory, so both
                    // trees share the renamed prefix.
                    for (const child of await featuresRepository.listFeatures(feature.projectId)) {
                        if (!isUnder(child.path, current.path)) continue;
                        queries.push(
                            featuresRepository.updateFeatureQuery(child.id, {
                                path: movedPath(child.path, current.path, featurePath),
                            }),
                        );
                    }
                    for (const spec of await specsRepository.listSpecs(feature.projectId)) {
                        if (!isUnder(spec.path, current.path)) continue;
                        queries.push(
                            specsRepository.updateSpecQuery(spec.id, { path: movedPath(spec.path, current.path, featurePath) }),
                        );
                    }
                }
                await runBatch(queries);
            });
            if (renamed) {
                await reindexProjectUnlocked(feature.projectId).catch((error: unknown) => {
                    console.error(`[specbook] reindex after renaming feature ${feature.id} failed:`, error);
                });
            }
            const updated = await featuresRepository.getFeature(feature.id);
            if (!updated) throw new Error("Feature disappeared during update");
            return updated;
        });
    } finally {
        await release();
    }
}

export async function readSpecFiles(spec: Spec): Promise<{ humanSpec: HumanSpec; testSource: string }> {
    const markdown = await readFile(spec.projectId, specYamlFile(spec.path));
    const testSource = await readFile(spec.projectId, specTestFile(spec.path));
    return { humanSpec: parseSpecYaml(markdown).humanSpec, testSource };
}

async function readOptionalFile(projectId: string, relative: string): Promise<string | null> {
    return readOptionalRepoFile(repoGit.getRepoDir(projectId), absolute(projectId, relative));
}

export interface SpecPatchInput {
    title?: string;
    description?: string;
    humanSpec?: HumanSpec;
    testSource?: string;
}

/**
 * Writes a Spec's files, validates the resulting spec.ts against the resulting
 * spec.yml and records the matching status. The caller must hold the Spec lock (see
 * updateSpecWithLock).
 */
export async function updateSpecInRepo(
    spec: Spec,
    patch: SpecPatchInput,
    options: RepoMutationOptions = {},
): Promise<{ spec: Spec; commitSha: string }> {
    return repoGit.withRepoLock(spec.projectId, async () => {
        const { commitSha } = await mutateRepoUnlocked(spec.projectId, `spec: update "${patch.title ?? spec.title}"`, async () => {
            const current = await specsRepository.getSpec(spec.id);
            if (!current) throw new Error("Spec not found");
            const currentYaml = await readFile(current.projectId, specYamlFile(current.path));
            if (options.expectedSpec && (currentYaml !== options.expectedSpec.yaml
                || await readOptionalFile(current.projectId, specTestFile(current.path)) !== options.expectedSpec.testSource)) {
                throw new Error("The Spec changed since this proposal. Ask the job to prepare a new proposal.");
            }
            const testSource = patch.testSource ?? (await readOptionalFile(current.projectId, specTestFile(current.path)));
            if (testSource === null) {
                throw new Error("Missing spec.ts; provide the complete testSource with this update.");
            }

            const title = patch.title ?? current.title;
            const description = patch.description ?? current.description;
            const humanSpec = patch.humanSpec ?? parseSpecYaml(currentYaml).humanSpec;

            const dir = path.posix.dirname(current.path);
            const currentSlug = path.posix.basename(current.path);
            let specPath = current.path;
            if (patch.title !== undefined) {
                const taken = await siblingNames(current.projectId, dir);
                taken.delete(currentSlug);
                const slug = uniqueSlug(title, taken, current.id);
                if (slug !== currentSlug) {
                    specPath = `${dir}/${slug}`;
                    const from = await safePath(current.projectId, current.path);
                    const to = await safePath(current.projectId, specPath);
                    await fs.rename(from, to);
                }
            }
            const markdown = patch.title === undefined && patch.description === undefined && patch.humanSpec === undefined
                ? currentYaml
                : serializeSpecYaml({ title, description, humanSpec });
            await writeFile(current.projectId, specYamlFile(specPath), markdown);
            await writeFile(current.projectId, specTestFile(specPath), testSource);
            const sourceHash = sourceHashOf(testSource);
            const markdownHash = markdownHashOf(markdown);
            const validation = validateSpec(testSource, humanSpec);
            const contentUnchanged = sourceHash === current.sourceHash && markdownHash === current.markdownHash;
            let status: Spec["status"] = "unverified";
            let invalidReason: string | null = null;
            if (!validation.ok) {
                status = "invalid";
                invalidReason = validation.error;
            } else if (contentUnchanged && current.status !== "invalid") {
                status = current.status;
                invalidReason = current.invalidReason;
            }
            await specsRepository.updateSpecRecord(current.id, {
                title,
                description,
                path: specPath,
                sourceHash,
                markdownHash,
                status,
                invalidReason,
            });
        }, options);
        const updated = await specsRepository.getSpec(spec.id);
        if (!updated) throw new Error("Spec disappeared during update");
        return { spec: updated, commitSha };
    });
}

/** The UI's Spec edit path: takes the Spec lock, then behaves like updateSpecInRepo. */
export async function updateSpecWithLock(
    specId: string,
    patch: SpecPatchInput,
): Promise<{ spec: Spec; commitSha: string } | null> {
    return withSpecLock(specId, async () => {
        const spec = await specsRepository.getSpec(specId);
        if (!spec) return null;
        return updateSpecInRepo(spec, patch);
    });
}

export async function deleteSpecFiles(spec: Spec): Promise<void> {
    await repoGit.withRepoLock(spec.projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(spec.projectId);
        await fs.rm(await safePath(spec.projectId, spec.path), { recursive: true, force: true });
        await repoGit.commitAll(spec.projectId, `spec: delete "${spec.title}"`);
    });
}

export async function deleteFeatureDirectory(projectId: string, featurePath: string, title: string): Promise<void> {
    await repoGit.withRepoLock(projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(projectId);
        await fs.rm(await safePath(projectId, featurePath), { recursive: true, force: true });
        await repoGit.commitAll(projectId, `feature: delete "${title}"`);
    });
}

/**
 * Writes context.yml and, when `confirmRevisionId` is given, confirms that draft
 * revision under the same repo lock, so a concurrent reindex never sees the new
 * file without the confirmed revision and records a duplicate.
 */
export async function writeContextToRepo(
    projectId: string,
    context: ProjectContext,
    options: { confirmRevisionId?: string } = {},
): Promise<ProjectContextRevisionRow | null> {
    return repoGit.withRepoLock(projectId, async () => {
        const { result } = await mutateRepoUnlocked(projectId, "context: update", async () => {
            await writeFile(projectId, "context.yml", serializeContextYaml(context));
            return options.confirmRevisionId
                ? projectContextsRepository.confirmProjectContextRevision(options.confirmRevisionId)
                : null;
        });
        return result;
    });
}
