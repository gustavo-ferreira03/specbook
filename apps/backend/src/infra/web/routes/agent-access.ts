import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { agentAccessRepository } from "../../repositories/agent-access";
import { projectsRepository } from "../../repositories/projects";
import { agentTokenInfo, issueAgentToken } from "../../../core/mcp/tokens";
import { agentAccessSettingsSchema } from "../../../core/mcp/schemas";
import { access } from "../access";
import { loadProject } from "../load-project";

export function createAgentAccessRouter(): Hono {
    const router = new Hono();
    router.get("/projects/:id/agent-access", access("viewer"), async (c) => {
        const project = await loadProject(c.req.param("id"));
        c.header("Cache-Control", "no-store");
        return c.json({ token: await agentTokenInfo(project.id), agentContractPolicy: project.agentContractPolicy ?? "apply_declared", agentsMayProvideCredentials: project.agentsMayProvideCredentials ?? true });
    });
    router.patch("/projects/:id/agent-access", access("editor"), zValidator("json", agentAccessSettingsSchema), async (c) => {
        const project = await loadProject(c.req.param("id"));
        await projectsRepository.updateProject(project.id, c.req.valid("json"));
        return c.json({ ok: true });
    });
    router.post("/projects/:id/agent-access/token", access("editor"), async (c) => {
        await loadProject(c.req.param("id"));
        c.header("Cache-Control", "no-store");
        return c.json(await issueAgentToken(c.req.param("id")));
    });
    router.delete("/projects/:id/agent-access/token", access("editor"), async (c) => {
        await loadProject(c.req.param("id"));
        await agentAccessRepository.revokeToken(c.req.param("id"));
        return c.body(null, 204);
    });
    return router;
}
