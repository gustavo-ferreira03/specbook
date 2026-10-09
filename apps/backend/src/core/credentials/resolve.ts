import type { RunEnvironment } from "../../infra/db/schema";
import { credentialsRepository, type CredentialProfileRow } from "../../infra/repositories/credentials";
import { getProfileByName } from "./profiles";

export interface ResolvedCredential {
    profile: CredentialProfileRow;
    appOrigins: Set<string>;
    fillOrigins: Set<string>;
}

export async function resolveCredentialProfile(
    projectId: string,
    name: string,
    productionBaseUrl: string,
    environment?: RunEnvironment,
): Promise<ResolvedCredential | string> {
    const overrideId = environment?.credentialOverrides[name];
    const profile = overrideId ? await credentialsRepository.getProfile(overrideId) : await getProfileByName(projectId, name);
    if (!profile) return `no vault item or credential profile named "${name}".`;
    if (profile.projectId !== projectId) return "the overridden profile does not belong to this project.";
    const base = new URL(overrideId ? environment!.configuredBaseUrl : productionBaseUrl).origin;
    const appOrigins = new Set([base, ...profile.allowedOrigins]);
    const exactLogin = profile.identifier !== null && profile.allowedOrigins.length > 0 && !overrideId;
    return { profile, appOrigins, fillOrigins: exactLogin ? new Set(profile.allowedOrigins) : appOrigins };
}
