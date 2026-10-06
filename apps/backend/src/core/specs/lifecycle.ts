import { createKeyedLock } from "../operations/keyed-lock";

/** Thrown when a Spec, Feature, chat or project is in use and cannot be changed right now. */
export class ResourceBusyError extends Error {}

const locks = createKeyedLock();

export function areSpecsLocked(specIds: string[]): boolean {
    return specIds.some(locks.has);
}

export const withSpecLock = locks.run;

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
    const held: { done: Promise<void>; release: () => void }[] = [];
    for (const id of ids) {
        let release: () => void = () => {};
        let acquired: () => void = () => {};
        const hold = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { acquired = resolve; });
        held.push({ done: withSpecLock(id, () => { acquired(); return hold; }), release });
        if (options.wait !== false) await started;
    }
    return async () => {
        for (const lock of held) lock.release();
        await Promise.all(held.map((lock) => lock.done));
    };
}
