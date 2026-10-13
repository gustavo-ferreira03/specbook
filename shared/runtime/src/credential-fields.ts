const PUBLIC_BY_DEFAULT = new Set(["username", "user", "email", "login", "identifier"]);

export function isSensitiveByDefault(field: string): boolean {
    return !PUBLIC_BY_DEFAULT.has(field.toLowerCase());
}

export function defaultSensitive(fields: string[]): string[] {
    return fields.filter(isSensitiveByDefault);
}
