import { access } from "../access";
import { loadProject } from "../load-project";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { repoGit } from "../../../core/repo/git";
import { repositoryRecoveryUnlocked, RepositoryRecoveryError, saveRepositoryRecovery } from "../../../core/repo/recovery";

const saveSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });

export function createRepositoryRecoveryRoutes(): Hono {
    const router = new Hono();
    router.get("/projects/:id/repository/recovery", access("editor"), async (c) => {
        const project = await loadProject(c.req.param("id"));
        return c.json(await repoGit.withRepoLock(project.id, () => repositoryRecoveryUnlocked(project.id)));
    });
    router.post("/projects/:id/repository/recovery", access("editor"), zValidator("json", saveSchema), async (c) => {
        const project = await loadProject(c.req.param("id"));
        try { return c.json(await saveRepositoryRecovery(project.id, c.req.valid("json").fingerprint)); }
        catch (error) {
            if (error instanceof RepositoryRecoveryError) throw new HTTPException(409, { message: error.message });
            throw error;
        }
    });
    return router;
}
