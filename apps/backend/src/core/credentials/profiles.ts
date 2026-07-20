import crypto from "node:crypto";
import type { CredentialField } from "../../infra/db/schema";
import { chatSessionsRepository } from "../../infra/repositories/chat-sessions";
import {
    credentialsRepository,
    type CredentialProfileRow,
} from "../../infra/repositories/credentials";
import { decryptSecret, encryptSecret } from "./crypto";

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const MAX_NAME_LENGTH = 40;

export interface CredentialFieldInput {
    key: string;
    secret: boolean;
    value?: string;
}

export interface PublicCredentialField {
    key: string;
    secret: boolean;
    value?: string;
    hasValue: boolean;
}

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
}

function envSegment(name: string): string {
    return name.toUpperCase().replace(/-/g, "_");
}

export function secretEnvName(profileName: string, fieldKey: string): string {
    return `SPECBOOK_SECRET_${envSegment(profileName)}_${envSegment(fieldKey)}`;
}

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
        if (!input.secret) {
            return { key: input.key, secret: false, value: input.value ?? "" };
        }
        if (input.value !== undefined && input.value !== "") {
            return { key: input.key, secret: true, value: encryptSecret(input.value) };
        }
        const kept = previous?.find((field) => field.key === input.key && field.secret);
        if (!kept) throw new Error(`Secret field "${input.key}" needs a value.`);
        return kept;
    });
}

async function assertNoEnvCollision(
    projectId: string,
    profileName: string,
    fields: CredentialField[],
    ignoreProfileId?: string,
): Promise<void> {
    const secretFields = fields.filter((field) => field.secret);
    const names = new Set(secretFields.map((field) => secretEnvName(profileName, field.key)));
    if (names.size !== secretFields.length) {
        throw new Error("Two secret fields map to the same environment name; rename one.");
    }
    for (const row of await credentialsRepository.listProfiles(projectId)) {
        if (row.id === ignoreProfileId) continue;
        if (row.name === profileName) throw new Error(`A profile named "${profileName}" already exists.`);
        for (const field of row.fields.filter((f) => f.secret)) {
            const envName = secretEnvName(row.name, field.key);
            if (names.has(envName)) {
                throw new Error(
                    `Secret env name ${envName} collides with existing profile ${row.name}.${field.key}; rename the profile or field.`,
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
        fields: row.fields.map((field) =>
            field.secret
                ? { key: field.key, secret: true, hasValue: field.value !== "" }
                : { key: field.key, secret: false, value: field.value, hasValue: field.value !== "" },
        ),
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

export async function listSecretValues(projectId: string): Promise<SecretValue[]> {
    const rows = await credentialsRepository.listProfiles(projectId);
    return rows.flatMap((row) =>
        row.fields
            .filter((field) => field.secret && field.value !== "")
            .map((field) => ({
                profile: row.name,
                field: field.key,
                envName: secretEnvName(row.name, field.key),
                value: decryptSecret(field.value),
            })),
    );
}

export async function resolveSecretEnv(
    projectId: string,
    refs: string[],
): Promise<{ env: Record<string, string>; missing: string[] }> {
    if (refs.length === 0) return { env: {}, missing: [] };
    const byEnvName = new Map((await listSecretValues(projectId)).map((secret) => [secret.envName, secret.value]));
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const ref of refs) {
        const value = byEnvName.get(ref);
        if (value === undefined) missing.push(ref);
        else env[ref] = value;
    }
    return { env, missing };
}
