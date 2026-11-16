import type { DiscoveryBrief, ProjectContext } from "../../infra/db/schema";
import { logger } from "../../infra/logger";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import type { ProjectContextRevisionRow } from "../../infra/repositories/project-contexts";
import { projectsRepository } from "../../infra/repositories/projects";
import { resolveRunEnvironment } from "../environments";
import { isAgentPaused } from "../jobs/pause";
import { configuredModel } from "../llm/runtime";
import { createAreaFeatures, writeContextToRepo } from "../repo/writer";
import { isChatBusy } from "./chat-registry";
import { createChat } from "./session-store";
// oxlint-disable-next-line import/no-cycle -- These service modules call each other after initialization; keep the existing orchestration boundary.
import { startChatTurn } from "./turn-runner";

const startDiscoveryLocked = async function startDiscoveryLocked(
  projectId: string,
  brief: DiscoveryBrief
): Promise<{ revision: ProjectContextRevisionRow; chat: { id: string } }> {
  const revision = await projectContextsRepository.createProjectContextDraft(
    projectId,
    brief
  );
  let chat: { id: string };
  try {
    chat = await createChat(
      projectId,
      { contextRevisionId: revision.id },
      "Project discovery"
    );
  } catch (error) {
    await projectContextsRepository
      .deleteProjectContextDraft(revision.id)
      .catch(console.error);
    throw error;
  }
  await projectContextsRepository.attachContextChat(revision.id, chat.id);
  startChatTurn(chat.id, BEGIN_DISCOVERY);
  return {
    revision:
      (await projectContextsRepository.getProjectContextRevision(
        revision.id
      )) ?? revision,
    chat,
  };
};

export const startContextDiscovery = async function startContextDiscovery(
  projectId: string,
  brief: DiscoveryBrief
): Promise<
  | { revision: ProjectContextRevisionRow; chat: { id: string } }
  | { activeDraft: ProjectContextRevisionRow }
> {
  if (
    (await (async () => {
      const awaitedValue1869 = await resolveRunEnvironment(projectId);
      return awaitedValue1869.executor;
    })()) === "runner"
  ) {
    throw new Error(
      "Application exploration is unavailable in runner environments. Write the project context manually and run Specs through the runner."
    );
  }
  return projectContextsRepository.withProjectContextDraftLock(
    projectId,
    async () => {
      const activeDraft =
        await projectContextsRepository.getActiveProjectContextDraft(projectId);
      return activeDraft
        ? { activeDraft }
        : startDiscoveryLocked(projectId, brief);
    }
  );
};

export const discoverProjectContext = async function discoverProjectContext(
  projectId: string
): Promise<string | null> {
  try {
    if (
      !(await (async () => {
        const awaitedValue2569 = await configuredModel();
        return awaitedValue2569.ready;
      })()) ||
      (await isAgentPaused(projectId))
    ) {
      return null;
    }
    return await projectContextsRepository.withProjectContextDraftLock(
      projectId,
      async () => {
        const project = await projectsRepository.getProject(projectId);
        if (
          !project ||
          (await projectContextsRepository.hasRevisions(projectId))
        ) {
          return null;
        }
        if (
          (await (async () => {
            const awaitedValue3006 = await resolveRunEnvironment(project.id);
            return awaitedValue3006.executor;
          })()) === "runner"
        ) {
          return null;
        }
        const brief = {
          goal: DEFAULT_DISCOVERY_GOAL,
          startUrl: project.baseUrl,
          safetyNotes: [],
        };
        return await (async () => {
          const awaitedValue3260 = await startDiscoveryLocked(
            project.id,
            brief
          );
          return awaitedValue3260.chat.id;
        })();
      }
    );
  } catch (error) {
    logger.error("automatic discovery failed", { projectId, error });
    return null;
  }
};

export const discoverPendingProjectContexts =
  function discoverPendingProjectContexts(): void {
    if (pendingDiscovery) {
      return;
    }
    pendingDiscovery = (async () => {
      if (
        !(await (async () => {
          const awaitedValue3642 = await configuredModel();
          return awaitedValue3642.ready;
        })())
      ) {
        return;
      }
      for (const project of await projectsRepository.listProjects()) {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        const chatId = await discoverProjectContext(project.id);
        if (chatId) {
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          await chatIdle(chatId);
        }
      }
    })()
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
      .catch((error) => logger.error("automatic discovery failed", { error }))
      .finally(() => {
        pendingDiscovery = null;
      });
  };

const chatIdle = async function chatIdle(
  chatId: string,
  timeoutMs = 30 * 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isChatBusy(chatId) && Date.now() < deadline) {
    // oxlint-disable-next-line promise/avoid-new, no-await-in-loop -- Bridge an event or callback API to the asynchronous operation. Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    await new Promise((resolve) => {
      setTimeout(resolve, 5000);
    });
  }
};

export const contextProposalProblem = function contextProposalProblem(
  context: ProjectContext
): string | null {
  if (!context.summary.trim()) {
    return "Confirmation requires a non-empty summary";
  }
  if (context.areas.length === 0 && context.unknowns.length === 0) {
    return "Confirmation requires at least one area or unknown";
  }
  return null;
};

export const confirmDiscoveredContext = async function confirmDiscoveredContext(
  revisionId: string
): Promise<void> {
  const initial =
    await projectContextsRepository.getProjectContextRevision(revisionId);
  if (!initial) {
    return;
  }
  await projectContextsRepository.withProjectContextDraftLock(
    initial.projectId,
    async () => {
      const revision =
        await projectContextsRepository.getProjectContextRevision(revisionId);
      if (
        revision?.status !== "draft" ||
        contextProposalProblem(revision.context)
      ) {
        return;
      }
      await writeContextToRepo(revision.projectId, revision.context, {
        confirmRevisionId: revision.id,
      });
      await createAreaFeatures(revision.projectId, revision.context);
    }
  );
};

export const DEFAULT_DISCOVERY_GOAL =
  "Autonomously explore the application and map its areas, terminology, roles, business rules, and UI patterns. Log in when the application requires it (request credentials if none exist), and record as unknowns only what stays unclear or unreachable after that.";

const BEGIN_DISCOVERY =
  "Begin the discovery. Follow the saved brief: explore from the start URL within the allowed origin, respect the safety notes, then propose the project context.";

let pendingDiscovery: Promise<void> | null = null;
