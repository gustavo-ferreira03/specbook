import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { featuresRepository } from "../../infra/repositories/features";
import { chatTitle, listChats } from "../chat/session-store";
import { ciResult } from "../ci/results";
import { CiRequestError, startCiRun } from "../ci/runs";
import { ciRunSchema } from "../ci/schemas";
import { createProjectScrubber } from "../credentials/scrub";
import { readRunEvidence } from "../runner/artifacts";
import { getRunBatch } from "../runner/batch";
import { conversationState, respondToConversationAction, sendConversationMessage, waitForConversation } from "./conversations";
import { getRunResultsSchema, listConversationsSchema, respondToActionSchema, runSpecsSchema, sendMessageSchema, waitForReplySchema } from "./schemas";
import { authenticateAgentToken } from "./tokens";

interface ProjectMcpOptions {
    projectId: string;
    authorization: string;
    frontendOrigin: string;
    signal: AbortSignal;
    clientName: string;
}

const instructions = "Specbook is your QA subagent. After implementing or changing a feature, call send_message describing what changed and which behaviours changed on purpose. Continue with wait_for_reply while working, and respond_to_action when an action is needed. Conversations are ordinary Specbook chats visible to the human. Use run_specs for regression checks and get_run_results for their outcome. Never ask the user for credentials in your own chat: answer login, code or secret actions with respond_to_action, or hand them off with response: { handOff: true }. Contract changes follow this project's policy; pending contract_change and spec_selection actions require a response. Every state includes the next call to make.";

export function createProjectMcpServer(options: ProjectMcpOptions): McpServer {
    const { projectId, authorization, signal, clientName } = options;
    const server = new McpServer({ name: "specbook", version: "2.0.0" }, { instructions });
    const scrub = createProjectScrubber(projectId);
    const frontend = options.frontendOrigin.replace(/\/$/, "");
    const reply = async (value: unknown): Promise<CallToolResult> => {
        const strings: string[] = [];
        const protocolValues = new Set(["replied", "working", "needs_action", "failed", "passed", "running", "error", "created", "updated", "login", "code", "secret", "spec_selection", "contract_change"]);
        function visit(item: unknown, replace: (value: string) => unknown, key = ""): unknown {
            if (typeof item === "string") return ["status", "type", "change"].includes(key) && protocolValues.has(item) ? item : replace(item);
            if (Array.isArray(item)) return item.map((entry) => visit(entry, replace));
            if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, replace, name)]));
            return item;
        }
        visit(value, (text) => { strings.push(text); return text; });
        const clean = await scrub.batch(strings);
        let index = 0;
        return { content: [{ type: "text", text: JSON.stringify(visit(value, () => clean[index++])) }] };
    };
    const authenticate = async () => {
        if (!await authenticateAgentToken(projectId, authorization)) throw new CiRequestError("A valid project agent bearer token is required", 401);
    };
    function tool<S extends z.ZodObject>(name: string, description: string, schema: S, run: (input: z.infer<S>) => Promise<unknown>, readOnly = true) {
        server.registerTool(name, { description, inputSchema: schema as z.ZodObject, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: !readOnly } }, async (input) => {
            try {
                await authenticate();
                const result = await run(input as z.infer<S>);
                await authenticate();
                return await reply(result);
            } catch (error) {
                return { ...await reply({ error: error instanceof Error ? error.message : String(error), next: "Refresh with wait_for_reply or list_conversations, then retry the requested action.",
                    ...(error instanceof CiRequestError ? { status: error.status, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}), next: error.status === 409 ? "Wait for the active Spec run to finish, then call run_specs again." : error.status === 429 ? "Retry after the indicated delay." : error.status === 401 ? "Check the project agent token before retrying." : "Correct the selection or environment, or call send_message for help." } : {}) }), isError: true };
            }
        });
    }
    async function batchResult(batchId: string, wait?: boolean) {
        const read = async () => {
            const batch = await getRunBatch(batchId);
            if (!batch || batch.projectId !== projectId) throw new Error("Run batch not found in this project");
            return ciResult(batch, frontend);
        };
        const deadline = Date.now() + 25_000;
        let result = await read();
        while (wait && !result.complete && Date.now() < deadline && !signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await authenticate();
            result = await read();
        }
        return { batchId, status: result.status, complete: result.complete, url: result.url,
            results: await Promise.all(result.results.map(async ({ specId, title, runId, status, failReason, flaky, url }) => ({ specId, title, runId, status, failReason, flaky, url,
                failedStep: (await readRunEvidence(runId).catch(() => null))?.failedStep ?? null }))),
            next: result.complete ? "Return the regression outcome to the user, or call send_message to investigate failures." : `Call get_run_results with batchId "${batchId}" and wait: true.` };
    }
    tool("send_message", "Ask Specbook to test your work in a new or existing conversation. Busy conversations queue follow-ups; waits up to 25 seconds.", sendMessageSchema, async (input) => {
        const id = await sendConversationMessage(projectId, await scrub(clientName), await scrub(input.message), input.conversationId);
        return waitForConversation(projectId, id, frontend, signal);
    }, false);
    tool("wait_for_reply", "Wait up to 25 seconds for this conversation's reply or secure action.", waitForReplySchema, (input) => waitForConversation(projectId, input.conversationId, frontend, signal));
    tool("respond_to_action", "Resolve a login, code, secret, Spec selection or contract approval; handOff: true leaves it to the human. Credential values stay outside chat and model context.", respondToActionSchema, async (input) => {
        const actionResult = await respondToConversationAction(projectId, input.conversationId, input.actionId, input.response, frontend);
        return { ...await waitForConversation(projectId, input.conversationId, frontend, signal), actionResult };
    }, false);
    tool("list_conversations", "List recent MCP conversations for this project.", listConversationsSchema, async (input) => {
        const chats = (await listChats(projectId)).filter((chat) => chat.source === "mcp").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, input.limit);
        return Promise.all(chats.map(async (chat) => {
            const state = await conversationState(projectId, chat.id, frontend);
            return { id: chat.id, title: chat.title || chatTitle(state.reply), status: state.status, updatedAt: state.updatedAt, url: state.url, next: state.next };
        }));
    });
    tool("run_specs", "Run all runnable Specs, selected ids, or a Feature by name. Returns immediately unless wait is true (up to 25 seconds).", runSpecsSchema, async ({ feature, wait, ...input }) => {
        let featureId: string | undefined;
        if (feature) {
            const matches = (await featuresRepository.listFeatures(projectId)).filter((item) => item.title.trim().toLowerCase() === feature.toLowerCase());
            if (matches.length !== 1) throw new CiRequestError(matches.length ? "Feature name is ambiguous; select explicit Spec ids." : "Feature not found in this project", 400);
            featureId = matches[0].id;
        }
        const batch = await startCiRun(projectId, authorization, ciRunSchema.parse({ ...input, featureId }), "MCP run");
        return batchResult(batch.id, wait);
    }, false);
    tool("get_run_results", "Read scoped batch results, including failed step and flaky status; optionally wait up to 25 seconds.", getRunResultsSchema, (input) => batchResult(input.batchId, input.wait));
    return server;
}
