import "dotenv/config";
import net from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { WebSocketServer } from "ws";
import { closeAllConversationBrowsers } from "./core/browser/sessions";
import { getVncSession } from "./core/browser/vnc";
import { stopActiveRobotProcesses } from "./core/runner/robot";
import { markInterruptedRuns } from "./repositories/runs";
import { createConversationsRouter } from "./routes/conversations";
import { createFeaturesRouter } from "./routes/features";
import { createProjectsRouter } from "./routes/projects";
import { createRunsRouter } from "./routes/runs";
import { createSettingsRouter } from "./routes/settings";
import { createSpecsRouter } from "./routes/specs";

const app = new Hono();
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:4001";
app.use("*", cors({ origin: frontendOrigin }));
app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", createProjectsRouter());
app.route("/", createSpecsRouter());
app.route("/", createRunsRouter());
app.route("/", createConversationsRouter());
app.route("/", createFeaturesRouter());
app.route("/", createSettingsRouter());

const port = Number(process.env.PORT ?? 4000);
const hostname = process.env.HOST ?? "127.0.0.1";
await markInterruptedRuns();
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
        (request.headers.origin !== undefined && request.headers.origin !== frontendOrigin)
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
    await closeAllConversationBrowsers();
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
