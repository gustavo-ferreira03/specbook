import crypto from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { recordAudit } from "../../../core/accounts/audit";
import { beginOidc, finishOidc, validateIssuer } from "../../../core/accounts/oidc";
import { hashPassword, verifyPassword } from "../../../core/accounts/passwords";
import { acceptInvitationSchema, accessTokenSchema, adminSchema, invitationSchema, loginSchema, memberSchema, ssoSchema, tokenSchema } from "../../../core/accounts/schemas";
import { authEvents, clearCookies, cookieToken, publicUser, randomToken, requestOrigin, revokeUserSessions, sessionFromHeaders, startSession, tokenHash } from "../../../core/accounts/sessions";
import { encryptSecret } from "../../../core/credentials/crypto";
import { accountsRepository, withAccountsLock, type User } from "../../repositories/accounts";
import { access, browserSession, requireBrowserSession, requireRole } from "../access";
import { logger } from "../../logger";

const attempts = new Map<string, { count: number; resets: number }>();
function attempt(key: string): { count: number; resets: number } {
    const now = Date.now();
    for (const [entry, value] of attempts) if (value.resets <= now) attempts.delete(entry);
    while (attempts.size >= 10_000) attempts.delete(attempts.keys().next().value!);
    const entry = attempts.get(key) ?? { count: 0, resets: now + 60_000 };
    attempts.set(key, entry);
    return entry;
}
const tooMany = () => new HTTPException(429, { message: "Too many sign-in attempts. Wait a minute and try again." });
function limit(key: string, maximum = 10): void {
    const entry = attempt(key);
    entry.count++;
    if (entry.count > maximum) throw tooMany();
}

const actor = (user: User) => ({ id: user.id, name: user.name, email: user.email, kind: "user" as const });
const publicInvitation = ({ id, email, role, expiresAt }: { id: string; email: string; role: string; expiresAt: string }) => ({ id, email, role, expiresAt });
const publicSso = (sso: Awaited<ReturnType<typeof accountsRepository.getSso>>) => {
    const { clientSecret, verifiedUsers: _verifiedUsers, ...settings } = sso;
    return { ...settings, hasClientSecret: Boolean(clientSecret) };
};

async function passwordHash(password: string): Promise<string> {
    try { return await hashPassword(password); }
    catch { throw new HTTPException(429, { message: "Another sign-in is being processed. Wait a moment and try again." }); }
}

export function createAccountsRouter(): Hono {
    const router = new Hono();

    router.get("/auth/options", access("public"), async (c) => {
        const sso = await accountsRepository.getSso();
        return c.json({ needsAdmin: !await accountsRepository.hasUsers(), passwordLoginEnabled: sso.passwordLoginEnabled, oidcEnabled: sso.enabled });
    });
    router.get("/auth/me", access("viewer"), (c) => c.json({ user: publicUser(requireRole(c, "viewer")) }));

    router.get("/auth/access-tokens", access("viewer"), browserSession, async (c) => {
        return c.json({ tokens: await accountsRepository.accessTokens(requireRole(c, "viewer").id) });
    });
    router.post("/auth/access-tokens", access("viewer"), zValidator("json", accessTokenSchema), async (c) => {
        if (c.get("authentication") !== "session") throw new HTTPException(403, { message: "Sign in to the web app to create access tokens." });
        const user = requireRole(c, "viewer");
        const token = `sb_pat_${randomToken()}`;
        const { name, expiresAt } = c.req.valid("json");
        const accessToken = await withAccountsLock(async () => {
            const session = await sessionFromHeaders(c.req.raw.headers);
            if (!session || session.user.id !== user.id) throw new HTTPException(401, { message: "Your session was revoked. Sign in again before creating a token." });
            return accountsRepository.createAccessToken(user.id, name, tokenHash(token), expiresAt);
        });
        await recordAudit("auth.access_token.created", { id: accessToken.id, name: accessToken.name });
        c.header("Cache-Control", "no-store");
        return c.json({ token, accessToken }, 201);
    });
    router.delete("/auth/access-tokens/:id", access("viewer"), async (c) => {
        if (c.get("authentication") !== "session") throw new HTTPException(403, { message: "Sign in to the web app to revoke access tokens." });
        const id = c.req.param("id");
        if (!await accountsRepository.revokeAccessToken(requireRole(c, "viewer").id, id)) throw new HTTPException(404, { message: "Access token not found." });
        await recordAudit("auth.access_token.revoked", { id });
        return c.json({ ok: true });
    });

    router.post("/setup/admin", access("public"), zValidator("json", adminSchema), async (c) => {
        limit("bootstrap", 5);
        if (await accountsRepository.hasUsers()) throw new HTTPException(409, { message: "An administrator already exists. Sign in to continue." });
        const input = c.req.valid("json");
        const user = await accountsRepository.bootstrap({ ...input, passwordHash: await passwordHash(input.password) });
        if (!user) throw new HTTPException(409, { message: "An administrator already exists. Sign in to continue." });
        await startSession(c, user);
        await recordAudit("auth.admin.created", {}, undefined, actor(user));
        return c.json({ user: publicUser(user) }, 201);
    });

    router.post("/auth/login", access("public"), zValidator("json", loginSchema), async (c) => {
        const { email, password } = c.req.valid("json");
        // Only failed passwords count, so repeated valid sign-ins (CI, scripted checks) are never locked out.
        const failures = attempt(`login:${tokenHash(email)}`);
        if (failures.count >= 10) throw tooMany();
        if (!(await accountsRepository.getSso()).passwordLoginEnabled) throw new HTTPException(403, { message: "Password sign-in is disabled. Use single sign-on." });
        const user = await accountsRepository.userByEmail(email);
        let valid = false;
        try { valid = await verifyPassword(password, user?.passwordHash ?? null); }
        catch { throw new HTTPException(429, { message: "Another sign-in is being processed. Wait a moment and try again." }); }
        if (!valid || !user || user.disabledAt) {
            failures.count++;
            await recordAudit("auth.login.failed", {});
            throw new HTTPException(401, { message: "Email or password is incorrect." });
        }
        const current = await withAccountsLock(async () => {
            const latest = await accountsRepository.getUser(user.id);
            if (!latest || latest.disabledAt || !(await accountsRepository.getSso()).passwordLoginEnabled) throw new HTTPException(401, { message: "Sign-in is no longer available for this account." });
            await startSession(c, latest);
            return latest;
        });
        await recordAudit("auth.login", {}, undefined, actor(current));
        return c.json({ user: publicUser(current) });
    });
    router.post("/auth/logout", access("viewer"), browserSession, async (c) => {
        const token = cookieToken(c.req.raw.headers);
        if (token) { await withAccountsLock(() => accountsRepository.revokeSession(tokenHash(token))); authEvents.emit("session", tokenHash(token)); }
        clearCookies(c);
        await recordAudit("auth.logout");
        return c.json({ ok: true });
    });

    router.get("/settings/members", access("admin"), async (c) => c.json({ members: (await accountsRepository.listUsers()).map(publicUser),
        invitations: (await accountsRepository.invitations()).map(publicInvitation) }));
    router.post("/settings/invitations", access("admin"), zValidator("json", invitationSchema), async (c) => {
        if (!(await accountsRepository.getSso()).passwordLoginEnabled) throw new HTTPException(409, { message: "Password invitations are disabled. New members can use single sign-on; you can then change their role in Members." });
        const input = c.req.valid("json");
        const user = requireRole(c, "admin");
        const token = randomToken();
        const invitation = await withAccountsLock(async () => {
            if (await accountsRepository.userByEmail(input.email)) throw new HTTPException(409, { message: "This email already has an account. Change its role in Members." });
            return accountsRepository.createInvitation({ ...input, tokenHash: tokenHash(token), createdBy: user.id, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() });
        });
        return c.json({ invitation: publicInvitation(invitation), inviteUrl: `${requestOrigin(c)}/join#token=${token}` }, 201);
    });
    router.delete("/settings/invitations/:id", access("admin"), async (c) => {
        await accountsRepository.revokeInvitation(c.req.param("id"));
        return c.json({ ok: true });
    });
    router.patch("/settings/members/:id", access("admin"), zValidator("json", memberSchema), async (c) => {
        const updated = await withAccountsLock(async () => {
            const user = await accountsRepository.getUser(c.req.param("id"));
            if (!user) throw new HTTPException(404, { message: "Account not found." });
            const next = await accountsRepository.changeMember(user.id, c.req.valid("json"));
            if (!next) throw new HTTPException(409, { message: "Keep at least one active administrator who can sign in." });
            await revokeUserSessions(user.id);
            return next;
        });
        return c.json({ user: publicUser(updated) });
    });

    router.post("/auth/invitations/inspect", access("public"), zValidator("json", tokenSchema), async (c) => {
        limit("invite-inspect", 60);
        const invitation = await accountsRepository.invitation(tokenHash(c.req.valid("json").token));
        if (!invitation) throw new HTTPException(410, { message: "This invitation expired or has already been used. Ask an administrator for a new link." });
        return c.json(publicInvitation(invitation));
    });
    router.post("/auth/invitations/accept", access("public"), zValidator("json", acceptInvitationSchema), async (c) => {
        limit("invite-accept", 30);
        if (!(await accountsRepository.getSso()).passwordLoginEnabled) throw new HTTPException(403, { message: "Password sign-up is disabled. Use single sign-on or ask an administrator for help." });
        const input = c.req.valid("json");
        const hash = await passwordHash(input.password);
        const user = await withAccountsLock(async () => {
            if (!(await accountsRepository.getSso()).passwordLoginEnabled) throw new HTTPException(403, { message: "Password sign-up is disabled. Use single sign-on or ask an administrator for help." });
            const invitation = await accountsRepository.invitation(tokenHash(input.token));
            if (!invitation) throw new HTTPException(410, { message: "This invitation expired or has already been used." });
            if (await accountsRepository.userByEmail(invitation.email)) throw new HTTPException(409, { message: "This email already has an account. Sign in instead." });
            const created = await accountsRepository.acceptInvitation(invitation, { name: input.name, passwordHash: hash });
            if (!created) throw new HTTPException(410, { message: "This invitation has already been used." });
            return created;
        });
        await startSession(c, user);
        await recordAudit("auth.invitation.accepted", {}, undefined, actor(user));
        return c.json({ user: publicUser(user) }, 201);
    });

    router.get("/settings/sso", access("admin"), async (c) => {
        const sso = await accountsRepository.getSso();
        const user = requireRole(c, "admin");
        return c.json({ sso: publicSso(sso), linked: (sso.verifiedUsers ?? []).includes(user.id) && await accountsRepository.linked(user.id, sso.issuer) });
    });
    router.put("/settings/sso", access("admin"), zValidator("json", ssoSchema), async (c) => withAccountsLock(async () => {
        const input = c.req.valid("json");
        if (input.enabled) {
            validateIssuer(input.issuer);
            if (!input.clientId) throw new HTTPException(400, { message: "Enter the client ID from your identity provider." });
        }
        const user = requireRole(c, "admin");
        const previous = await accountsRepository.getSso();
        const changed = previous.enabled !== input.enabled || previous.issuer !== input.issuer || previous.clientId !== input.clientId || Boolean(input.clientSecret);
        const verifiedUsers = changed ? [] : previous.verifiedUsers ?? [];
        const linked = verifiedUsers.includes(user.id) && await accountsRepository.linked(user.id, input.issuer)
            && (!input.allowedEmailDomains.length || input.allowedEmailDomains.includes(user.email.split("@")[1]));
        if (!input.passwordLoginEnabled && (!input.enabled || !linked)) {
            throw new HTTPException(409, { message: "Connect your own account through single sign-on before disabling password sign-in." });
        }
        if (!input.enabled && !(await accountsRepository.listUsers()).some((member) => member.role === "admin" && !member.disabledAt && member.passwordHash)) {
            throw new HTTPException(409, { message: "Keep an active administrator who can sign in with a password before disabling single sign-on." });
        }
        const sso = { ...input, verifiedUsers, clientSecret: input.clientSecret ? encryptSecret(input.clientSecret) : previous.clientSecret };
        if (!await accountsRepository.hasUsableAdministrator(sso)) {
            throw new HTTPException(409, { message: "Keep an administrator with a working sign-in method before changing single sign-on." });
        }
        await accountsRepository.saveSso(sso);
        return c.json({ sso: publicSso(sso), linked });
    }));
    router.post("/auth/oidc/start", access("public"), zValidator("json", z.object({ link: z.boolean().optional() }).strict()), async (c) => {
        limit("oidc-start", 30);
        const link = c.req.valid("json").link === true;
        if (link) requireBrowserSession(c);
        return c.json({ url: await beginOidc(c, link) });
    });
    router.get("/auth/oidc/callback", access("public"), async (c) => {
        try { return c.redirect(await finishOidc(c)); }
        catch (error) {
            const errorId = crypto.randomUUID();
            logger.warn("single sign-on failed", { errorId, reason: error instanceof Error ? error.message : "unknown" });
            await recordAudit("auth.sso.failed", { errorId });
            return c.redirect(`${requestOrigin(c)}/login?error=sso_failed`);
        }
    });
    router.get("/settings/audit", access("admin"), async (c) => {
        const limit = Math.floor(Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50)));
        let before: { createdAt: string; id: string } | null = null;
        if (c.req.query("before")) {
            try { before = z.object({ createdAt: z.iso.datetime(), id: z.string().uuid() }).strict().parse(JSON.parse(Buffer.from(c.req.query("before")!, "base64url").toString("utf8"))); }
            catch { throw new HTTPException(400, { message: "Invalid audit page." }); }
        }
        const events = await accountsRepository.auditPage(before, limit);
        const last = events.at(-1);
        return c.json({ events, nextBefore: events.length === limit && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null });
    });
    return router;
}
