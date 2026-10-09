import { z } from "zod";

export const errorCodeSchema = z.enum(["infrastructure", "provider_auth", "provider_limit", "provider_model", "provider_connection", "provider_error", "environment", "credentials", "credential_origin", "assertion", "locator", "invalid_spec", "repository_dirty", "failed", "cancelled"]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export class CodedError extends Error {
    constructor(public readonly code: ErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
    }
}

export function errorCodeOf(error: unknown): ErrorCode | undefined {
    if (!error || typeof error !== "object") return undefined;
    const value = error as { code?: unknown; errorCode?: unknown; cause?: unknown };
    const parsed = errorCodeSchema.safeParse(value.errorCode ?? value.code);
    return parsed.success ? parsed.data : value.cause && value.cause !== error ? errorCodeOf(value.cause) : undefined;
}

export function providerErrorCode(error: unknown): ErrorCode {
    const known = errorCodeOf(error);
    if (known) return known;
    const value = error && typeof error === "object" ? error as { status?: number; statusCode?: number; code?: string } : {};
    const status = value.status ?? value.statusCode;
    if (status === 401 || status === 403) return "provider_auth";
    if (status === 429) return "provider_limit";
    if (status === 404) return "provider_model";
    if (status && status >= 500 || ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"].includes(value.code ?? "")) return "provider_connection";
    return "provider_error";
}

export function isInfrastructureCode(code: ErrorCode): boolean {
    return code === "infrastructure" || code.startsWith("provider_");
}

export function specErrorCode(error: unknown): ErrorCode {
    const known = errorCodeOf(error);
    if (known) return known;
    if (error && typeof error === "object") {
        if ("matcherResult" in error) return "assertion";
        if ("name" in error && error.name === "TimeoutError") return "locator";
    }
    return "failed";
}
