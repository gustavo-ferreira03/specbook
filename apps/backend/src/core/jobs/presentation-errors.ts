const INFRASTRUCTURE_FAILURE = /\bXvfb\b|\bX server\b|servidor X|display\s*:?\s*\d+|EADDRINUSE|BrowserUnavailableError|browserType\.launch|could(?:n['’]t| not) start (?:its |the )?browser|(?:browser|chromium|navegador).{0,80}(?:failed to (?:start|launch)|could not (?:start|launch)|não iniciou|não foi iniciado)|executable doesn't exist|failed to launch.{0,30}browser|(?:LLM|model|provider).{0,60}(?:not configured|not authenticated|unavailable|rate limit)|No LLM model|No API key|MCP.{0,40}(?:disconnected|connection closed|failed to connect)|(?:OpenAI|Anthropic|Copilot).{0,40}(?:401|429|authentication)/i;

export function isInfrastructureFailure(text: string): boolean {
    return INFRASTRUCTURE_FAILURE.test(text);
}

export function sanitizeTechnicalDetails(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, "")
        .split("\n")
        .filter((line) => !/^\s*at(?:\s|$)/.test(line) && !/^\s*>?\s*\d+\s*\|/.test(line) && !/^\s*(?:\|\s*)?\^+\s*$/.test(line)
            && !/(?:src[\\/]core[\\/]runner|apps[\\/]backend[\\/]src|node_modules)/.test(line))
        .map((line) => line
            .replace(/(?:file:\/\/)?(?:\b[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var|app|workspace|root|mnt|opt|srv|storage)\/)[^\s"'`<>)]*/g, "[server path]")
            .replace(/(?:\.\.[\\/])+(?:src|storage)[^\s"'`<>)]*/g, "[server path]"))
        .join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 16000);
}
