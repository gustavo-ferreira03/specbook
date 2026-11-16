export class ChatTurnTimeoutError extends Error {
  name = "ChatTurnTimeoutError";

  constructor() {
    super(
      "This conversation turn took too long and was stopped. Try a smaller request or test your model connection in global Settings."
    );
  }
}

export const withTurnTimeout = async function withTurnTimeout<T>(
  run: () => Promise<T>,
  abort: () => Promise<void>,
  timeoutMs = CHAT_TURN_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let aborting: Promise<void> | undefined;
  // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      aborting = Promise.resolve()
        .then(abort)
        .catch(() => {
          /* No action is needed until this callback is replaced or invoked by its owner. */
        });
      reject(new ChatTurnTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), expired]);
  } finally {
    clearTimeout(timer);
    if (aborting) {
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        aborting,
        // oxlint-disable-next-line promise/avoid-new -- Bridge an event or callback API to the asynchronous operation.
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, 5000);
        }),
      ]);
      clearTimeout(grace);
    }
  }
};
export const CHAT_TURN_TIMEOUT_MS = 10 * 60_000;
