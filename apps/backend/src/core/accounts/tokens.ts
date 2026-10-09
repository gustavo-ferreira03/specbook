import crypto from "node:crypto";

export const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export function issuePrefixedToken(prefix: string) {
    const token = `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
    return { token, hash: tokenHash(token), prefix: token.slice(0, prefix.length + 6) };
}

export function verifyTokenHash(storedHash: string, candidate: string): boolean {
    const expected = Buffer.from(storedHash, "hex");
    const actual = Buffer.from(tokenHash(candidate), "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
