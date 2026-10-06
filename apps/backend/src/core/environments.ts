import { z } from "zod";
import type { RunEnvironment } from "../infra/db/schema";
import { credentialsRepository } from "../infra/repositories/credentials";
import { environmentsRepository } from "../infra/repositories/environments";
import { httpUrlSchema } from "./ci/schemas";
import { NetworkTargetError } from "./network/targets";

export const environmentSchema = z.object({
    name: z.string().trim().min(1).max(80),
    baseUrl: httpUrlSchema,
    allowedOrigins: z.array(httpUrlSchema.refine((value) => {
        const url = new URL(value);
        return url.pathname === "/" && !url.search && !url.hostname.includes("*");
    }, "Enter an origin without a path or query").transform((value) => new URL(value).origin)).max(50).default([]),
    credentialOverrides: z.record(z.string(), z.string().uuid()).default({}),
}).strict();

export async function validateEnvironmentCredentials(projectId: string, overrides: Record<string, string>): Promise<void> {
    const profiles = await credentialsRepository.listProfiles(projectId);
    for (const [source, target] of Object.entries(overrides)) {
        if (!profiles.some((profile) => profile.name === source) || !profiles.some((profile) => profile.id === target)) {
            throw new Error("Choose credential profiles saved in this project");
        }
    }
}

export async function resolveRunEnvironment(projectId: string, name = "Production", baseUrl?: string): Promise<RunEnvironment> {
    const row = (await environmentsRepository.list(projectId)).find((environment) => environment.name.toLowerCase() === name.toLowerCase());
    if (!row) throw new NetworkTargetError(`Environment "${name}" was not found in this project`);
    const origins = [new URL(row.baseUrl).origin, ...row.allowedOrigins];
    if (baseUrl && !origins.includes(new URL(baseUrl).origin)) throw new NetworkTargetError(`Add this origin to ${row.name} in Settings → Environments before using it for a preview run`);
    return { configuredBaseUrl: row.baseUrl, id: row.id, name: row.name, baseUrl: baseUrl ?? row.baseUrl, allowedOrigins: [...new Set(origins)], credentialOverrides: row.credentialOverrides };
}
