import "dotenv/config";
import { createCiRouter, createCiSettingsRouter } from "./infra/web/routes/ci";
import { startSteward, stopSteward } from "./core/steward/engine";
import { createStewardRouter } from "./infra/web/routes/steward";
import { startFailureMonitor, stopFailureMonitor } from "./core/jobs/failures";
import { startScheduleMonitor, stopScheduleMonitor } from "./core/jobs/schedules";
import { startJobWorker, stopJobWorker } from "./core/jobs/worker";
import { createJobsRouter } from "./infra/web/routes/jobs";
import { createSchedulesRouter } from "./infra/web/routes/schedules";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleRequestError } from "./infra/web/errors";
import { WebSocketServer } from "ws";
import { closeAllChatBrowsers } from "./core/browser/sessions";
import { getVncSession, proxyVncSession } from "./core/browser/vnc";
import { repoGit } from "./core/repo/git";
import { reindexAllProjects } from "./core/repo/indexer";
import { markInterruptedBatches } from "./core/runner/batch";
import { stopActiveRunProcesses } from "./core/runner/run";
import { runMigrations } from "./infra/db/migrate";
import { logger } from "./infra/logger";
import { runsRepository } from "./infra/repositories/runs";
import { createChatsRouter } from "./infra/web/routes/chats";
import { createCredentialsRouter } from "./infra/web/routes/credentials";
import { createFeaturesRouter } from "./infra/web/routes/features";
import { createGitRouter } from "./infra/web/routes/git";
import { createGitHttpRouter } from "./infra/web/routes/git-http";
import { createProjectContextsRouter } from "./infra/web/routes/project-contexts";
import { createProjectsRouter } from "./infra/web/routes/projects";
import { createRunsRouter } from "./infra/web/routes/runs";
import { createSettingsRouter } from "./infra/web/routes/settings";
import { createSpecsRouter } from "./infra/web/routes/specs";
import {
    buildHostAllowlist,
    csrfGuard,
    hostGuard,
    isAllowedHost,
    isAllowedWebsocketOrigin,
    jsonBodyLimit,
    REQUEST_HEADER,
    requestLogger,
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

function buildAllowedOrigins(frontendOrigin: string): Set<string> {
    const allowed = new Set([frontendOrigin]);
    try {
        const url = new URL(frontendOrigin);
        if (url.hostname === "localhost") allowed.add(`${url.protocol}//127.0.0.1:${url.port}`);
        if (url.hostname === "127.0.0.1") allowed.add(`${url.protocol}//localhost:${url.port}`);
    } catch {}
    return allowed;
}

const port = Number(process.env.PORT ?? 4000);
const hostname = process.env.HOST ?? "127.0.0.1";
const app = new Hono();
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:4001";
const allowedOrigins = buildAllowedOrigins(frontendOrigin);
const hostAllowlist = buildHostAllowlist(port);
app.use("*", requestLogger());
app.use(
    "*",
    cors({
        origin: (origin) => (allowedOrigins.has(origin) ? origin : undefined),
        allowHeaders: ["Content-Type", REQUEST_HEADER],
        credentials: true,
    }),
);
// CORS only stops other sites from reading responses. These guards stop them
// from reaching the API at all: DNS rebinding through the Host check, and
// cross-site form posts through the custom header that forces a preflight.
app.use("*", hostGuard(hostAllowlist));
app.use("*", csrfGuard());
app.use("*", jsonBodyLimit());
app.onError(handleRequestError);

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", createProjectsRouter());
app.route("/", createJobsRouter());
app.route("/", createStewardRouter());
app.route("/", createCiRouter());
app.route("/", createCiSettingsRouter());
app.route("/", createSchedulesRouter());
app.route("/", createSpecsRouter());
app.route("/", createRunsRouter());
app.route("/", createChatsRouter());
app.route("/", createProjectContextsRouter());
app.route("/", createFeaturesRouter());
app.route("/", createGitRouter());
app.route("/", createGitHttpRouter());
app.route("/", createSettingsRouter());
app.route("/", createCredentialsRouter());

// ---- Boot sequence --------------------------------------------------------
// Order matters: schema first, then repository repair, then state that reads
// the repositories. Wire new boot steps here, before the server starts.
await runMigrations();
await repoGit.recoverAllInterruptedState();
// reindexAllProjects also applies the bare repository policy to every project.
await runsRepository.markInterruptedRuns();
await markInterruptedBatches();
await reindexAllProjects();
await startJobWorker();
startFailureMonitor();
startScheduleMonitor();
startSteward();
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
    wss.handleUpgrade(request, socket, head, (websocket) => {
        wss.emit("connection", websocket, request);
    });
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
    await stopJobWorker();
    stopActiveRunProcesses();
    await closeAllChatBrowsers().catch((error: unknown) => logger.error("closing browsers failed", { error }));
    // Open SSE streams would otherwise hold server.close() until the timeout.
    if ("closeAllConnections" in server) server.closeAllConnections();
    await closed;
    clearTimeout(timer);
    process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { app, server };
