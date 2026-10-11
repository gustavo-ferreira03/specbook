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
