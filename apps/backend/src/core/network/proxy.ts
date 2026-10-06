import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { httpTarget, resolveTarget, type AddressResolver } from "./targets";

/** Each connection resolves once and connects to that checked IP, including HTTPS tunnels. */
export async function createRunProxy(privateOrigins: string[], resolver?: AddressResolver) {
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => {
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
        socket.on("close", () => sockets.delete(socket));
        socket.setTimeout(30_000, () => socket.destroy());
        return socket;
    };
    const server = http.createServer((request, response) => {
        void (async () => {
            const target = httpTarget(request.url ?? "");
            if (target.protocol !== "http:") throw new Error("Use CONNECT for HTTPS");
            const address = await resolveTarget(target, privateOrigins.includes(target.origin), resolver);
            if (request.destroyed) return;
            const { "proxy-authorization": _, "proxy-connection": __, ...headers } = request.headers;
            const upstream = http.request(target, {
                method: request.method, headers: { ...headers, host: target.host },
                lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
                agent: false,
            }, (result) => {
                response.writeHead(result.statusCode ?? 502, result.headers);
                result.pipe(response);
            });
            upstream.on("socket", track);
            upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
            response.on("close", () => upstream.destroy());
            request.pipe(upstream);
        })().catch(() => { response.writeHead(403); response.end("Network target blocked"); });
    });
    server.on("connection", track);
    server.on("connect", (request, socket, head) => {
        void (async () => {
            const target = httpTarget(`https://${request.url}`);
            const address = await resolveTarget(target, privateOrigins.includes(target.origin), resolver);
            if (socket.destroyed) return;
            const upstream = track(net.connect({ host: address.address, port: Number(target.port || 443) }));
            upstream.on("connect", () => {
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length) upstream.write(head);
                upstream.pipe(socket);
                socket.pipe(upstream);
            });
            upstream.on("error", () => socket.destroy());
            socket.on("close", () => upstream.destroy());
        })().catch(() => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
    });
    server.on("upgrade", (request, socket, head) => {
        void (async () => {
            const target = httpTarget((request.url ?? "").replace(/^ws:/, "http:"));
            if (target.protocol !== "http:") throw new Error("Use CONNECT for HTTPS");
            const address = await resolveTarget(target, privateOrigins.includes(target.origin), resolver);
            if (socket.destroyed) return;
            const { "proxy-authorization": _, "proxy-connection": __, ...headers } = request.headers;
            const upstream = http.request(target, {
                headers: { ...headers, host: target.host }, agent: false,
                lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
            });
            upstream.on("socket", track);
            upstream.on("upgrade", (response, connection, upstreamHead) => {
                socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
                if (head.length) connection.write(head);
                if (upstreamHead.length) socket.write(upstreamHead);
                connection.pipe(socket);
                socket.pipe(connection);
                socket.on("close", () => connection.destroy());
            });
            upstream.on("response", () => { upstream.destroy(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
            upstream.on("error", () => socket.destroy());
            socket.on("close", () => upstream.destroy());
            upstream.end();
        })().catch(() => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return {
        server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
