import { z } from "zod";
import { httpTarget } from "./network/targets.ts";

const origin = z.string().max(2000).refine((value) => {
    try { return httpTarget(value).origin === value; } catch { return false; }
}, "Use an HTTP(S) origin without credentials, path or fragment");
const id = z.string().uuid();

export const tunnelConfigSchema = z.object({
    environment: z.object({ id, projectId: id, name: z.string(), group: z.string().min(1) }).strict(),
    origins: z.array(origin).min(1).max(100),
    websocketPath: z.literal("/runner/tunnel"),
}).strict();
export type TunnelConfig = z.infer<typeof tunnelConfigSchema>;
export const tunnelReadySchema = tunnelConfigSchema.extend({ type: z.literal("ready") });
export const tunnelFrameSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("open"), id, origin }).strict(),
    z.object({ type: z.literal("opened"), id }).strict(),
    z.object({ type: z.literal("data"), id, data: z.string().max(44_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
    z.object({ type: z.literal("end"), id }).strict(),
    z.object({ type: z.literal("close"), id }).strict(),
    z.object({ type: z.literal("pause"), id }).strict(),
    z.object({ type: z.literal("resume"), id }).strict(),
    z.object({ type: z.literal("refused"), id }).strict(),
]);
export type TunnelFrame = z.infer<typeof tunnelFrameSchema>;
export const tunnelJsonSchemas = { config: z.toJSONSchema(tunnelConfigSchema), ready: z.toJSONSchema(tunnelReadySchema), frame: z.toJSONSchema(tunnelFrameSchema) };
