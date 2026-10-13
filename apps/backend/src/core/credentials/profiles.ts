import crypto from "node:crypto";
import type { CredentialField } from "../../infra/db/schema";
import { chatSessionsRepository } from "../../infra/repositories/chat-sessions";
import {
    credentialsRepository,
    type CredentialProfileRow,
} from "../../infra/repositories/credentials";
import { secretEnvName, SECRET_NAME_PATTERN } from "@specbook/runtime/specbook/guard";
import { isSensitiveByDefault } from "@specbook/runtime/credential-fields";
import { decryptSecret, encryptSecret } from "./crypto";

const NAME_PATTERN = SECRET_NAME_PATTERN;
const MAX_NAME_LENGTH = 40;

export interface CredentialFieldInput {
    key: string;
    value?: string;
    sensitive?: boolean;
    previousKey?: string;
}

export type PublicCredentialField =
    | { key: string; sensitive: true; hasValue: boolean }
    | { key: string; sensitive: false; value: string };

export interface PublicCredentialProfile {
    id: string;
    name: string;
    allowedOrigins: string[];
    fields: PublicCredentialField[];
    createdAt: string;
}

export interface SecretValue {
    profile: string;
    field: string;
    envName: string;
    value: string;
    sensitive: boolean;
}

export { secretEnvName };

function assertValidName(kind: string, value: string): void {
    if (!NAME_PATTERN.test(value) || value.length > MAX_NAME_LENGTH) {
        throw new Error(
            `Invalid ${kind} "${value}": use lowercase letters, digits, "-" or "_", starting with a letter (max ${MAX_NAME_LENGTH} chars).`,
        );
    }
}

function assertValidOrigins(origins: string[]): void {
    for (const origin of origins) {
        let parsed: URL;
        try {
            parsed = new URL(origin);
        } catch {
            throw new Error(`Invalid allowed origin "${origin}": not a URL.`);
        }
        if (parsed.origin !== origin) {
            throw new Error(`Invalid allowed origin "${origin}": use an origin only, like ${parsed.origin}.`);
        }
    }
}

function buildFields(inputs: CredentialFieldInput[], previous?: CredentialField[]): CredentialField[] {
    if (inputs.length === 0) throw new Error("A credential profile needs at least one field.");
    const seen = new Set<string>();
    return inputs.map((input) => {
        assertValidName("field key", input.key);
        if (seen.has(input.key)) throw new Error(`Duplicate field key "${input.key}".`);
        seen.add(input.key);
        const kept = previous?.find((field) => field.key === (input.previousKey ?? input.key));
        const sensitive = input.sensitive ?? (kept ? kept.sensitive !== false : isSensitiveByDefault(input.key));
        if (input.value !== undefined && (input.value !== "" || !sensitive)) {
            return { key: input.key, value: encryptSecret(input.value), sensitive };
        }
        if (!kept) throw new Error(`Field "${input.key}" needs a value.`);
        return { key: input.key, value: kept.value, sensitive };
    });
}

async function assertNoEnvCollision(
    projectId: string,
    profileName: string,
    fields: CredentialField[],
    ignoreProfileId?: string,
): Promise<void> {
    const keys = fields.map((field) => field.key);
    const names = new Set(keys.map((key) => secretEnvName(profileName, key)));
    if (names.size !== keys.length) {
        throw new Error("Two fields map to the same environment name; rename one.");
    }
    for (const row of await credentialsRepository.listProfiles(projectId)) {
        if (row.id === ignoreProfileId) continue;
        if (row.name === profileName) throw new Error(`A profile named "${profileName}" already exists.`);
        for (const { key } of row.fields) {
            const envName = secretEnvName(row.name, key);
            if (names.has(envName)) {
                throw new Error(
                    `Secret env name ${envName} collides with existing profile ${row.name}.${key}; rename the profile or field.`,
                );
            }
        }
    }
}

export function publicProfile(row: CredentialProfileRow): PublicCredentialProfile {
    return {
        id: row.id,
        name: row.name,
        allowedOrigins: row.allowedOrigins,
        createdAt: row.createdAt,
        fields: row.fields.map((field) => field.sensitive !== false
            ? { key: field.key, sensitive: true, hasValue: field.value !== "" }
            : { key: field.key, sensitive: false, value: decryptSecret(field.value) }),
    };
}

export async function createProfile(
    projectId: string,
    input: { name: string; allowedOrigins?: string[]; fields: CredentialFieldInput[] },
): Promise<PublicCredentialProfile> {
    assertValidName("profile name", input.name);
    const allowedOrigins = input.allowedOrigins ?? [];
    assertValidOrigins(allowedOrigins);
    const fields = buildFields(input.fields);
    await assertNoEnvCollision(projectId, input.name, fields);
    const now = new Date().toISOString();
    const row: CredentialProfileRow = {
        id: crypto.randomUUID(),
        projectId,
        name: input.name,
        allowedOrigins,
        fields,
        createdAt: now,
        updatedAt: now,
    };
    await credentialsRepository.insertProfile(row);
    return publicProfile(row);
}

export async function updateProfile(
    row: CredentialProfileRow,
    input: { allowedOrigins?: string[]; fields: CredentialFieldInput[] },
): Promise<PublicCredentialProfile> {
    const allowedOrigins = input.allowedOrigins ?? row.allowedOrigins;
    assertValidOrigins(allowedOrigins);
    const fields = buildFields(input.fields, row.fields);
    await assertNoEnvCollision(row.projectId, row.name, fields, row.id);
    const patch = { allowedOrigins, fields, updatedAt: new Date().toISOString() };
    await credentialsRepository.updateProfile(row.id, patch);
    return publicProfile({ ...row, ...patch });
}

export async function deleteProfile(row: CredentialProfileRow): Promise<void> {
    await chatSessionsRepository.deleteByProfileId(row.id);
    await credentialsRepository.deleteProfile(row.id);
}

export async function listPublicProfiles(projectId: string): Promise<PublicCredentialProfile[]> {
    return (await credentialsRepository.listProfiles(projectId)).map(publicProfile);
}

export async function getProfileByName(
    projectId: string,
    name: string,
): Promise<CredentialProfileRow | null> {
    return (await credentialsRepository.listProfiles(projectId)).find((row) => row.name === name) ?? null;
}

export async function listCredentialValues(projectId: string): Promise<SecretValue[]> {
    const rows = await credentialsRepository.listProfiles(projectId);
    return rows.flatMap((row) => row.fields
            .filter((field) => field.value !== "")
            .map((field) => ({
                profile: row.name,
                field: field.key,
                envName: secretEnvName(row.name, field.key),
                value: decryptSecret(field.value),
                sensitive: field.sensitive !== false,
            })));
}

export async function listSecretValues(projectId: string): Promise<SecretValue[]> {
    return (await listCredentialValues(projectId)).filter((field) => field.sensitive);
}

export async function resolveSecretEnv(
    projectId: string,
    refs: string[],
    overrides: Record<string, string> = {},
): Promise<{ env: Record<string, string>; missing: string[]; publicRefs: string[] }> {
    if (refs.length === 0) return { env: {}, missing: [], publicRefs: [] };
    const byEnvName = new Map((await listCredentialValues(projectId)).map((field) => [field.envName, { value: field.value, sensitive: field.sensitive }]));
    const profiles = await credentialsRepository.listProfiles(projectId);
    for (const [sourceName, targetId] of Object.entries(overrides)) {
        const source = profiles.find((profile) => profile.name === sourceName);
        const target = profiles.find((profile) => profile.id === targetId);
        for (const field of source?.fields ?? []) {
            const envName = secretEnvName(sourceName, field.key);
            byEnvName.delete(envName);
            const targetField = target?.fields.find((item) => item.key === field.key);
            if (targetField?.value) byEnvName.set(envName, { value: decryptSecret(targetField.value), sensitive: targetField.sensitive !== false });
        }
    }
    const env: Record<string, string> = {};
    const missing: string[] = [];
    const publicRefs: string[] = [];
    for (const ref of refs) {
        const field = byEnvName.get(ref);
        if (!field) missing.push(ref);
        else {
            env[ref] = field.value;
            if (!field.sensitive) publicRefs.push(ref);
        }
    }
    return { env, missing, publicRefs };
}
