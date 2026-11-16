import crypto from "node:crypto";

export const issuePrefixedToken = function issuePrefixedToken(prefix: string) {
  const token = `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
  return {
    token,
    hash: tokenHash(token),
    prefix: token.slice(0, prefix.length + 6),
  };
};

export const verifyTokenHash = function verifyTokenHash(
  storedHash: string,
  candidate: string
): boolean {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(tokenHash(candidate), "hex");
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
};

export const tokenHash = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");
