import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { featuresRepository } from "../../repositories/features";
import { projectsRepository } from "../../repositories/projects";
import { specsRepository } from "../../repositories/specs";

const createProjectSchema = z.object({
    name: z.string().min(1),
    baseUrl: z.string().url(),
});

export function createProjectsRouter(): Hono {
    const router = new Hono();

    router.post("/projects", zValidator("json", createProjectSchema), async (c) => {
        const { name, baseUrl } = c.req.valid("json");
        const project = await projectsRepository.createProject(name, baseUrl);
        return c.json({ project });
    });

    router.get("/projects", async (c) => {
        return c.json({ projects: await projectsRepository.listProjects() });
    });

    router.get("/projects/:id", async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        return c.json({ project });
    });

    router.get("/projects/:id/tree", async (c) => {
        const projectId = c.req.param("id");
        const project = await projectsRepository.getProject(projectId);
        if (!project) throw new HTTPException(404, { message: "Project not found" });
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
        });
    });

    return router;
}
