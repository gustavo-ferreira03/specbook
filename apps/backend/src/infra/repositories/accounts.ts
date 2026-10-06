import crypto from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { DEFAULT_SSO_SETTINGS, type SsoSettings, type UserRole } from "../../core/accounts/schemas";
import { db } from "../db/client";
import { appSettings, auditEvents, oidcIdentities, oidcStates, userInvites, users, userSessions } from "../db/schema";

export type User = typeof users.$inferSelect;
export type Invitation = typeof userInvites.$inferSelect;
const now = () => new Date().toISOString();
let accountOperation = Promise.resolve<unknown>(undefined);

function usableLogin(sso: SsoSettings) {
    return sql`((${sso.passwordLoginEnabled} and password_hash is not null)
        or (${sso.enabled} and id in (select value from json_each(${JSON.stringify(sso.verifiedUsers ?? [])}))
        and (${sso.allowedEmailDomains.length === 0} or lower(substr(email, instr(email, '@') + 1)) in (select value from json_each(${JSON.stringify(sso.allowedEmailDomains)})))
        and id in (select user_id from oidc_identities where issuer = ${sso.issuer})))`;
}

export function withAccountsLock<T>(work: () => Promise<T>): Promise<T> {
    const current = accountOperation.catch(() => undefined).then(work);
    accountOperation = current;
    return current;
}

export const accountsRepository = {
    async hasUsers() { return Boolean((await db.select({ id: users.id }).from(users).limit(1))[0]); },
    async getUser(id: string) { return (await db.select().from(users).where(eq(users.id, id)))[0] ?? null; },
    async userByEmail(email: string) { return (await db.select().from(users).where(eq(users.email, email)))[0] ?? null; },
    async listUsers() { return db.select().from(users).orderBy(asc(users.createdAt), asc(users.id)); },
    async bootstrap(input: { email: string; name: string; passwordHash: string }): Promise<User | null> {
        const id = crypto.randomUUID();
        const timestamp = now();
        await db.run(sql`insert into users (id, email, name, password_hash, role, created_at, updated_at)
            select ${id}, ${input.email}, ${input.name}, ${input.passwordHash}, 'admin', ${timestamp}, ${timestamp}
            where not exists (select 1 from users)`);
        return this.getUser(id);
    },
    async createSession(tokenHash: string, userId: string, expiresAt: string) {
        await db.insert(userSessions).values({ tokenHash, userId, expiresAt, createdAt: now() });
    },
    async session(tokenHash: string) {
        const row = (await db.select({ user: users, session: userSessions }).from(userSessions)
            .innerJoin(users, eq(users.id, userSessions.userId))
            .where(and(eq(userSessions.tokenHash, tokenHash), gt(userSessions.expiresAt, now()), isNull(users.disabledAt))))[0];
        return row ?? null;
    },
    async deleteSession(tokenHash: string) { await db.delete(userSessions).where(eq(userSessions.tokenHash, tokenHash)); },
    async revokeUserSessions(userId: string) { await db.delete(userSessions).where(eq(userSessions.userId, userId)); },
    async changeMember(id: string, patch: { role?: UserRole; disabled?: boolean }): Promise<User | null> {
        const removesAdmin = patch.role && patch.role !== "admin" || patch.disabled === true;
        const sso = await this.getSso();
        const usable = usableLogin(sso);
        const [updated] = await db.update(users).set({
            ...(patch.role ? { role: patch.role } : {}),
            ...(patch.disabled !== undefined ? { disabledAt: patch.disabled ? now() : null } : {}), updatedAt: now(),
        }).where(and(eq(users.id, id), removesAdmin
            ? sql`(${users.role} != 'admin' or ${users.disabledAt} is not null or not ${usable} or (select count(*) from users where role = 'admin' and disabled_at is null and ${usable}) > 1)`
            : undefined)).returning();
        return updated ?? null;
    },
    async invitations() {
        return db.select().from(userInvites).where(and(isNull(userInvites.consumedAt), gt(userInvites.expiresAt, now()))).orderBy(asc(userInvites.createdAt));
    },
    async createInvitation(input: Omit<typeof userInvites.$inferInsert, "id" | "createdAt">) {
        const [invite] = await db.insert(userInvites).values({ ...input, id: crypto.randomUUID(), createdAt: now() }).returning();
        return invite!;
    },
    async invitation(tokenHash: string) {
        return (await db.select().from(userInvites).where(and(eq(userInvites.tokenHash, tokenHash), isNull(userInvites.consumedAt), gt(userInvites.expiresAt, now()))))[0] ?? null;
    },
    async revokeInvitation(id: string) { await db.update(userInvites).set({ consumedAt: now() }).where(eq(userInvites.id, id)); },
    async acceptInvitation(invite: Invitation, input: { name: string; passwordHash: string }): Promise<User | null> {
        const id = crypto.randomUUID();
        const timestamp = now();
        await db.batch([
            db.insert(users).select(db.select({ id: sql<string>`${id}`.as("id"), email: userInvites.email,
                name: sql<string>`${input.name}`.as("name"), passwordHash: sql<string>`${input.passwordHash}`.as("password_hash"), role: userInvites.role,
                disabledAt: sql<string | null>`null`.as("disabled_at"), createdAt: sql<string>`${timestamp}`.as("created_at"), updatedAt: sql<string>`${timestamp}`.as("updated_at"),
            }).from(userInvites).where(and(eq(userInvites.id, invite.id), isNull(userInvites.consumedAt), gt(userInvites.expiresAt, timestamp)))),
            db.update(userInvites).set({ consumedAt: timestamp }).where(and(eq(userInvites.id, invite.id), sql`changes() = 1`)),
        ]);
        return this.getUser(id);
    },
    async getSso(): Promise<SsoSettings> {
        return (await db.select({ sso: appSettings.sso }).from(appSettings).where(eq(appSettings.id, 1)))[0]?.sso ?? { ...DEFAULT_SSO_SETTINGS };
    },
    async hasUsableAdministrator(sso: SsoSettings): Promise<boolean> {
        return Boolean((await db.select({ id: users.id }).from(users)
            .where(and(eq(users.role, "admin"), isNull(users.disabledAt), usableLogin(sso))).limit(1))[0]);
    },
    async saveSso(sso: SsoSettings) {
        await db.insert(appSettings).values({ id: 1, llm: { provider: "", model: "" }, sso, updatedAt: now() })
            .onConflictDoUpdate({ target: appSettings.id, set: { sso, updatedAt: now() } });
    },
    async identity(issuer: string, subject: string) {
        return (await db.select({ user: users }).from(oidcIdentities).innerJoin(users, eq(users.id, oidcIdentities.userId))
            .where(and(eq(oidcIdentities.issuer, issuer), eq(oidcIdentities.subject, subject))))[0]?.user ?? null;
    },
    async linked(userId: string, issuer: string) {
        return Boolean((await db.select({ id: oidcIdentities.id }).from(oidcIdentities).where(and(eq(oidcIdentities.userId, userId), eq(oidcIdentities.issuer, issuer))).limit(1))[0]);
    },
    async addIdentity(userId: string, issuer: string, subject: string) {
        await db.insert(oidcIdentities).values({ id: crypto.randomUUID(), userId, issuer, subject });
    },
    async createSsoUser(email: string, name: string, role: UserRole, issuer: string, subject: string): Promise<User> {
        const user: User = { id: crypto.randomUUID(), email, name, role, passwordHash: null, disabledAt: null, createdAt: now(), updatedAt: now() };
        await db.batch([db.insert(users).values(user), db.insert(oidcIdentities).values({ id: crypto.randomUUID(), userId: user.id, issuer, subject })]);
        return user;
    },
    async saveOidcState(state: typeof oidcStates.$inferInsert) { await db.insert(oidcStates).values(state); },
    async takeOidcState(stateHash: string, browserHash: string) {
        return (await db.delete(oidcStates).where(and(eq(oidcStates.stateHash, stateHash), eq(oidcStates.browserHash, browserHash), gt(oidcStates.expiresAt, now()))).returning())[0] ?? null;
    },
    async cleanup() {
        await db.batch([db.delete(userSessions).where(lt(userSessions.expiresAt, now())), db.delete(oidcStates).where(lt(oidcStates.expiresAt, now()))]);
    },
    async audit(event: typeof auditEvents.$inferInsert) { await db.insert(auditEvents).values(event); },
    async auditPage(before: { createdAt: string; id: string } | null, limit: number) {
        return db.select().from(auditEvents).where(before ? or(lt(auditEvents.createdAt, before.createdAt), and(eq(auditEvents.createdAt, before.createdAt), lt(auditEvents.id, before.id))) : undefined)
            .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(limit);
    },
};
