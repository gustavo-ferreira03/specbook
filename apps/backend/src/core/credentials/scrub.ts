import { listSecretValues } from "./profiles";

const MIN_SECRET_LENGTH = 4;

export function createProjectScrubber(projectId: string): (text: string) => Promise<string> {
    return async (text) => {
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
        return entries.reduce((acc, [needle, label]) => acc.split(needle).join(label), text);
    };
}
