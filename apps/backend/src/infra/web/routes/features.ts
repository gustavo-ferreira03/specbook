import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { deleteFeatureData, ResourceBusyError } from "../../../core/deletion";
import { editFeatureFile, readFeatureRaw, RepoConflictError } from "../../../core/repo/manual";
import { createFeatureInRepo } from "../../../core/repo/writer";
import { featuresRepository } from "../../repositories/features";
import { projectsRepository } from "../../repositories/projects";

const editFileSchema = z.object({ yaml: z.string().min(1) });

const createFeatureSchema = z.object({
    parentId: z.string().min(1).optional(),
    title: z.string().min(1),
    description: z.string().default(""),
});

function mapManualError(error: unknown): never {
    if (error instanceof RepoConflictError) throw new HTTPException(409, { message: error.message });
    if (error instanceof Error && /unfinished rebase|uncommitted changes/.test(error.message)) {
        throw new HTTPException(409, { message: error.message });
    }
    throw error;
}

export function createFeaturesRouter(): Hono {
    const router = new Hono();

    router.post("/projects/:id/features", zValidator("json", createFeatureSchema), async (c) => {
        const project = await projectsRepository.getProject(c.req.param("id"));
        if (!project) throw new HTTPException(404, { message: "Project not found" });
        const { parentId, title, description } = c.req.valid("json");
        if (parentId) {
            const parent = await featuresRepository.getFeature(parentId);
            if (!parent || parent.projectId !== project.id) {
                throw new HTTPException(404, { message: "Parent feature not found" });
            }
        }
        const feature = await createFeatureInRepo(project.id, parentId ?? null, title, description).catch(mapManualError);
        return c.json({ feature });
    });

    router.get("/features/:id/file", async (c) => {
        const feature = await featuresRepository.getFeature(c.req.param("id"));
        if (!feature) throw new HTTPException(404, { message: "Feature not found" });
        return c.json({ feature, yaml: await readFeatureRaw(feature) });
    });

    router.put("/features/:id/file", zValidator("json", editFileSchema), async (c) => {
        const feature = await featuresRepository.getFeature(c.req.param("id"));
        if (!feature) throw new HTTPException(404, { message: "Feature not found" });
        const updated = await editFeatureFile(feature, c.req.valid("json").yaml).catch(mapManualError);
        return c.json({ feature: updated });
    });

    router.delete("/features/:id", async (c) => {
        try {
            if (!(await deleteFeatureData(c.req.param("id")))) {
                throw new HTTPException(404, { message: "Feature not found" });
            }
            return c.body(null, 204);
        } catch (error) {
            if (error instanceof HTTPException) throw error;
            if (error instanceof ResourceBusyError) throw new HTTPException(409, { message: error.message });
            throw error;
        }
    });

    return router;
}
