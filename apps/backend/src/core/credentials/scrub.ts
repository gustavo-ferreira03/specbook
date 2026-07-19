import { listSecretValues } from "./profiles";

const MIN_SECRET_LENGTH = 4;

export async function createProjectScrubber(projectId: string): Promise<(text: string) => string> {
    const entries = (await listSecretValues(projectId))
        .filter((secret) => secret.value.length >= MIN_SECRET_LENGTH)
        .flatMap((secret) => {
            const label = `[REDACTED:${secret.profile}.${secret.field}]`;
            const encoded = encodeURIComponent(secret.value);
            const pairs: [string, string][] = [[secret.value, label]];
            if (encoded !== secret.value) pairs.push([encoded, label]);
            return pairs;
        })
        .sort((a, b) => b[0].length - a[0].length);
    if (entries.length === 0) return (text) => text;
    return (text) => entries.reduce((acc, [needle, label]) => acc.split(needle).join(label), text);
}
