import fs from "node:fs/promises";
import path from "node:path";
import { blockChatBrowser, cancelChatBrowserDeletion, removeChatBrowserData } from "./browser/sessions";
import { beginChatDeletion, cancelChatDeletion, isChatBusy, isChatDeleting, removeChatSession } from "./chat/session";
import { deleteProfile } from "./credentials/profiles";
import { runsDir } from "./paths";
import { deleteRunCommitRefsUnlocked, repoDir, withRepoLock } from "./repo/git";
import { deleteFeatureDirectory, deleteSpecFiles } from "./repo/writer";
import { getRunBatch, getRunBatchDirectory } from "./runner/batch";
import { areSpecsLocked, withSpecLock, withSpecLocks } from "./specs/lifecycle";
import { chatsRepository } from "../infra/repositories/chats";
import { credentialsRepository } from "../infra/repositories/credentials";
import { projectContextsRepository } from "../infra/repositories/project-contexts";
import { featuresRepository } from "../infra/repositories/features";
import { projectsRepository } from "../infra/repositories/projects";
import { runsRepository } from "../infra/repositories/runs";
import { specsRepository } from "../infra/repositories/specs";

export class ResourceBusyError extends Error {}

function entityDirectory(root: string, id: string): string {
    const absoluteRoot = path.resolve(root);
    const directory = path.resolve(absoluteRoot, id);
    if (path.dirname(directory) !== absoluteRoot) throw new Error("Invalid storage directory");
    return directory;
}

async function removeEntityDirectories(root: string, ids: string[]): Promise<void> {
    const results = await Promise.allSettled(
        ids.map((id) => fs.rm(entityDirectory(root, id), { recursive: true, force: true })),
    );
    for (const result of results) {
        if (result.status === "rejected") console.error(result.reason);
    }
}

async function removeRunResources(projectId: string, runIds: string[]): Promise<void> {
    await withRepoLock(projectId, () => deleteRunCommitRefsUnlocked(projectId, runIds));
    const batchIds = new Set<string>();
    for (const runId of runIds) {
        try {
            const link = JSON.parse(await fs.readFile(path.join(entityDirectory(runsDir, runId), "batch.json"), "utf8")) as { batchId?: unknown };
            if (typeof link.batchId === "string") batchIds.add(link.batchId);
        } catch {}
    }
    await removeEntityDirectories(runsDir, runIds);
    for (const batchId of batchIds) {
        const batch = await getRunBatch(batchId);
        if (batch?.specs.every((item) => runIds.includes(item.runId))) {
            await fs.rm(getRunBatchDirectory(batchId), { recursive: true, force: true });
        }
    }
}

export async function deleteChatData(id: string): Promise<boolean> {
    if (!(await chatsRepository.getChatRow(id))) return false;
    if (!beginChatDeletion(id)) throw new ResourceBusyError("Wait for the agent to finish before deleting this chat");
    try {
        await blockChatBrowser(id);
        await projectContextsRepository.discardDraftForChat(id);
        await chatsRepository.deleteChatRow(id);
    } catch (error) {
        cancelChatBrowserDeletion(id);
        cancelChatDeletion(id);
        throw error;
    }
    const cleanup = await Promise.allSettled([
        removeChatSession(id),
        removeChatBrowserData(id),
    ]);
    for (const result of cleanup) {
        if (result.status === "rejected") console.error(result.reason);
    }
    cancelChatBrowserDeletion(id);
    cancelChatDeletion(id);
    return true;
}

export async function deleteSpecData(id: string): Promise<boolean> {
    if (areSpecsLocked([id])) throw new ResourceBusyError("Wait for the current Spec operation to finish before deleting it");
    return withSpecLock(id, async () => {
        const spec = await specsRepository.getSpec(id);
        if (!spec) return false;
        if (await runsRepository.hasRunningRuns([id])) {
            throw new ResourceBusyError("Wait for the current Spec run to finish before deleting it");
        }
        await deleteSpecFiles(spec);
        const result = await specsRepository.deleteSpecWithRelations(id);
        if (result.status === "not_found") return false;
        if (result.status === "busy") {
            throw new ResourceBusyError("Wait for the current Spec run to finish before deleting it");
        }
        await removeRunResources(spec.projectId, result.runIds);
        return true;
    });
}

export async function deleteFeatureData(id: string): Promise<boolean> {
    const specIds = await featuresRepository.getFeatureDeletionSpecIds(id);
    if (!specIds) return false;
    if (areSpecsLocked(specIds)) {
        throw new ResourceBusyError("Wait for active Spec operations in this Feature to finish before deleting it");
    }
    return withSpecLocks(specIds, async () => {
        const feature = await featuresRepository.getFeature(id);
        if (!feature) return false;
        if (await runsRepository.hasRunningRuns(specIds)) {
            throw new ResourceBusyError("Wait for active Spec runs in this Feature to finish before deleting it");
        }
        await deleteFeatureDirectory(feature.projectId, feature.path, feature.title);
        const result = await featuresRepository.deleteFeatureWithRelations(id);
        if (result.status === "not_found") return false;
        if (result.status === "busy") {
            throw new ResourceBusyError("Wait for active Spec runs in this Feature to finish before deleting it");
        }
        await removeRunResources(feature.projectId, result.runIds);
        return true;
    });
}

export async function deleteProjectData(id: string): Promise<boolean> {
    const project = await projectsRepository.getProject(id);
    if (!project) return false;

    const chatRows = await chatsRepository.listChatRows(id);
    if (chatRows.some((chat) => isChatBusy(chat.id) || isChatDeleting(chat.id))) {
        throw new ResourceBusyError("Wait for the active chat to finish before deleting this project");
    }
    const specIds = (await specsRepository.listSpecs(id)).map((spec) => spec.id);
    if (areSpecsLocked(specIds)) {
        throw new ResourceBusyError("Wait for active Spec operations to finish before deleting this project");
    }
    if (await runsRepository.hasRunningRuns(specIds)) {
        throw new ResourceBusyError("Wait for a running Spec verification to finish before deleting this project");
    }

    for (const chat of chatRows) {
        await deleteChatData(chat.id);
    }

    const features = await featuresRepository.listFeatures(id);
    const knownFeatureIds = new Set(features.map((feature) => feature.id));
    const rootFeatures = features.filter(
        (feature) => feature.parentId === null || !knownFeatureIds.has(feature.parentId),
    );
    for (const feature of rootFeatures) {
        await deleteFeatureData(feature.id);
    }

    for (const spec of await specsRepository.listSpecs(id)) {
        await deleteSpecData(spec.id);
    }

    for (const profile of await credentialsRepository.listProfiles(id)) {
        await deleteProfile(profile);
    }

    await projectContextsRepository.deleteAllForProject(id);

    await withRepoLock(id, async () => {
        await fs.rm(repoDir(id), { recursive: true, force: true });
    });

    await projectsRepository.deleteProject(id);
    return true;
}
