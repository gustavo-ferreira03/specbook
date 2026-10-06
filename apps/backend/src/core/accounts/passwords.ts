import crypto from "node:crypto";
const OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
let active = 0;

async function derive(password: string, salt: Buffer): Promise<Buffer> {
    if (active >= 2) throw new Error("Too many sign-in attempts. Wait a moment and try again.");
    active++;
    try { return await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, OPTIONS, (error, result) => error ? reject(error) : resolve(result))); }
    finally { active--; }
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    return `scrypt-v1:${salt.toString("hex")}:${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
    const match = stored?.match(/^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{128})$/);
    const salt = match ? Buffer.from(match[1], "hex") : Buffer.alloc(16);
    const actual = await derive(password, salt);
    const expected = match ? Buffer.from(match[2], "hex") : Buffer.alloc(64);
    return crypto.timingSafeEqual(actual, expected) && Boolean(match);
}
