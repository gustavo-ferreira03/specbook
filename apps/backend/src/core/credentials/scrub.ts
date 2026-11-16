import { scrubJsonText } from "@specbook/runtime/scrub";

import { listCredentialValues } from "./profiles";

const xmlEscaped = function xmlEscaped(value: string, quotes: boolean): string {
  const escaped = value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return quotes
    ? escaped.replaceAll('"', "&quot;").replaceAll("'", "&#x27;")
    : escaped;
};

export const createSecretScrubber = function createSecretScrubber(
  values: string[]
): (text: string) => string {
  const needles = new Set<string>();
  for (const value of values) {
    if (value.length === 0) {
      continue;
    }
    needles.add(value);
    needles.add(encodeURIComponent(value));
    needles.add(xmlEscaped(value, false));
    needles.add(xmlEscaped(value, true));
    needles.add(JSON.stringify(value).slice(1, -1));
  }
  const sorted = [...needles].toSorted((a, b) => b.length - a.length);
  const replace = (text: string) => {
    let masked = text;
    for (const needle of sorted) {
      masked = masked.split(needle).join(LABEL);
    }
    return masked;
  };
  return (text) => scrubJsonText(text, replace);
};

export const registerTransientSecret = function registerTransientSecret(
  projectId: string,
  value: string
): void {
  const values = transientSecrets.get(projectId) ?? new Map<string, number>();
  values.set(value, Date.now() + TRANSIENT_TTL_MS);
  transientSecrets.set(projectId, values);
};

const liveTransientSecrets = function liveTransientSecrets(
  projectId: string
): string[] {
  const values = transientSecrets.get(projectId);
  if (!values) {
    return [];
  }
  const now = Date.now();
  for (const [value, expiresAt] of values) {
    if (expiresAt < now) {
      values.delete(value);
    }
  }
  return [...values.keys()];
};

export const projectSecretScrubber = async function projectSecretScrubber(
  projectId: string
): Promise<(text: string) => string> {
  const fields = await listCredentialValues(projectId);
  const sensitive = new Set(
    fields.filter((field) => field.sensitive).map((field) => field.value)
  );
  const visible = new Set(
    fields.filter((field) => !field.sensitive).map((field) => field.value)
  );
  const transient = liveTransientSecrets(projectId).filter(
    (value) => !visible.has(value) || sensitive.has(value)
  );
  return createSecretScrubber([...sensitive, ...transient]);
};

export const createProjectScrubber = function createProjectScrubber(
  projectId: string
) {
  return Object.assign(
    async (text: string) => (await projectSecretScrubber(projectId))(text),
    {
      async batch(values: string[]): Promise<string[]> {
        const scrub = await projectSecretScrubber(projectId);
        return values.map(scrub);
      },
    }
  );
};

const LABEL = "••••";

const TRANSIENT_TTL_MS = 30 * 60_000;
const transientSecrets = new Map<string, Map<string, number>>();
