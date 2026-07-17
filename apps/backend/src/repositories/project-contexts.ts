import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import {
    EMPTY_PROJECT_CONTEXT,
    projectContextRevisions,
    type DiscoveryBrief,
    type ProjectContext,
} from "../db/schema";

export type ProjectContextRevisionRow = typeof projectContextRevisions.$inferSelect;

const draftLocks = new Map<string, Promise<unknown>>();

export async function withProjectContextDraftLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = draftLocks.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    draftLocks.set(projectId, current);
    try {
        return await current;
    } finally {
        if (draftLocks.get(projectId) === current) draftLocks.delete(projectId);
    }
}

export async function createProjectContextDraft(
    projectId: string,
    brief: DiscoveryBrief,
): Promise<ProjectContextRevisionRow> {
    const now = new Date().toISOString();
    const row: ProjectContextRevisionRow = {
        id: crypto.randomUUID(),
        projectId,
        sourceConversationId: null,
        status: "draft",
        brief,
        context: EMPTY_PROJECT_CONTEXT,
        actionsUsed: 0,
        createdAt: now,
        updatedAt: now,
        confirmedAt: null,
    };
    await db.insert(projectContextRevisions).values(row);
    return row;
}

export async function attachContextConversation(revisionId: string, conversationId: string): Promise<void> {
    await db
        .update(projectContextRevisions)
        .set({ sourceConversationId: conversationId, updatedAt: new Date().toISOString() })
        .where(eq(projectContextRevisions.id, revisionId));
}

export async function getProjectContextRevision(
    revisionId: string,
): Promise<ProjectContextRevisionRow | null> {
    const rows = await db
        .select()
        .from(projectContextRevisions)
        .where(eq(projectContextRevisions.id, revisionId));
    return rows[0] ?? null;
}

export async function getProjectContextForConversation(
    conversationId: string,
): Promise<ProjectContextRevisionRow | null> {
    const rows = await db
        .select()
        .from(projectContextRevisions)
        .where(eq(projectContextRevisions.sourceConversationId, conversationId))
        .orderBy(desc(projectContextRevisions.createdAt), desc(projectContextRevisions.id));
    return rows[0] ?? null;
}

export async function getLatestConfirmedProjectContext(
    projectId: string,
): Promise<ProjectContextRevisionRow | null> {
    const rows = await db
        .select()
        .from(projectContextRevisions)
        .where(
            and(
                eq(projectContextRevisions.projectId, projectId),
                eq(projectContextRevisions.status, "confirmed"),
            ),
        )
        .orderBy(desc(projectContextRevisions.confirmedAt), desc(projectContextRevisions.id));
    return rows[0] ?? null;
}

export async function getActiveProjectContextDraft(
    projectId: string,
): Promise<ProjectContextRevisionRow | null> {
    const rows = await db
        .select()
        .from(projectContextRevisions)
        .where(
            and(
                eq(projectContextRevisions.projectId, projectId),
                eq(projectContextRevisions.status, "draft"),
            ),
        )
        .orderBy(desc(projectContextRevisions.createdAt), desc(projectContextRevisions.id));
    return rows[0] ?? null;
}

export async function replaceProjectContextDraft(
    revisionId: string,
    context: ProjectContext,
): Promise<ProjectContextRevisionRow | null> {
    await db
        .update(projectContextRevisions)
        .set({ context, updatedAt: new Date().toISOString() })
        .where(
            and(eq(projectContextRevisions.id, revisionId), eq(projectContextRevisions.status, "draft")),
        );
    return getProjectContextRevision(revisionId);
}

export async function updateProjectContextDraftBrief(
    revisionId: string,
    brief: DiscoveryBrief,
): Promise<ProjectContextRevisionRow | null> {
    await db
        .update(projectContextRevisions)
        .set({ brief, updatedAt: new Date().toISOString() })
        .where(
            and(eq(projectContextRevisions.id, revisionId), eq(projectContextRevisions.status, "draft")),
        );
    return getProjectContextRevision(revisionId);
}

export async function confirmProjectContextRevision(
    revisionId: string,
): Promise<ProjectContextRevisionRow | null> {
    const now = new Date().toISOString();
    await db
        .update(projectContextRevisions)
        .set({ status: "confirmed", confirmedAt: now, updatedAt: now })
        .where(
            and(eq(projectContextRevisions.id, revisionId), eq(projectContextRevisions.status, "draft")),
        );
    return getProjectContextRevision(revisionId);
}

export async function discardProjectContextRevision(
    revisionId: string,
): Promise<ProjectContextRevisionRow | null> {
    await db
        .update(projectContextRevisions)
        .set({ status: "discarded", updatedAt: new Date().toISOString() })
        .where(
            and(eq(projectContextRevisions.id, revisionId), eq(projectContextRevisions.status, "draft")),
        );
    return getProjectContextRevision(revisionId);
}

export async function discardDraftForConversation(conversationId: string): Promise<void> {
    await db
        .update(projectContextRevisions)
        .set({ status: "discarded", updatedAt: new Date().toISOString() })
        .where(
            and(
                eq(projectContextRevisions.sourceConversationId, conversationId),
                eq(projectContextRevisions.status, "draft"),
            ),
        );
}

export async function consumeDiscoveryAction(
    revisionId: string,
): Promise<{ used: number; max: number; allowed: boolean } | null> {
    return db.transaction(async (tx) => {
        const rows = await tx
            .select()
            .from(projectContextRevisions)
            .where(eq(projectContextRevisions.id, revisionId));
        const revision = rows[0];
        if (!revision) return null;
        const max = revision.brief.maxActions;
        if (revision.status !== "draft") {
            return { used: revision.actionsUsed, max, allowed: false };
        }
        if (revision.actionsUsed >= max) {
            return { used: revision.actionsUsed, max, allowed: false };
        }
        const used = revision.actionsUsed + 1;
        await tx
            .update(projectContextRevisions)
            .set({ actionsUsed: used, updatedAt: new Date().toISOString() })
            .where(eq(projectContextRevisions.id, revisionId));
        return { used, max, allowed: true };
    });
}

export async function deleteProjectContextDraft(revisionId: string): Promise<void> {
    await db
        .delete(projectContextRevisions)
        .where(
            and(eq(projectContextRevisions.id, revisionId), eq(projectContextRevisions.status, "draft")),
        );
}
