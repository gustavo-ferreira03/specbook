import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { withRepoLock } from "../../../core/repo/git";
import { specAtCommit, specHistory } from "../../../core/repo/history";
import { reindexProjectUnlocked } from "../../../core/repo/indexer";
import { cancelScheduledPush, flushPush, testRemote } from "../../../core/repo/remote";
import { resolveConflicts, syncProject } from "../../../core/repo/sync";
import { projectsRepository, type Project } from "../../repositories/projects";
import { specsRepository } from "../../repositories/specs";

const connectSchema = z.object({
    remoteUrl: z.string().trim().min(1),
    token: z.string().trim().min(1).nullable().optional(),
});

const resolveSchema = z.object({
    choices: z.array(z.object({ path: z.string().min(1), keep: z.enum(["local", "remote"]) })),
});

function gitStatusOf(project: Project) {
    return {
        remoteUrl: project.gitRemoteUrl,
        hasToken: Boolean(project.gitToken),
        pushError: project.gitPushError,
        conflictPaths: project.gitConflictPaths,
        contextSyncError: project.contextSyncError,
    };
}

async function loadProject(id: string): Promise<Project> {
    const project = await projectsRepository.getProject(id);
    if (!project) throw new HTTPException(404, { message: "Project not found" });
    return project;
}

function validateRemote(remoteUrl: string, token: string | null): void {
    try {
        const url = new URL(remoteUrl);
        if (url.username || url.password) {
            throw new HTTPException(400, { message: "Repository URLs must not contain credentials" });
        }
        if (token && url.protocol !== "https:") {
            throw new HTTPException(400, { message: "GitHub tokens can only be sent to HTTPS repositories" });
        }
        if (token && url.hostname.toLowerCase() !== "github.com") {
            throw new HTTPException(400, { message: "GitHub tokens can only be sent to github.com" });
        }
    } catch (error) {
        if (error instanceof HTTPException) throw error;
        if (token) throw new HTTPException(400, { message: "GitHub tokens require an HTTPS repository URL" });
    }
}

export function createGitRouter(): Hono {
    const router = new Hono();

    router.get("/projects/:id/git", async (c) => {
        return c.json({ git: gitStatusOf(await loadProject(c.req.param("id"))) });
    });

    router.put("/projects/:id/git", zValidator("json", connectSchema), async (c) => {
        const project = await loadProject(c.req.param("id"));
        const { remoteUrl, token } = c.req.valid("json");
        const effectiveToken = token === undefined && remoteUrl === project.gitRemoteUrl ? project.gitToken : token ?? null;
        validateRemote(remoteUrl, effectiveToken);
        const clearingSavedToken = token === null && remoteUrl === project.gitRemoteUrl;
        if (clearingSavedToken) {
            await withRepoLock(project.id, async () => {
                cancelScheduledPush(project.id);
                await projectsRepository.updateGitConnection(project.id, remoteUrl, null);
                await reindexProjectUnlocked(project.id);
            });
            return c.json({ git: gitStatusOf(await loadProject(project.id)) });
        }
        const test = await testRemote(remoteUrl, effectiveToken);
        if (!test.ok) throw new HTTPException(400, { message: test.error });
        await withRepoLock(project.id, async () => {
            cancelScheduledPush(project.id);
            await projectsRepository.updateGitConnection(project.id, remoteUrl, effectiveToken);
            await reindexProjectUnlocked(project.id);
        });
        let outcome;
        try {
            outcome = await syncProject(project.id);
        } catch (error) {
            await withRepoLock(project.id, async () => {
                cancelScheduledPush(project.id);
                await projectsRepository.updateGitConnection(project.id, project.gitRemoteUrl, project.gitToken);
                await projectsRepository.setGitPushError(project.id, project.gitPushError);
                await projectsRepository.setGitConflictPaths(project.id, project.gitConflictPaths);
                await reindexProjectUnlocked(project.id);
            });
            throw error;
        }
        if (outcome.status !== "conflict") await flushPush(project.id);
        return c.json({ git: gitStatusOf(await loadProject(project.id)) });
    });

    router.delete("/projects/:id/git", async (c) => {
        const project = await loadProject(c.req.param("id"));
        await withRepoLock(project.id, async () => {
            cancelScheduledPush(project.id);
            await projectsRepository.updateGitConnection(project.id, null, null);
            await reindexProjectUnlocked(project.id);
        });
        return c.body(null, 204);
    });

    router.post("/projects/:id/git/sync", async (c) => {
        const project = await loadProject(c.req.param("id"));
        const outcome = await syncProject(project.id);
        if (outcome.status !== "conflict") await flushPush(project.id);
        return c.json({ outcome });
    });

    router.post("/projects/:id/git/resolve", zValidator("json", resolveSchema), async (c) => {
        const project = await loadProject(c.req.param("id"));
        return c.json({ outcome: await resolveConflicts(project.id, c.req.valid("json").choices) });
    });

    router.get("/specs/:id/history", async (c) => {
        const spec = await specsRepository.getSpec(c.req.param("id"));
        if (!spec) throw new HTTPException(404, { message: "Spec not found" });
        return c.json({ entries: await specHistory(spec) });
    });

    router.get("/specs/:id/history/:sha", async (c) => {
        const spec = await specsRepository.getSpec(c.req.param("id"));
        if (!spec) throw new HTTPException(404, { message: "Spec not found" });
        return c.json(await specAtCommit(spec, c.req.param("sha")));
    });

    return router;
}
