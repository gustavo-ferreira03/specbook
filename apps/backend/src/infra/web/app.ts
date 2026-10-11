import { Hono } from "hono";
import { cors } from "hono/cors";
import { access, accessGate } from "./access";
import { handleRequestError } from "./errors";
import { buildHostAllowlist, csrfGuard, hostGuard, jsonBodyLimit, REQUEST_HEADER, requestLogger } from "./security";
import { createAccountsRouter } from "./routes/accounts";
import { createCiRouter, createCiSettingsRouter } from "./routes/ci";
import { createStewardRouter } from "./routes/steward";
import { createJobsRouter } from "./routes/jobs";
import { createSchedulesRouter } from "./routes/schedules";
import { createChatsRouter } from "./routes/chats";
import { createCredentialsRouter } from "./routes/credentials";
import { createCoverageRouter } from "./routes/coverage";
import { createFeaturesRouter } from "./routes/features";
import { createGitRouter } from "./routes/git";
import { createGitHttpRouter } from "./routes/git-http";
import { createProjectContextsRouter } from "./routes/project-contexts";
import { createEnvironmentsRouter } from "./routes/environments";
import { createProjectsRouter } from "./routes/projects";
import { createRunsRouter } from "./routes/runs";
import { createSettingsRouter } from "./routes/settings";
import { createSpecsRouter } from "./routes/specs";
import { createSetupRouter } from "./routes/setup";
import { createRepositoryRecoveryRoutes } from "./routes/repository-recovery";
import { createSafetySettingsRouter } from "./routes/safety-settings";
import { createOperationsRouter } from "./routes/operations";

export function buildAllowedOrigins(frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:4001"): Set<string> {
    const allowed = new Set([frontendOrigin]);
    try {
        const url = new URL(frontendOrigin);
        if (url.hostname === "localhost") allowed.add(`${url.protocol}//127.0.0.1:${url.port}`);
        if (url.hostname === "127.0.0.1") allowed.add(`${url.protocol}//localhost:${url.port}`);
    } catch {}
    return allowed;
}

export function createApp(): Hono {
    const app = new Hono();
    const allowedOrigins = buildAllowedOrigins();
    app.use("*", requestLogger());
    app.use("*", cors({ origin: (origin) => allowedOrigins.has(origin) ? origin : undefined, allowHeaders: ["Content-Type", REQUEST_HEADER], credentials: true }));
    app.use("*", hostGuard(buildHostAllowlist(Number(process.env.PORT ?? 4000))));
    app.use("*", accessGate());
    app.use("*", csrfGuard());
    app.use("*", jsonBodyLimit());
    app.onError(handleRequestError);
    app.get("/health", access("public"), (c) => c.json({ ok: true }));
    app.route("/", createAccountsRouter());
    app.route("/", createSafetySettingsRouter());
    app.route("/", createOperationsRouter());
    app.route("/", createSetupRouter());
    app.route("/", createRepositoryRecoveryRoutes());
    app.route("/", createProjectsRouter());
    app.route("/", createEnvironmentsRouter());
    app.route("/", createCoverageRouter());
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
    return app;
}
