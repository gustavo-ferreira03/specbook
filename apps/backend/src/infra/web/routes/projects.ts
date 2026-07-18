import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ensureProjectRepo } from "../../../core/repo/git";
import { createManualSpec, editContextFile, readContextRaw, RepoConflictError } from "../../../core/repo/manual";
import { syncProject } from "../../../core/repo/sync";
import { featuresRepository } from "../../repositories/features";
import { projectsRepository } from "../../repositories/projects";
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

const createSpecSchema = z.object({
    featureId: z.string().min(1),
    title: z.string().min(1),
});

const contextFileSchema = z.object({ yaml: z.string().min(1) });

function mapManualError(error: unknown): never {
    if (error instanceof RepoConflictError) throw new HTTPException(409, { message: error.message });
    if (error instanceof Error && /unfinished rebase|uncommitted changes/.test(error.message)) {
        throw new HTTPException(409, { message: error.message });
    }
    throw error;
}

export function createProjectsRouter(): Hono {
    const router = new Hono();

    router.post("/projects", zValidator("json", createProjectSchema), async (c) => {
        const { name, baseUrl } = c.req.valid("json");
        const project = await projectsRepository.createProject(name, baseUrl);
        try {
            await ensureProjectRepo(project.id, { create: true });
        } catch (error) {
            await projectsRepository.deleteProject(project.id);
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

    router.get("/projects/:id/tree", async (c) => {
        const projectId = c.req.param("id");
        const project = await projectsRepository.getProject(projectId);
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        let syncError: string | null = null;
        if (!project.gitConflictPaths?.length) {
            try {
                await syncProject(projectId);
            } catch (error) {
                syncError = error instanceof Error ? error.message : String(error);
            }
        }
        const [features, specs] = await Promise.all([
            featuresRepository.listFeatures(projectId),
            specsRepository.listSpecs(projectId),
        ]);
        return c.json({
            features,
            specs: specs.map((spec) => ({
                id: spec.id,
                featureId: spec.featureId,
                title: spec.title,
                status: spec.status,
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
