import type { DiscoveryBrief, ProjectContext } from "../../infra/db/schema";
import { logger } from "../../infra/logger";
import { projectContextsRepository, type ProjectContextRevisionRow } from "../../infra/repositories/project-contexts";
import { projectsRepository } from "../../infra/repositories/projects";
import { isAgentPaused } from "../jobs/pause";
import { configuredModel } from "../llm/runtime";
import { createAreaFeatures, writeContextToRepo } from "../repo/writer";
import { isChatBusy } from "./chat-registry";
import { createChat } from "./session-store";
import { startChatTurn } from "./turn-runner";

export const DEFAULT_DISCOVERY_GOAL =
    "Autonomously explore the application and map its areas, terminology, roles, business rules, and UI patterns. Log in when the application requires it (request credentials if none exist), and record as unknowns only what stays unclear or unreachable after that.";

const BEGIN_DISCOVERY =
    "Begin the discovery. Follow the saved brief: explore from the start URL within the allowed origin, respect the safety notes, then propose the project context.";

async function startDiscoveryLocked(
    projectId: string,
    brief: DiscoveryBrief,
): Promise<{ revision: ProjectContextRevisionRow; chat: { id: string } }> {
    const revision = await projectContextsRepository.createProjectContextDraft(projectId, brief);
    let chat: { id: string };
    try {
        chat = await createChat(projectId, { contextRevisionId: revision.id }, "Project discovery");
    } catch (error) {
        await projectContextsRepository.deleteProjectContextDraft(revision.id).catch(console.error);
        throw error;
    }
    await projectContextsRepository.attachContextChat(revision.id, chat.id);
    startChatTurn(chat.id, BEGIN_DISCOVERY);
    return { revision: (await projectContextsRepository.getProjectContextRevision(revision.id)) ?? revision, chat };
}

export function startContextDiscovery(
    projectId: string,
    brief: DiscoveryBrief,
): Promise<{ revision: ProjectContextRevisionRow; chat: { id: string } } | { activeDraft: ProjectContextRevisionRow }> {
    return projectContextsRepository.withProjectContextDraftLock(projectId, async () => {
        const activeDraft = await projectContextsRepository.getActiveProjectContextDraft(projectId);
        return activeDraft ? { activeDraft } : startDiscoveryLocked(projectId, brief);
    });
}

export async function discoverProjectContext(projectId: string): Promise<string | null> {
    try {
        if (!(await configuredModel()).ready || (await isAgentPaused(projectId))) return null;
        return await projectContextsRepository.withProjectContextDraftLock(projectId, async () => {
            const project = await projectsRepository.getProject(projectId);
            if (!project || (await projectContextsRepository.hasRevisions(projectId))) return null;
            const brief = { goal: DEFAULT_DISCOVERY_GOAL, startUrl: project.baseUrl, safetyNotes: [] };
            return (await startDiscoveryLocked(project.id, brief)).chat.id;
        });
    } catch (error) {
        logger.error("automatic discovery failed", { projectId, error });
        return null;
    }
}

let pendingDiscovery: Promise<void> | null = null;

export function discoverPendingProjectContexts(): void {
    if (pendingDiscovery) return;
    pendingDiscovery = (async () => {
        if (!(await configuredModel()).ready) return;
        for (const project of await projectsRepository.listProjects()) {
            const chatId = await discoverProjectContext(project.id);
            if (chatId) await chatIdle(chatId);
        }
    })().catch((error) => logger.error("automatic discovery failed", { error })).finally(() => { pendingDiscovery = null; });
}

async function chatIdle(chatId: string, timeoutMs = 30 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (isChatBusy(chatId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5000));
}

export function contextProposalProblem(context: ProjectContext): string | null {
    if (!context.summary.trim()) return "Confirmation requires a non-empty summary";
    if (context.areas.length === 0 && context.unknowns.length === 0) {
        return "Confirmation requires at least one area or unknown";
    }
    return null;
}

export async function confirmDiscoveredContext(revisionId: string): Promise<void> {
    const initial = await projectContextsRepository.getProjectContextRevision(revisionId);
    if (!initial) return;
    await projectContextsRepository.withProjectContextDraftLock(initial.projectId, async () => {
        const revision = await projectContextsRepository.getProjectContextRevision(revisionId);
        if (revision?.status !== "draft" || contextProposalProblem(revision.context)) return;
        await writeContextToRepo(revision.projectId, revision.context, { confirmRevisionId: revision.id });
        await createAreaFeatures(revision.projectId, revision.context);
    });
}
