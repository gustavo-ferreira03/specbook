"use client";

import { useRef } from "react";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

const FINAL = new Set(["passed", "failed", "error", "invalid"]);

export function StatusPill({ status, kind = "spec", size = "default", className }: { status: string; kind?: "spec" | "run"; size?: "default" | "sm"; className?: string }) {
    const meta = statusMeta(status);
    const Icon = meta.icon;
    const previous = useRef(status);
    const settled = useRef(false);
    if (previous.current !== status) {
        settled.current = previous.current === "running" && FINAL.has(status);
        previous.current = status;
    }
    return (
        <span className={cn("inline-flex w-fit shrink-0 items-center gap-1.5 text-meta font-medium whitespace-nowrap", size === "sm" ? "h-5" : "h-6", status === "flaky" && "rounded-full border-(length:--stroke) border-warning-icon px-2 shadow-[2px_2px_0_var(--color-warning-icon)]", meta.text, className)} title={meta.description || undefined}>
            <Icon
                key={settled.current ? `${status}-settled` : status}
                size={size === "sm" ? 12 : 13}
                strokeWidth={2.25}
                aria-hidden="true"
                className={cn(meta.iconColor, status === "running" && "animate-spin motion-reduce:animate-none", settled.current && "status-stamp")}
            />
            {kind === "run" ? meta.runLabel : meta.label}
        </span>
    );
}
