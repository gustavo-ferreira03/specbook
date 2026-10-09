import { agentAccessRepository } from "../../infra/repositories/agent-access";
import { issuePrefixedToken, verifyTokenHash } from "../accounts/tokens";

export async function agentTokenInfo(projectId: string) {
    const row = await agentAccessRepository.token(projectId);
    return { configured: Boolean(row?.tokenHash), prefix: row?.tokenPrefix ?? null, createdAt: row?.createdAt ?? null, lastUsedAt: row?.lastUsedAt ?? null };
}

export async function issueAgentToken(projectId: string) {
    const { token, hash, prefix } = issuePrefixedToken("sbag_");
    await agentAccessRepository.setToken(projectId, { tokenHash: hash, tokenPrefix: prefix, createdAt: new Date().toISOString() });
    return { token, access: await agentTokenInfo(projectId) };
}

export async function authenticateAgentToken(projectId: string, authorization?: string): Promise<boolean> {
    const candidate = authorization?.match(/^Bearer (sbag_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!candidate) return false;
    const row = await agentAccessRepository.token(projectId);
    if (!row?.tokenHash || !verifyTokenHash(row.tokenHash, candidate)) return false;
    if (!row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) >= 60_000) await agentAccessRepository.touchToken(projectId, row.tokenHash);
    return true;
}
