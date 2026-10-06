"use client";

import { useState, useSyncExternalStore } from "react";
import { Monitor } from "lucide-react";
import { VncViewer, type VncStatus } from "@/components/VncViewer";
import { cn } from "@/lib/utils";

const WIDE_QUERY = "(min-width: 1280px)";

function subscribeWide(listener: () => void) {
    const query = window.matchMedia(WIDE_QUERY);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
}

/** True on screens wide enough to show the live browser beside the conversation. */
export function useWideLayout(): boolean {
    return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => false);
}

export function originOf(url: string | null | undefined): string {
    if (!url) return "";
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

const STATUS_COPY: Record<VncStatus, { label: string; dot: string }> = {
    connecting: { label: "Connecting", dot: "status-pulse bg-ink-subtle" },
    connected: { label: "Live", dot: "bg-success" },
    error: { label: "Disconnected", dot: "bg-danger" },
};

/**
 * The agent's browser, view-only. `pane` fills the right column on wide screens; `inline` sits in
 * the conversation flow on narrower ones. Only one is mounted at a time, so there is one VNC
 * connection per chat.
 */
export function LiveBrowser({ sessionId, origin, variant }: { sessionId: string; origin: string; variant: "pane" | "inline" }) {
    const [status, setStatus] = useState<VncStatus>("connecting");
    const copy = STATUS_COPY[status];
    const pane = variant === "pane";
    return (
        <section
            aria-label="Live browser"
            className={cn(
                "flex min-h-0 flex-col overflow-hidden",
                pane ? "h-full rounded-xl border border-line bg-surface shadow-xs" : "mt-5 rounded-xl border border-line bg-surface shadow-xs",
            )}
        >
            <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line bg-surface-soft px-3.5">
                <Monitor size={14} className="shrink-0 text-ink-subtle" aria-hidden="true" />
                <h2 className="text-control font-semibold text-ink">Live browser</h2>
                {origin && <span className="min-w-0 truncate font-mono text-meta text-ink-subtle" title={origin}>{origin}</span>}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-meta text-ink-muted" role="status">
                    <span className={cn("size-1.5 rounded-full", copy.dot)} aria-hidden="true" />
                    {copy.label}
                </span>
            </header>
            <div className={cn("w-full bg-browser", pane ? "min-h-0 flex-1" : "aspect-[16/10] max-h-[340px]")}>
                <VncViewer vncSessionId={sessionId} onStatusChange={setStatus} />
            </div>
            <p className="shrink-0 border-t border-line px-3.5 py-2 text-meta text-ink-subtle">
                View only. The agent is driving this browser.
            </p>
        </section>
    );
}
