import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { CodedError } from "../errors.ts";

export class NetworkTargetError extends CodedError {
  override name = "NetworkTargetError";

  constructor(message: string) {
    super("environment", message);
  }
}
export interface ResolvedAddress {
  address: string;
  family: number;
}
export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;
const resolveAddresses: AddressResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

const isPrivateIpv4 = (address: string): boolean => {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  const specialRanges = [
    a === 100 && b >= 64 && b <= 127,
    a === 169 && b === 254,
    a === 172 && b >= 16 && b <= 31,
    a === 192 && [0, 168].includes(b),
    a === 192 && b === 88 && c === 99,
    a === 198 && [18, 19].includes(b),
    a === 198 && b === 51 && c === 100,
    a === 203 && b === 0 && c === 113,
  ];
  return [0, 10, 127].includes(a) || a >= 224 || specialRanges.some(Boolean);
};

const isPrivateIpv6 = (address: string): boolean => {
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  if (canonical.startsWith("::ffff:")) {
    const [high = 0, low = 0] = canonical
      .slice(7)
      .split(":")
      .map((value) => Number.parseInt(value, 16));
    return isPrivateIpv4(
      `${Math.floor(high / 256)}.${high % 256}.${Math.floor(low / 256)}.${low % 256}`
    );
  }
  const [first = "", second = "0"] = address.toLowerCase().split(":");
  const prefix = Number.parseInt(first, 16);
  return (
    !(prefix >= 0x20_00 && prefix <= 0x3f_ff) ||
    (prefix === 0x20_01 && Number.parseInt(second, 16) < 0x2_00) ||
    (prefix === 0x20_01 && Number.parseInt(second, 16) === 0xd_b8) ||
    prefix === 0x20_02 ||
    prefix === 0x3f_ff
  );
};

export const isPrivateAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    return isPrivateIpv4(address);
  }
  if (isIP(address) === 6) {
    return isPrivateIpv6(address);
  }
  return true;
};

export const httpTarget = function httpTarget(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NetworkTargetError("Use a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new NetworkTargetError(
      "Use an HTTP(S) URL without credentials or a fragment"
    );
  }
  return url;
};

export const isHttpTarget = function isHttpTarget(value: string): boolean {
  try {
    httpTarget(value);
    return true;
  } catch {
    return false;
  }
};

export const resolveTarget = async function resolveTarget(
  value: string | URL,
  allowPrivate = false,
  resolver: AddressResolver = resolveAddresses
): Promise<ResolvedAddress> {
  const url = typeof value === "string" ? httpTarget(value) : value;
  const hostname = url.hostname.replaceAll(/^\[|\]$/gu, "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: ResolvedAddress[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
          resolver(hostname),
          // oxlint-disable-next-line promise/avoid-new -- Bridge a callback or deadline into a promise; there is no promise-returning operation to await.
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("DNS timeout")), 5000);
          }),
        ]);
  } catch {
    throw new NetworkTargetError("The target hostname could not be resolved");
  } finally {
    clearTimeout(timer);
  }
  if (!addresses.length || addresses.some((entry) => !isIP(entry.address))) {
    throw new NetworkTargetError("The target hostname could not be resolved");
  }
  if (
    !allowPrivate &&
    addresses.some((entry) => isPrivateAddress(entry.address))
  ) {
    throw new NetworkTargetError(
      "Private, loopback and link-local targets are not allowed"
    );
  }
  const [address] = addresses;
  if (!address) {
    throw new NetworkTargetError("The target hostname could not be resolved");
  }
  return address;
};

export interface RunNetworkPolicy {
  origins: string[];
  allowPrivate: boolean;
}

export const localNetworkPolicy = async function localNetworkPolicy(
  baseUrl: string,
  resolver?: AddressResolver
): Promise<RunNetworkPolicy> {
  const target = httpTarget(baseUrl);
  const hostname = target.hostname.replaceAll(/^\[|\]$/gu, "");
  const allowPrivate = isIP(hostname)
    ? isPrivateAddress(hostname)
    : hostname === "localhost" || hostname.endsWith(".localhost");
  await resolveTarget(target, allowPrivate, resolver);
  return { origins: [target.origin], allowPrivate };
};
