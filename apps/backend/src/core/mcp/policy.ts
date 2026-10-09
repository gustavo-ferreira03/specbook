import { payloadOf } from "../jobs/schemas";
import type { defineTool } from "@earendil-works/pi-coding-agent";
import { chatsRepository } from "../../infra/repositories/chats";
import { jobsRepository } from "../../infra/repositories/jobs";
import { projectsRepository, type Project } from "../../infra/repositories/projects";
import { specsRepository } from "../../infra/repositories/specs";
import { createChat } from "../chat/session-store";
import { publishChatUpdate } from "../chat/chat-registry";
import { createProjectScrubber } from "../credentials/scrub";
import { proposeMutation, applyProposal } from "../jobs/proposals";
import { fixProposalSchema, jobLimitsSchema, newSpecProposalSchema } from "../jobs/schemas";

export function mcpChatPrompt(project: Project): string {
    return `\nThe requester in this MCP conversation is another AI agent acting for the user. Work as its QA subagent: inspect the application, create or update the affected Specs, run them and report the outcome concisely. End every turn stating what you did, including the Spec ids. Never ask for credential values in text: use browser_vault_save_login, browser_vault_enter_code or request_credential so access requests become secure actions.\nContract policy: ${project.agentContractPolicy ?? "apply_declared"}. ${project.agentContractPolicy === "propose_only" ? "Updates to existing Specs must be proposed for approval, including replacements attempted through create_spec. The tools enforce this. Explain the pending contract_change action; do not claim the Spec changed until approved." : "Only behaviour changes explicitly declared by the requester authorize changing the affected spec.yml contract. Read the current Spec first. Failures in behaviour they did not declare are possible application bugs: report them and preserve the expected result. Fix locators, waits or implementation errors without weakening the contract."}\nWhen suggesting new coverage with propose_spec_batch, explain the spec_selection action. Plain questions can be answered by the requester in the next message. Do not invent unrelated work.`;
}

async function proposeChatUpdate(projectId: string, chatId: string, input: unknown) {
    let job = (await jobsRepository.list(projectId)).find((job) => job.sourceChatId === chatId && job.kind === "review" && job.goal === "Review contract changes requested by an external agent.");
    if (!job) {
        const internal = await createChat(projectId);
        job = await jobsRepository.create({ projectId, chatId: internal.id, sourceChatId: chatId, kind: "review", trigger: "chat",
            goal: "Review contract changes requested by an external agent.", limits: jobLimitsSchema.parse({}), status: "blocked" });
        await jobsRepository.transition(job.id, "blocked", "completed");
    }
    const item = await proposeMutation(job, "update_spec", input);
    await jobsRepository.updateItem(item.id, { payload: { ...item.payload, mcpContractChange: true } });
    publishChatUpdate(chatId);
    return { content: [{ type: "text" as const, text: JSON.stringify({ inboxId: item.id, status: "needs_approval", next: "The requester must approve the contract_change action before this Spec is updated." }) }], details: undefined };
}

export function mcpChatTools(projectId: string, chatId: string, tools: ReturnType<typeof defineTool>[]): ReturnType<typeof defineTool>[] {
    const updateSpec = tools.find((tool) => tool.name === "update_spec");
    if (!updateSpec) throw new Error("update_spec is not available in this chat");
    return tools.map((tool) => ["update_spec", "create_spec"].includes(tool.name) ? {
        ...tool,
        async execute(id, input, signal, onUpdate, context) {
            const project = await projectsRepository.getProject(projectId);
            if (!project) throw new Error("Project not found");
            let patch: unknown = input;
            let replacement = false;
            if (tool.name === "create_spec") {
                const proposed = newSpecProposalSchema.parse(input);
                const existing = (await specsRepository.listSpecs(projectId)).find((spec) => spec.featureId === proposed.featureId && spec.title.trim().toLowerCase() === proposed.title.trim().toLowerCase());
                if (!existing) return tool.execute(id, input, signal, onUpdate, context);
                replacement = true;
                patch = { specId: existing.id, title: proposed.title, description: proposed.description, humanSpec: proposed.humanSpec, testSource: proposed.testSource };
            }
            if (project.agentContractPolicy === "propose_only") return proposeChatUpdate(projectId, chatId, patch);
            if (replacement) return updateSpec.execute(id, patch as never, signal, onUpdate, context);
            return tool.execute(id, input, signal, onUpdate, context);
        },
    } : tool);
}

export async function reviewChatContract(projectId: string, chatId: string, itemId: string, approve: boolean): Promise<void> {
    const [chat, item, project] = await Promise.all([chatsRepository.getChatRow(chatId), jobsRepository.item(itemId), projectsRepository.getProject(projectId)]);
    if (chat?.projectId !== projectId || !item || item.projectId !== projectId || item.kind !== "spec_fix" || payloadOf(item).sourceChatId !== chatId || (payloadOf(item).mcpContractChange !== true && project?.agentContractPolicy !== "propose_only")) throw new Error("Contract action not found in this conversation");
    if (!await jobsRepository.claimItem(item.id)) throw new Error("This action has already been reviewed");
    let commitSha: string | undefined;
    try {
        if (approve) commitSha = await applyProposal(item);
        await jobsRepository.updateItem(item.id, { status: approve ? "approved" : "rejected", commitSha });
        await jobsRepository.log(item.jobId, `inbox:${approve ? "approve" : "reject"}`, item.id);
    } catch (error) {
        if (commitSha) await jobsRepository.updateItem(item.id, { status: "approved", commitSha }).catch(() => undefined);
        else await jobsRepository.updateItem(item.id, { status: "pending" });
        throw new Error(await createProjectScrubber(projectId)(error instanceof Error ? error.message : String(error)));
    }
    publishChatUpdate(chatId);
}
