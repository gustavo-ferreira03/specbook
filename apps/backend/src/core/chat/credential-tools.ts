import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getActiveTabUrl, renderMcpResult, type BrowserMcp } from "../browser/mcp";
import { registerCredentialRequest, waitForCredentialRequest } from "./credential-requests";
import { decryptSecret } from "../credentials/crypto";
import { getProfileByName, listPublicProfiles } from "../credentials/profiles";

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
    chatId: string;
    mcp: BrowserMcp | null;
    workDir: string | null;
    scrub: (value: string) => string;
    notify: () => void;
}

export function createCredentialTools(options: CredentialToolOptions) {
    return [
        defineTool({
            name: "list_credential_profiles",
            label: "list_credential_profiles",
            description:
                "List the project's credential profiles. Non-secret fields include their values; secret fields only report hasValue and must be entered with fill_secret (browser) or Fill Secret (specs).",
            parameters: Type.Object({}),
            async execute() {
                return text(JSON.stringify(await listPublicProfiles(options.projectId)));
            },
        }),
        defineTool({
            name: "fill_secret",
            label: "fill_secret",
            description:
                "Type a secret credential field into the page without exposing it. Provide the element description and ref from the latest browser_snapshot. Only works on the project origin or the profile's allowed origins.",
            parameters: Type.Object({
                profile: Type.String(),
                field: Type.String(),
                element: Type.String(),
                ref: Type.String(),
            }),
            async execute(_id, params) {
                if (!options.mcp || !options.workDir) {
                    return text("fill_secret failed: the agent browser is not available this turn.");
                }
                const profile = await getProfileByName(options.projectId, params.profile);
                if (!profile) return text(`fill_secret failed: no credential profile named "${params.profile}".`);
                const field = profile.fields.find((f) => f.key === params.field && f.secret);
                if (!field || field.value === "") {
                    return text(`fill_secret failed: profile "${params.profile}" has no secret field "${params.field}" with a value.`);
                }
                const activeUrl = await getActiveTabUrl(options.mcp);
                if (!activeUrl) return text("fill_secret failed: could not determine the active page URL.");
                let origin: string;
                try {
                    origin = new URL(activeUrl).origin;
                } catch {
                    return text(`fill_secret failed: active page URL "${activeUrl}" is not a valid URL.`);
                }
                const allowed = new Set([new URL(options.baseUrl).origin, ...profile.allowedOrigins]);
                if (!allowed.has(origin)) {
                    return text(
                        `fill_secret refused: the active page origin ${origin} is not allowed for this credential (allowed: ${[...allowed].join(", ")}).`,
                    );
                }
                try {
                    const result = await options.mcp.client.callTool({
                        name: "browser_type",
                        arguments: { element: params.element, ref: params.ref, text: decryptSecret(field.value) },
                    });
                    const rendered = await renderMcpResult(result as { content?: unknown }, options.workDir);
                    return text(options.scrub(rendered) || `Filled ${params.profile}.${params.field} into ${params.element}.`);
                } catch (error) {
                    return text(options.scrub(`fill_secret failed: ${error instanceof Error ? error.message : String(error)}`));
                }
            },
        }),
        defineTool({
            name: "request_credential",
            label: "request_credential",
            description:
                'Ask the user for a credential through a secure form outside the chat. Never ask the user to paste secrets into the conversation. Blocks until the user submits (or 10 minutes). Field keys and the profile name must be lowercase slugs like "admin" / "password".',
            parameters: Type.Object({
                profileName: Type.String(),
                fields: Type.Array(
                    Type.Object({
                        key: Type.String(),
                        secret: Type.Boolean(),
                        label: Type.Optional(Type.String()),
                    }),
                ),
            }),
            async execute(_id, params) {
                if (params.fields.length === 0) return text("request_credential failed: request at least one field.");
                const request = registerCredentialRequest(
                    options.chatId,
                    options.projectId,
                    params.profileName,
                    params.fields,
                );
                options.notify();
                const outcome = await waitForCredentialRequest(options.chatId, request.id, 10 * 60 * 1000);
                options.notify();
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
