import { specBatchOf, payloadOf, verificationOf } from "../jobs/schemas";
import { chatsRepository } from "../../infra/repositories/chats";
import { jobsRepository } from "../../infra/repositories/jobs";
import { projectsRepository } from "../../infra/repositories/projects";
import { chatTitle, createChat, ERROR_TYPE, extractText, messagesOf, openSession, toolStepsOf } from "../chat/session-store";
import { getActiveChatSession, isChatBusy, isChatDeleting, queueChatFollowUp, subscribeToChatUpdates } from "../chat/chat-registry";
import { startChatTurn } from "../chat/turn-runner";
import { chatResults } from "../chat/results";
import { getPendingCredentialRequest } from "../chat/credential-requests";
import { submitChatCredentials } from "../chat/credential-submit";
import { drainJobs } from "../jobs/worker";
import { selectSpecBatch } from "../jobs/spec-batches";
import { reviewChatContract } from "./policy";
import type { z } from "zod";
import type { actionResponseSchema } from "./schemas";

const handOffs = new Set<string>();
const turnBoundaries = new Map<string, string | null>();
const credentialDeadlines = new Map<string, { id: string; until: number }>();
const labels: Record<string, [string, string]> = {
    create_spec: ["Creating Spec", "Created Spec"], update_spec: ["Updating Spec", "Updated Spec"], run_spec: ["Running Spec", "Ran Spec"],
    get_spec: ["Reading Spec", "Read Spec"], list_specs: ["Listing Specs", "Listed Specs"], list_features: ["Listing Features", "Listed Features"],
    create_feature: ["Creating Feature", "Created Feature"], browser_navigate: ["Opening page", "Opened page"], browser_snapshot: ["Inspecting page", "Inspected page"],
    browser_vault_save_login: ["Waiting for a login", "Requested a login"], browser_vault_enter_code: ["Waiting for a verification code", "Entered the verification code"],
    browser_vault_fill: ["Filling the login", "Filled the login"], request_credential: ["Waiting for a credential", "Requested a credential"],
    propose_spec_batch: ["Suggesting Specs", "Suggested Specs"], scan_page: ["Checking page", "Checked page"],
};

export interface ConversationAction {
    id: string;
    type: "login" | "code" | "secret" | "spec_selection" | "contract_change";
    description: string;
    fields?: { key: string; label?: string }[];
    origin?: string | null;
    handOffOnly?: boolean;
    candidates?: { id: string; title: string }[];
}

export async function requireConversation(projectId: string, conversationId: string) {
    const row = await chatsRepository.getChatRow(conversationId);
    if (!row || row.projectId !== projectId || row.source !== "mcp" || isChatDeleting(conversationId)) throw new Error("Conversation not found in this project. Call list_conversations.");
    return row;
}

export async function conversationState(projectId: string, conversationId: string, frontendOrigin: string) {
    const row = await requireConversation(projectId, conversationId);
    const manager = getActiveChatSession(conversationId)?.sessionManager ?? await openSession(conversationId);
    if (!manager) throw new Error("Conversation no longer exists. Call send_message without a conversationId.");
    const [results, project] = await Promise.all([chatResults(conversationId), projectsRepository.getProject(projectId)]);
    if (!results || !project) throw new Error("Conversation not found");
    const messages = messagesOf(conversationId, manager);
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === "user") { userIndex = index; break; }
    const boundary = turnBoundaries.get(conversationId);
    const awaitingNewTurn = turnBoundaries.has(conversationId) && (userIndex < 0 || messages[userIndex].id === boundary || messages.findIndex((message) => message.id === boundary) >= userIndex);
    const current = awaitingNewTurn ? [] : messages.slice(Math.max(0, userIndex));
    const anchors = new Set(current.map((message) => message.id));
    const inTurn = (value: { afterMessageId?: string | null; createdAt?: string; startedAt?: string | number }) => {
        if (awaitingNewTurn || !current.length) return false;
        if (value.afterMessageId != null) return anchors.has(value.afterMessageId);
        const at = value.createdAt ?? value.startedAt;
        return at !== undefined && (typeof at === "number" ? at : Date.parse(at)) >= Date.parse(current[0].createdAt);
    };
    const url = `${frontendOrigin.replace(/\/$/, "")}/p/${projectId}/chats/${conversationId}`;
    const actions: ConversationAction[] = [];
    const previousCredential = credentialDeadlines.get(conversationId);
    const expiredCredential = results.credentialRequests.some(({ request }) => Date.now() - Date.parse(request.createdAt) >= 10 * 60_000) || previousCredential && previousCredential.until <= Date.now() && !results.credentialRequests.some(({ request }) => request.id === previousCredential.id && Date.now() - Date.parse(request.createdAt) < 10 * 60_000);
    for (const { request } of results.credentialRequests) {
        credentialDeadlines.set(conversationId, { id: request.id, until: Date.parse(request.createdAt) + 10 * 60_000 });
        if (Date.now() - Date.parse(request.createdAt) >= 10 * 60_000) continue;
        actions.push({ id: request.id, type: request.kind === "fields" ? "secret" : request.kind,
            description: request.kind === "login" ? `Provide a login for ${request.origin}` : request.kind === "code" ? `Provide the verification code for ${request.origin}` : `Provide the requested fields for ${request.profileName}`,
            fields: request.fields, origin: request.origin, ...(project.agentsMayProvideCredentials === false ? { handOffOnly: true } : {}) });
    }
    for (const item of results.items.filter((item) => item.status === "pending")) {
        if (item.kind === "spec_batch") {
            const batch = specBatchOf(item);
            actions.push({ id: item.id, type: "spec_selection", description: item.title,
                candidates: batch?.candidates?.map(({ id, title }) => ({ id, title })) ?? [] });
        } else if (item.kind === "spec_fix" && (payloadOf(item).mcpContractChange === true || project.agentContractPolicy === "propose_only")) {
            actions.push({ id: item.id, type: "contract_change", description: item.title });
        }
    }
    const tasks = results.tasks.filter(inTurn);
    const busy = isChatBusy(conversationId) || tasks.some((task) => ["queued", "working"].includes(task.status));
    const branch = manager.getBranch();
    let lastUser = -1;
    for (let index = branch.length - 1; index >= 0; index--) { const entry = branch[index]; if (entry.type === "message" && entry.message.role === "user") { lastUser = index; break; } }
    const error = !awaitingNewTurn && branch.slice(lastUser + 1).reverse().find((entry) => entry.type === "custom_message" && entry.customType === ERROR_TYPE);
    const question = results.items.find((item) => item.kind === "question" && item.status === "pending" && inTurn(item));
    const status = actions.length ? "needs_action" as const : question ? "replied" as const : busy ? "working" as const : error || tasks.some((task) => task.status === "failed") ? "failed" as const : "replied" as const;
    const changedSpecs = results.specs.filter(inTurn).map((spec) => ({ id: spec.id, title: spec.title, change: spec.change, url: `${frontendOrigin}/p/${projectId}/specs/${spec.id}` }));
    for (const item of results.items.filter((item) => inTurn(item) && item.status === "approved")) {
        if (item.kind === "spec_batch") {
            const batch = specBatchOf(item);
            for (const candidate of batch?.candidates ?? []) if (candidate.selected && candidate.specId && !changedSpecs.some((spec) => spec.id === candidate.specId)) changedSpecs.push({ id: candidate.specId, title: candidate.title, change: "created", url: `${frontendOrigin}/p/${projectId}/specs/${candidate.specId}` });
        } else if (item.kind === "spec_fix" && payloadOf(item).mcpContractChange === true) {
            const specId = payloadOf(item).params?.specId;
            if (specId && !changedSpecs.some((spec) => spec.id === specId)) changedSpecs.push({ id: specId, title: item.title.replace(/^Proposed fix: /, ""), change: "updated", url: `${frontendOrigin}/p/${projectId}/specs/${specId}` });
        }
    }
    const runs = results.runs.filter(inTurn).map((run) => ({ specId: run.specId, title: run.title, status: run.status, failReason: run.failReason,
        url: `${frontendOrigin}/p/${projectId}/specs/${run.specId}#run-${run.id}` }));
    const reply = question?.body ?? current.filter((message) => message.role === "agent").at(-1)?.content ?? "";
    const notes = results.notes.filter(inTurn);
    const handOff = actions.some((action) => action.handOffOnly || handOffs.has(`${conversationId}:${action.id}`));
    return { conversationId, url, status, reply: reply || notes.at(-1)?.body || "",
        progress: toolStepsOf(manager).filter(inTurn).map((step) => {
            const result = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === step.id.slice(step.id.indexOf(":") + 1));
            let specId: string | undefined;
            let proposed = false;
            if (result?.type === "message") {
                try { const value = JSON.parse(extractText(result.message)); specId = value.specId; proposed = value.status === "needs_approval"; } catch {}
            }
            const title = changedSpecs.find((spec) => spec.id === specId)?.title ?? results.runs.find((run) => run.specId === specId)?.title;
            const label = proposed ? "Proposed Spec update" : (labels[step.toolName] ?? ["Working in the application", "Checked the application"])[step.endedAt === null ? 0 : 1];
            return title ? `${label} '${title}'` : label;
        }),
        changes: { specs: changedSpecs, runs }, actions,
        next: status === "working" ? "Call wait_for_reply" : handOff ? `Ask the user to complete the action in Specbook at ${url}` : status === "needs_action" ? "Call respond_to_action with the action id, or handOff: true for the human"
            : status === "failed" ? "Read the error and call send_message to retry or clarify" : tasks.some((task) => task.status === "paused") ? `Ask the user to resume the paused QA work in Specbook at ${url}` : "Call send_message to continue this conversation, or return the QA outcome to the user",
        ...(status === "failed" ? { error: reply || tasks.find((task) => task.status === "failed")?.summary || "The conversation turn failed." } : {}),
        ...(expiredCredential ? { notice: "The credential request expired after 10 minutes. Specbook may request access again; call send_message if it needs a reminder." } : {}),
        updatedAt: branch.at(-1)?.timestamp ?? messages.at(-1)?.createdAt ?? row.createdAt };
}

export async function waitForConversation(projectId: string, conversationId: string, frontendOrigin: string, signal: AbortSignal) {
    await requireConversation(projectId, conversationId);
    return new Promise<Awaited<ReturnType<typeof conversationState>>>((resolve, reject) => {
        let done = false;
        let checking = false;
        let dirty = true;
        let expired = false;
        const cleanup = () => { done = true; clearTimeout(timer); unsubscribe(); signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(new Error("Request cancelled. Call wait_for_reply to continue.")); };
        const check = async () => {
            if (done || checking) return;
            checking = true;
            try {
                while (dirty && !done) {
                    dirty = false;
                    const state = await conversationState(projectId, conversationId, frontendOrigin);
                    if (expired || !dirty && state.status !== "working") { cleanup(); resolve(state); break; }
                }
            } catch (error) { cleanup(); reject(error); }
            finally { checking = false; }
        };
        const unsubscribe = subscribeToChatUpdates(conversationId, () => { dirty = true; void check(); });
        const timer = setTimeout(() => { expired = true; dirty = true; void check(); }, 25_000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else void check();
    });
}

export async function sendConversationMessage(projectId: string, clientName: string, message: string, conversationId?: string) {
    const chat = conversationId ? await requireConversation(projectId, conversationId) : await createChat(projectId, { source: "mcp", sourceClient: clientName }, chatTitle(message));
    if (conversationId && !isChatBusy(chat.id)) {
        const results = await chatResults(chat.id);
        const questions = results?.items.filter((item) => item.kind === "question" && item.status === "pending" && payloadOf(item).waitingFor !== "credentials") ?? [];
        if (questions.length === 1) {
            const item = await jobsRepository.item(questions[0].id);
            const job = item ? await jobsRepository.get(item.jobId) : null;
            if (item && job?.status === "blocked" && !isChatBusy(job.chatId) && await jobsRepository.claimItem(item.id)) {
                try { await jobsRepository.answer(item, message); void drainJobs(); }
                catch (error) { await jobsRepository.updateItem(item.id, { status: "pending" }); throw error; }
            }
        }
    }
    const manager = getActiveChatSession(chat.id)?.sessionManager ?? await openSession(chat.id);
    turnBoundaries.set(chat.id, manager ? messagesOf(chat.id, manager).at(-1)?.id ?? null : null);
    if (isChatBusy(chat.id)) await queueChatFollowUp(chat.id, message);
    else startChatTurn(chat.id, message);
    return chat.id;
}

export async function respondToConversationAction(projectId: string, conversationId: string, actionId: string, response: z.infer<typeof actionResponseSchema>, frontendOrigin: string) {
    const state = await conversationState(projectId, conversationId, frontendOrigin);
    const action = state.actions.find((action) => action.id === actionId);
    if (!action) throw new Error("Unknown or expired action. Call wait_for_reply to refresh the state; send_message if the agent needs to request access again.");
    if ("handOff" in response) { handOffs.add(`${conversationId}:${actionId}`); return "Action handed to the human in Specbook."; }
    if (action.handOffOnly) throw new Error("Agents may not provide credentials for this project. Call respond_to_action with handOff: true and ask the user to complete it in Specbook.");
    if (["login", "code", "secret"].includes(action.type)) {
        const results = await chatResults(conversationId);
        const entry = results?.credentialRequests.find(({ request }) => request.id === actionId);
        if (!entry || getPendingCredentialRequest(entry.request.chatId)?.id !== actionId) throw new Error("This credential action expired. Call wait_for_reply.");
        const project = await projectsRepository.getProject(projectId);
        if (project?.agentsMayProvideCredentials === false) throw new Error("Credentials must be provided by the human in Specbook. Use handOff: true.");
        const values = action.type === "login" && "username" in response ? { username: response.username, password: response.password }
            : action.type === "code" && "code" in response ? { code: response.code }
            : action.type === "secret" && "fields" in response ? response.fields : null;
        if (!values) throw new Error("Response fields do not match this action. Call respond_to_action with the requested fields.");
        await submitChatCredentials(entry.request.chatId, actionId, { action: "submit", values,
            ...(entry.request.origin ? { allowedOrigins: [entry.request.origin] } : {}) });
    } else if (action.type === "spec_selection" && "candidateIds" in response) {
        const item = await jobsRepository.item(actionId);
        if (!item || item.projectId !== projectId || payloadOf(item).sourceChatId !== conversationId) throw new Error("Suggestion no longer belongs to this conversation");
        await selectSpecBatch(item, response.candidateIds);
    } else if (action.type === "contract_change" && "approve" in response) {
        await reviewChatContract(projectId, conversationId, actionId, response.approve);
        await sendConversationMessage(projectId, "External agent", `Contract change ${actionId} was ${response.approve ? "approved" : "rejected"}. Read the chat results, continue the requested QA and report the outcome.`, conversationId);
    } else throw new Error("Response fields do not match this action. Call respond_to_action with the requested fields.");
    handOffs.delete(`${conversationId}:${actionId}`);
    if (credentialDeadlines.get(conversationId)?.id === actionId) credentialDeadlines.delete(conversationId);
    return action.type === "login" ? `Login saved for ${action.origin}` : action.type === "code" ? "Verification code provided to the waiting tool." : action.type === "secret" ? "Requested credentials saved." : "Action completed.";
}
