import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";

import { recordAudit, withActor } from "../../core/accounts/audit";
import type { Actor } from "../../core/accounts/audit";
import type { UserRole } from "../../core/accounts/schemas";
import {
  accessTokenFromHeaders,
  sessionFromHeaders,
} from "../../core/accounts/sessions";
import { logger } from "../logger";
import type { User } from "../repositories/accounts";

export type BearerRule = "git-token" | "ci-token" | "runner-token";
export type AccessRule = UserRole | "public" | BearerRule;
export type BearerVerifier = (c: Context) => Promise<true | Response>;
const policies = new WeakMap<object, AccessRule>();
const verifiers = new WeakMap<object, BearerVerifier>();
const rank: Record<UserRole, number> = { viewer: 1, editor: 2, admin: 3 };

declare module "hono" {
  interface ContextVariableMap {
    user: User | null;
    authentication: "session" | "token" | null;
  }
}

interface AccessFactory {
  (rule: UserRole | "public"): MiddlewareHandler;
  (rule: BearerRule, verify: BearerVerifier): MiddlewareHandler;
}

export const access: AccessFactory = (
  rule: AccessRule,
  verify?: BearerVerifier
): MiddlewareHandler => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Each route needs a unique handler identity as its WeakMap policy key.
  const marker: MiddlewareHandler = async (_c, next) => await next();
  policies.set(marker, rule);
  if (verify) {
    verifiers.set(marker, verify);
  }
  return marker;
};

export const routePolicy = (handler: object) => policies.get(handler);

export const requireBrowserSession = (c: Context): void => {
  if (c.get("authentication") !== "session") {
    throw new HTTPException(403, {
      message: "Sign in to the web app to manage account or instance settings.",
    });
  }
};

export const browserSession: MiddlewareHandler = async (c, next) => {
  requireBrowserSession(c);
  return await next();
};

export const requireRole = (c: Context, role: UserRole): User => {
  const user = c.get("user");
  if (!user) {
    throw new HTTPException(401, { message: "Sign in to continue." });
  }
  if (rank[user.role] < rank[role]) {
    throw new HTTPException(403, {
      message: "Your account does not have permission to do that.",
    });
  }
  return user;
};

// oxlint-disable-next-line arrow-body-style -- Keep the middleware factory body as the boundary around its returned request handler.
export const accessGate = (): MiddlewareHandler => {
  return async (c, next) => {
    const handlers = matchedRoutes(c).map(({ handler }) => handler);
    const declared = handlers
      .map((handler) => routePolicy(handler))
      .filter((rule): rule is AccessRule => Boolean(rule));
    const required = declared
      .filter((rule): rule is UserRole => rule in rank)
      .toSorted((a, b) => rank[b] - rank[a])
      .at(0);
    const bearer =
      !required &&
      declared.find(
        (rule) =>
          rule === "git-token" || rule === "ci-token" || rule === "runner-token"
      );
    const probe = c.req.path === "/health" || c.req.path === "/ready";
    const tokenRequest =
      !bearer && !probe && c.req.raw.headers.has("authorization");
    const session =
      bearer || probe || tokenRequest
        ? null
        : await sessionFromHeaders(c.req.raw.headers);
    const user = tokenRequest
      ? await accessTokenFromHeaders(c.req.raw.headers)
      : (session?.user ?? null);
    c.set("user", user);
    c.set(
      "authentication",
      (() => {
        if (user) {
          if (tokenRequest) {
            return "token";
          }
          return "session";
        }
        return null;
      })()
    );
    if (!declared.length) {
      throw new HTTPException(user ? 403 : 401, {
        message: "This endpoint is not available to your account.",
      });
    }
    if (required) {
      requireRole(c, required);
    }
    if (required === "admin") {
      requireBrowserSession(c);
    }
    if (bearer) {
      const verify = handlers
        .map((handler) => verifiers.get(handler))
        .find(Boolean);
      if (!verify) {
        throw new HTTPException(401, {
          message: "This endpoint requires a verified token.",
        });
      }
      const verdict = await verify(c);
      if (verdict !== true) {
        return verdict;
      }
    }
    const actor: Actor = user
      ? { id: user.id, name: user.name, email: user.email, kind: "user" }
      : {
          id: null,
          name: (() => {
            if (bearer === "git-token") {
              return "Git client";
            }
            if (bearer === "ci-token") {
              return "CI";
            }
            if (bearer === "runner-token") {
              return "Runner";
            }
            return "Specbook";
          })(),
          kind: (() => {
            if (bearer === "git-token") {
              return "git";
            }
            if (bearer === "ci-token") {
              return "ci";
            }
            return "system";
          })(),
        };
    await withActor(actor, async () => {
      // oxlint-disable-next-line node/callback-return -- This is middleware continuation or a rendered text helper, rather than an error-first Node callback.
      await next();
      if (
        !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
        c.res.status < 400 &&
        !c.req.path.startsWith("/auth/") &&
        c.req.path !== "/setup/admin"
      ) {
        const projectId = c.req.path.match(
          /\/(?:projects|git)\/(?<capture1>[a-f0-9-]{36})(?:\/|$)/u
        )?.[1];
        await recordAudit(
          "http.request",
          { method: c.req.method, path: c.req.path, status: c.res.status },
          projectId,
          actor
        ).catch((error) =>
          logger.error("could not record request audit", { error })
        );
      }
    });
  };
};
