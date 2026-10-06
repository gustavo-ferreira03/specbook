import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
    accessTokenInfoOf,
    issueGitAccessToken,
    revokeGitAccessToken,
} from "../../../core/repo/access";
import { repoBare } from "../../../core/repo/bare";
import { repoGit } from "../../../core/repo/git";
import { gitCloneUrl } from "./git-http";
import { specAtCommit, specHistory } from "../../../core/repo/history";
import { reindexProjectUnlocked } from "../../../core/repo/indexer";
import { projectsRepository, type Project } from "../../repositories/projects";
import { specsRepository } from "../../repositories/specs";

async function remoteAccessOf(c: Context, project: Project) {
    return {
        cloneUrl: gitCloneUrl(c, project.id),
        branch: "main",
        headSha: await repoBare.getBareHeadSha(project.id).catch(() => null),
        token: accessTokenInfoOf(project),
        externalSyncError: project.gitExternalSyncError,
    };
}

async function loadProject(id: string): Promise<Project> {
    const project = await projectsRepository.getProject(id);
    if (!project) throw new HTTPException(404, { message: "Project not found" });
    return project;
}

export function createGitRouter(): Hono {
    const router = new Hono();

    router.get("/projects/:id/git/remote", async (c) => {
        const project = await loadProject(c.req.param("id"));
        return c.json({ remote: await remoteAccessOf(c, project) });
    });

    router.post("/projects/:id/git/remote/token", async (c) => {
        const project = await loadProject(c.req.param("id"));
        const token = await repoGit.withRepoLock(project.id, async () => {
            await repoGit.ensureProjectRepo(project.id, { create: true });
            const { checkoutMoved } = await repoBare.ensureBareRepo(project.id, repoGit.getRepoDir(project.id));
            if (checkoutMoved) await reindexProjectUnlocked(project.id);
            return (await issueGitAccessToken(project.id)).token;
        });
        // The plain token is returned exactly once; only its hash is stored.
        return c.json({ token, remote: await remoteAccessOf(c, await loadProject(project.id)) });
    });

    router.delete("/projects/:id/git/remote/token", async (c) => {
        const project = await loadProject(c.req.param("id"));
        await revokeGitAccessToken(project.id);
        return c.json({ remote: await remoteAccessOf(c, await loadProject(project.id)) });
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
