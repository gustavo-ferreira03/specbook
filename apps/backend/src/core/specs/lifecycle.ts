/** Thrown when a Spec, Feature, chat or project is in use and cannot be changed right now. */
export class ResourceBusyError extends Error {}

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

export async function acquireSpecLocks(specIds: string[], options: { wait?: boolean } = {}): Promise<() => Promise<void>> {
    const ids = [...new Set(specIds)].sort();
    if (options.wait === false && areSpecsLocked(ids)) throw new ResourceBusyError("Selected Specs are already in use; retry after their current operation finishes");
    const acquired: { id: string; current: Promise<unknown>; release: () => void }[] = [];
    for (const id of ids) {
        const previous = locks.get(id) ?? Promise.resolve();
        let release: () => void = () => {};
        const hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const current = previous.catch(() => undefined).then(() => hold);
        locks.set(id, current);
        if (options.wait !== false) await previous.catch(() => undefined);
        acquired.push({ id, current, release });
    }
    return async () => {
        for (const lock of acquired) lock.release();
        await Promise.all(acquired.map((lock) => lock.current.catch(() => undefined)));
        for (const lock of acquired) if (locks.get(lock.id) === lock.current) locks.delete(lock.id);
    };
}
