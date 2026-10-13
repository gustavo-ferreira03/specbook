export const MAX_REPLAY_RAW_BYTES = 64 * 1024 * 1024;
export const MAX_REPLAY_EVENTS = 250_000;

export interface ReplayEvent {
    type: number;
    timestamp: number;
    data?: unknown;
}

export interface ReplayRecording {
    version: 1;
    assets: string[];
    events: ReplayEvent[];
}

export function isReplayEvents(value: unknown): value is ReplayEvent[] {
    return Array.isArray(value) && value.length >= 2 && value.length <= MAX_REPLAY_EVENTS
        && value.every((event) => event && typeof event === "object"
            && Number.isInteger(event.type) && event.type >= 0 && event.type <= 6
            && Number.isFinite(event.timestamp) && event.timestamp >= 0)
        && value.some((event) => event.type === 2) && value.some((event) => event.type === 4);
}

export function restoreReplayEvents(value: unknown): ReplayEvent[] | null {
    // This function is also embedded in the offline report; keep it self-contained.
    const limit = 64 * 1024 * 1024;
    const maxEvents = 250_000;
    const encoder = new TextEncoder();
    const image = /^data:image\/[^,\s]+,/i;
    let bytes = 0;
    const packed = !Array.isArray(value);
    let source: unknown = value;
    let assets: string[] = [];
    let assetSizes: number[] = [];
    const ancestors = new Set<object>();
    const codec = {
        count(size: number): void {
            bytes += size;
            if (bytes > limit) throw new Error("Replay exceeds its expanded limit");
        },
        jsonBytes(item: string): number {
            if (item.length > limit) throw new Error("Replay exceeds its expanded limit");
            const text = JSON.stringify(item);
            if (text.length > limit) throw new Error("Replay exceeds its expanded limit");
            return encoder.encode(text).length;
        },
        reference(item: Record<string, unknown>): number {
            const index = item.__specbookReplayAsset;
            if (Object.keys(item).length !== 1 || !Number.isInteger(index) || (index as number) < 0 || (index as number) >= assets.length) {
                throw new Error("Invalid replay asset reference");
            }
            return index as number;
        },
        restore(item: unknown, depth: number): unknown {
            if (depth > 256) throw new Error("Replay nesting exceeds its limit");
            if (typeof item === "string") { codec.count(codec.jsonBytes(item)); return item; }
            if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) {
                codec.count(JSON.stringify(item).length);
                return item;
            }
            if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error("Invalid replay value");
            if (packed && !Array.isArray(item)) {
                const entry = item as Record<string, unknown>;
                if (Object.hasOwn(entry, "__specbookReplayAsset")) {
                    const index = codec.reference(entry);
                    codec.count(assetSizes[index]);
                    return assets[index];
                }
                if (Object.hasOwn(entry, "__specbookReplayString")) {
                    const parts = entry.__specbookReplayString;
                    if (Object.keys(entry).length !== 1 || !Array.isArray(parts) || !parts.length) throw new Error("Invalid replay string reference");
                    let size = 2;
                    const strings = parts.map((part) => {
                        if (typeof part === "string") { size += codec.jsonBytes(part) - 2; return part; }
                        if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("Invalid replay string part");
                        const index = codec.reference(part);
                        size += assetSizes[index] - 2;
                        if (size > limit) throw new Error("Replay exceeds its expanded limit");
                        return assets[index];
                    });
                    codec.count(size);
                    return strings.join("");
                }
            }
            ancestors.add(item);
            const entries = Object.entries(item);
            codec.count(2 + Math.max(0, entries.length - 1));
            let result: unknown;
            if (Array.isArray(item)) result = item.map((part) => codec.restore(part, depth + 1));
            else {
                const object: Record<string, unknown> = {};
                for (const [key, part] of entries) {
                    codec.count(codec.jsonBytes(key) + 1);
                    Object.defineProperty(object, key, { value: codec.restore(part, depth + 1), enumerable: true, configurable: true, writable: true });
                }
                result = object;
            }
            ancestors.delete(item);
            return result;
        },
    };
    try {
        if (packed) {
            if (!value || typeof value !== "object") return null;
            const recording = value as Record<string, unknown>;
            if (Object.keys(recording).length !== 3 || !Object.hasOwn(recording, "version") || !Object.hasOwn(recording, "assets")
                || !Object.hasOwn(recording, "events") || recording.version !== 1 || !Array.isArray(recording.assets)
                || !Array.isArray(recording.events) || recording.assets.some((asset) => typeof asset !== "string" || !image.test(asset))) return null;
            assets = recording.assets;
            source = recording.events;
        }
        if (!Array.isArray(source) || source.length < 2 || source.length > maxEvents) return null;
        assetSizes = assets.map((asset) => codec.jsonBytes(asset));
        if (assetSizes.reduce((total, size) => total + size, 0) > limit) return null;
        const events = codec.restore(source, 0) as ReplayEvent[];
        return events.every((event) => event && typeof event === "object"
            && Number.isInteger(event.type) && event.type >= 0 && event.type <= 6
            && Number.isFinite(event.timestamp) && event.timestamp >= 0)
            && events.some((event) => event.type === 2) && events.some((event) => event.type === 4) ? events : null;
    } catch {
        return null;
    }
}

export function packReplayEvents(events: ReplayEvent[]): ReplayRecording | null {
    const source = restoreReplayEvents(events);
    if (!source) return null;
    const assets: string[] = [];
    const indices = new Map<string, number>();
    const asset = (image: string): { __specbookReplayAsset: number } => {
        let index = indices.get(image);
        if (index === undefined) { index = assets.length; assets.push(image); indices.set(image, index); }
        return { __specbookReplayAsset: index };
    };
    const pack = (value: unknown): unknown => {
        if (typeof value === "string") {
            if (/^data:image\/[^,\s]+,/i.test(value)) return asset(value);
            const matches = [...value.matchAll(/data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/=]+/gi)];
            if (!matches.length) return value;
            const parts: (string | { __specbookReplayAsset: number })[] = [];
            let position = 0;
            for (const match of matches) {
                if (match.index! > position) parts.push(value.slice(position, match.index));
                parts.push(asset(match[0]));
                position = match.index! + match[0].length;
            }
            if (position < value.length) parts.push(value.slice(position));
            return { __specbookReplayString: parts };
        }
        if (Array.isArray(value)) return value.map(pack);
        if (!value || typeof value !== "object") return value;
        if (Object.hasOwn(value, "__specbookReplayAsset") || Object.hasOwn(value, "__specbookReplayString")) throw new Error("Reserved replay reference key");
        return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, pack(part)]));
    };
    try {
        return { version: 1, assets, events: pack(source) as ReplayEvent[] };
    } catch {
        return null;
    }
}
