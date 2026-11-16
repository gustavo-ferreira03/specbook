export const createKeyedLock = function createKeyedLock() {
  const queues = new Map<string, Promise<unknown>>();
  return {
    has: (key: string) => queues.has(key),
    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const current = (queues.get(key) ?? Promise.resolve())
        .catch(() => {
          /* No action is needed until this callback is replaced or invoked by its owner. */
        })
        .then(work);
      queues.set(key, current);
      try {
        return await current;
      } finally {
        if (queues.get(key) === current) {
          queues.delete(key);
        }
      }
    },
  };
};
