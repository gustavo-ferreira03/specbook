import fs from "node:fs/promises";
import { jobsRepository } from "../infra/repositories/jobs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { blockChatBrowser, cancelChatBrowserDeletion, removeChatBrowserData } from "./browser/sessions";
import { beginChatDeletion, cancelChatDeletion, isChatBusy, isChatDeleting, removeChatSession } from "./chat/session";
import { runsDir } from "./paths";
import { repoBare } from "./repo/bare";
import { repoGit } from "./repo/git";
import { deleteFeatureDirectory, deleteSpecFiles } from "./repo/writer";
import { getRunBatch, getRunBatchDirectory } from "./runner/batch";
import { areSpecsLocked, ResourceBusyError, withSpecLock, withSpecLocks } from "./specs/lifecycle";
import { db, runBatch } from "../infra/db/client";
import { chatSessions, chats, credentialProfiles, features, projects, runs, specs } from "../infra/db/schema";
import { chatsRepository } from "../infra/repositories/chats";
import { projectContextsRepository } from "../infra/repositories/project-contexts";
import { featuresRepository } from "../infra/repositories/features";
import { projectsRepository } from "../infra/repositories/projects";
import { runsRepository } from "../infra/repositories/runs";
import { specsRepository } from "../infra/repositories/specs";

export { ResourceBusyError };

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
    await repoGit.withRepoLock(projectId, () => repoGit.deleteRunCommitRefsUnlocked(projectId, runIds));
    await removeRunDirectories(runIds);
}

async function removeRunDirectories(runIds: string[]): Promise<void> {
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

    if ((await jobsRepository.list(id)).some((job) => job.status === "running")) {
        throw new ResourceBusyError("Cancel the active jobs before deleting this project");
    }
    await jobsRepository.cancelProject(id);
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

    const runIds = await repoGit.withRepoLock(id, async () => {
        const projectSpecIds = (await specsRepository.listSpecs(id)).map((spec) => spec.id);
        if (await runsRepository.hasRunningRuns(projectSpecIds)) {
            throw new ResourceBusyError("Wait for a running Spec verification to finish before deleting this project");
        }
        const runRows = projectSpecIds.length
            ? await db.select({ id: runs.id }).from(runs).where(inArray(runs.specId, projectSpecIds))
            : [];
        const projectSpecs = db.select({ id: specs.id }).from(specs).where(eq(specs.projectId, id));
        await runBatch([
            db.delete(chatSessions).where(eq(chatSessions.projectId, id)),
            db.delete(credentialProfiles).where(eq(credentialProfiles.projectId, id)),
            projectContextsRepository.deleteAllForProjectQuery(id),
            db.delete(runs).where(inArray(runs.specId, projectSpecs)),
            db.delete(specs).where(eq(specs.projectId, id)),
            db.delete(features).where(eq(features.projectId, id)),
            db.delete(chats).where(eq(chats.projectId, id)),
            db.delete(projects).where(eq(projects.id, id)),
        ]);
        const removal = await Promise.allSettled([
            fs.rm(repoGit.getRepoDir(id), { recursive: true, force: true }),
            repoBare.removeBareRepo(id),
        ]);
        for (const result of removal) {
            if (result.status === "rejected") console.error(`[specbook] removing repositories of ${id} failed:`, result.reason);
        }
        return runRows.map((run) => run.id);
    });

    await fs.rm(path.join(runsDir, "proposals", id), { recursive: true, force: true });
    await removeRunDirectories(runIds).catch((error: unknown) => {
        console.error(`[specbook] removing run artifacts of project ${id} failed:`, error);
    });
    return true;
}
