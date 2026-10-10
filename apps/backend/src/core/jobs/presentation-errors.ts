import { isInfrastructureCode, type ErrorCode } from "../errors";
const INFRASTRUCTURE_FAILURE = /\bXvfb\b|\bX server\b|servidor X|display\s*:?\s*\d+|EADDRINUSE|BrowserUnavailableError|browserType\.launch|could(?:n['’]t| not) start (?:its |the )?browser|(?:browser|chromium|navegador).{0,80}(?:failed to (?:start|launch)|could not (?:start|launch)|não iniciou|não foi iniciado)|executable doesn't exist|failed to launch.{0,30}browser|(?:LLM|model|provider).{0,60}(?:not configured|not authenticated|unavailable|rate limit)|No LLM model|No API key|MCP.{0,40}(?:disconnected|connection closed|failed to connect)|(?:OpenAI|Anthropic|Copilot).{0,40}(?:401|429|authentication)/i;

export function isInfrastructureFailure(text: string, code?: ErrorCode | null): boolean {
    if (code) return isInfrastructureCode(code);
    return INFRASTRUCTURE_FAILURE.test(text)
        || /\b(?:Your model provider|The model provider could not|Specbook could not reach your model provider|Specbook could not complete this conversation turn|The selected model is unavailable|This conversation turn took too long|The browser (?:could not start|did not start in time|process stopped before it was ready|could not inspect its open tabs|could not confirm (?:or inspect )?(?:the current|the application) page address)|The current browser snapshot could not be read|Browser is already in use)\b/i.test(text)
        || /browser tool failed:.{0,200}(?:EROFS|EACCES|read-only file system|permission denied)/is.test(text);
}

export function providerFailure(error: unknown): { code: string; message: string; nextStep: string } {
    const text = error instanceof Error ? error.message : String(error);
    if (/429|rate.?limit|too many requests|quota|credit.balance|insufficient.funds/i.test(text)) {
        return { code: "provider_limit", message: "Your model provider has reached its request or usage limit.", nextStep: "Wait a moment and try again, or check your provider account's limits." };
    }
    if (/401|403|invalid.{0,20}(?:key|token)|authentication|unauthori[sz]ed|not authenticated|No API key|expired.{0,20}(?:token|session)|credential/i.test(text)) {
        return { code: "provider_auth", message: "Your model provider could not verify the connection.", nextStep: "Open global Settings and reconnect the provider or replace its API key." };
    }
    if (/model.{0,80}(?:not found|unavailable|does not exist|not supported|not configured)|model_not_found|No LLM model|404/i.test(text)) {
        return { code: "provider_model", message: "The selected model is unavailable.", nextStep: "Open global Settings and select an available model." };
    }
    if (/timed?\s*out|timeout|ETIMEDOUT|ECONN|ENOTFOUND|fetch failed|network|502|503|504/i.test(text)) {
        return { code: "provider_connection", message: "Specbook could not reach your model provider.", nextStep: "Check the server's internet connection and try again." };
    }
    return { code: "provider_error", message: "The model provider could not complete this response.", nextStep: "Try again. If it keeps failing, test the connection in global Settings." };
}

export function providerFailureMessage(error: unknown): string {
    const failure = providerFailure(error);
    return `${failure.message} ${failure.nextStep}`;
}

export function oauthFailureMessage(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    if (/EADDRINUSE|Port 1455 is in use/i.test(text)) {
        return "Another sign-in is using the callback port (1455). Finish or cancel it, then try again.";
    }
    if (/OAuth state mismatch/i.test(text)) {
        return "This sign-in link has been replaced or expired. Start sign-in again and use the new link.";
    }
    if (/callback URL|Missing authorization code|Missing OAuth state|callback did not contain an issued client ID/i.test(text)) {
        return "Paste the complete address from the final sign-in page, then try again.";
    }
    if (/requires a device ID/i.test(text)) {
        return "Specbook could not initialize sign-in. Restart Specbook and try again.";
    }
    if (/cancelled|canceled|session expired|AbortError/i.test(text)) {
        return "Sign-in was cancelled or expired. Start sign-in again.";
    }
    const failure = providerFailure(error);
    if (failure.code === "provider_auth") return "The provider could not authorize sign-in. Start sign-in again and check your account's access.";
    if (failure.code !== "provider_error") return `${failure.message} ${failure.nextStep}`;
    return "Sign-in could not be completed. Start sign-in again.";
}

export function browserFailureMessage(error: unknown): string {
    const text = error instanceof Error ? `${error.message} ${error.cause ?? ""}` : String(error);
    if (/ENOENT|executable doesn't exist|command not found/i.test(text)) {
        return "The browser could not start because a required program is missing. Open System status in global Settings to see what needs installing.";
    }
    if (/display.{0,40}(?:in use|already|occupied)|already active|EADDRINUSE|Cannot establish any listening sockets/i.test(text)) {
        return "The browser could not start because its display is already in use. Restart Specbook to release its browser processes, then try again.";
    }
    if (/EACCES|permission denied|not permitted/i.test(text)) {
        return "The browser could not start because the server denied permission. Check the container permissions and System status in global Settings.";
    }
    if (/timed?\s*out|did not become ready|timeout/i.test(text)) {
        return "The browser did not start in time. Check available memory and System status in global Settings, then try again.";
    }
    return "The browser process stopped before it was ready. Check System status in global Settings and the server logs, then try again.";
}

export function sanitizeTechnicalDetails(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, "")
        .split("\n")
        .filter((line) => !/^\s*at(?:\s|$)/.test(line) && !/^\s*>?\s*\d+\s*\|/.test(line) && !/^\s*(?:\|\s*)?\^+\s*$/.test(line)
            && !/(?:src[\\/]core[\\/]runner|apps[\\/]backend[\\/]src|node_modules)/.test(line))
        .map((line) => line
            .replace(/https?:\/\/[^\s"'`<>)]*|(?:file:\/\/)?(?:\b[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var|app|workspace|root|mnt|opt|srv|storage|code|build|data)\/)[^\s"'`<>)]*/g, (value) => /^https?:\/\//.test(value) ? value : "[server path]")
            .replace(/(?:\.\.[\\/])+(?:src|storage)[^\s"'`<>)]*/g, "[server path]"))
        .join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 16000);
}

export function isCredentialFailure(text: string, code?: ErrorCode | null, context: "triage" | "prerequisite" = "triage"): boolean {
    if (code) return code === "credentials" || code === "credential_origin";
    return context === "triage" ? /credential|session|login|sign.in|authentication|credencia|sessão/i.test(text)
        : /credential|password|session|sign.?in|authentication/i.test(text);
}

export function runFailureKind(run: { errorCode?: ErrorCode | null; status: string; failReason: string | null }): string {
    if (run.errorCode) {
        if (isInfrastructureCode(run.errorCode) || ["environment", "credentials", "credential_origin"].includes(run.errorCode)) return "environment";
        return run.errorCode === "assertion" || run.errorCode === "locator" ? run.errorCode : "failed";
    }
    const reason = run.failReason ?? "";
    return run.status === "error" || /net::|ECONN|ENOTFOUND|connection refused|session expired/i.test(reason) ? "environment"
        : /expect\(|AssertionError|Expected:|Received:|to[A-Z]\w+/.test(reason) ? "assertion"
        : /locator|TimeoutError|waiting for|strict mode/i.test(reason) ? "locator" : "failed";
}

