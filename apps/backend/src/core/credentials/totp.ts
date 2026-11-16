import crypto from "node:crypto";

import { requireValue } from "../utils/require-value";

const decodeBase32 = function decodeBase32(input: string): Buffer {
  const clean = input.toUpperCase().replaceAll(/[\s=-]/gu, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) {
      throw new Error("The authenticator key is not valid base32.");
    }
    // oxlint-disable-next-line no-bitwise -- Implement the byte layout required by the encoded protocol.
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      // oxlint-disable-next-line no-bitwise -- Implement the byte layout required by the encoded protocol.
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

const parseTotpSeed = function parseTotpSeed(seed: string): TotpParams {
  const trimmed = seed.trim();
  if (!trimmed.toLowerCase().startsWith("otpauth://")) {
    return {
      secret: decodeBase32(trimmed),
      digits: 6,
      period: 30,
      algorithm: "sha1",
    };
  }
  const url = new URL(trimmed);
  const secret = url.searchParams.get("secret");
  if (!secret) {
    throw new Error("The otpauth URI has no secret.");
  }
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
  return {
    secret: decodeBase32(secret),
    digits: Number(url.searchParams.get("digits") ?? 6),
    period: Number(url.searchParams.get("period") ?? 30),
    algorithm:
      algorithm === "sha256" || algorithm === "sha512" ? algorithm : "sha1",
  };
};

export const generateTotp = function generateTotp(
  seed: string,
  now = Date.now()
): string {
  const { secret, digits, period, algorithm } = parseTotpSeed(seed);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const hmac = crypto.createHmac(algorithm, secret).update(counter).digest();
  // oxlint-disable-next-line no-bitwise -- Implement the byte layout required by the encoded protocol.
  const offset = requireValue(hmac.at(-1)) & 0x0f;
  // oxlint-disable-next-line no-bitwise -- Implement the byte layout required by the encoded protocol.
  const binary = (hmac.readUInt32BE(offset) & 0x7f_ff_ff_ff) % 10 ** digits;
  return binary.toString().padStart(digits, "0");
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

interface TotpParams {
  secret: Buffer;
  digits: number;
  period: number;
  algorithm: "sha1" | "sha256" | "sha512";
}
