import crypto from "node:crypto";

export const registerCredentialRequest = function registerCredentialRequest(
  chatId: string,
  projectId: string,
  profileName: string,
  fields: CredentialRequestField[],
  kind: CredentialRequestKind = "fields",
  origin: string | null = null
): PendingCredentialRequest {
  pendingByChat.get(chatId)?.resolve("dismissed");
  let resolveOutcome!: (outcome: Outcome) => void;
  // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
  const outcome = new Promise<Outcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const request: PendingCredentialRequest = {
    id: crypto.randomUUID(),
    chatId,
    projectId,
    kind,
    origin,
    profileName,
    fields,
    createdAt: new Date().toISOString(),
  };
  pendingByChat.set(chatId, { request, resolve: resolveOutcome, outcome });
  return request;
};

export const getPendingCredentialRequest = function getPendingCredentialRequest(
  chatId: string
): PendingCredentialRequest | null {
  return pendingByChat.get(chatId)?.request ?? null;
};

export const resolveCredentialRequest = function resolveCredentialRequest(
  chatId: string,
  requestId: string,
  outcome: Outcome
): boolean {
  const entry = pendingByChat.get(chatId);
  if (!entry || entry.request.id !== requestId) {
    return false;
  }
  pendingByChat.delete(chatId);
  entry.resolve(outcome);
  return true;
};

export const waitForCredentialRequest = async function waitForCredentialRequest(
  chatId: string,
  requestId: string,
  timeoutMs: number
): Promise<Outcome | "timeout"> {
  const entry = pendingByChat.get(chatId);
  if (!entry || entry.request.id !== requestId) {
    return "dismissed";
  }
  let timer: NodeJS.Timeout | undefined;
  // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([entry.outcome, timeout]);
  clearTimeout(timer);
  if (
    result === "timeout" &&
    pendingByChat.get(chatId)?.request.id === requestId
  ) {
    pendingByChat.delete(chatId);
  }
  return result;
};

export interface CredentialRequestField {
  key: string;
  label?: string;
  sensitive?: boolean;
}

export type CredentialRequestKind = "login" | "code" | "fields";

export interface PendingCredentialRequest {
  id: string;
  chatId: string;
  projectId: string;
  kind: CredentialRequestKind;
  origin: string | null;
  profileName: string;
  fields: CredentialRequestField[];
  createdAt: string;
}

type Outcome = "saved" | "dismissed" | { code: string };

interface PendingEntry {
  request: PendingCredentialRequest;
  resolve: (outcome: Outcome) => void;
  outcome: Promise<Outcome>;
}

const pendingByChat = new Map<string, PendingEntry>();
