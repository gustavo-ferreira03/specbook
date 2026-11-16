import { Hono } from "hono";
import { cors } from "hono/cors";

import { access, accessGate } from "./access";
import { handleRequestError } from "./errors";
import { createAccountsRouter } from "./routes/accounts";
import { createChatsRouter } from "./routes/chats";
import { createCiRouter, createCiSettingsRouter } from "./routes/ci";
import { createCliRouter } from "./routes/cli";
import { createCoverageRouter } from "./routes/coverage";
import { createCredentialsRouter } from "./routes/credentials";
import { createEnvironmentsRouter } from "./routes/environments";
import { createFeaturesRouter } from "./routes/features";
import { createGitRouter } from "./routes/git";
import { createGitHttpRouter } from "./routes/git-http";
import { createJobsRouter } from "./routes/jobs";
import { createOperationsRouter } from "./routes/operations";
import { createProjectContextsRouter } from "./routes/project-contexts";
import { createProjectsRouter } from "./routes/projects";
import { createRepositoryRecoveryRoutes } from "./routes/repository-recovery";
import { createRunnersRouter } from "./routes/runners";
import { createRunsRouter } from "./routes/runs";
import { createSafetySettingsRouter } from "./routes/safety-settings";
import { createSchedulesRouter } from "./routes/schedules";
import { createSettingsRouter } from "./routes/settings";
import { createSetupRouter } from "./routes/setup";
import { createSpecsRouter } from "./routes/specs";
import { createStewardRouter } from "./routes/steward";
import { createTunnelsRouter } from "./routes/tunnels";
import {
  buildHostAllowlist,
  csrfGuard,
  hostGuard,
  jsonBodyLimit,
  REQUEST_HEADER,
  requestLogger,
} from "./security";

export function buildAllowedOrigins(
  frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:4001"
): Set<string> {
  const allowed = new Set([frontendOrigin]);
  try {
    const url = new URL(frontendOrigin);
    if (url.hostname === "localhost") {
      allowed.add(`${url.protocol}//127.0.0.1:${url.port}`);
    }
    if (url.hostname === "127.0.0.1") {
      allowed.add(`${url.protocol}//localhost:${url.port}`);
    }
  } catch {}
  return allowed;
}

export function createApp(): Hono {
  const app = new Hono();
  const allowedOrigins = buildAllowedOrigins();
  app.use("*", requestLogger());
  app.use(
    "*",
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", REQUEST_HEADER],
      credentials: true,
    })
  );
  app.use("*", hostGuard(buildHostAllowlist(Number(process.env.PORT ?? 4000))));
  app.use("*", accessGate());
  app.use("*", csrfGuard());
  app.use("*", jsonBodyLimit());
  app.onError(handleRequestError);
  app.get("/health", access("public"), (c) => c.json({ ok: true }));
  app.route("/", createCliRouter());
  app.route("/", createAccountsRouter());
  app.route("/", createSafetySettingsRouter());
  app.route("/", createOperationsRouter());
  app.route("/", createSetupRouter());
  app.route("/", createRepositoryRecoveryRoutes());
  app.route("/", createProjectsRouter());
  app.route("/", createEnvironmentsRouter());
  app.route("/", createRunnersRouter());
  app.route("/", createTunnelsRouter());
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
