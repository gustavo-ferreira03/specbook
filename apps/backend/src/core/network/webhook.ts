import http from "node:http";
import https from "node:https";
import { httpTarget, resolveTarget, type AddressResolver } from "./targets";

export async function postWebhook(value: string, payload: Record<string, unknown>, options: { allowPrivate: boolean; signal: AbortSignal; resolver?: AddressResolver }): Promise<number> {
    const url = httpTarget(value);
    const address = await resolveTarget(url, options.allowPrivate, options.resolver);
    const body = JSON.stringify(payload);
    return new Promise<number>((resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).request(url, {
            method: "POST", agent: false, signal: options.signal,
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
            lookup: (_hostname, lookupOptions, callback) => lookupOptions.all ? callback(null, [address]) : callback(null, address.address, address.family),
        }, (response) => {
            resolve(response.statusCode ?? 502);
            response.destroy();
        });
        request.on("error", reject);
        request.end(body);
    });
}
