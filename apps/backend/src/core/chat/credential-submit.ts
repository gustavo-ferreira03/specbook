import { HTTPException } from "hono/http-exception";
import { getPendingCredentialRequest, resolveCredentialRequest } from "./credential-requests";
import { loginFieldKeys } from "../credentials/login-classifier";
import { createProfile, getProfileByName, updateProfile } from "../credentials/profiles";
import { registerTransientSecret } from "../credentials/scrub";

export type CredentialSubmission = { action: "dismiss" } | { action: "submit"; values: Record<string, string>; allowedOrigins?: string[] };

export async function submitChatCredentials(chatId: string, requestId: string, body: CredentialSubmission) {
    const pending = getPendingCredentialRequest(chatId);
    if (!pending || pending.id !== requestId || Date.now() - Date.parse(pending.createdAt) >= 10 * 60_000) {
        throw new HTTPException(404, { message: "Credential request not found" });
    }
    if (body.action === "dismiss") {
        resolveCredentialRequest(chatId, requestId, "dismissed");
        return { ok: true };
    }
    let inputs: { key: string; value?: string; sensitive: boolean }[] = pending.fields.map((field) => ({
        key: field.key,
        value: body.values[field.key] ?? "",
        sensitive: field.sensitive ?? !(pending.kind === "login" && field.key === "username"),
    }));
    for (const input of inputs) if (input.sensitive && input.value) registerTransientSecret(pending.projectId, input.value);
    if (inputs.some((input) => input.value === "")) {
        throw new HTTPException(400, { message: "Fill every requested field." });
    }
    if (pending.kind === "code") {
        resolveCredentialRequest(chatId, requestId, { code: inputs[0].value! });
        return { ok: true };
    }
    const existing = await getProfileByName(pending.projectId, pending.profileName);
    if (pending.kind === "login" && pending.origin) {
        const fieldKeys = loginFieldKeys(existing?.fields.map((field) => field.key) ?? []);
        const passwordKey = fieldKeys.password ?? "password";
        const usernameKey = fieldKeys.identifier ?? "username";
        inputs = [
            { key: usernameKey, value: body.values.username, sensitive: false },
            { key: passwordKey, value: body.values.password, sensitive: true },
            ...(existing?.fields ?? []).filter((field) => field.key !== passwordKey && field.key !== usernameKey)
                .map((field) => ({ key: field.key, sensitive: field.sensitive !== false })),
        ];
        const allowedOrigins = [...new Set([...(existing?.allowedOrigins ?? []), pending.origin])];
        if (existing) await updateProfile(existing, { allowedOrigins, fields: inputs });
        else await createProfile(pending.projectId, { name: pending.profileName, allowedOrigins, fields: inputs });
        resolveCredentialRequest(chatId, requestId, "saved");
        return { ok: true };
    }
    if (existing) {
        await updateProfile(existing, { allowedOrigins: body.allowedOrigins, fields: inputs });
    } else {
        await createProfile(pending.projectId, {
            name: pending.profileName,
            allowedOrigins: body.allowedOrigins,
            fields: inputs,
        });
    }
    resolveCredentialRequest(chatId, requestId, "saved");
    return { ok: true };
}
