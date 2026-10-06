import crypto from "node:crypto";
import { ciRepository } from "../../infra/repositories/ci";

const TOKEN_PREFIX = "sbci_";
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function ciTokenInfo(projectId: string) {
    const row = await ciRepository.token(projectId);
    return { configured: Boolean(row?.tokenHash), prefix: row?.tokenPrefix ?? null, createdAt: row?.createdAt ?? null, lastUsedAt: row?.lastUsedAt ?? null };
}

export async function issueCiToken(projectId: string) {
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    await ciRepository.setToken(projectId, { tokenHash: hashToken(token), tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6), createdAt: new Date().toISOString() });
    return { token, access: await ciTokenInfo(projectId) };
}

export async function authenticateCiToken(projectId: string, authorization?: string): Promise<boolean> {
    const candidate = authorization?.match(/^Bearer (sbci_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!candidate) return false;
    const row = await ciRepository.token(projectId);
    if (!row?.tokenHash) return false;
    const expected = Buffer.from(row.tokenHash, "hex");
    const actual = Buffer.from(hashToken(candidate), "hex");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
    if (!row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) >= 60_000) await ciRepository.touchToken(projectId, row.tokenHash);
    return true;
}
