import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import type { defineTool } from "@earendil-works/pi-coding-agent";
import { accountsRepository } from "../../infra/repositories/accounts";
import { createProjectScrubber } from "../credentials/scrub";

export interface Actor {
    id: string | null;
    name: string;
    email?: string;
    kind: "user" | "agent" | "ci" | "git" | "system";
}

const actors = new AsyncLocalStorage<Actor>();
export const currentActor = () => actors.getStore();
export const withActor = <T>(actor: Actor, work: () => T): T => actors.run(actor, work);

export async function recordAudit(action: string, details: Record<string, unknown> = {}, projectId?: string, actor = currentActor()): Promise<void> {
    const source = actor ?? { id: null, name: "Specbook", kind: "system" as const };
    const text = JSON.stringify(details);
    const safe = projectId ? await createProjectScrubber(projectId)(text) : text;
    await accountsRepository.audit({ id: crypto.randomUUID(), actorId: source.id, actorName: source.name, actorKind: source.kind,
        action: action.slice(0, 200), projectId: projectId ?? null, details: safe.length <= 16_000 ? JSON.parse(safe) as Record<string, unknown> : { summary: "Details omitted because they exceed the audit size limit." }, createdAt: new Date().toISOString() });
}

export function auditTools(projectId: string, chatId: string, tools: ReturnType<typeof defineTool>[]): ReturnType<typeof defineTool>[] {
    return tools.map((tool) => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) {
        const started = Date.now();
        await recordAudit("chat.tool.started", { chatId, tool: tool.name }, projectId);
        try {
            const result = await tool.execute(...args);
            await recordAudit("chat.tool.finished", { chatId, tool: tool.name, durationMs: Date.now() - started }, projectId);
            return result;
        } catch (error) {
            await recordAudit("chat.tool.failed", { chatId, tool: tool.name, durationMs: Date.now() - started }, projectId);
            throw error;
        }
    } }));
}
