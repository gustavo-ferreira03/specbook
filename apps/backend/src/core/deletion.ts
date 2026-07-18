import fs from "node:fs/promises";
import path from "node:path";
import { blockChatBrowser, cancelChatBrowserDeletion, removeChatBrowserData } from "./browser/sessions";
import { beginChatDeletion, cancelChatDeletion, removeChatSession } from "./chat/session";
import { runsDir, specsDir } from "./paths";
import { getRunBatchDirectory } from "./runner/batch";
import { areSpecsLocked, withSpecLock, withSpecLocks } from "./specs/lifecycle";
import { chatsRepository } from "../infra/repositories/chats";
import { projectContextsRepository } from "../infra/repositories/project-contexts";
import { featuresRepository } from "../infra/repositories/features";
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

async function removeSpecResources(specIds: string[], runIds: string[]): Promise<void> {
    const batchIds = new Set<string>();
    for (const runId of runIds) {
        try {
            const link = JSON.parse(await fs.readFile(path.join(entityDirectory(runsDir, runId), "batch.json"), "utf8")) as { batchId?: unknown };
            if (typeof link.batchId === "string") batchIds.add(link.batchId);
        } catch {}
    }
    await Promise.all([
        removeEntityDirectories(specsDir, specIds),
        removeEntityDirectories(runsDir, runIds),
    ]);
    for (const batchId of batchIds) {
        await fs.rm(getRunBatchDirectory(batchId), { recursive: true, force: true });
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
        const result = await specsRepository.deleteSpecWithRelations(id);
        if (result.status === "not_found") return false;
        if (result.status === "busy") {
            throw new ResourceBusyError("Wait for the current Spec run to finish before deleting it");
        }
        await removeSpecResources([id], result.runIds);
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
        const result = await featuresRepository.deleteFeatureWithRelations(id);
        if (result.status === "not_found") return false;
        if (result.status === "busy") {
            throw new ResourceBusyError("Wait for active Spec runs in this Feature to finish before deleting it");
        }
        await removeSpecResources(result.specIds, result.runIds);
        return true;
    });
}
