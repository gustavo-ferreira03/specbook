"use client";

import { Monitor } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { VncViewer, type VncStatus } from "@/components/VncViewer";
import { cn } from "@/lib/utils";

const WIDE_QUERY = "(min-width: 1280px)";

function subscribeWide(listener: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export function useWideLayout(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false
  );
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

export function LiveBrowser({
  sessionId,
  origin,
  variant,
}: {
  sessionId: string;
  origin: string;
  variant: "pane" | "inline";
}) {
  const [status, setStatus] = useState<VncStatus>("connecting");
  const copy = STATUS_COPY[status];
  const pane = variant === "pane";
  return (
    <section
      aria-label="Live browser"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden",
        pane
          ? "border-line bg-surface h-full rounded-xl border shadow-xs"
          : "border-line bg-surface mt-5 rounded-xl border shadow-xs"
      )}
    >
      <header className="border-line bg-surface-soft flex h-11 shrink-0 items-center gap-2.5 border-b px-3.5">
        <Monitor
          size={14}
          className="text-ink-subtle shrink-0"
          aria-hidden="true"
        />
        <h2 className="text-control text-ink font-semibold">Live browser</h2>
        {origin && (
          <span
            className="text-meta text-ink-subtle min-w-0 truncate font-mono"
            title={origin}
          >
            {origin}
          </span>
        )}
        <span
          className="text-meta text-ink-muted ml-auto flex shrink-0 items-center gap-1.5"
          role="status"
        >
          <span
            className={cn("size-1.5 rounded-full", copy.dot)}
            aria-hidden="true"
          />
          <span className={status === "connected" ? "sr-only" : undefined}>
            {copy.label}
          </span>
        </span>
      </header>
      <div
        className={cn(
          "bg-browser w-full",
          pane ? "min-h-0 flex-1" : "aspect-[16/10] max-h-[340px]"
        )}
      >
        <VncViewer vncSessionId={sessionId} onStatusChange={setStatus} />
      </div>
      <p className="border-line text-meta text-ink-subtle shrink-0 border-t px-3.5 py-2">
        View only. The agent is driving this browser.
      </p>
    </section>
  );
}
