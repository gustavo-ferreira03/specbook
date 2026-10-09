import { projectsRepository } from "../../infra/repositories/projects";
import { credentialsRepository } from "../../infra/repositories/credentials";
import type { RunEnvironment } from "../../infra/db/schema";
import { IDENTIFIER_FIELD } from "../credentials/profiles";
import { secretEnvName, type SecretOriginPolicy } from "./specbook/guard";

export type { SecretOriginPolicy } from "./specbook/guard";

export async function resolveSecretOriginPolicy(
    projectId: string,
    refs: string[],
    environment?: RunEnvironment,
): Promise<SecretOriginPolicy> {
    const project = await projectsRepository.getProject(projectId);
    if (!project) throw new Error("Project not found");
    const productionOrigin = new URL(project.baseUrl).origin;
    const baseOrigin = new URL(environment?.baseUrl ?? project.baseUrl).origin;
    const credentialOrigin = new URL(environment?.configuredBaseUrl ?? project.baseUrl).origin;
    const wanted = new Set(refs);
    const byRef: Record<string, string[]> = {};
    const profiles = await credentialsRepository.listProfiles(projectId);
    for (const profile of profiles) {
        const overrideId = environment?.credentialOverrides[profile.name];
        const target = overrideId ? profiles.find((item) => item.id === overrideId) : profile;
        if (!target) throw new Error(`The credential override for "${profile.name}" no longer exists.`);
        const origins = [...new Set([overrideId ? credentialOrigin : productionOrigin, ...target.allowedOrigins])];
        for (const field of profile.fields) {
            const envName = secretEnvName(profile.name, field.key);
            if (!wanted.has(envName)) continue;
            if (!target.fields.some((item) => item.key === field.key)) continue;
            byRef[envName] = origins;
        }
        const identifierEnv = secretEnvName(profile.name, IDENTIFIER_FIELD);
        if (profile.identifier && target.identifier && wanted.has(identifierEnv)) byRef[identifierEnv] = origins;
    }
    return { defaultOrigins: [...new Set([baseOrigin, ...(environment?.allowedOrigins ?? [])])], byRef };
}
