import type { Agent as HttpAgent } from "node:http";

import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici-proxy";
import type { Dispatcher } from "undici-proxy";

import { requiredValue } from "./values";

const dispatchers = new Map<string, Dispatcher>();
const socketAgents = new Map<string, HttpAgent>();
const env = (name: string) =>
  process.env[name.toLowerCase()] || process.env[name];

const proxyFor = function proxyFor(input: string | URL): string | undefined {
  const url = new URL(input);
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const port = url.port || (secure ? "443" : "80");
  for (const entry of (env("NO_PROXY") ?? "")
    .split(/[\s,]+/u)
    .filter(Boolean)) {
    if (entry === "*") {
      return;
    }
    const match = entry.match(
      /^(?<segment1>\[[^\]]+\]|[^:]+)(?::(?<segment2>\d+))?$/u
    );
    if (!match || (match[2] && match[2] !== port)) {
      continue;
    }
    const host = requiredValue(match[1])
      .toLowerCase()
      .replace(/\.$/u, "")
      .replace(/^\*?\./u, "");
    if (hostname === host || hostname.endsWith(`.${host}`)) {
      return;
    }
  }
  const value = secure
    ? env("HTTPS_PROXY") || env("HTTP_PROXY")
    : env("HTTP_PROXY");
  if (!value) {
    return;
  }
  try {
    const proxy = new URL(value);
    if (
      !["http:", "https:"].includes(proxy.protocol) ||
      proxy.search ||
      proxy.hash
    ) {
      throw new Error("The proxy must use HTTP or HTTPS");
    }
  } catch {
    throw new Error("Use an HTTP(S) URL for HTTPS_PROXY or HTTP_PROXY");
  }
  return value;
};

export const remoteFetch = function remoteFetch(
  url: string | URL,
  options: RequestInit = {}
): Promise<Response> {
  const proxy = proxyFor(url);
  if (!proxy) {
    return fetch(url, options);
  }
  let dispatcher = dispatchers.get(proxy);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxy);
    dispatchers.set(proxy, dispatcher);
  }
  return fetch(url, { ...options, dispatcher } as RequestInit & {
    dispatcher: Dispatcher;
  });
};

export const webSocketProxyAgent = function webSocketProxyAgent(
  url: string | URL
): HttpAgent | undefined {
  const proxy = proxyFor(url);
  if (!proxy) {
    return;
  }
  let agent = socketAgents.get(proxy);
  if (!agent) {
    agent = new HttpsProxyAgent(proxy);
    socketAgents.set(proxy, agent);
  }
  return agent;
};

export const redactProxyCredentials = function redactProxyCredentials(
  input: string
): string {
  let text = input;
  const valuesValue = new Set<string>();
  for (const value of [env("HTTP_PROXY"), env("HTTPS_PROXY")]) {
    if (!value) {
      continue;
    }
    valuesValue.add(value);
    try {
      const url = new URL(value);
      const username = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      if (username) {
        valuesValue.add(username);
      }
      if (password) {
        valuesValue.add(password);
      }
      if (username || password) {
        valuesValue.add(
          Buffer.from(`${username}:${password}`).toString("base64")
        );
      }
    } catch {
      /* Cleanup is best effort after the operation has completed or failed. */
      /* Invalid proxy configuration is still hidden. */
    }
  }
  for (const value of [...valuesValue]
    .flatMap((secretValue) => [
      secretValue,
      encodeURIComponent(secretValue),
      JSON.stringify(secretValue).slice(1, -1),
    ])
    .toSorted((a, b) => b.length - a.length)) {
    if (value) {
      text = text.split(value).join("[REDACTED]");
    }
  }
  return text;
};
