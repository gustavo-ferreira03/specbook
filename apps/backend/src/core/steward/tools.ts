import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { runsRepository } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { createProjectScrubber } from "../credentials/scrub";
import { enqueueIntent } from "./engine";
import { stewardIntentSchema } from "./schemas";
import type { StewardIntent, StewardIntentInput } from "./schemas";

const result = function result(value: string) {
  return {
    content: [{ type: "text" as const, text: value }],
    details: undefined,
    terminate: false,
  };
};

const validateReferences = async function validateReferences(
  projectId: string,
  intent: StewardIntent
): Promise<void> {
  for (const specId of intent.specIds ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
    const spec = await specsRepository.getSpec(specId);
    if (!spec || spec.projectId !== projectId) {
      throw new Error("Every selected Spec must belong to this project");
    }
  }
  if (intent.runId) {
    const run = await runsRepository.getRun(intent.runId);
    const spec = run ? await specsRepository.getSpec(run.specId) : null;
    if (!run || !spec || spec.projectId !== projectId) {
      throw new Error("The referenced run must belong to this project");
    }
    if (
      intent.kind === "triage" &&
      run.status !== "failed" &&
      run.status !== "error"
    ) {
      throw new Error("Triage needs a failed run");
    }
  }
};

export const createBackgroundTaskTool = function createBackgroundTaskTool(
  projectId: string,
  sourceKey: string,
  sourceChatId?: string
) {
  const scrub = createProjectScrubber(projectId);
  return defineTool({
    name: "start_background_task",
    label: "start_background_task",
    description:
      "Start background work the user requested in this chat, with their concrete goal and why it matters. Kinds: triage (a failed run), regenerate (an invalid Spec), coverage (find uncovered areas), explore (investigate an area), run_specs (run selected Specs; omit specIds for all). Waits while the agent is paused or another task runs.",
    parameters: Type.Unsafe<StewardIntentInput>(
      stewardIntentSchema.toJSONSchema()
    ),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted();
      const intent = stewardIntentSchema.parse(input);
      await validateReferences(projectId, intent);
      signal?.throwIfAborted();
      const queued = await enqueueIntent(
        projectId,
        intent,
        `${sourceKey}:${toolCallId}`,
        "user",
        { sourceChatId }
      );
      return result(await scrub(JSON.stringify(queued)));
    },
  });
};
