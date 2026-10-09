import { listSecretValues } from "./profiles";

const MIN_SECRET_LENGTH = 4;
const LABEL = "••••";

function xmlEscaped(value: string, quotes: boolean): string {
    const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return quotes ? escaped.replace(/"/g, "&quot;").replace(/'/g, "&#x27;") : escaped;
}

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

const TRANSIENT_TTL_MS = 30 * 60_000;
const transientSecrets = new Map<string, Map<string, number>>();

export function registerTransientSecret(projectId: string, value: string): void {
    const values = transientSecrets.get(projectId) ?? new Map<string, number>();
    values.set(value, Date.now() + TRANSIENT_TTL_MS);
    transientSecrets.set(projectId, values);
}

function liveTransientSecrets(projectId: string): string[] {
    const values = transientSecrets.get(projectId);
    if (!values) return [];
    const now = Date.now();
    for (const [value, expiresAt] of values) if (expiresAt < now) values.delete(value);
    return [...values.keys()];
}

export async function projectSecretScrubber(projectId: string, options: { identifiers?: boolean } = {}): Promise<(text: string) => string> {
    return createSecretScrubber([...(await listSecretValues(projectId, options)).map((secret) => secret.value), ...liveTransientSecrets(projectId)]);
}

export function createProjectScrubber(projectId: string, options: { identifiers?: boolean } = {}) {
    return Object.assign(async (text: string) => (await projectSecretScrubber(projectId, options))(text), {
        async batch(values: string[]): Promise<string[]> {
            const scrub = await projectSecretScrubber(projectId, options);
            return values.map(scrub);
        },
    });
}
