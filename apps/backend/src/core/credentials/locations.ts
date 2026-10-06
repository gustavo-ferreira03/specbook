export const encryptedColumns = [
    { table: "credential_profiles", column: "fields", json: "fields" },
    { table: "chat_sessions", column: "state" },
    { table: "project_automations", column: "webhook_url", id: "project_id" },
    { table: "webhook_notifications", column: "webhook_url" },
    { table: "app_settings", column: "sso", json: "sso" },
    { table: "oidc_states", column: "pkce_verifier", id: "state_hash" },
] as const;

export function transformSecretColumn(value: string, format: string | undefined, transform: (secret: string) => string): string {
    if (format === "fields") {
        const fields = JSON.parse(value) as { key: string; value: string }[];
        return JSON.stringify(fields.map((field) => ({ ...field, value: transform(field.value) })));
    }
    if (format === "sso") {
        const settings = JSON.parse(value) as { clientSecret?: string | null };
        return JSON.stringify({ ...settings, ...(settings.clientSecret ? { clientSecret: transform(settings.clientSecret) } : {}) });
    }
    return transform(value);
}
