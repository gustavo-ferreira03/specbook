import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runBatch } from "../../infra/db/client";
import type { HumanSpec, ProjectContext } from "../../infra/db/schema";
import { featuresRepository, type Feature } from "../../infra/repositories/features";
import { projectContextsRepository, type ProjectContextRevisionRow } from "../../infra/repositories/project-contexts";
import { specsRepository, type Spec } from "../../infra/repositories/specs";
import { specEnvironmentsRepository } from "../../infra/repositories/spec-environments";
import { environmentsRepository } from "../../infra/repositories/environments";
import { validateSpecSource, type SpecSourceValidation } from "@specbook/runtime/validate";
import { acquireSpecLocks, areSpecsLocked, ResourceBusyError, withSpecLock, withSpecLocks } from "../specs/lifecycle";
import { repoGit } from "./git";
import { reindexProjectUnlocked } from "./indexer";
import { assertRepoPathSafe, readOptionalRepoFile, readRepoFile, writeRepoFile } from "@specbook/runtime/safe-fs";
import { uniqueSlug } from "./slug";
import {
    parseSpecYaml,
    parseFeatureYaml,
    serializeContextYaml,
    serializeFeatureYaml,
    serializeSpecYaml,
} from "@specbook/runtime/yaml";

export type SpecValidation = SpecSourceValidation;

export function sourceHashOf(source: string): string {
    return crypto.createHash("sha256").update(source).digest("hex");
}

export function specRevision(yaml: string, testSource: string): string {
    return sourceHashOf(JSON.stringify([yaml, testSource]));
}

export class SpecRevisionConflict extends Error {
    constructor(readonly conflicts: { path: string; revision: string | null }[]) {
        super("The remote Spec changed. Run specbook pull before publishing again.");
    }
}

export class SpecPublishValidationError extends Error {}

export interface PublishedSpecInput {
    path: string;
    baseRevision: string | null;
    files: { "spec.yml": string; "spec.ts": string };
    feature: { path: string; source: string };
}

export async function readProjectSpecFiles(projectId: string) {
    return repoGit.withRepoLock(projectId, async () => {
        const features = await Promise.all((await featuresRepository.listFeatures(projectId)).map(async (feature) => ({
            path: feature.path,
            source: await readFile(projectId, featureYamlFile(feature.path)),
        })));
        const specs = await Promise.all((await specsRepository.listSpecs(projectId)).map(async (spec) => {
            const yaml = await readFile(projectId, specYamlFile(spec.path));
            const source = await readFile(projectId, specTestFile(spec.path));
            return { path: spec.path, revision: specRevision(yaml, source), files: { "spec.yml": yaml, "spec.ts": source } };
        }));
        return { features, specs };
    });
}

export async function publishSpecsInRepo(projectId: string, environmentId: string, inputs: PublishedSpecInput[]) {
    for (const input of inputs) {
        if (!/^specs\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/.test(input.path)) throw new SpecPublishValidationError("Use a Spec path inside specs/<feature>/<slug>");
        const document = parseSpecYaml(input.files["spec.yml"]);
        if (!document.title) throw new SpecPublishValidationError("Every Spec needs a title in spec.yml");
        const validation = validateSpec(input.files["spec.ts"], document.humanSpec);
        if (!validation.ok) throw new SpecPublishValidationError(`${input.path}: ${validation.error}`);
        if (!parseFeatureYaml(input.feature.source).title) throw new SpecPublishValidationError("Every Feature needs a title in feature.yml");
        if (path.posix.dirname(input.path) !== input.feature.path) throw new SpecPublishValidationError("The Feature path must be the Spec's parent directory");
    }
    const paths = new Set(inputs.map((input) => input.path));
    if (paths.size !== inputs.length) throw new SpecPublishValidationError("Publish each Spec only once per request");
    const existing = (await specsRepository.listSpecs(projectId)).filter((spec) => paths.has(spec.path));
    const lockedIds = new Set(existing.map((spec) => spec.id));
    return withSpecLocks(existing.map((spec) => spec.id), () => repoGit.withRepoLock(projectId, async () => {
        await repoGit.assertRepoWritableUnlocked(projectId);
        if (!(await environmentsRepository.list(projectId)).some((environment) => environment.id === environmentId)) throw new SpecPublishValidationError("The target environment was removed. Connect to an existing environment before publishing.");
        const conflicts: SpecRevisionConflict["conflicts"] = [];
        const changed = new Set<string>();
        const existingFeatures = new Set((await featuresRepository.listFeatures(projectId)).map((feature) => feature.path));
        const currentSpecs = new Map((await specsRepository.listSpecs(projectId)).map((spec) => [spec.path, spec]));
        for (const input of inputs) {
            const current = currentSpecs.get(input.path);
            const yaml = await readOptionalFile(projectId, specYamlFile(input.path));
            const source = await readOptionalFile(projectId, specTestFile(input.path));
            const revision = yaml !== null && source !== null ? specRevision(yaml, source) : null;
            if (input.baseRevision !== revision || (!current && (yaml !== null || source !== null))) conflicts.push({ path: input.path, revision });
            if (revision !== specRevision(input.files["spec.yml"], input.files["spec.ts"])) changed.add(input.path);
            if (existingFeatures.has(input.path)) throw new SpecPublishValidationError("A Feature already uses this Spec path");
            for (let parent = input.feature.path; parent !== "specs"; parent = path.posix.dirname(parent)) {
                if (currentSpecs.has(parent) || paths.has(parent)) throw new SpecPublishValidationError("A Spec cannot contain Features or other Specs");
            }
        }
        if (conflicts.length) throw new SpecRevisionConflict(conflicts);
        if (inputs.some((input) => {
            const current = currentSpecs.get(input.path);
            return current && !lockedIds.has(current.id);
        })) throw new ResourceBusyError("The project changed while publish was being prepared. Retry publishing.");
        const { commitSha } = await mutateRepoUnlocked(projectId, `spec: publish ${inputs.length} from CLI`, async () => {
            for (const input of inputs) {
                const parents: string[] = [];
                for (let parent = input.feature.path; parent !== "specs"; parent = path.posix.dirname(parent)) parents.unshift(parent);
                for (const parent of parents) {
                    if (existingFeatures.has(parent)) continue;
                    const yaml = parent === input.feature.path ? input.feature.source : serializeFeatureYaml({ title: path.posix.basename(parent), description: "" });
                    await fs.mkdir(await safePath(projectId, parent), { recursive: true });
                    await writeFile(projectId, featureYamlFile(parent), yaml);
                    existingFeatures.add(parent);
                }
                await fs.mkdir(await safePath(projectId, input.path), { recursive: true });
                await writeFile(projectId, specYamlFile(input.path), input.files["spec.yml"]);
                await writeFile(projectId, specTestFile(input.path), input.files["spec.ts"]);
            }
        });
        await reindexProjectUnlocked(projectId);
        const result = await Promise.all(inputs.map(async (input) => {
            const spec = await specsRepository.getSpecByPath(projectId, input.path);
            if (!spec) throw new Error("Published Spec was not indexed");
            return { input, spec };
        }));
        const specs = [];
        for (const { input, spec } of result) {
            const state = (await specEnvironmentsRepository.list(spec)).find((row) => row.environmentId === environmentId);
            if (changed.has(input.path) || !state) await specEnvironmentsRepository.set(spec, environmentId, "awaiting_deploy");
            const updated = await specsRepository.getSpec(spec.id);
            specs.push({ id: spec.id, path: spec.path, revision: specRevision(input.files["spec.yml"], input.files["spec.ts"]), status: updated!.status });
        }
        const features = await Promise.all([...new Set(inputs.map((input) => input.feature.path))].map(async (featurePath) => ({
            path: featurePath,
            source: await readFile(projectId, featureYamlFile(featurePath)),
        })));
        return { commitSha, specs, features };
    }));
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

export function validateSpec(source: string, humanSpec: HumanSpec | null): SpecValidation {
    return validateSpecSource(source, humanSpec);
}

async function rollbackWorkingTree(projectId: string): Promise<void> {
    const git = repoGit.getProjectGit(projectId);
    await git.raw(["reset", "--hard", "--quiet", "HEAD"]);
    await git.raw(["clean", "-fd", "--quiet"]);
}

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
