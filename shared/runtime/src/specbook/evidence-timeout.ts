export async function withEvidenceTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation(),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Browser evidence timed out")), timeoutMs); }),
        ]);
    } finally { clearTimeout(timer); }
}
