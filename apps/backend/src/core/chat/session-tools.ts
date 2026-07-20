import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { BrowserMcp } from "../browser/mcp";
import { decryptSecret, encryptSecret } from "../credentials/crypto";
import { getProfileByName } from "../credentials/profiles";
import { chatSessionsRepository } from "../../infra/repositories/chat-sessions";

function text(value: string) {
    return {
        content: [{ type: "text" as const, text: value }],
        details: undefined,
        terminate: false,
    };
}

export interface SessionToolOptions {
    projectId: string;
    baseUrl: string;
    mcp: BrowserMcp | null;
    workDir: string | null;
}

export function createSessionTools(options: SessionToolOptions) {
    return [
        defineTool({
            name: "save_session",
            label: "save_session",
            description:
                "Save the current browser session (cookies and local storage) under a credential profile name, so a future chat can restore it with resume_session instead of logging in again. Call this right after confirming a login succeeded.",
            parameters: Type.Object({ profile: Type.String() }),
            async execute(_id, params) {
                if (!options.mcp || !options.workDir) {
                    return text("save_session failed: the agent browser is not available this turn.");
                }
                const profile = await getProfileByName(options.projectId, params.profile);
                if (!profile) return text(`save_session failed: no credential profile named "${params.profile}".`);
                const filename = `session-save-${crypto.randomUUID()}.json`;
                const filePath = path.join(options.workDir, filename);
                try {
                    await options.mcp.client.callTool({
                        name: "browser_storage_state",
                        arguments: { filename },
                    });
                    const raw = await fs.readFile(filePath, "utf8");
                    await chatSessionsRepository.upsert({
                        id: crypto.randomUUID(),
                        projectId: options.projectId,
                        profileId: profile.id,
                        state: encryptSecret(raw),
                        savedAt: new Date().toISOString(),
                    });
                    return text(`Session saved for profile "${params.profile}".`);
                } catch (error) {
                    return text(`save_session failed: ${error instanceof Error ? error.message : String(error)}`);
                } finally {
                    await fs.rm(filePath, { force: true });
                }
            },
        }),
        defineTool({
            name: "resume_session",
            label: "resume_session",
            description:
                "Restore a previously saved browser session for a credential profile and navigate to the application. Try this before request_credential when a saved session might already exist. The saved session can be stale (expired cookies) — verify you're actually logged in afterward, and fall back to logging in normally if not.",
            parameters: Type.Object({ profile: Type.String() }),
            async execute(_id, params) {
                if (!options.mcp || !options.workDir) {
                    return text("resume_session failed: the agent browser is not available this turn.");
                }
                const profile = await getProfileByName(options.projectId, params.profile);
                if (!profile) return text(`resume_session failed: no credential profile named "${params.profile}".`);
                const saved = await chatSessionsRepository.getByProfile(options.projectId, profile.id);
                if (!saved) {
                    return text(`resume_session failed: no saved session for "${params.profile}". Log in and call save_session first.`);
                }
                const filename = `session-restore-${crypto.randomUUID()}.json`;
                const filePath = path.join(options.workDir, filename);
                try {
                    await fs.writeFile(filePath, decryptSecret(saved.state), "utf8");
                    await options.mcp.client.callTool({
                        name: "browser_set_storage_state",
                        arguments: { filename },
                    });
                    await options.mcp.client.callTool({
                        name: "browser_navigate",
                        arguments: { url: options.baseUrl },
                    });
                    return text(`Session restored for profile "${params.profile}"; navigated to ${options.baseUrl}.`);
                } catch (error) {
                    return text(`resume_session failed: ${error instanceof Error ? error.message : String(error)}`);
                } finally {
                    await fs.rm(filePath, { force: true });
                }
            },
        }),
    ];
}
