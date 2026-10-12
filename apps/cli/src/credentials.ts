import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SECRET_NAME_PATTERN, secretEnvName } from "@specbook/runtime/specbook/guard";
import type { SecretRef } from "@specbook/runtime/validate";
import { httpTarget } from "@specbook/runtime/network/targets";
import { CodedError } from "@specbook/runtime/errors";
import { providerFields } from "./secret-provider";

const nameSchema = z.string().regex(SECRET_NAME_PATTERN);
const profileSchema = z.object({
    fields: z.record(nameSchema, z.string().min(1)),
    origins: z.array(z.string().refine((origin) => {
        try { return httpTarget(origin).origin === origin; } catch { return false; }
    }, "Use an HTTP(S) origin without credentials, path or fragment")).default([]),
});
const storeSchema = z.record(nameSchema, profileSchema);
type Store = z.infer<typeof storeSchema>;
const runnerSecretValues = new Set<string>();

function rememberEnvironmentSecrets(): void {
    for (const [name, value] of Object.entries(process.env)) if (name.startsWith("SPECBOOK_SECRET_") && value) runnerSecretValues.add(value);
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

export async function addProfile(name: string, fields: Record<string, string>, origins: string[] = []): Promise<unknown> {
    nameSchema.parse(name);
    if (!Object.keys(fields).length) throw new Error("Provide at least one credential field");
    const normalized = origins.map((origin) => httpTarget(origin).origin);
    const profile = profileSchema.parse({ fields, origins: [...new Set(normalized)] });
    const store = await readStore();
    store[name] = profile;
    await writeStore(store);
    return { profile: name, fields: Object.keys(fields), origins: profile.origins };
}

export async function listProfiles(): Promise<{ name: string; fields: string[]; origins: string[] }[]> {
    return Object.entries(await readStore()).map(([name, profile]) => ({ name, fields: Object.keys(profile.fields), origins: profile.origins }));
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
    for (const ref of refs) {
        const profile = store[ref.profile];
        const value = profile?.fields[ref.field];
        if (value === undefined) throw new Error(`Credential field ${ref.profile}.${ref.field} is not configured`);
        secretEnv[secretEnvName(ref.profile, ref.field)] = value;
        byRef[ref.envName] = profile.origins.length ? profile.origins : [new URL(baseUrl).origin];
    }
    return { secretEnv, secretOrigins: { defaultOrigins: [new URL(baseUrl).origin], byRef }, scrub: scrubber(store) };
}

export async function resolveRunnerSecrets(refs: SecretRef[], baseUrl: string, options: { command?: string; signal?: AbortSignal } = {}) {
    rememberEnvironmentSecrets();
    const store = await readStore();
    const provided = new Map<string, Record<string, string>>();
    if (options.command) {
        for (const profile of new Set(refs.filter((ref) => process.env[secretEnvName(ref.profile, ref.field)] === undefined).map((ref) => ref.profile))) {
            const fields = await providerFields(options.command, profile, options.signal);
            provided.set(profile, fields);
            for (const value of Object.values(fields)) runnerSecretValues.add(value);
        }
    }
    const secretEnv: Record<string, string> = {};
    const byRef: Record<string, string[]> = {};
    const baseOrigin = new URL(baseUrl).origin;
    for (const ref of refs) {
        const envName = secretEnvName(ref.profile, ref.field);
        const environment = process.env[envName];
        const provider = provided.get(ref.profile)?.[ref.field];
        const profile = store[ref.profile];
        const value = environment ?? provider ?? profile?.fields[ref.field];
        if (!value) throw new CodedError("credentials", `Credential field ${ref.profile}.${ref.field} is not configured; set ${envName}, configure --secrets-command, or run specbook credentials add ${ref.profile}`);
        runnerSecretValues.add(value);
        secretEnv[envName] = value;
        byRef[ref.envName] = environment === undefined && provider === undefined && profile?.origins.length ? profile.origins : [baseOrigin];
    }
    return { secretEnv, secretOrigins: { defaultOrigins: [baseOrigin], byRef }, scrub: scrubber(store) };
}

function textScrubber(store: Store): (text: string) => string {
    rememberEnvironmentSecrets();
    const values = [...new Set([...Object.values(store).flatMap((profile) => Object.values(profile.fields)), ...runnerSecretValues])];
    const variants = [...new Set(values.flatMap((value) => {
        const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), escaped, escaped.replace(/"/g, "&quot;").replace(/'/g, "&#39;"), escaped.replace(/"/g, "&quot;").replace(/'/g, "&#x27;")];
    }))].sort((a, b) => b.length - a.length);
    return (text) => variants.reduce((safe, value) => value ? safe.split(value).join("[REDACTED]") : safe, text);
}

function scrubber(store: Store): (text: string) => string {
    const replace = textScrubber(store);
    const visit = (value: unknown): unknown => {
        if (typeof value === "string") return replace(value);
        if (Array.isArray(value)) return value.map(visit);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
        return value;
    };
    return (text) => {
        try { return JSON.stringify(visit(JSON.parse(text))); } catch { return replace(text); }
    };
}

export async function scrub(text: string): Promise<string> {
    return scrubber(await readStore())(text);
}

export async function containsSecret(text: string): Promise<boolean> {
    return textScrubber(await readStore())(text) !== text;
}
