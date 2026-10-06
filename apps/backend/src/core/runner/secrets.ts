import { projectsRepository } from "../../infra/repositories/projects";
import { credentialsRepository } from "../../infra/repositories/credentials";
import type { RunEnvironment } from "../../infra/db/schema";
import { secretEnvName, type SecretOriginPolicy } from "./specbook/guard";

export type { SecretOriginPolicy } from "./specbook/guard";

/**
 * Origins a secret may reach: Production by default, or the selected environment
 * when a profile is explicitly overridden, plus that profile's allowed origins.
 */
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
        for (const field of profile.fields) {
            const envName = secretEnvName(profile.name, field.key);
            if (!wanted.has(envName)) continue;
            if (!target.fields.some((item) => item.key === field.key)) continue;
            byRef[envName] = [...new Set([overrideId ? credentialOrigin : productionOrigin, ...target.allowedOrigins])];
        }
    }
    return { defaultOrigins: [...new Set([baseOrigin, ...(environment?.allowedOrigins ?? [])])], byRef };
}
