import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authenticateAgentToken } from "../../../core/mcp/tokens";
import { tokenHash } from "../../../core/accounts/tokens";
import { withActor } from "../../../core/accounts/audit";
import { createProjectScrubber } from "../../../core/credentials/scrub";
import { createProjectMcpServer } from "../../../core/mcp/server";
import { access, type BearerVerifier } from "../access";
import { publicFrontendOrigin } from "../security";

const clientNames = new Map<string, { name: string; until: number }>();

const verifyAgentToken: BearerVerifier = async (c) => {
    const projectId = c.req.path.match(/^\/mcp\/projects\/([0-9a-f-]{36})$/i)?.[1];
    return projectId && await authenticateAgentToken(projectId, c.req.header("authorization"))
        ? true
        : Response.json({ error: "A valid project agent bearer token is required" }, { status: 401 });
};

export function createMcpRouter(): Hono {
    const router = new Hono();
    router.on(["POST", "GET", "DELETE"], "/mcp/projects/:id", access("agent-token", verifyAgentToken), async (c) => {
        const projectId = c.req.param("id");
        const authorization = c.req.header("authorization");
        if (!z.string().uuid().safeParse(projectId).success || !await authenticateAgentToken(projectId, authorization)) {
            throw new HTTPException(401, { message: "A valid project agent bearer token is required" });
        }
        c.header("Cache-Control", "no-store");
        const frontendOrigin = publicFrontendOrigin(c);
        const key = `${projectId}:${tokenHash(authorization!)}:${c.req.header("user-agent") ?? ""}`;
        let initializedName: string | undefined;
        if (c.req.method === "POST") {
            const body = await c.req.raw.clone().json().catch(() => null);
            if (body?.method === "initialize" && typeof body.params?.clientInfo?.name === "string") initializedName = body.params.clientInfo.name;
        }
        const remembered = clientNames.get(key);
        const clientName = (await createProjectScrubber(projectId)(initializedName || (remembered && remembered.until > Date.now() ? remembered.name : "") || c.req.header("user-agent") || "External agent")).slice(0, 200);
        if (initializedName) {
            for (const [id, entry] of clientNames) if (entry.until <= Date.now()) clientNames.delete(id);
            if (clientNames.size >= 1000) clientNames.delete(clientNames.keys().next().value!);
            clientNames.set(key, { name: clientName, until: Date.now() + 30 * 60_000 });
        }
        c.set("agentClientName", clientName);
        const server = createProjectMcpServer({ projectId, authorization: authorization!, frontendOrigin,
            clientName, signal: c.req.raw.signal });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try {
            await server.connect(transport);
            return await withActor({ id: null, kind: "agent", name: clientName }, () => transport.handleRequest(c.req.raw));
        } finally {
            await server.close();
        }
    });
    return router;
}
