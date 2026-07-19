import crypto from "node:crypto";

export interface CredentialRequestField {
    key: string;
    secret: boolean;
    label?: string;
}

export interface PendingCredentialRequest {
    id: string;
    chatId: string;
    projectId: string;
    profileName: string;
    fields: CredentialRequestField[];
    createdAt: string;
}

type Outcome = "saved" | "dismissed";

interface PendingEntry {
    request: PendingCredentialRequest;
    resolve: (outcome: Outcome) => void;
    outcome: Promise<Outcome>;
}

const pendingByChat = new Map<string, PendingEntry>();

export function registerCredentialRequest(
    chatId: string,
    projectId: string,
    profileName: string,
    fields: CredentialRequestField[],
): PendingCredentialRequest {
    pendingByChat.get(chatId)?.resolve("dismissed");
    let resolve!: (outcome: Outcome) => void;
    const outcome = new Promise<Outcome>((res) => (resolve = res));
    const request: PendingCredentialRequest = {
        id: crypto.randomUUID(),
        chatId,
        projectId,
        profileName,
        fields,
        createdAt: new Date().toISOString(),
    };
    pendingByChat.set(chatId, { request, resolve, outcome });
    return request;
}

export function getPendingCredentialRequest(chatId: string): PendingCredentialRequest | null {
    return pendingByChat.get(chatId)?.request ?? null;
}

export function resolveCredentialRequest(chatId: string, requestId: string, outcome: Outcome): boolean {
    const entry = pendingByChat.get(chatId);
    if (!entry || entry.request.id !== requestId) return false;
    pendingByChat.delete(chatId);
    entry.resolve(outcome);
    return true;
}

export async function waitForCredentialRequest(
    chatId: string,
    requestId: string,
    timeoutMs: number,
): Promise<Outcome | "timeout"> {
    const entry = pendingByChat.get(chatId);
    if (!entry || entry.request.id !== requestId) return "dismissed";
    let timer: NodeJS.Timeout;
    const timeout = new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), timeoutMs);
        timer.unref();
    });
    const result = await Promise.race([entry.outcome, timeout]);
    clearTimeout(timer!);
    if (result === "timeout" && pendingByChat.get(chatId)?.request.id === requestId) {
        pendingByChat.delete(chatId);
    }
    return result;
}
