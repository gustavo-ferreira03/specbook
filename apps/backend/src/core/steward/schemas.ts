import { z } from "zod";
import { httpUrlSchema } from "../ci/schemas";

export const intentKindSchema = z.enum(["triage", "regenerate", "coverage", "explore", "run_specs"]);

export const stewardIntentSchema = z.object({
    kind: intentKindSchema,
    goal: z.string().trim().min(1).max(6000),
    reason: z.string().trim().min(1).max(2000),
    specIds: z.array(z.string().uuid()).max(100).optional(),
    runId: z.string().uuid().optional(),
    baseUrl: httpUrlSchema.optional(),
    environment: z.string().trim().min(1).max(80).optional(),
    priority: z.number().int().min(0).max(100).default(50),
}).strict().superRefine((intent, context) => {
    if (intent.kind === "triage" && !intent.runId) {
        context.addIssue({ code: "custom", path: ["runId"], message: "Triage needs the failed run id" });
    }
    if (intent.kind === "regenerate" && !intent.specIds?.length) {
        context.addIssue({ code: "custom", path: ["specIds"], message: "Regeneration needs at least one Spec id" });
    }
});

export type StewardIntentInput = z.input<typeof stewardIntentSchema>;
export type StewardIntent = z.infer<typeof stewardIntentSchema>;
export type IntentKind = z.infer<typeof intentKindSchema>;
