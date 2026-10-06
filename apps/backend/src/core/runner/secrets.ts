import { credentialsRepository } from "../../infra/repositories/credentials";
import { secretEnvName, type SecretOriginPolicy } from "./specbook/guard";

export type { SecretOriginPolicy } from "./specbook/guard";

/**
 * Origins a secret may be typed into: the project origin plus each profile's allowed
 * origins. The "specbook" test module enforces it before fill()/type() reveal a secret.
 */
export async function resolveSecretOriginPolicy(
    projectId: string,
    baseUrl: string,
    refs: string[],
): Promise<SecretOriginPolicy> {
    const baseOrigin = new URL(baseUrl).origin;
    const wanted = new Set(refs);
    const byRef: Record<string, string[]> = {};
    for (const profile of await credentialsRepository.listProfiles(projectId)) {
        for (const field of profile.fields) {
            const envName = secretEnvName(profile.name, field.key);
            if (!wanted.has(envName)) continue;
            byRef[envName] = [...new Set([baseOrigin, ...profile.allowedOrigins])];
        }
    }
    return { defaultOrigins: [baseOrigin], byRef };
}
