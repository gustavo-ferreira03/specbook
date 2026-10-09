import { z } from "zod";
import { ciRunSchema } from "../ci/schemas";

export const agentAccessSettingsSchema = z.object({
    agentContractPolicy: z.enum(["apply_declared", "propose_only"]),
    agentsMayProvideCredentials: z.boolean(),
}).strict();
export const sendMessageSchema = z.object({ message: z.string().trim().min(1).max(30000), conversationId: z.string().uuid().optional() }).strict();
export const waitForReplySchema = z.object({ conversationId: z.string().uuid() }).strict();
export const actionResponseSchema = z.union([
    z.object({ handOff: z.literal(true) }).strict(),
    z.object({ username: z.string().min(1).max(320), password: z.string().min(1).max(16000) }).strict(),
    z.object({ code: z.string().min(1).max(1000) }).strict(),
    z.object({ fields: z.record(z.string().min(1).max(200), z.string().min(1).max(16000)) }).strict(),
    z.object({ candidateIds: z.array(z.string().uuid()).min(1).max(40) }).strict(),
    z.object({ approve: z.boolean() }).strict(),
]);
export const respondToActionSchema = z.object({ conversationId: z.string().uuid(), actionId: z.string().uuid(), response: actionResponseSchema }).strict();
export const listConversationsSchema = z.object({ limit: z.number().int().min(1).max(50).default(10) }).strict();
export const runSpecsSchema = z.object({
    specIds: ciRunSchema.shape.specIds,
    feature: z.string().trim().min(1).max(200).optional(),
    environment: ciRunSchema.shape.environment,
    wait: z.boolean().optional(),
}).strict().refine((value) => !(value.feature && value.specIds), "Select a Feature or Specs, not both");
export const getRunResultsSchema = z.object({ batchId: z.string().uuid(), wait: z.boolean().optional() }).strict();
