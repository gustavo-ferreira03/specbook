import "dotenv/config";
import net from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { WebSocketServer } from "ws";
import { closeAllChatBrowsers } from "./core/browser/sessions";
import { getVncSession } from "./core/browser/vnc";
import { reindexAllProjects } from "./core/repo/indexer";
import { startSyncLoop } from "./core/repo/sync";
import { markInterruptedBatches } from "./core/runner/batch";
import { stopActiveRobotProcesses } from "./core/runner/robot";
import { runsRepository } from "./infra/repositories/runs";
import { createChatsRouter } from "./infra/web/routes/chats";
import { createFeaturesRouter } from "./infra/web/routes/features";
import { createGitRouter } from "./infra/web/routes/git";
import { createProjectContextsRouter } from "./infra/web/routes/project-contexts";
import { createProjectsRouter } from "./infra/web/routes/projects";
import { createRunsRouter } from "./infra/web/routes/runs";
import { createSettingsRouter } from "./infra/web/routes/settings";
import { createSpecsRouter } from "./infra/web/routes/specs";

function buildAllowedOrigins(frontendOrigin: string): Set<string> {
    const allowed = new Set([frontendOrigin]);
    try {
        const url = new URL(frontendOrigin);
        if (url.hostname === "localhost") allowed.add(`${url.protocol}//127.0.0.1:${url.port}`);
        if (url.hostname === "127.0.0.1") allowed.add(`${url.protocol}//localhost:${url.port}`);
    } catch {}
    return allowed;
}

const app = new Hono();
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:4001";
const allowedOrigins = buildAllowedOrigins(frontendOrigin);
app.use("*", cors({ origin: (origin) => (allowedOrigins.has(origin) ? origin : undefined) }));
app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", createProjectsRouter());
app.route("/", createSpecsRouter());
app.route("/", createRunsRouter());
app.route("/", createChatsRouter());
app.route("/", createProjectContextsRouter());
app.route("/", createFeaturesRouter());
app.route("/", createGitRouter());
app.route("/", createSettingsRouter());

const port = Number(process.env.PORT ?? 4000);
const hostname = process.env.HOST ?? "127.0.0.1";
await runsRepository.markInterruptedRuns();
await markInterruptedBatches();
await reindexAllProjects();
startSyncLoop();
const server = serve({ fetch: app.fetch, port, hostname }, () => {
    console.log(`[specbook] backend listening on :${port}`);
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (websocket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const sessionId = url.pathname.split("/").filter(Boolean)[1];
    const session = sessionId ? getVncSession(sessionId) : null;
    if (!session) {
        websocket.close(1008, "Unknown VNC session");
        return;
    }
    const vnc = net.createConnection(session.port, "127.0.0.1");
    const cleanup = () => {
        vnc.destroy();
        if (websocket.readyState === websocket.OPEN || websocket.readyState === websocket.CONNECTING) {
            websocket.terminate();
        }
    };
    websocket.on("message", (data) => {
        if (vnc.writable) vnc.write(data as Buffer);
    });
    websocket.on("close", () => vnc.destroy());
    websocket.on("error", cleanup);
    vnc.on("data", (data) => {
        if (websocket.readyState === websocket.OPEN) websocket.send(data);
    });
    vnc.on("close", () => {
        if (websocket.readyState === websocket.OPEN || websocket.readyState === websocket.CONNECTING) {
            websocket.terminate();
        }
    });
    vnc.on("error", cleanup);
});

server.on("upgrade", (request, socket, head) => {
    if (
        !request.url?.startsWith("/vnc/") ||
        (request.headers.origin !== undefined && !allowedOrigins.has(request.headers.origin))
    ) {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => {
        wss.emit("connection", websocket, request);
    });
});

let shuttingDown = false;

async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const client of wss.clients) client.terminate();
    wss.close();
    stopActiveRobotProcesses();
    await closeAllChatBrowsers();
    const timer = setTimeout(() => process.exit(1), 5000);
    timer.unref();
    server.close(() => {
        clearTimeout(timer);
        process.exit(0);
    });
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

export { app, server };
