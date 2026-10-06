import { listSecretValues } from "./profiles";

const MIN_SECRET_LENGTH = 4;
const LABEL = "••••";

function xmlEscaped(value: string, quotes: boolean): string {
    const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return quotes ? escaped.replace(/"/g, "&quot;").replace(/'/g, "&#x27;") : escaped;
}

/** Builds a synchronous scrubber that masks the given secret values and their common encodings. */
export function createSecretScrubber(values: string[]): (text: string) => string {
    const needles = new Set<string>();
    for (const value of values) {
        if (value.length < MIN_SECRET_LENGTH) continue;
        needles.add(value);
        needles.add(encodeURIComponent(value));
        needles.add(xmlEscaped(value, false));
        needles.add(xmlEscaped(value, true));
        needles.add(JSON.stringify(value).slice(1, -1));
    }
    const sorted = [...needles].sort((a, b) => b.length - a.length);
    return (text) => sorted.reduce((acc, needle) => acc.split(needle).join(LABEL), text);
}

export async function projectSecretScrubber(projectId: string): Promise<(text: string) => string> {
    return createSecretScrubber((await listSecretValues(projectId)).map((secret) => secret.value));
}

export function createProjectScrubber(projectId: string): (text: string) => Promise<string> {
    return async (text) => (await projectSecretScrubber(projectId))(text);
}
