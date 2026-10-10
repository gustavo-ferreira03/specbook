import { HTTPException } from "hono/http-exception";
import { getPendingCredentialRequest, resolveCredentialRequest } from "./credential-requests";
import { loginFieldKeys } from "./credential-tools";
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
    for (const [key, value] of Object.entries(body.values)) if (pending.kind !== "login" || key !== "username") registerTransientSecret(pending.projectId, value);
    let inputs: { key: string; value?: string }[] = pending.fields.map((field) => ({
        key: field.key,
        value: body.values[field.key] ?? "",
    }));
    if (inputs.some((input) => input.value === "")) {
        throw new HTTPException(400, { message: "Fill every requested field." });
    }
    if (pending.kind === "code") {
        resolveCredentialRequest(chatId, requestId, { code: inputs[0].value! });
        return { ok: true };
    }
    const existing = await getProfileByName(pending.projectId, pending.profileName);
    if (pending.kind === "login" && pending.origin) {
        const fieldKeys = existing && existing.identifier === null ? loginFieldKeys(existing.fields.map((field) => field.key)) : null;
        const passwordKey = (existing ? loginFieldKeys(existing.fields.map((field) => field.key)).password : undefined) ?? "password";
        const identifierField = fieldKeys?.identifier;
        inputs = [
            ...(identifierField ? [{ key: identifierField, value: body.values.username }] : []),
            { key: passwordKey, value: body.values.password },
            ...(existing?.fields ?? []).filter((field) => field.key !== passwordKey && field.key !== identifierField).map((field) => ({ key: field.key })),
        ];
        const identifier = identifierField ? undefined : body.values.username;
        const allowedOrigins = [...new Set([...(existing?.allowedOrigins ?? []), pending.origin])];
        if (existing) await updateProfile(existing, { allowedOrigins, fields: inputs, identifier });
        else await createProfile(pending.projectId, { name: pending.profileName, allowedOrigins, fields: inputs, identifier });
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
