import crypto from "node:crypto";

/**
 * Tokens are 256-bit random strings rather than user-chosen passwords, so a
 * single SHA-256 is enough: there is nothing to brute force and Git clients
 * re-authenticate on every request of a clone, which rules out a slow KDF.
 */
export const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** The plain token is shown once; only its hash and a short display prefix are stored. */
export function issuePrefixedToken(prefix: string) {
    const token = `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
    return { token, hash: tokenHash(token), prefix: token.slice(0, prefix.length + 6) };
}

export function verifyTokenHash(storedHash: string, candidate: string): boolean {
    const expected = Buffer.from(storedHash, "hex");
    const actual = Buffer.from(tokenHash(candidate), "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
