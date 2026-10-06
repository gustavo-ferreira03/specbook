import "dotenv/config";
import { acquireStorageLock } from "./core/operations/lock";
import { migrateSecrets } from "./core/credentials/migration";
import { startRetentionMonitor, stopRetentionMonitor } from "./core/operations/retention";
import { createApp, buildAllowedOrigins } from "./infra/web/app";
import { authEvents, sessionFromHeaders } from "./core/accounts/sessions";
import { startSteward, stopSteward } from "./core/steward/engine";
import { startFailureMonitor, stopFailureMonitor } from "./core/jobs/failures";
import { startScheduleMonitor, stopScheduleMonitor } from "./core/jobs/schedules";
import { startJobWorker, stopJobWorker } from "./core/jobs/worker";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { closeAllChatBrowsers } from "./core/browser/sessions";
import { discoverPendingProjectContexts } from "./core/chat/discovery";
import { getVncSession, proxyVncSession } from "./core/browser/vnc";
import { repoGit } from "./core/repo/git";
import { reindexAllProjects } from "./core/repo/indexer";
import { markInterruptedBatches } from "./core/runner/batch";
import { stopActiveRunProcesses } from "./core/runner/run";
import { runMigrations } from "./infra/db/migrate";
import { logger } from "./infra/logger";
import { runsRepository } from "./infra/repositories/runs";
import {
    buildHostAllowlist,
    isAllowedHost,
    isAllowedWebsocketOrigin,
} from "./infra/web/security";

// Log before anything else can fail. An uncaught exception leaves the process
// in an unknown state, so exit and let Docker's restart policy recover it.
process.on("unhandledRejection", (reason) => {
    logger.error("unhandled promise rejection", { error: reason });
});
process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error });
    process.exit(1);
});

const port = Number(process.env.PORT ?? 4000);
const hostname = process.env.HOST ?? "127.0.0.1";
const app = createApp();
const allowedOrigins = buildAllowedOrigins();
const hostAllowlist = buildHostAllowlist(port);

// ---- Boot sequence --------------------------------------------------------
// Order matters: schema first, then repository repair, then state that reads
// the repositories. Wire new boot steps here, before the server starts.
const releaseStorage = await acquireStorageLock();
await runMigrations();
await migrateSecrets();
await repoGit.recoverAllInterruptedState();
// reindexAllProjects also applies the bare repository policy to every project.
await runsRepository.markInterruptedRuns();
await markInterruptedBatches();
await reindexAllProjects();
await startJobWorker();
discoverPendingProjectContexts();
startFailureMonitor();
startScheduleMonitor();
startSteward();
startRetentionMonitor();
// ---------------------------------------------------------------------------
const server = serve({ fetch: app.fetch, port, hostname }, () => {
    logger.info("backend listening", { hostname, port });
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (websocket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const sessionId = url.pathname.split("/").filter(Boolean)[1];
    if (!sessionId || !getVncSession(sessionId)) {
        websocket.close(1008, "Unknown VNC session");
        return;
    }
    proxyVncSession(sessionId, websocket).catch((error: unknown) => {
        logger.warn("VNC proxy handshake failed", { sessionId, error });
    });
});

server.on("upgrade", (request, socket, head) => {
    const headers = new Headers(Object.entries(request.headers).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []));
    if (
        !request.url?.startsWith("/vnc/") ||
        !isAllowedHost(hostAllowlist, request.headers.host) ||
        !isAllowedWebsocketOrigin(headers, hostAllowlist, allowedOrigins)
    ) {
        socket.destroy();
        return;
    }
    void sessionFromHeaders(headers).then((authenticated) => {
        if (!authenticated || authenticated.user.role === "viewer") { socket.destroy(); return; }
        wss.handleUpgrade(request, socket, head, (websocket) => {
            const closeUser = (id: string) => { if (id === authenticated.user.id) websocket.close(1008, "Account permissions changed"); };
            const closeSession = (hash: string) => { if (hash === authenticated.session.tokenHash) websocket.close(1008, "Signed out"); };
            authEvents.on("user", closeUser);
            authEvents.on("session", closeSession);
            const expiry = setTimeout(() => websocket.close(1008, "Session expired"), Math.max(0, Date.parse(authenticated.session.expiresAt) - Date.now()));
            expiry.unref();
            websocket.once("close", () => { clearTimeout(expiry); authEvents.off("user", closeUser); authEvents.off("session", closeSession); });
            // Recheck after subscribing so a permission change during the upgrade cannot be missed.
            void sessionFromHeaders(headers).then((current) => {
                if (!current || current.user.role === "viewer") websocket.close(1008, "Sign in with permission to use the browser");
                else wss.emit("connection", websocket, request);
            }).catch(() => websocket.close(1011, "Could not verify session"));
        });
    }).catch((error) => { logger.warn("VNC authentication failed", { error }); socket.destroy(); });
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    const timer = setTimeout(() => {
        logger.warn("shutdown timed out; exiting");
        process.exit(1);
    }, 10_000);
    timer.unref();
    // Stop accepting first, then tear down the work that is still running.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const client of wss.clients) client.terminate();
    wss.close();
    stopFailureMonitor();
    stopScheduleMonitor();
    stopSteward();
    await stopRetentionMonitor();
    await stopJobWorker();
    stopActiveRunProcesses();
    await closeAllChatBrowsers().catch((error: unknown) => logger.error("closing browsers failed", { error }));
    // Open SSE streams would otherwise hold server.close() until the timeout.
    if ("closeAllConnections" in server) server.closeAllConnections();
    await closed;
    await releaseStorage();
    clearTimeout(timer);
    process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { app, server };
