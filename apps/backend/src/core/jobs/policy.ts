import { errorCodeOf, isInfrastructureCode, type ErrorCode } from "../errors";
import { loadPrompt } from "../chat/prompt-loader";
import { logger } from "../../infra/logger";
import { createSelectedSpec, selectedSpecResult } from "./spec-batches";
import { z } from "zod";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { credentialsRepository } from "../../infra/repositories/credentials";
import { createProjectScrubber } from "../credentials/scrub";
import { proposeMutation } from "./proposals";
import { createTriageTools } from "./triage";
import { verifyProposal } from "./verification";
import { reviewNextStep } from "../runner/evidence-review";
import { applyVerifiedRepairs } from "../steward/approval";
import { reportSchema } from "./schemas";
import { retryInfrastructure, stallJob } from "./retry";
import { isAgentPaused } from "./pause";
import type { RunEnvironment } from "../../infra/db/schema";

const JOB_SYSTEM_PROMPT = loadPrompt("job-system-prompt.txt");

export const AGENT_RULES_VERSION = 4;

export interface TurnPolicy {
    prompt: string;
    browserScope: "spec" | "explore";
    baseUrl?: string;
    environment?: RunEnvironment;
    infrastructureFailure?(error: string, code?: ErrorCode): Promise<void>;
    browserReady?(): Promise<void>;
    tools(tools: ToolDefinition[]): ToolDefinition[];
    tokens(count: number): void;
    flush(): Promise<void>;
}

function result(value: unknown, terminate = false) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined, terminate };
}

interface ToolCall {
    job: Job;
    tool: ToolDefinition;
    args: Parameters<ToolDefinition["execute"]>;
    abort: () => void;
    check: () => Promise<void>;
    baseUrl?: string;
    environment?: RunEnvironment;
}
type ToolHandler = (call: ToolCall) => Promise<Awaited<ReturnType<ToolDefinition["execute"]>>>;

async function executeOriginal({ tool, args }: ToolCall) { return tool.execute(...args); }

async function createSelected({ job, args, check, baseUrl, environment }: ToolCall) {
    return result(await createSelectedSpec(job, args[1], { signal: args[2], checkPolicy: check, baseUrl, environment }));
}

async function rejectSelectedMutation(): Promise<never> {
    throw new Error("Create only the selected Spec using its assigned feature. Do not change existing Specs. To revise the selected Spec after a failed run, call create_spec again with the corrected Spec.");
}

async function readSelected({ job }: ToolCall) { return result(await selectedSpecResult(job)); }

async function rejectCoverageMutation(): Promise<never> {
    throw new Error("Use propose_spec_batch to suggest Specs for uncovered areas. The human chooses which Specs to create.");
}

async function proposeAndVerify({ job, tool, args }: ToolCall) {
    const item = await proposeMutation(job, tool.name, args[1]);
    const verification = ["failure_triage", "regenerate"].includes(job.kind) ? await verifyProposal(job, item, args[2]) : undefined;
    if (verification?.status === "passed") await applyVerifiedRepairs(job.projectId);
    const saved = (await jobsRepository.item(item.id))?.status === "approved";
    const unproven = verification?.status === "passed" ? reviewNextStep(verification.review) : undefined;
    return result({ inboxId: item.id, status: verification && (verification.status !== "passed" || unproven) ? "unfinished" : saved ? "saved" : "proposed", verification,
        message: unproven ? `This candidate passed but does not prove the expected result. ${unproven} Then call update_spec again.`
            : verification && verification.status !== "passed" ? "This candidate did not pass and is not visible for approval. Inspect the failure and keep working on a minimal repair. Do not ask the human to approve unfinished work."
            : saved ? "The verified repair was saved to the project. Report the result in one short sentence and finish." : "Await human approval; no repository files changed." });
}

async function runInvestigated({ job, tool, args }: ToolCall) {
    if (z.object({ specId: z.string() }).parse(args[1]).specId !== job.specId) throw new Error("Run the Spec being investigated");
    const item = (await jobsRepository.itemsForJob(job.id, { kind: "spec_fix", statuses: ["pending"] }))[0];
    if (item) return result(await verifyProposal(job, item, args[2]));
    const output = await tool.execute(...args);
    const text = output.content.map((part) => part.type === "text" ? part.text : "").join("");
    const rerun = z.object({ runId: z.string(), status: z.string() }).safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
    if (rerun.success && ["failed", "error"].includes(rerun.data.status)) await jobsRepository.update(job.id, { runId: rerun.data.runId });
    return output;
}

async function requestCredentials({ job, tool, args, abort }: ToolCall) {
    if ((await credentialsRepository.listProfiles(job.projectId)).length > 0
        && !(await jobsRepository.actions(job.id)).some((action) => action.action === "fill_secret" || action.action === "browser_vault_fill")) {
        throw new Error("Do not ask for access yet: this project has saved credential profiles. Call browser_vault_list, sign in with browser_vault_fill on the login form, and continue. Ask for a login only if signing in with them fails.");
    }
    const credentialRequest = tool.name === "browser_vault_save_login"
        ? { profileName: z.object({ label: z.string().optional() }).parse(args[1]).label?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "login", fields: [{ key: "username", label: "Email or username" }, { key: "password", label: "Password" }] }
        : args[1];
    const item = await jobsRepository.addItem({ projectId: job.projectId, jobId: job.id, kind: "question",
        title: "Can you provide access to the app?", payload: { errorCode: "credentials", waitingFor: "credentials", language: "en", credentialRequest, rulesVersion: AGENT_RULES_VERSION }, body: "Use the secure credentials form to add the requested sign-in details. Specbook will continue when they are available. Do not paste passwords in a message." });
    await jobsRepository.transition(job.id, "running", "blocked", { errorCode: "credentials" });
    abort();
    return result({ inboxId: item.id, status: "blocked" }, true);
}

const commonHandlers = new Map<string, ToolHandler>([
    ["create_spec", proposeAndVerify], ["update_spec", proposeAndVerify], ["create_feature", proposeAndVerify],
    ["request_credential", requestCredentials], ["browser_vault_save_login", requestCredentials],
]);
const jobHandlers = new Map<string, Map<string, ToolHandler>>([
    ["generate_spec", new Map<string, ToolHandler>([
        ["create_spec", createSelected], ["create_feature", rejectSelectedMutation], ["update_spec", rejectSelectedMutation],
        ["propose_spec_batch", rejectSelectedMutation], ["start_background_task", rejectSelectedMutation], ["run_spec", readSelected],
    ])],
    ["coverage", new Map<string, ToolHandler>([["create_spec", rejectCoverageMutation], ["create_feature", rejectCoverageMutation]])],
    ["failure_triage", new Map<string, ToolHandler>([["run_spec", runInvestigated]])],
]);

export function createJobPolicy(job: Job, abort: () => void, baseUrl?: string, environment?: RunEnvironment): TurnPolicy {
    const scrub = createProjectScrubber(job.projectId);
    let actions = job.actionsUsed;
    let pending = Promise.resolve();
    const started = Date.now();
    const check = async () => {
        await pending;
        const current = await jobsRepository.get(job.id);
        if (current?.status !== "running") throw new Error("Job is paused or stopped. No further actions are allowed.");
        if (await isAgentPaused(job.projectId)) {
            await jobsRepository.transition(job.id, "running", "paused");
            abort();
            throw new Error("The user paused the agent. No further actions are allowed.");
        }
        if (actions >= job.limits.maxActions || job.elapsedMs + Date.now() - started >= job.limits.wallTimeMs) {
            await stallJob(job, "The investigation kept repeating actions without confirming the expected result.");
            abort();
            throw new Error("The investigation did not reach a confirmed result.");
        }
    };
    return {
        baseUrl,
        environment,
        browserScope: ["failure_triage", "regenerate", "generate_spec"].includes(job.kind) ? "spec" : "explore",
        async infrastructureFailure(error, code) { await retryInfrastructure(job, error, code); abort(); },
        async browserReady() { await jobsRepository.update(job.id, { systemError: null, errorCode: null }); },
        prompt: `\n${JOB_SYSTEM_PROMPT.replace("{{goal}}", () => job.goal)}`,
        tools(tools) {
            const reportTool = defineTool({
                name: "inbox_report", label: "inbox_report",
                description: "Send a question, bug report with reproduction steps/evidence, or result to the project Inbox. Questions pause the job.",
                parameters: Type.Unsafe<ReturnType<typeof reportSchema.parse>>(reportSchema.toJSONSchema()),
                async execute(_id, input) {
                    const report = reportSchema.parse(input);
                    const current = await jobsRepository.get(job.id);
                    const code = report.errorCode ?? current?.errorCode ?? "failed";
                    if (isInfrastructureCode(code)) {
                        await retryInfrastructure(job, `${report.title}\n${report.body}`, report.errorCode ?? current?.errorCode ?? "infrastructure");
                        abort();
                        return result({ status: "retrying", message: "Specbook will retry its service. No human decision is needed." }, true);
                    }
                    if (report.kind === "question" && job.kind === "failure_triage" && (await jobsRepository.get(job.id))?.classification === "test_drift") {
                        throw new Error("Do not ask permission to repair test drift. Call update_spec with the fix; Specbook runs it in isolation and saves or holds it for review on its own.");
                    }
                    const item = await jobsRepository.addItem({ ...report, body: await scrub(report.body), title: await scrub(report.title), payload: { errorCode: code, language: "en", rulesVersion: AGENT_RULES_VERSION }, projectId: job.projectId, jobId: job.id });
                    if (report.kind === "question") {
                        await jobsRepository.transition(job.id, "running", "blocked");
                        abort();
                    }
                    return result({ inboxId: item.id, status: report.kind === "question" ? "blocked" : "submitted" }, report.kind === "question");
                },
            });
            const listTool = defineTool({
                name: "list_inbox", label: "list_inbox", description: "Read this job's previous proposals and human answers before continuing.",
                parameters: Type.Unsafe(z.object({}).toJSONSchema()),
                async execute() {
                    return result(await jobsRepository.itemsForJob(job.id));
                },
            });
            return [...tools.filter((tool) => tool.name !== "start_background_task"), reportTool, listTool, ...(job.kind === "failure_triage" ? createTriageTools(job, abort) : [])].map((tool) => ({
                ...tool,
                executionMode: "sequential" as const,
                async execute(id, params, signal, onUpdate, ctx) {
                    await check();
                    actions++;
                    await jobsRepository.update(job.id, { actionsUsed: actions });
                    await jobsRepository.log(job.id, tool.name, (await scrub(JSON.stringify(params))).slice(0, 6000));
                    try {
                        if ((await jobsRepository.get(job.id))?.status !== "running" || await isAgentPaused(job.projectId)) {
                            abort();
                            throw new Error("The user paused the agent before this action started.");
                        }
                        const handler = jobHandlers.get(job.kind)?.get(tool.name) ?? commonHandlers.get(tool.name) ?? executeOriginal;
                        const output = await handler({ job, tool, args: [id, params, signal, onUpdate, ctx], abort, check, baseUrl, environment });
                        const text = JSON.stringify(output);
                        const code = errorCodeOf(output) ?? "failed";
                        if ((output as { isError?: boolean }).isError && code) await jobsRepository.update(job.id, { errorCode: code });
                        if ((output as { isError?: boolean }).isError && isInfrastructureCode(code)) {
                            await retryInfrastructure(job, text, code);
                            abort();
                        }
                        await jobsRepository.log(job.id, `${tool.name}:completed`);
                        return output;
                    } catch (error) {
                        const code = errorCodeOf(error);
                        if (code) await jobsRepository.update(job.id, { errorCode: code });
                        await jobsRepository.log(job.id, `${tool.name}:error`, await scrub(String(error)));
                        throw error;
                    }
                },
            }));
        },
        tokens(count) {
            pending = pending.then(() => jobsRepository.recordUsage(job.id, count)).catch((error) => logger.error("job usage could not be recorded", { jobId: job.id, error }));
        },
        flush: () => pending,
    };
}
