import crypto from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { jobsRepository, type Job } from "../../infra/repositories/jobs";
import { runsRepository } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { createProjectScrubber } from "../credentials/scrub";
import { proposeIntentsSchema, stewardIntentSchema, type StewardIntent, type StewardIntentInput } from "./schemas";

function result(value: string) {
    return { content: [{ type: "text" as const, text: value }], details: undefined, terminate: false };
}

async function validateReferences(projectId: string, intent: StewardIntent): Promise<void> {
    for (const specId of intent.specIds ?? []) {
        const spec = await specsRepository.getSpec(specId);
        if (!spec || spec.projectId !== projectId) throw new Error("Every selected Spec must belong to this project");
    }
    if (intent.runId) {
        const run = await runsRepository.getRun(intent.runId);
        const spec = run ? await specsRepository.getSpec(run.specId) : null;
        if (!run || !spec || spec.projectId !== projectId) throw new Error("The referenced run must belong to this project");
        if (intent.kind === "triage" && run.status !== "failed" && run.status !== "error") {
            throw new Error("Triage needs a failed run");
        }
    }
}

export function createBackgroundTaskTool(projectId: string, sourceKey: string) {
    const scrub = createProjectScrubber(projectId);
    return defineTool({
        name: "start_background_task",
        label: "start_background_task",
        description: "Ask the project steward to investigate or verify something in the background while this conversation continues. Include a concrete goal and why it matters. The steward applies project policy, deduplication and daily budgets before starting work; acceptance does not mean execution has started. Use triage for a failed run, regenerate for invalid spec.ts, coverage to propose missing Specs, explore to investigate an area, or run_specs to verify selected Specs (omit specIds for all runnable Specs).",
        parameters: Type.Unsafe<StewardIntentInput>(stewardIntentSchema.toJSONSchema()),
        async execute(toolCallId, input, signal) {
            signal?.throwIfAborted();
            const intent = stewardIntentSchema.parse(input);
            await validateReferences(projectId, intent);
            signal?.throwIfAborted();
            const { enqueueIntent } = await import("./engine");
            const queued = await enqueueIntent(projectId, intent, `${sourceKey}:${toolCallId}`);
            return result(await scrub(JSON.stringify(queued)));
        },
    });
}

export function createPlannerTools(job: Job) {
    const scrub = createProjectScrubber(job.projectId);
    const assertPlanner = async () => {
        const current = await jobsRepository.get(job.id);
        if (!current || current.projectId !== job.projectId || current.kind !== "planner" || current.status !== "running") {
            throw new Error("Only the active project steward planner may propose intents");
        }
    };
    return [defineTool({
        name: "propose_intents",
        label: "propose_intents",
        description: "Submit at most eight prioritized next actions for this project, each with a concrete goal and an evidence-based reason. Higher priority runs first. Respect the human's decisions and avoid repeating rejected proposals or already active work. Submit an empty list when the project needs no additional work. These are intents for the steward to evaluate, not permission to change spec.yml or commit files.",
        parameters: Type.Unsafe<ReturnType<typeof proposeIntentsSchema.parse>>(proposeIntentsSchema.toJSONSchema()),
        async execute(_toolCallId, input, signal) {
            signal?.throwIfAborted();
            await assertPlanner();
            const { intents } = proposeIntentsSchema.parse(input);
            for (const intent of intents) await validateReferences(job.projectId, intent);
            const { enqueueIntent } = await import("./engine");
            const queued = [];
            for (const intent of [...intents].sort((left, right) => right.priority - left.priority)) {
                signal?.throwIfAborted();
                await assertPlanner();
                const key = crypto.createHash("sha256").update(JSON.stringify({
                    ...intent, specIds: intent.specIds ? [...new Set(intent.specIds)].sort() : undefined,
                })).digest("hex").slice(0, 24);
                queued.push(await enqueueIntent(job.projectId, intent, `planner:${job.id}:${key}`));
            }
            return result(await scrub(JSON.stringify({ intents: queued })));
        },
    })];
}
