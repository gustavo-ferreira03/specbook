import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { MAX_REPLAY_RAW_BYTES, packReplayEvents, restoreReplayEvents, type ReplayEvent } from "./replay-assets.ts";

export { MAX_REPLAY_RAW_BYTES, MAX_REPLAY_EVENTS, isReplayEvents, packReplayEvents, restoreReplayEvents, type ReplayEvent } from "./replay-assets.ts";

export const REPLAY_FILE = "evidence/replay.json.gz";
export const REPLAY_ATTACHMENT = "specbook-replay";
export const REPLAY_UNAVAILABLE_ATTACHMENT = "specbook-replay-unavailable";
export const MAX_REPLAY_BYTES = 15 * 1024 * 1024;
export const REPLAY_LIMIT_NOTE = "Replay omitted because it exceeded the recording limit (15 MiB compressed, 64 MiB uncompressed or 250,000 events).";

const compress = promisify(gzip);
const decompress = promisify(gunzip);

export async function decodeReplay(data: Buffer): Promise<ReplayEvent[] | null> {
    if (data.length > MAX_REPLAY_BYTES) return null;
    try {
        const raw = await decompress(data, { maxOutputLength: MAX_REPLAY_RAW_BYTES });
        return restoreReplayEvents(JSON.parse(raw.toString("utf8")));
    } catch {
        return null;
    }
}

export async function encodeReplay(events: ReplayEvent[], scrub: (text: string) => string = (text) => text): Promise<Buffer | null> {
    try {
        const source = restoreReplayEvents(events);
        if (!source) return null;
        const safe = scrub(JSON.stringify(source.sort((left, right) => left.timestamp - right.timestamp)));
        if (Buffer.byteLength(safe) > MAX_REPLAY_RAW_BYTES) return null;
        const packed = packReplayEvents(JSON.parse(safe));
        if (!packed) return null;
        const raw = scrub(JSON.stringify(packed));
        if (Buffer.byteLength(raw) > MAX_REPLAY_RAW_BYTES || !restoreReplayEvents(JSON.parse(raw))) return null;
        const data = await compress(raw, { level: 6 });
        return data.length <= MAX_REPLAY_BYTES ? data : null;
    } catch {
        return null;
    }
}

export async function readReplay(directory: string): Promise<ReplayEvent[] | null> {
    try {
        const file = path.join(directory, REPLAY_FILE);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > MAX_REPLAY_BYTES) return null;
        if (await fs.realpath(file) !== path.join(await fs.realpath(directory), REPLAY_FILE)) return null;
        return decodeReplay(await fs.readFile(file));
    } catch {
        return null;
    }
}

let recorderSource: Promise<string> | undefined;

export function readRecorderSource(): Promise<string> {
    return recorderSource ??= (async () => {
        const candidates = [new URL("./assets/rrweb-recorder.js", import.meta.url), new URL("../dist/assets/rrweb-recorder.js", import.meta.url)];
        const bundled = candidates.find((file) => existsSync(file));
        const file = bundled ?? path.join(path.dirname(createRequire(import.meta.url).resolve("rrweb")), "rrweb.umd.min.cjs");
        return fs.readFile(file, "utf8");
    })();
}
