import { createKeyedLock } from "../operations/keyed-lock";

export class ResourceBusyError extends Error {
  name = "ResourceBusyError";
}

export const areSpecsLocked = function areSpecsLocked(
  specIds: string[]
): boolean {
  return specIds.some(locks.has);
};

export const settleSpecLocks = async function settleSpecLocks(
  specIds: string[],
  timeoutMs = 10_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (areSpecsLocked(specIds)) {
    if (Date.now() >= deadline) {
      return false;
    }
    // oxlint-disable-next-line promise/avoid-new, no-await-in-loop -- Bridge an event or callback API to the asynchronous operation. Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return true;
};

export const withSpecLocks = async function withSpecLocks<T>(
  specIds: string[],
  work: () => Promise<T>
): Promise<T> {
  const acquire = async function acquire(index: number): Promise<T> {
    const id = ids[index];
    return await (id ? withSpecLock(id, () => acquire(index + 1)) : work());
  };

  const ids = [...new Set(specIds)].toSorted();

  return await acquire(0);
};

export const acquireSpecLocks = async function acquireSpecLocks(
  specIds: string[],
  options: { wait?: boolean } = {}
): Promise<() => Promise<void>> {
  const ids = [...new Set(specIds)].toSorted();
  if (options.wait === false && areSpecsLocked(ids)) {
    throw new ResourceBusyError(
      "Selected Specs are already in use; retry after their current operation finishes"
    );
  }
  const held: { done: Promise<void>; release: () => void }[] = [];
  for (const id of ids) {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- This mutable callback slot belongs to one resource acquisition and is replaced independently for each operation.
    let release: () => void = () => {
      /* No action is needed until this callback is replaced or invoked by its owner. */
    };
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- This mutable callback slot belongs to one resource acquisition and is replaced independently for each operation.
    let acquired: () => void = () => {
      /* No action is needed until this callback is replaced or invoked by its owner. */
    };
    // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
    const started = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    held.push({
      done: withSpecLock(id, () => {
        acquired();
        return hold;
      }),
      release,
    });
    if (options.wait !== false) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await started;
    }
  }
  return async () => {
    for (const lock of held) {
      lock.release();
    }
    await Promise.all(held.map((lock) => lock.done));
  };
};

const locks = createKeyedLock();

export const withSpecLock = locks.run;

// A run's result is visible before its batch finishes writing the report, so callers may wait out that short tail.
