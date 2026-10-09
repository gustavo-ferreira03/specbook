import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";
import { recordAudit, withActor, type Actor } from "../../core/accounts/audit";
import { sessionFromHeaders } from "../../core/accounts/sessions";
import type { UserRole } from "../../core/accounts/schemas";
import type { User } from "../repositories/accounts";
import { logger } from "../logger";

export type BearerRule = "git-token" | "ci-token" | "agent-token";
export type AccessRule = UserRole | "public" | BearerRule;
export type BearerVerifier = (c: Context) => Promise<true | Response>;
const policies = new WeakMap<Function, AccessRule>();
const verifiers = new WeakMap<Function, BearerVerifier>();
const rank: Record<UserRole, number> = { viewer: 1, editor: 2, admin: 3 };

declare module "hono" {
    interface ContextVariableMap { user: User | null; agentClientName: string }
}

export function access(rule: UserRole | "public"): MiddlewareHandler;
export function access(rule: BearerRule, verify: BearerVerifier): MiddlewareHandler;
export function access(rule: AccessRule, verify?: BearerVerifier): MiddlewareHandler {
    const marker: MiddlewareHandler = async (_c, next) => next();
    policies.set(marker, rule);
    if (verify) verifiers.set(marker, verify);
    return marker;
}

export const routePolicy = (handler: Function) => policies.get(handler);

export function requireRole(c: Context, role: UserRole): User {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "Sign in to continue." });
    if (rank[user.role] < rank[role]) throw new HTTPException(403, { message: "Your account does not have permission to do that." });
    return user;
}

export function accessGate(): MiddlewareHandler {
    return async (c, next) => {
        const handlers = matchedRoutes(c).map(({ handler }) => handler);
        const declared = handlers.map((handler) => routePolicy(handler)).filter((rule): rule is AccessRule => Boolean(rule));
        const required = declared.filter((rule): rule is UserRole => rule in rank).sort((a, b) => rank[b] - rank[a]).at(0);
        const bearer = !required && declared.find((rule) => rule === "git-token" || rule === "ci-token" || rule === "agent-token");
        const probe = c.req.path === "/health" || c.req.path === "/ready";
        const session = bearer || probe ? null : await sessionFromHeaders(c.req.raw.headers);
        c.set("user", session?.user ?? null);
        if (!declared.length) throw new HTTPException(session ? 403 : 401, { message: "This endpoint is not available to your account." });
        if (required) requireRole(c, required);
        if (bearer) {
            const verify = handlers.map((handler) => verifiers.get(handler)).find(Boolean);
            if (!verify) throw new HTTPException(401, { message: "This endpoint requires a verified token." });
            const verdict = await verify(c);
            if (verdict !== true) return verdict;
        }
        const actor: Actor = session
            ? { id: session.user.id, name: session.user.name, email: session.user.email, kind: "user" }
            : { id: null, name: bearer === "git-token" ? "Git client" : bearer === "ci-token" ? "CI" : bearer === "agent-token" ? c.req.header("user-agent") || "External agent" : "Specbook", kind: bearer === "git-token" ? "git" : bearer === "ci-token" ? "ci" : bearer === "agent-token" ? "agent" : "system" };
        await withActor(actor, async () => {
            await next();
            if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.res.status < 400 && !c.req.path.startsWith("/auth/") && c.req.path !== "/setup/admin") {
                const projectId = c.req.path.match(/\/(?:projects|git)\/([a-f0-9-]{36})(?:\/|$)/)?.[1];
                await recordAudit("http.request", { method: c.req.method, path: c.req.path, status: c.res.status }, projectId, bearer === "agent-token" ? { id: null, kind: "agent", name: c.get("agentClientName") || actor.name } : actor)
                    .catch((error) => logger.error("could not record request audit", { error }));
            }
        });
    };
}
