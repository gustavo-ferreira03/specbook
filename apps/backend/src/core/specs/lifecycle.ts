const locks = new Map<string, Promise<unknown>>();

export function areSpecsLocked(specIds: string[]): boolean {
    return specIds.some((id) => locks.has(id));
}

export async function withSpecLock<T>(specId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(specId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    locks.set(specId, current);
    try {
        return await current;
    } finally {
        if (locks.get(specId) === current) locks.delete(specId);
    }
}

export async function withSpecLocks<T>(specIds: string[], work: () => Promise<T>): Promise<T> {
    const ids = [...new Set(specIds)].sort();
    async function acquire(index: number): Promise<T> {
        const id = ids[index];
        return id ? withSpecLock(id, () => acquire(index + 1)) : work();
    }
    return acquire(0);
}
