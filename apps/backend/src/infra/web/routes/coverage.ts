import { Hono } from "hono";
import { projectCoverage } from "../../../core/coverage";
import { access } from "../access";
import { loadProject } from "../load-project";

export function createCoverageRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/coverage", access("viewer"), async (c) => {
        await loadProject(c.req.param("id"));
        return c.json(await projectCoverage(c.req.param("id")));
    });
    return router;
}
