import http from "node:http";
import https from "node:https";

import { httpTarget, resolveTarget } from "@specbook/runtime/network/targets";
import type { AddressResolver } from "@specbook/runtime/network/targets";

import { requireValue } from "../utils/require-value";

export const readApiDocumentation = async function readApiDocumentation(
  value: string,
  options: {
    origins: string[];
    allowPrivate: boolean;
    signal?: AbortSignal;
    resolver?: AddressResolver;
  }
) {
  options.signal?.throwIfAborted();
  const url = httpTarget(value);
  if (!options.origins.includes(url.origin)) {
    throw new Error(
      "This documentation origin is not allowed. Add it in Settings → Environments, then try again."
    );
  }
  const address = await resolveTarget(
    url,
    options.allowPrivate,
    options.resolver
  );
  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
  return new Promise<{ url: string; contentType: string; text: string }>(
    (resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method: "GET",
          agent: false,
          signal,
          headers: {
            Accept:
              "application/json, application/yaml, text/yaml, text/plain, text/html",
            "User-Agent": "Specbook",
          },
          // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
          lookup: (_hostname, lookupOptions, callback) =>
            lookupOptions.all
              ? // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
                callback(null, [address])
              : // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
                callback(null, address.address, address.family),
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status < 200 || status >= 300) {
            reject(
              new Error(
                status >= 300 && status < 400
                  ? "This documentation redirects to another URL. Use the final documentation URL on an allowed origin."
                  : `The documentation returned HTTP ${status}. Check the URL or read the signed-in documentation in the browser.`
              )
            );
            response.destroy();
            return;
          }
          const contentType = requireValue(
            String(response.headers["content-type"] ?? "").split(";")[0]
          );
          if (
            !/^(?:text\/(?:plain|html|yaml|x-yaml)|application\/(?:json|yaml|x-yaml|[^/]+\+json))$/iu.test(
              contentType
            )
          ) {
            reject(
              new Error(
                "This URL did not return text, JSON or YAML documentation. Use an API documentation page or OpenAPI file."
              )
            );
            response.destroy();
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_DOCUMENTATION_BYTES) {
              reject(
                new Error(
                  "This API documentation is larger than 128 KiB. Use a smaller OpenAPI file or inspect the relevant endpoint in the browser."
                )
              );
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              url: url.href,
              contentType,
              text: Buffer.concat(chunks).toString("utf-8"),
            })
          );
        }
      );
      request.on("error", reject);
      request.end();
    }
  );
};

const MAX_DOCUMENTATION_BYTES = 131_072;
