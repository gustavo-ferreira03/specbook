export function createKeyedLock() {
    const queues = new Map<string, Promise<unknown>>();
    return {
        has: (key: string) => queues.has(key),
        async run<T>(key: string, work: () => Promise<T>): Promise<T> {
            const current = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
            queues.set(key, current);
            try { return await current; }
            finally { if (queues.get(key) === current) queues.delete(key); }
        },
    };
}
