"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WS_URL } from "@/lib/api";

export type VncStatus = "connecting" | "connected" | "error";

export function VncViewer({ vncSessionId, onStatusChange }: { vncSessionId: string; onStatusChange?: (status: VncStatus) => void }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<VncStatus>("connecting");
    const [error, setError] = useState("");
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        let connection: InstanceType<(typeof import("@novnc/novnc"))["default"]> | null = null;
        let cancelled = false;
        setStatus("connecting");
        setError("");
        container.replaceChildren();

        const handleConnect: EventListener = () => {
            if (!cancelled) setStatus("connected");
        };
        const handleDisconnect: EventListener = (event) => {
            if (cancelled) return;
            const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean;
            setError(clean ? "The browser stream ended." : "The browser connection was interrupted.");
            setStatus("error");
        };
        const handleSecurityFailure: EventListener = (event) => {
            if (cancelled) return;
            const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
            setError(reason || "The browser connection could not be secured.");
            setStatus("error");
        };

        async function connect() {
            try {
                const { default: noVNC } = await import("@novnc/novnc");
                if (cancelled || !containerRef.current) return;
                connection = new noVNC(containerRef.current, `${WS_URL}/vnc/${encodeURIComponent(vncSessionId)}`, { shared: true });
                connection.background = getComputedStyle(document.documentElement).getPropertyValue("--color-browser").trim() || "black";
                connection.scaleViewport = true;
                connection.viewOnly = true;
                connection.addEventListener("connect", handleConnect);
                connection.addEventListener("disconnect", handleDisconnect);
                connection.addEventListener("securityfailure", handleSecurityFailure);
            } catch (connectError) {
                if (cancelled) return;
                setError(connectError instanceof Error ? connectError.message : String(connectError));
                setStatus("error");
            }
        }

        void connect();
        return () => {
            cancelled = true;
            if (connection) {
                connection.removeEventListener("connect", handleConnect);
                connection.removeEventListener("disconnect", handleDisconnect);
                connection.removeEventListener("securityfailure", handleSecurityFailure);
                connection.disconnect();
            }
            container.replaceChildren();
        };
    }, [retryKey, vncSessionId]);

    useEffect(() => {
        onStatusChange?.(status);
    }, [onStatusChange, status]);

    return (
        <div className="relative h-full min-h-0 w-full overflow-hidden bg-browser">
            <div ref={containerRef} className="h-full w-full overflow-hidden" />
            {status === "connecting" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-browser text-control text-white/70" role="status">
                    <span className="flex gap-1" aria-hidden="true">
                        <span className="status-pulse size-1.5 rounded-full bg-white/80" />
                        <span className="status-pulse size-1.5 rounded-full bg-white/80 [animation-delay:200ms]" />
                        <span className="status-pulse size-1.5 rounded-full bg-white/80 [animation-delay:400ms]" />
                    </span>
                    Connecting to the live browser
                </div>
            )}
            {status === "error" && (
                <div className="absolute inset-0 flex items-center justify-center bg-browser px-5 text-center">
                    <Alert className="max-w-xs border-0 bg-transparent p-0 text-white" role="alert">
                        <span className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-white/10">
                            <AlertCircle className="text-white/80" size={18} aria-hidden="true" />
                        </span>
                        <p className="mb-4 text-control text-white/80">{error}</p>
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => setRetryKey((key) => key + 1)}
                            className="bg-white text-black shadow-none hover:bg-white/85 focus-visible:ring-white focus-visible:ring-offset-browser"
                        >
                            <RefreshCw size={13} /> Reconnect
                        </Button>
                    </Alert>
                </div>
            )}
        </div>
    );
}
