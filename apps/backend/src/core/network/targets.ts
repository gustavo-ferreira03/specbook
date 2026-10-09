import { CodedError } from "../errors";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class NetworkTargetError extends CodedError {
    constructor(message: string) { super("environment", message); }
}
export type ResolvedAddress = { address: string; family: number };
export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;
const resolveAddresses: AddressResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

export function isPrivateAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b, c] = address.split(".").map(Number);
        return a === 0 || a === 10 || a === 127 || a! >= 224
            || a === 100 && b! >= 64 && b! <= 127 || a === 169 && b === 254
            || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99)
            || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
            || a === 203 && b === 0 && c === 113;
    }
    if (isIP(address) === 6) {
        const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
        if (canonical.startsWith("::ffff:")) {
            const [high, low] = canonical.slice(7).split(":").map((value) => parseInt(value, 16));
            return isPrivateAddress(`${high! >> 8}.${high! & 255}.${low! >> 8}.${low! & 255}`);
        }
        const [first, second = "0"] = address.toLowerCase().split(":");
        const prefix = parseInt(first!, 16);
        return !(prefix >= 0x2000 && prefix <= 0x3fff)
            || prefix === 0x2001 && parseInt(second, 16) < 0x200 || prefix === 0x2001 && parseInt(second, 16) === 0xdb8
            || prefix === 0x2002 || prefix === 0x3fff;
    }
    return true;
}

export function httpTarget(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new NetworkTargetError("Use a valid HTTP(S) URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new NetworkTargetError("Use an HTTP(S) URL without credentials or a fragment");
    }
    return url;
}

export function isHttpTarget(value: string): boolean {
    try { httpTarget(value); return true; } catch { return false; }
}

export async function resolveTarget(value: string | URL, allowPrivate = false, resolver: AddressResolver = resolveAddresses): Promise<ResolvedAddress> {
    const url = typeof value === "string" ? httpTarget(value) : value;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let addresses: ResolvedAddress[];
    try {
        addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
            resolver(hostname),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 5000); }),
        ]);
    } catch { throw new NetworkTargetError("The target hostname could not be resolved"); }
    finally { clearTimeout(timer); }
    if (!addresses.length || addresses.some((entry) => !isIP(entry.address))) throw new NetworkTargetError("The target hostname could not be resolved");
    if (!allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
        throw new NetworkTargetError("Private, loopback and link-local targets are not allowed");
    }
    return addresses[0]!;
}
