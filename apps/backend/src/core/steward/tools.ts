import { enqueueIntent } from "./engine";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runsRepository } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { createProjectScrubber } from "../credentials/scrub";
import { stewardIntentSchema, type StewardIntent, type StewardIntentInput } from "./schemas";

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

export function createBackgroundTaskTool(projectId: string, sourceKey: string, sourceChatId?: string) {
    const scrub = createProjectScrubber(projectId);
    return defineTool({
        name: "start_background_task",
        label: "start_background_task",
        description: "Start background work explicitly requested in this conversation. Include the user's concrete goal and why it matters. Do not invent additional work. Use triage for a failed run, regenerate for an invalid check, coverage to find uncovered areas, explore to investigate the requested area, or run_specs to verify selected checks (omit specIds for all runnable checks). Requests wait while the agent is paused or another task is running.",
        parameters: Type.Unsafe<StewardIntentInput>(stewardIntentSchema.toJSONSchema()),
        async execute(toolCallId, input, signal) {
            signal?.throwIfAborted();
            const intent = stewardIntentSchema.parse(input);
            await validateReferences(projectId, intent);
            signal?.throwIfAborted();
            const queued = await enqueueIntent(projectId, intent, `${sourceKey}:${toolCallId}`, "user", { sourceChatId });
            return result(await scrub(JSON.stringify(queued)));
        },
    });
}
