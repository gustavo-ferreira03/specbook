import fs from "node:fs/promises";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { deleteProjectData, ResourceBusyError } from "../../../core/deletion";
import { SyncConflictError } from "../../../core/repo/errors";
import { UnsafeRepoPathError } from "../../../core/repo/safe-fs";
import { YamlParseError } from "../../../core/repo/yaml";
import { repoBare } from "../../../core/repo/bare";
import { repoGit } from "../../../core/repo/git";
import { createManualSpec, editContextFile, readContextRaw, RepoConflictError } from "../../../core/repo/manual";
import { syncProject } from "../../../core/repo/sync";
import { featuresRepository } from "../../repositories/features";
import { projectsRepository } from "../../repositories/projects";
import { runsRepository } from "../../repositories/runs";
import { specsRepository } from "../../repositories/specs";

function publicProject(project: NonNullable<Awaited<ReturnType<typeof projectsRepository.getProject>>>) {
    return {
        id: project.id,
        name: project.name,
        baseUrl: project.baseUrl,
        createdAt: project.createdAt,
    };
}

const createProjectSchema = z.object({
    name: z.string().min(1),
    baseUrl: z.string().url(),
});

const updateProjectSchema = z
    .object({
        name: z.string().min(1).optional(),
        baseUrl: z.string().url().optional(),
    })
    .refine((value) => value.name !== undefined || value.baseUrl !== undefined, {
        message: "Provide at least one of name or baseUrl",
    });

const createSpecSchema = z.object({
    featureId: z.string().min(1),
    title: z.string().min(1),
});

const contextFileSchema = z.object({ yaml: z.string().min(1) });

function mapManualError(error: unknown): never {
    if (error instanceof HTTPException) throw error;
    if (
        error instanceof RepoConflictError ||
        error instanceof SyncConflictError ||
        error instanceof ResourceBusyError ||
        error instanceof UnsafeRepoPathError
    ) {
        throw new HTTPException(409, { message: error.message });
    }
    if (error instanceof YamlParseError) throw new HTTPException(400, { message: error.message });
    if (error instanceof Error && /unfinished rebase|uncommitted changes/.test(error.message)) {
        throw new HTTPException(409, { message: error.message });
    }
    throw error;
}

// The tree endpoint answers from the DB; opening a page only nudges a sync
// (fetch, reindex, push) in the background, at most once per interval.
const BACKGROUND_SYNC_INTERVAL_MS = 30_000;
const lastSyncStarts = new Map<string, number>();
const syncsInFlight = new Set<string>();
const lastSyncErrors = new Map<string, string>();

function scheduleBackgroundSync(projectId: string): void {
    const now = Date.now();
    if (syncsInFlight.has(projectId)) return;
    if (now - (lastSyncStarts.get(projectId) ?? 0) < BACKGROUND_SYNC_INTERVAL_MS) return;
    lastSyncStarts.set(projectId, now);
    syncsInFlight.add(projectId);
    void syncProject(projectId)
        .then(() => lastSyncErrors.delete(projectId))
        .catch((error: unknown) => {
            lastSyncErrors.set(projectId, error instanceof Error ? error.message : String(error));
        })
        .finally(() => syncsInFlight.delete(projectId));
}

export function createProjectsRouter(): Hono {
    const router = new Hono();

    router.post("/projects", zValidator("json", createProjectSchema), async (c) => {
        const { name, baseUrl } = c.req.valid("json");
        const project = await projectsRepository.createProject(name, baseUrl);
        try {
            await repoGit.ensureProjectRepo(project.id, { create: true });
            await repoBare.ensureBareRepo(project.id, repoGit.getRepoDir(project.id));
        } catch (error) {
            await projectsRepository.deleteProject(project.id);
            await Promise.allSettled([
                fs.rm(repoGit.getRepoDir(project.id), { recursive: true, force: true }),
                repoBare.removeBareRepo(project.id),
            ]);
            throw error;
        }
        return c.json({ project: publicProject(project) });
    });

    router.get("/projects", async (c) => {
        return c.json({ projects: (await projectsRepository.listProjects()).map(publicProject) });
    });

    router.get("/projects/:id", async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ project: publicProject(project) });
    });

    router.patch("/projects/:id", zValidator("json", updateProjectSchema), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        await projectsRepository.updateProject(project.id, c.req.valid("json"));
        const updated = await projectsRepository.getProject(project.id);
        if (!updated) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ project: publicProject(updated) });
    });

    router.delete("/projects/:id", async (c) => {
        try {
            if (!(await deleteProjectData(c.req.param("id")))) {
                throw new HTTPException(404, { message: "Project not found" });
            }
            return c.body(null, 204);
        } catch (error) {
            mapManualError(error);
        }
    });

    router.get("/projects/:id/tree", async (c) => {
        const projectId = c.req.param("id");
        const project = await projectsRepository.getProject(projectId);
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        if (!project.gitConflictPaths?.length) scheduleBackgroundSync(projectId);
        const syncError = lastSyncErrors.get(projectId) ?? null;
        const [features, specs] = await Promise.all([
            featuresRepository.listFeatures(projectId),
            specsRepository.listSpecs(projectId),
        ]);
        const lastRuns = await runsRepository.latestRuns(specs.map((spec) => spec.id));
        return c.json({
            features,
            specs: specs.map((spec) => ({
                id: spec.id,
                featureId: spec.featureId,
                title: spec.title,
                status: spec.status,
                lastRun: lastRuns.get(spec.id) ?? null,
            })),
            syncError,
        });
    });

    router.post("/projects/:id/specs", zValidator("json", createSpecSchema), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        const { featureId, title } = c.req.valid("json");
        const feature = await featuresRepository.getFeature(featureId);
        if (!feature || feature.projectId !== project.id) {
            throw new HTTPException(404, { message: "Feature not found" });
        }
        const spec = await createManualSpec(project.id, featureId, title).catch(mapManualError);
        return c.json({ spec });
    });

    router.get("/projects/:id/context-file", async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ yaml: await readContextRaw(project.id), contextSyncError: project.contextSyncError });
    });

    router.put("/projects/:id/context-file", zValidator("json", contextFileSchema), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        await editContextFile(project.id, c.req.valid("json").yaml).catch(mapManualError);
        const refreshed = await projectsRepository.getProject(project.id);
        return c.json({ yaml: await readContextRaw(project.id), contextSyncError: refreshed?.contextSyncError ?? null });
    });

    return router;
}
