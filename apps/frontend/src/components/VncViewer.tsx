"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WS_URL } from "@/lib/api";

export function VncViewer({ vncSessionId }: { vncSessionId: string }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
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
                connection.background = getComputedStyle(document.documentElement).getPropertyValue("--color-browser").trim() || "#11110f";
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

    return (
        <div className="relative h-full min-h-0 w-full overflow-hidden bg-browser">
            <div ref={containerRef} className="h-full w-full overflow-hidden" />
            {status === "connecting" && (
                <div className="absolute inset-0 flex items-center justify-center bg-browser text-[0.6875rem] font-medium text-white/75" role="status">
                    <span className="status-pulse mr-2 size-1.5 rounded-full bg-white" />
                    Connecting to live browser
                </div>
            )}
            {status === "error" && (
                <div className="absolute inset-0 flex items-center justify-center bg-browser px-5 text-center">
                    <Alert className="max-w-sm bg-transparent p-0 text-white" role="alert">
                        <AlertCircle className="mx-auto mb-3 text-white/70" size={22} />
                        <p className="mb-4 text-[0.71875rem] leading-5 text-white/80">{error}</p>
                        <Button
                            type="button"
                            onClick={() => setRetryKey((key) => key + 1)}
                            className="min-h-11 bg-white px-3 text-xs text-ink hover:bg-canvas md:min-h-9"
                        >
                            <RefreshCw size={13} /> Reconnect
                        </Button>
                    </Alert>
                </div>
            )}
        </div>
    );
}
