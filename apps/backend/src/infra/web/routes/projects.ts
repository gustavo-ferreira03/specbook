import { access } from "../access";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { deleteProjectData, ResourceBusyError } from "../../../core/deletion";
import { UnsafeRepoPathError } from "../../../core/repo/safe-fs";
import { YamlParseError } from "../../../core/repo/yaml";
import { discoverProjectContext } from "../../../core/chat/discovery";
import { createProject, publicProject } from "../../../core/projects";
import { createManualSpec } from "../../../core/repo/manual";
import { projectFavicon } from "../../../core/network/favicon";
import { featuresRepository } from "../../repositories/features";
import { projectsRepository } from "../../repositories/projects";
import { runsRepository } from "../../repositories/runs";
import { specsRepository } from "../../repositories/specs";

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


function mapManualError(error: unknown): never {
    if (error instanceof HTTPException) throw error;
    if (


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

export function createProjectsRouter(): Hono {
    const router = new Hono();

    router.post("/projects", access("editor"), zValidator("json", createProjectSchema), async (c) => {
        const { name, baseUrl } = c.req.valid("json");
        const project = await createProject(name, baseUrl);
        return c.json({ project: publicProject(project), discoveryChatId: await discoverProjectContext(project.id) });
    });

    router.get("/projects", access("viewer"), async (c) => {
        return c.json({ projects: (await projectsRepository.listProjects()).map(publicProject) });
    });

    router.get("/projects/:id", access("viewer"), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ project: publicProject(project) });
    });

    router.get("/projects/:id/favicon", access("viewer"), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        const icon = await projectFavicon(project.id, project.baseUrl).catch(() => null);
        if (!icon) return c.body(null, 404, { "Cache-Control": "private, max-age=3600" });
        return c.body(new Uint8Array(icon.body), 200, {
            "Content-Type": icon.contentType,
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        });
    });

    router.patch("/projects/:id", access("editor"), zValidator("json", updateProjectSchema), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        await projectsRepository.updateProject(project.id, c.req.valid("json"));
        const updated = await projectsRepository.getProject(project.id);
        if (!updated) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ project: publicProject(updated) });
    });

    router.delete("/projects/:id", access("editor"), async (c) => {
        try {
            if (!(await deleteProjectData(c.req.param("id")))) {
                throw new HTTPException(404, { message: "Project not found" });
            }
            return c.body(null, 204);
        } catch (error) {
            mapManualError(error);
        }
    });

    router.get("/projects/:id/tree", access("viewer"), async (c) => {
        const projectId = c.req.param("id");
        const project = await projectsRepository.getProject(projectId);
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        const syncError = project.gitExternalSyncError;
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

    router.post("/projects/:id/specs", access("editor"), zValidator("json", createSpecSchema), async (c) => {
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


    return router;
}
