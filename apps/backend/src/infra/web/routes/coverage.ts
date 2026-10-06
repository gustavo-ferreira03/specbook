import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { projectCoverage } from "../../../core/coverage";
import { NetworkTargetError } from "../../../core/network/targets";
import { projectsRepository } from "../../repositories/projects";
import { access } from "../access";

const coverageQuerySchema = z.object({ environment: z.string().trim().min(1).max(80).optional() });

export function createCoverageRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/coverage", access("viewer"), zValidator("query", coverageQuerySchema), async (c) => {
        if (!await projectsRepository.getProject(c.req.param("id"))) throw new HTTPException(404, { message: "Project not found" });
        try { return c.json(await projectCoverage(c.req.param("id"), c.req.valid("query").environment)); }
        catch (error) {
            if (error instanceof NetworkTargetError) throw new HTTPException(400, { message: error.message });
            throw error;
        }
    });
    return router;
}
