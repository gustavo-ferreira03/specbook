import { z } from "zod";

export const chatIdSchema = z.string().regex(/^c-[a-f0-9]{8}$/);
const message = z.string().trim().min(1).max(20_000);
const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
export const proposalInputSchema = z.strictObject({ title: message, why: message, feature: message });
export const proposalSchema = proposalInputSchema.extend({ number: z.number().int().positive() });
export const pendingActionSchema = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("question"), question: message }),
    z.strictObject({ type: z.literal("spec_selection") }),
    z.strictObject({ type: z.literal("credentials"), profile: name, fields: z.array(name).min(1), command: message }),
]);
export const outcomeToolSchemas = {
    ask_question: z.strictObject({ message }),
    propose_specs: z.strictObject({ message, proposals: z.array(proposalInputSchema).min(1).max(10) }),
    request_credentials: z.strictObject({ message, profile: name, fields: z.array(name).min(1).max(20) }),
    report_done: z.strictObject({ message }),
    report_failed: z.strictObject({ message, error: message }),
};
export const outcomeSchema = z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("waiting_for_reply"), message, pendingAction: pendingActionSchema.options[0] }),
    z.strictObject({ status: z.literal("waiting_for_selection"), message, proposals: z.array(proposalSchema).min(1), pendingAction: pendingActionSchema.options[1] }),
    z.strictObject({ status: z.literal("needs_credentials"), message, pendingAction: pendingActionSchema.options[2] }),
    z.strictObject({ status: z.literal("done"), message }),
    z.strictObject({ status: z.literal("failed"), message, error: message }),
]);
export const chatSpecSchema = z.strictObject({
    path: z.string(), title: z.string(), created: z.boolean(),
    status: z.enum(["passed", "failed", "error", "changed_after_run", "not_run"]),
    evidencePath: z.string().optional(), report: z.string().optional(), failReason: z.string().nullable().optional(),
});
export const chatReplySchema = z.strictObject({
    id: z.string(), status: z.enum(["working", "waiting_for_reply", "waiting_for_selection", "needs_credentials", "done", "failed"]),
    message: z.string().min(1).max(200_000), proposals: z.array(proposalSchema).optional(), pendingAction: pendingActionSchema.optional(),
    specs: z.array(chatSpecSchema).optional(), evidencePaths: z.array(z.string()).optional(), error: z.string().optional(),
});
export const chatReplyJsonSchema = chatReplySchema.toJSONSchema();
export type ChatReply = z.infer<typeof chatReplySchema>;
export type ChatSpec = z.infer<typeof chatSpecSchema>;
export const conversationSchema = z.strictObject({
    version: z.literal(1), id: chatIdSchema, agent: z.enum(["claude", "codex"]),
    createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), brainSessionId: z.string().optional(),
    reply: chatReplySchema, specs: z.array(chatSpecSchema),
    pendingSelection: z.array(proposalSchema).optional(),
    pendingProposalRuns: z.record(z.string(), z.string()).optional(),
    history: z.array(z.strictObject({ role: z.enum(["user", "specbook"]), message: z.string(), at: z.iso.datetime(), reply: chatReplySchema.optional() })),
    turn: z.strictObject({
        id: z.string().uuid(), request: message, startedAt: z.iso.datetime(),
        pid: z.number().int().positive().optional(), brainPid: z.number().int().positive().optional(), selected: z.array(proposalSchema).optional(),
        workerIdentity: z.string().optional(), brainIdentity: z.string().optional(),
        baseline: z.strictObject({ runs: z.number().int().nonnegative(), writes: z.number().int().nonnegative(), existing: z.array(z.string()) }).optional(),
    }).optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
