import { ciRepository } from "../../infra/repositories/ci";
import { issuePrefixedToken, verifyTokenHash } from "../accounts/tokens";

export async function ciTokenInfo(projectId: string) {
    const row = await ciRepository.token(projectId);
    return { configured: Boolean(row?.tokenHash), prefix: row?.tokenPrefix ?? null, createdAt: row?.createdAt ?? null, lastUsedAt: row?.lastUsedAt ?? null };
}

export async function issueCiToken(projectId: string) {
    const { token, hash, prefix } = issuePrefixedToken("sbci_");
    await ciRepository.setToken(projectId, { tokenHash: hash, tokenPrefix: prefix, createdAt: new Date().toISOString() });
    return { token, access: await ciTokenInfo(projectId) };
}

export async function authenticateCiToken(projectId: string, authorization?: string): Promise<boolean> {
    const candidate = authorization?.match(/^Bearer (sbci_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!candidate) return false;
    const row = await ciRepository.token(projectId);
    if (!row?.tokenHash || !verifyTokenHash(row.tokenHash, candidate)) return false;
    if (!row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) >= 60_000) await ciRepository.touchToken(projectId, row.tokenHash);
    return true;
}
