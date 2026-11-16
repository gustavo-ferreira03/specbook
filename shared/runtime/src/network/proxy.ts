import http from "node:http";
import net from "node:net";
import type { AddressInfo, LookupFunction, Socket } from "node:net";
import type { Duplex } from "node:stream";

import { httpTarget, resolveTarget } from "./targets.ts";
import type { AddressResolver, ResolvedAddress } from "./targets.ts";

const resolvedLookup = (
  address: ResolvedAddress | undefined
): LookupFunction => {
  if (!address) {
    throw new Error("Network target was not resolved");
  }
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This callback is required by the Node networking or player event API.
  return (_hostname, options, callback) => {
    if (options.all) {
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This callback is required by the Node networking or player event API.
      return callback(null, [address]);
    }
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This callback is required by the Node networking or player event API.
    return callback(null, address.address, address.family);
  };
};

export type TargetConnector = (target: URL) => Promise<Duplex>;

export const createRunProxy = async function createRunProxy(
  privateOrigins: string[],
  resolver?: AddressResolver,
  connectTarget?: TargetConnector
) {
  const sockets = new Set<Duplex>();
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    if (socket instanceof net.Socket) {
      socket.setTimeout(30_000, () => socket.destroy());
    }
    return socket;
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      const target = httpTarget(request.url ?? "");
      if (target.protocol !== "http:") {
        throw new Error("Use CONNECT for HTTPS");
      }
      if (connectTarget && !privateOrigins.includes(target.origin)) {
        throw new Error("Network target blocked");
      }
      const connection = connectTarget
        ? track(await connectTarget(target))
        : undefined;
      const address = connection
        ? undefined
        : await resolveTarget(
            target,
            privateOrigins.includes(target.origin),
            resolver
          );
      if (request.destroyed) {
        connection?.destroy();
        return;
      }
      const {
        "proxy-authorization": _,
        "proxy-connection": __,
        ...headers
      } = request.headers;
      const upstream = http.request(
        target,
        {
          method: request.method,
          headers: { ...headers, host: target.host },
          ...(connection
            ? { createConnection: () => connection as Socket, agent: undefined }
            : {
                lookup: resolvedLookup(address),
                agent: false,
              }),
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        }
      );
      upstream.on("socket", track);
      upstream.on("error", () => {
        if (!response.headersSent) {
          response.writeHead(502);
        }
        response.end();
      });
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    })().catch(() => {
      response.writeHead(403);
      response.end("Network target blocked");
    });
  });
  server.on("connection", track);
  server.on("connect", (request, socket, head) => {
    void (async () => {
      // Browsers tunnel WebSockets through CONNECT even for ws:// origins, so a private
      // target is allowed when either its http or https origin is.
      const target = httpTarget(`https://${request.url}`);
      const plain = httpTarget(`http://${request.url}`);
      const allowed =
        privateOrigins.includes(target.origin) ||
        privateOrigins.includes(plain.origin);
      if (connectTarget && !allowed) {
        throw new Error("Network target blocked");
      }
      const address = connectTarget
        ? undefined
        : await resolveTarget(target, allowed, resolver);
      if (socket.destroyed) {
        return;
      }
      const upstream = track(
        connectTarget
          ? await connectTarget(
              privateOrigins.includes(target.origin) ? target : plain
            )
          : net.connect({
              host: (() => {
                const presentValue = address;
                if (presentValue === null || presentValue === undefined) {
                  throw new Error("Expected an existing value");
                }
                return presentValue;
              })().address,
              port: Number(target.port || 443),
            })
      );
      if (socket.destroyed || socket.readableEnded) {
        upstream.destroy();
        socket.destroy();
        return;
      }
      const connected = () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) {
          upstream.write(head);
        }
        upstream.pipe(socket);
        socket.pipe(upstream);
      };
      if (connectTarget) {
        connected();
      } else {
        upstream.on("connect", connected);
      }
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    })().catch(() =>
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
    );
  });
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const target = httpTarget((request.url ?? "").replace(/^ws:/u, "http:"));
      if (target.protocol !== "http:") {
        throw new Error("Use CONNECT for HTTPS");
      }
      if (connectTarget && !privateOrigins.includes(target.origin)) {
        throw new Error("Network target blocked");
      }
      const connection = connectTarget
        ? track(await connectTarget(target))
        : undefined;
      const address = connection
        ? undefined
        : await resolveTarget(
            target,
            privateOrigins.includes(target.origin),
            resolver
          );
      if (socket.destroyed || socket.readableEnded) {
        connection?.destroy();
        socket.destroy();
        return;
      }
      const {
        "proxy-authorization": _,
        "proxy-connection": __,
        ...headers
      } = request.headers;
      const upstream = http.request(target, {
        headers: { ...headers, host: target.host },
        ...(connection
          ? { createConnection: () => connection as Socket, agent: undefined }
          : {
              lookup: resolvedLookup(address),
              agent: false,
            }),
      });
      upstream.on("socket", track);
      upstream.on("upgrade", (response, upgradedConnection, upstreamHead) => {
        socket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(
            response.headers
          )
            .map(([key, value]) => `${key}: ${value}`)
            .join("\r\n")}\r\n\r\n`
        );
        if (head.length) {
          upgradedConnection.write(head);
        }
        if (upstreamHead.length) {
          socket.write(upstreamHead);
        }
        upgradedConnection.pipe(socket);
        socket.pipe(upgradedConnection);
        socket.on("close", () => upgradedConnection.destroy());
      });
      upstream.on("response", () => {
        upstream.destroy();
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.end();
    })().catch(() =>
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
    );
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  // oxlint-disable-next-line promise/avoid-new -- Bridge a callback or deadline into a promise; there is no promise-returning operation to await.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      // oxlint-disable-next-line promise/avoid-new -- Bridge a callback or deadline into a promise; there is no promise-returning operation to await.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};
