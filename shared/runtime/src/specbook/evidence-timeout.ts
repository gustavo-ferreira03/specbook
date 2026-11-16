export const withEvidenceTimeout = async function withEvidenceTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      // oxlint-disable-next-line promise/avoid-new -- Bridge a callback or deadline into a promise; there is no promise-returning operation to await.
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser evidence timed out")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
