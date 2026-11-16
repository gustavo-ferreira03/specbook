import http from "node:http";
import https from "node:https";

import { httpTarget, resolveTarget } from "@specbook/runtime/network/targets";
import type { AddressResolver } from "@specbook/runtime/network/targets";

export const postWebhook = async function postWebhook(
  value: string,
  payload: Record<string, unknown>,
  options: {
    allowPrivate: boolean;
    signal: AbortSignal;
    resolver?: AddressResolver;
  }
): Promise<number> {
  const url = httpTarget(value);
  const address = await resolveTarget(
    url,
    options.allowPrivate,
    options.resolver
  );
  const body = JSON.stringify(payload);
  // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
  return new Promise<number>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        agent: false,
        signal: options.signal,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
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
        resolve(response.statusCode ?? 502);
        response.destroy();
      }
    );
    request.on("error", reject);
    request.end(body);
  });
};
