"use client";

import { useRef, useState } from "react";
import { Check, Clipboard, Unplug } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { copyText, selectElementText } from "@/lib/clipboard";
import { useProjectTunnels } from "@/lib/useProjectTunnels";
import { cn } from "@/lib/utils";

export function TunnelConnectionNotice({ projectId, className }: { projectId: string; className?: string }) {
    const { tunnels, error } = useProjectTunnels(projectId);
    const [copied, setCopied] = useState(false);
    const [copyError, setCopyError] = useState(false);
    const commandRef = useRef<HTMLElement | null>(null);
    const production = tunnels?.find((tunnel) => tunnel.environmentName === "Production");
    if (!error && (!production || production.connected)) return null;
    async function copyCommand() {
        if (!production) return;
        if (await copyText(production.command)) { setCopied(true); setCopyError(false); }
        else { setCopied(false); setCopyError(true); selectElementText(commandRef.current); }
    }
    return <Alert className={cn("flex items-start gap-3", className)} role={error ? "alert" : undefined}>
        <Unplug size={16} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1"><AlertTitle>{error ? "Tunnel status is unavailable" : "Connect a tunnel to explore this app"}</AlertTitle><AlertDescription>{error ? "Connection details could not load. Check the server connection, or start the tunnel again." : `Production uses the server's browsers through a tunnel in group ${production?.group}. Runs wait until it connects.`}</AlertDescription>{production && <><p className="mt-2 text-control text-ink-muted">Inside your private network, set <code className="font-mono text-meta">SPECBOOK_URL</code> and <code className="font-mono text-meta">SPECBOOK_RUNNER_TOKEN</code> to a tunnel token, then run:</p><code ref={commandRef} tabIndex={0} aria-label="Tunnel command" className="mt-1 block overflow-x-auto whitespace-nowrap rounded-sm pb-1 font-mono text-meta text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring">{production.command}</code><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void copyCommand()} aria-live="polite">{copied ? <Check size={13} /> : <Clipboard size={13} />}{copied ? "Copied" : "Copy tunnel command"}</Button>{copyError && <p className="mt-2 text-meta text-danger" role="alert">Clipboard unavailable. The command is selected; press Ctrl+C or Cmd+C to copy it.</p>}</>}</div>
    </Alert>;
}
