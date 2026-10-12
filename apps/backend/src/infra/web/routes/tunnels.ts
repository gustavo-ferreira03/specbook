import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { authenticateRunnerToken } from "../../../core/private-runner/tokens";
import { configuredTunnel, hasTunnel, publicTunnels, tunnelStartCommand } from "../../../core/tunnel/registry";
import { environmentsRepository } from "../../repositories/environments";
import { access } from "../access";
import { loadProject } from "../load-project";

async function verifyTunnel(c: Context): Promise<true> {
    const runner = await authenticateRunnerToken(c.req.header("authorization"));
    if (!runner) throw new HTTPException(401, { message: "Provide a valid runner token. Create one in Settings → Runners." });
    c.set("runner", runner);
    return true;
}

export function createTunnelsRouter(): Hono {
    const router = new Hono();
    router.get("/tunnels", access("admin"), (c) => c.json({ tunnels: publicTunnels() }));
    router.get("/projects/:id/tunnels", access("viewer"), async (c) => {
        const projectId = c.req.param("id");
        await loadProject(projectId);
        const environments = await environmentsRepository.list(projectId);
        return c.json({ tunnels: environments.filter((environment) => String(environment.executor) === "tunnel").map((environment) => ({
            environmentId: environment.id, environmentName: environment.name, group: environment.runnerGroup,
            connected: hasTunnel(environment.id), command: tunnelStartCommand(environment, projectId),
        })) });
    });
    router.get("/runner/tunnel/config", access("runner-token", verifyTunnel), async (c) => {
        try {
            const config = await configuredTunnel(c.get("runner"), c.req.query("project") ?? "", c.req.query("environment") ?? "Production");
            c.header("Cache-Control", "no-store");
            return c.json(config);
        } catch (error) { throw new HTTPException(403, { message: error instanceof Error ? error.message : "Runner token cannot tunnel this environment" }); }
    });
    return router;
}
