import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";

import {
  httpTarget,
  isPrivateAddress,
  resolveTarget,
} from "@specbook/runtime/network/targets";

import { storageRoot } from "../paths";
import { requireValue } from "../utils/require-value";

const attribute = (tag: string, name: string) =>
  tag
    .match(
      new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu")
    )
    ?.slice(2)
    .find((value) => value !== undefined);

const allowsPrivate = function allowsPrivate(baseUrl: URL): boolean {
  const hostname = baseUrl.hostname.replaceAll(/^\[|\]$/gu, "");
  return isIP(hostname)
    ? isPrivateAddress(hostname)
    : hostname === "localhost" || hostname.endsWith(".localhost");
};

const fetchLimited = async function fetchLimited(
  start: URL,
  project: URL,
  accept: string,
  maxBytes: number
): Promise<Fetched | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
    const address = await resolveTarget(
      url,
      url.origin === project.origin && allowsPrivate(project)
    );
    // oxlint-disable-next-line promise/avoid-new, no-await-in-loop -- Bridge an event or callback API to the asynchronous operation. Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    const result = await new Promise<{
      status: number;
      location?: string;
      contentType: string;
      body: Buffer | null;
      // oxlint-disable-next-line no-loop-func -- This awaited or explicitly chained callback observes the current operation state; iterations retain their sequencing.
    }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method: "GET",
          agent: false,
          signal: AbortSignal.timeout(8000),
          headers: { Accept: accept, "User-Agent": "Specbook" },
          // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
          lookup: (_hostname, options, callback) =>
            options.all
              ? // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
                callback(null, [address])
              : // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
                callback(null, address.address, address.family),
        },
        (response) => {
          const status = response.statusCode ?? 502;
          const contentType = requireValue(
            String(response.headers["content-type"] ?? "").split(";")[0]
          )
            .trim()
            .toLowerCase();
          if (status < 200 || status >= 300) {
            response.destroy();
            resolve({
              status,
              location: response.headers.location,
              contentType,
              body: null,
            });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy();
              resolve({ status, contentType, body: null });
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({ status, contentType, body: Buffer.concat(chunks) })
          );
        }
      );
      request.on("error", reject);
      request.end();
    });
    if (result.status >= 300 && result.status < 400 && result.location) {
      url = httpTarget(new URL(result.location, url).href);
      continue;
    }
    return result.body
      ? { url, contentType: result.contentType, body: result.body }
      : null;
  }
  return null;
};

const iconCandidates = function iconCandidates(
  html: string,
  pageUrl: URL
): URL[] {
  const links = [...html.matchAll(/<link\b[^>]*>/giu)].map((match) => match[0]);

  const ranked = links
    .flatMap((tag) => {
      const rel = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/u);
      const href = attribute(tag, "href");
      if (
        !href ||
        !rel.some((value) => value === "icon" || value === "apple-touch-icon")
      ) {
        return [];
      }
      if (
        /\.svg(?:[?#]|$)/iu.test(href) ||
        /svg/iu.test(attribute(tag, "type") ?? "")
      ) {
        return [];
      }
      return [{ href, score: rel.includes("apple-touch-icon") ? 1 : 0 }];
    })
    .toSorted((a, b) => a.score - b.score);
  const urls = ranked.flatMap(({ href }) => {
    try {
      return [httpTarget(new URL(href, pageUrl).href)];
    } catch {
      return [];
    }
  });
  return [...urls, new URL("/favicon.ico", pageUrl.origin)];
};

const discover = async function discover(
  baseUrl: string
): Promise<Favicon | null> {
  const project = httpTarget(baseUrl);
  const page = await fetchLimited(
    project,
    project,
    "text/html",
    MAX_PAGE_BYTES
  ).catch(() => null);
  const candidates =
    page?.contentType === "text/html"
      ? iconCandidates(page.body.toString("utf-8"), page.url)
      : [new URL("/favicon.ico", project.origin)];
  for (const candidate of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
    const icon = await fetchLimited(
      candidate,
      project,
      "image/*",
      MAX_ICON_BYTES
    ).catch(() => null);
    const contentType =
      icon?.contentType === "image/vnd.microsoft.icon"
        ? "image/x-icon"
        : icon?.contentType;
    if (
      icon &&
      contentType &&
      ICON_TYPES.has(contentType) &&
      icon.body.length > 0
    ) {
      return { contentType, body: icon.body };
    }
  }
  return null;
};

export const projectFavicon = async function projectFavicon(
  projectId: string,
  baseUrl: string
): Promise<Favicon | null> {
  const file = path.join(faviconsDir, projectId);
  const meta = await fs
    .readFile(`${file}.json`, "utf-8")
    .then(
      (text) =>
        JSON.parse(text) as {
          baseUrl: string;
          contentType: string | null;
          fetchedAt: number;
        }
    )
    .catch(() => null);
  if (
    meta &&
    meta.baseUrl === baseUrl &&
    Date.now() - meta.fetchedAt <
      (meta.contentType ? FOUND_TTL_MS : MISSING_TTL_MS)
  ) {
    if (!meta.contentType) {
      return null;
    }
    const body = await fs.readFile(file).catch(() => null);
    if (body) {
      return { contentType: meta.contentType, body };
    }
  }
  const icon = await discover(baseUrl);
  await fs.mkdir(faviconsDir, { recursive: true });
  if (icon) {
    await fs.writeFile(file, icon.body);
  }
  await fs.writeFile(
    `${file}.json`,
    JSON.stringify({
      baseUrl,
      contentType: icon?.contentType ?? null,
      fetchedAt: Date.now(),
    })
  );
  return icon;
};

const faviconsDir = path.join(storageRoot, "favicons");
const MAX_PAGE_BYTES = 262_144;
const MAX_ICON_BYTES = 102_400;
const MAX_REDIRECTS = 3;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 6 * 60 * 60 * 1000;
const ICON_TYPES = new Set([
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/gif",
  "image/jpeg",
  "image/webp",
]);

export interface Favicon {
  contentType: string;
  body: Buffer;
}

interface Fetched {
  url: URL;
  contentType: string;
  body: Buffer;
}
