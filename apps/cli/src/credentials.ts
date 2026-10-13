import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SECRET_NAME_PATTERN, secretEnvName } from "@specbook/runtime/specbook/guard";
import type { SecretRef } from "@specbook/runtime/validate";
import { httpTarget } from "@specbook/runtime/network/targets";
import { CodedError } from "@specbook/runtime/errors";
import { providerProfile, type ProviderProfile } from "./secret-provider";
import { defaultSensitive, isSensitiveByDefault } from "@specbook/runtime/credential-fields";
import { scrubJsonText } from "@specbook/runtime/scrub";

export { defaultSensitive } from "@specbook/runtime/credential-fields";

const nameSchema = z.string().regex(SECRET_NAME_PATTERN);
const profileSchema = z.object({
    fields: z.record(nameSchema, z.string().min(1)),
    origins: z.array(z.string().refine((origin) => {
        try { return httpTarget(origin).origin === origin; } catch { return false; }
    }, "Use an HTTP(S) origin without credentials, path or fragment")).default([]),
    sensitive: z.array(nameSchema).optional(),
});
const storeSchema = z.record(nameSchema, profileSchema);
type Store = z.infer<typeof storeSchema>;
type Profile = z.infer<typeof profileSchema>;
const runnerSecretValues = new Set<string>();

function sensitiveFields(profile: Profile): string[] {
    return profile.sensitive ?? defaultSensitive(Object.keys(profile.fields));
}

function rememberEnvironmentSecrets(store: Store): void {
    const marked = new Map(Object.entries(store).flatMap(([name, profile]) => Object.keys(profile.fields)
        .map((field) => [secretEnvName(name, field), sensitiveFields(profile).includes(field)] as const)));
    for (const [name, value] of Object.entries(process.env)) {
        if (!name.startsWith("SPECBOOK_SECRET_") || name.endsWith("_ORIGINS") || !value) continue;
        const sensitive = marked.get(name) ?? isSensitiveByDefault(name.slice(name.lastIndexOf("_") + 1));
        if (sensitive) runnerSecretValues.add(value);
    }
}

function environmentProfileOrigins(profile: string): string[] {
    const value = process.env[secretEnvName(profile, "ORIGINS")];
    if (!value) return [];
    const origins = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
    for (const origin of origins) {
        try { if (httpTarget(origin).origin !== origin) throw new Error(); }
        catch { throw new CodedError("credentials", `Credential profile ${profile} origins must be HTTP(S) origins without credentials, paths or fragments`); }
    }
    return origins;
}

export function configHome(): string {
    return path.resolve(process.env.SPECBOOK_HOME ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "specbook"));
}

async function readStore(): Promise<Store> {
    const file = path.join(configHome(), "credentials.json");
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Credentials must be a regular file");
        if (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) throw new Error("Credentials file must belong to this user with 0600 permissions");
        let parsed: unknown;
        try { parsed = JSON.parse(await fs.readFile(file, "utf8")); } catch { throw new Error("Credentials file contains invalid JSON"); }
        const validated = storeSchema.safeParse(parsed);
        if (!validated.success) throw new Error("Credentials file has an invalid profile structure");
        return validated.data;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
    }
}

async function writeStore(store: Store): Promise<void> {
    const directory = configHome();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SPECBOOK_HOME must be a directory, without a symlink");
    const temporary = path.join(directory, `credentials-${process.pid}-${Date.now()}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, path.join(directory, "credentials.json"));
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

export async function addProfile(name: string, fields: Record<string, string>, origins: string[] = [], sensitive?: string[]): Promise<unknown> {
    nameSchema.parse(name);
    if (!Object.keys(fields).length) throw new Error("Provide at least one credential field");
    const unknown = sensitive?.find((field) => !Object.hasOwn(fields, field));
    if (unknown) throw new Error(`Sensitive field ${unknown} is not one of the profile's fields`);
    const normalized = origins.map((origin) => httpTarget(origin).origin);
    const profile = profileSchema.parse({ fields, origins: [...new Set(normalized)], sensitive: sensitive ?? defaultSensitive(Object.keys(fields)) });
    const store = await readStore();
    store[name] = profile;
    await writeStore(store);
    return { profile: name, fields: Object.keys(fields), sensitive: profile.sensitive, origins: profile.origins };
}

export async function listProfiles(): Promise<{ name: string; fields: string[]; sensitive: string[]; origins: string[] }[]> {
    return Object.entries(await readStore()).map(([name, profile]) => ({ name, fields: Object.keys(profile.fields), sensitive: sensitiveFields(profile), origins: profile.origins }));
}

export async function removeProfile(name: string): Promise<unknown> {
    nameSchema.parse(name);
    const store = await readStore();
    const removed = Object.hasOwn(store, name);
    delete store[name];
    await writeStore(store);
    return { profile: name, removed };
}

export async function resolveSecret(reference: string): Promise<string> {
    const [profile, field, extra] = reference.split(".");
    if (extra || !field) throw new Error("Use a credential reference in profile.field form");
    nameSchema.parse(profile);
    nameSchema.parse(field);
    const value = (await readStore())[profile]?.fields[field];
    if (value === undefined) throw new Error(`Credential field ${profile}.${field} is not configured`);
    return value;
}

export async function secretOrigins(reference: string, baseUrl: string): Promise<string[]> {
    const [profile] = reference.split(".");
    const stored = (await readStore())[profile];
    if (!stored) throw new Error(`Credential profile ${profile} is not configured`);
    return stored.origins.length ? stored.origins : [new URL(baseUrl).origin];
}

export async function resolveRunSecrets(refs: SecretRef[], baseUrl: string) {
    const store = await readStore();
    const secretEnv: Record<string, string> = {};
    const byRef: Record<string, string[]> = {};
    const publicRefs: string[] = [];
    for (const ref of refs) {
        const profile = store[ref.profile];
        const value = profile?.fields[ref.field];
        if (value === undefined) throw new Error(`Credential field ${ref.profile}.${ref.field} is not configured`);
        secretEnv[secretEnvName(ref.profile, ref.field)] = value;
        byRef[ref.envName] = profile.origins.length ? profile.origins : [new URL(baseUrl).origin];
        if (!sensitiveFields(profile).includes(ref.field)) publicRefs.push(ref.envName);
    }
    return { secretEnv, secretOrigins: { defaultOrigins: [new URL(baseUrl).origin], byRef, publicRefs }, scrub: scrubber(store) };
}

export async function resolveRunnerSecrets(refs: SecretRef[], baseUrl: string, options: { command?: string; signal?: AbortSignal; allowedOrigins?: string[]; jobOrigins?: string[] } = {}) {
    const store = await readStore();
    rememberEnvironmentSecrets(store);
    const jobOrigins = options.jobOrigins ?? [httpTarget(baseUrl).origin];
    const sourceOrigins = (options.allowedOrigins ?? []).filter((origin) => jobOrigins.includes(origin));
    if (refs.length && !sourceOrigins.length) throw new CodedError("credentials", "Runner secret sources require locally configured --allow-origin values matching the job");
    const provided = new Map<string, ProviderProfile>();
    if (options.command) {
        for (const profile of new Set(refs.filter((ref) => !process.env[secretEnvName(ref.profile, ref.field)]).map((ref) => ref.profile))) {
            const supplied = await providerProfile(options.command, profile, options.signal);
            provided.set(profile, supplied);
        }
    }
    const secretEnv: Record<string, string> = {};
    const byRef: Record<string, string[]> = {};
    const publicRefs: string[] = [];
    for (const ref of refs) {
        const envName = secretEnvName(ref.profile, ref.field);
        const environment = process.env[envName] || undefined;
        const supplied = provided.get(ref.profile);
        const provider = supplied && Object.hasOwn(supplied.fields, ref.field) ? supplied.fields[ref.field] : undefined;
        const profile = Object.hasOwn(store, ref.profile) ? store[ref.profile] : undefined;
        const local = profile && Object.hasOwn(profile.fields, ref.field) ? profile.fields[ref.field] : undefined;
        const value = environment ?? provider ?? local;
        if (!value) throw new CodedError("credentials", `Credential field ${ref.profile}.${ref.field} is not configured; set ${envName}, configure --secrets-command, or run specbook credentials add ${ref.profile}`);
        const declaredOrigins = environment !== undefined ? environmentProfileOrigins(ref.profile)
            : provider !== undefined ? supplied!.origins.length ? supplied!.origins : environmentProfileOrigins(ref.profile)
            : profile?.origins ?? [];
        const origins = declaredOrigins.filter((origin) => sourceOrigins.includes(origin));
        if (!origins.length) throw new CodedError("credentials", `Credential profile ${ref.profile} needs explicit origins matching this job; set ${secretEnvName(ref.profile, "ORIGINS")}, return provider origins, or configure credentials add ${ref.profile} --origin <allowed-origin>`);
        const sensitive = provider !== undefined && supplied?.sensitive
            ? supplied.sensitive.includes(ref.field)
            : profile && Object.hasOwn(profile.fields, ref.field)
                ? sensitiveFields(profile).includes(ref.field) : isSensitiveByDefault(ref.field);
        if (sensitive) runnerSecretValues.add(value);
        else publicRefs.push(ref.envName);
        secretEnv[envName] = value;
        byRef[ref.envName] = origins;
    }
    return { secretEnv, secretOrigins: { defaultOrigins: sourceOrigins, byRef, publicRefs }, scrub: scrubber(store) };
}

function textScrubber(store: Store): (text: string) => string {
    rememberEnvironmentSecrets(store);
    const fields = Object.values(store).flatMap((profile) => sensitiveFields(profile).flatMap((field) => Object.hasOwn(profile.fields, field) ? [profile.fields[field]] : []));
    const values = [...new Set([...fields, ...runnerSecretValues])];
    const variants = [...new Set(values.flatMap((value) => {
        const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), escaped, escaped.replace(/"/g, "&quot;").replace(/'/g, "&#39;"), escaped.replace(/"/g, "&quot;").replace(/'/g, "&#x27;")];
    }))].sort((a, b) => b.length - a.length);
    return (text) => variants.reduce((safe, value) => value ? safe.split(value).join("[REDACTED]") : safe, text);
}

function scrubber(store: Store): (text: string) => string {
    const replace = textScrubber(store);
    return (text) => scrubJsonText(text, replace);
}

export async function scrub(text: string): Promise<string> {
    return scrubber(await readStore())(text);
}

export async function containsSecret(text: string): Promise<boolean> {
    return textScrubber(await readStore())(text) !== text;
}
