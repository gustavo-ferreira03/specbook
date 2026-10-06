export const CHAT_TURN_TIMEOUT_MS = 10 * 60_000;

export class ChatTurnTimeoutError extends Error {
    constructor() {
        super("This conversation turn took too long and was stopped. Try a smaller request or test your model connection in global Settings.");
    }
}

export async function withTurnTimeout<T>(run: () => Promise<T>, abort: () => Promise<void>, timeoutMs = CHAT_TURN_TIMEOUT_MS): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let aborting: Promise<void> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            aborting = Promise.resolve().then(abort).catch(() => undefined);
            reject(new ChatTurnTimeoutError());
        }, timeoutMs);
    });
    try {
        return await Promise.race([run(), expired]);
    } finally {
        clearTimeout(timer);
        if (aborting) {
            let grace: NodeJS.Timeout | undefined;
            await Promise.race([aborting, new Promise<void>((resolve) => { grace = setTimeout(resolve, 5_000); })]);
            clearTimeout(grace);
        }
    }
}
