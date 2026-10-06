import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { getActiveTabUrl, renderMcpResult, type BrowserMcp } from "../browser/mcp";
import { registerCredentialRequest, resolveCredentialRequest, waitForCredentialRequest } from "./credential-requests";
import { decryptSecret } from "../credentials/crypto";
import { getProfileByName, listPublicProfiles } from "../credentials/profiles";
import { credentialsRepository } from "../../infra/repositories/credentials";
import type { RunEnvironment } from "../../infra/db/schema";

const fillSecretSchema = z.object({
    profile: z.string(),
    field: z.string(),
    element: z.string(),
    target: z.string(),
});

const requestCredentialSchema = z.object({
    profileName: z.string(),
    fields: z.array(z.object({ key: z.string(), label: z.string().optional() })),
});

function text(value: string) {
    return {
        content: [{ type: "text" as const, text: value }],
        details: undefined,
        terminate: false,
    };
}

export interface CredentialToolOptions {
    projectId: string;
    baseUrl: string;
    environment?: RunEnvironment;
    chatId: string;
    mcp: BrowserMcp | null;
    workDir: string | null;
    scrub: (value: string) => Promise<string>;
    notify: () => void;
}

export function createCredentialTools(options: CredentialToolOptions) {
    return [
        defineTool({
            name: "list_credential_profiles",
            label: "list_credential_profiles",
            description:
                "List the project's credential profiles and which fields have a value (hasValue). Values are never included. Enter every field with fill_secret (browser) or secret('<profile>', '<field>') in spec.ts.",
            parameters: Type.Unsafe(z.object({}).toJSONSchema()),
            async execute() {
                const profiles = await listPublicProfiles(options.projectId);
                const targets = new Map(profiles.map((profile) => [profile.id, { ...profile }]));
                for (const profile of profiles) {
                    const overrideId = options.environment?.credentialOverrides[profile.name];
                    if (!overrideId) continue;
                    const target = targets.get(overrideId);
                    profile.fields = profile.fields.map((field) => ({ ...field, hasValue: target?.fields.some((item) => item.key === field.key && item.hasValue) ?? false }));
                    profile.allowedOrigins = target ? [...new Set([new URL(options.environment!.configuredBaseUrl).origin, ...target.allowedOrigins])] : [];
                }
                return text(JSON.stringify(profiles));
            },
        }),
        defineTool({
            name: "fill_secret",
            label: "fill_secret",
            description:
                "Type a stored credential field into the page. Use it for EVERY credential field, email/username included, instead of browser_type. Pass element and target from the latest browser_snapshot, as for browser_type. Only works on the project origin or the profile's allowed origins.",
            parameters: Type.Unsafe<z.infer<typeof fillSecretSchema>>(fillSecretSchema.toJSONSchema()),
            async execute(_id, params, signal) {
                signal?.throwIfAborted();
                params = fillSecretSchema.parse(params);
                if (!options.mcp || !options.workDir) {
                    return text("fill_secret failed: the agent browser is not available this turn.");
                }
                const overrideId = options.environment?.credentialOverrides[params.profile];
                const profile = overrideId ? await credentialsRepository.getProfile(overrideId) : await getProfileByName(options.projectId, params.profile);
                if (!profile) return text(`fill_secret failed: no credential profile named "${params.profile}".`);
                if (profile.projectId !== options.projectId) return text("fill_secret failed: the overridden profile does not belong to this project.");
                const field = profile.fields.find((f) => f.key === params.field);
                if (!field || field.value === "") {
                    return text(`fill_secret failed: profile "${params.profile}" has no field "${params.field}" with a value.`);
                }
                const activeUrl = await getActiveTabUrl(options.mcp, signal);
                if (!activeUrl) return text("fill_secret failed: could not determine the active page URL.");
                let origin: string;
                try {
                    origin = new URL(activeUrl).origin;
                } catch {
                    return text(`fill_secret failed: active page URL "${activeUrl}" is not a valid URL.`);
                }
                const allowed = new Set([new URL(overrideId ? options.environment!.configuredBaseUrl : options.baseUrl).origin, ...profile.allowedOrigins]);
                if (!allowed.has(origin)) {
                    return text(
                        `fill_secret refused: the active page origin ${origin} is not allowed for this credential (allowed: ${[...allowed].join(", ")}).`,
                    );
                }
                try {
                    signal?.throwIfAborted();
                    const value = decryptSecret(field.value);
                    const result = await options.mcp.client.callTool({
                        name: "browser_type",
                        arguments: { element: params.element, target: params.target, text: value },
                    }, undefined, { signal });
                    const rendered = await renderMcpResult(result as { content?: unknown }, options.workDir);
                    const cleaned = await options.scrub(rendered);
                    return text(cleaned || `Filled ${params.profile}.${params.field} into ${params.element}.`);
                } catch (error) {
                    signal?.throwIfAborted();
                    return text(await options.scrub(`fill_secret failed: ${error instanceof Error ? error.message : String(error)}`));
                }
            },
        }),
        defineTool({
            name: "request_credential",
            label: "request_credential",
            description:
                'Ask the user for a credential through a secure form outside the chat; never ask them to paste it into the conversation. Every field is stored encrypted and never shown to you, only usable via fill_secret / Fill Secret. Blocks until the user submits (or 10 minutes). Profile name and field keys are lowercase slugs like "admin" / "password".',
            parameters: Type.Unsafe<z.infer<typeof requestCredentialSchema>>(requestCredentialSchema.toJSONSchema()),
            async execute(_id, params, signal) {
                signal?.throwIfAborted();
                params = requestCredentialSchema.parse(params);
                if (params.fields.length === 0) return text("request_credential failed: request at least one field.");
                const request = registerCredentialRequest(
                    options.chatId,
                    options.projectId,
                    params.profileName,
                    params.fields,
                );
                const onAbort = () => resolveCredentialRequest(options.chatId, request.id, "dismissed");
                signal?.addEventListener("abort", onAbort, { once: true });
                options.notify();
                const outcome = await waitForCredentialRequest(options.chatId, request.id, 10 * 60 * 1000)
                    .finally(() => signal?.removeEventListener("abort", onAbort));
                options.notify();
                signal?.throwIfAborted();
                if (outcome === "saved") {
                    return text(
                        `Credential profile "${params.profileName}" saved with fields: ${params.fields.map((f) => f.key).join(", ")}. Use list_credential_profiles / fill_secret to use it.`,
                    );
                }
                if (outcome === "dismissed") return text("The user dismissed the credential form without saving.");
                return text(
                    "The user has not submitted the credential form yet. Ask them to fill it, or call request_credential again when they are ready.",
                );
            },
        }),
    ];
}
