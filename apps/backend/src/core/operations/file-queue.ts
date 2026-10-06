const queues = new Map<string, Promise<unknown>>();

/** Serializes append and retention rewrites so cleanup cannot lose a concurrent record. */
export async function withFileQueue<T>(file: string, work: () => Promise<T>): Promise<T> {
    const pending = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(work);
    queues.set(file, pending);
    try { return await pending; }
    finally { if (queues.get(file) === pending) queues.delete(file); }
}
