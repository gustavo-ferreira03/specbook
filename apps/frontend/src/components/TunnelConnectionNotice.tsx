"use client";

import { Unplug } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useProjectTunnels } from "@/lib/useProjectTunnels";
import { cn } from "@/lib/utils";

export function TunnelConnectionNotice({ projectId, className }: { projectId: string; className?: string }) {
    const { tunnels, error } = useProjectTunnels(projectId);
    const production = tunnels?.find((tunnel) => tunnel.environmentName === "Production");
    if (!production || production.connected && !error) return null;
    return <Alert className={cn("flex items-start gap-3", className)} role="status">
        <Unplug size={16} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden="true" />
        <div className="min-w-0"><AlertTitle>{error ? "Tunnel status is unavailable" : "Connect a tunnel to explore this app"}</AlertTitle><AlertDescription>{error ? "Connection details could not refresh. Check the server connection, or start the tunnel again." : `Production uses the server's browsers through a tunnel in group ${production.group}. Runs wait until it connects.`}</AlertDescription><p className="mt-2 text-control text-ink-muted">Inside your private network, set <code className="font-mono text-meta">SPECBOOK_URL</code> and <code className="font-mono text-meta">SPECBOOK_RUNNER_TOKEN</code>, then run:</p><code className="mt-1 block break-all font-mono text-meta text-ink">{production.command}</code></div>
    </Alert>;
}
