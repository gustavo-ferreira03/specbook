import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { tunnelFrameSchema, type TunnelFrame } from "../tunnel-protocol.ts";

interface MessageSocket extends EventEmitter {
    readyState: number;
    bufferedAmount: number;
    send(data: string, callback: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
}
type Pending = { resolve: (stream: Duplex) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class TunnelMultiplexer {
    private streams = new Map<string, Duplex>();
    private pending = new Map<string, Pending>();
    private remotePaused = new Set<string>();
    private blockedWrites = new Map<string, (error?: Error) => void>();
    private stopped = false;

    constructor(private socket: MessageSocket, private accept?: (origin: string) => Promise<Duplex>) {
        socket.on("message", (data: Buffer, binary: boolean) => {
            if (binary || data.length > 65_536) { socket.close(1008, "Invalid tunnel frame"); this.close(); return; }
            let input: unknown;
            try { input = JSON.parse(data.toString()); } catch { socket.close(1008, "Invalid tunnel frame"); this.close(); return; }
            const parsed = tunnelFrameSchema.safeParse(input);
            if (!parsed.success) { socket.close(1008, "Invalid tunnel frame"); this.close(); return; }
            void this.receive(parsed.data);
        });
        socket.once("close", () => this.close());
        socket.on("error", () => this.close());
    }

    private send(frame: TunnelFrame, done: (error?: Error) => void = () => undefined): void {
        if (this.stopped || this.socket.readyState !== 1 || this.socket.bufferedAmount > 4 * 1024 * 1024) {
            done(new Error("Tunnel connection unavailable"));
            this.close();
            return;
        }
        this.socket.send(JSON.stringify(frame), done);
    }

    private stream(id: string): Duplex {
        let paused = false;
        const stream = new Duplex({
            read: () => { if (paused) { paused = false; this.send({ type: "resume", id }); } },
            write: (chunk: Buffer, _encoding, done) => {
                let offset = 0;
                const next = (error?: Error) => {
                    if (error || offset >= chunk.length) { done(error); return; }
                    if (this.remotePaused.has(id)) { this.blockedWrites.set(id, next); return; }
                    const end = Math.min(chunk.length, offset + 32_768);
                    const data = chunk.subarray(offset, end).toString("base64");
                    offset = end;
                    this.send({ type: "data", id, data }, next);
                };
                next();
            },
            final: (done) => this.send({ type: "end", id }, done),
            destroy: (error, done) => {
                this.streams.delete(id);
                this.remotePaused.delete(id);
                const write = this.blockedWrites.get(id);
                this.blockedWrites.delete(id);
                if (write) write(new Error("Tunnel connection closed"));
                this.send({ type: "close", id });
                const pending = this.pending.get(id);
                if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error ?? new Error("Tunnel connection closed")); }
                done(error);
            },
        });
        stream.on("error", () => undefined);
        stream.on("tunnel-data", (chunk: Buffer) => {
            if (!stream.push(chunk) && !paused) { paused = true; this.send({ type: "pause", id }); }
        });
        this.streams.set(id, stream);
        return stream;
    }

    async connect(origin: string): Promise<Duplex> {
        if (this.stopped || this.streams.size >= 256) throw new Error("Tunnel connection unavailable");
        const id = randomUUID();
        this.stream(id);
        return new Promise<Duplex>((resolve, reject) => {
            const timer = setTimeout(() => this.streams.get(id)?.destroy(new Error("Tunnel connection timed out")), 15_000);
            timer.unref();
            this.pending.set(id, { resolve, reject, timer });
            this.send({ type: "open", id, origin }, (error) => { if (error) this.streams.get(id)?.destroy(error); });
        });
    }

    private async receive(frame: TunnelFrame): Promise<void> {
        if (this.stopped) return;
        if (frame.type === "open") {
            if (!this.accept || this.streams.has(frame.id) || this.streams.size >= 256) { this.send({ type: "refused", id: frame.id }); return; }
            const stream = this.stream(frame.id);
            try {
                const upstream = await this.accept(frame.origin);
                if (stream.destroyed || this.stopped) { upstream.destroy(); return; }
                upstream.on("error", () => stream.destroy());
                stream.on("close", () => upstream.destroy());
                upstream.on("close", (failed: boolean) => { if (failed || !upstream.readableEnded) stream.destroy(); });
                upstream.pipe(stream);
                stream.pipe(upstream);
                this.send({ type: "opened", id: frame.id });
            } catch { this.send({ type: "refused", id: frame.id }); stream.destroy(); }
            return;
        }
        const stream = this.streams.get(frame.id);
        if (!stream) return;
        const pending = this.pending.get(frame.id);
        switch (frame.type) {
            case "opened":
                if (pending) { clearTimeout(pending.timer); this.pending.delete(frame.id); pending.resolve(stream); }
                break;
            case "refused": stream.destroy(new Error("Network target blocked by tunnel")); break;
            case "data": {
                const chunk = Buffer.from(frame.data, "base64");
                const buffered = [...this.streams.values()].reduce((sum, value) => sum + value.readableLength, 0);
                if (stream.readableLength + chunk.length > 4 * 1024 * 1024 || buffered + chunk.length > 16 * 1024 * 1024) {
                    this.socket.close(1008, "Tunnel backpressure limit exceeded");
                    this.close();
                } else stream.emit("tunnel-data", chunk);
                break;
            }
            case "end": stream.push(null); break;
            case "close": stream.destroy(); break;
            case "pause": this.remotePaused.add(frame.id); break;
            case "resume": {
                this.remotePaused.delete(frame.id);
                const write = this.blockedWrites.get(frame.id);
                this.blockedWrites.delete(frame.id);
                write?.();
                break;
            }
        }
    }

    close(): void {
        if (this.stopped) return;
        this.stopped = true;
        for (const stream of this.streams.values()) stream.destroy(new Error("Tunnel connection closed"));
        this.streams.clear();
    }
}
