const INFRASTRUCTURE_FAILURE = /\bXvfb\b|\bX server\b|servidor X|display\s*:?\s*\d+|EADDRINUSE|BrowserUnavailableError|browserType\.launch|could(?:n['’]t| not) start (?:its |the )?browser|(?:browser|chromium|navegador).{0,80}(?:failed to (?:start|launch)|could not (?:start|launch)|não iniciou|não foi iniciado)|executable doesn't exist|failed to launch.{0,30}browser|(?:LLM|model|provider).{0,60}(?:not configured|not authenticated|unavailable|rate limit)|No LLM model|No API key|MCP.{0,40}(?:disconnected|connection closed|failed to connect)|(?:OpenAI|Anthropic|Copilot).{0,40}(?:401|429|authentication)/i;

export function isInfrastructureFailure(text: string): boolean {
    return INFRASTRUCTURE_FAILURE.test(text)
        || /\b(?:Your model provider|The model provider could not|Specbook could not reach your model provider|Specbook could not complete this conversation turn|The selected model is unavailable|This conversation turn took too long|The browser (?:could not start|did not start in time|process stopped before it was ready))\b/i.test(text);
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
