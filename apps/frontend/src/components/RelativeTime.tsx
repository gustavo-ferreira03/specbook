"use client";

import { useSyncExternalStore } from "react";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

// One shared minute ticker for every RelativeTime on the page.
const listeners = new Set<() => void>();
let timer: number | null = null;
let now = Date.now();

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (timer === null) {
        now = Date.now();
        timer = window.setInterval(() => {
            now = Date.now();
            listeners.forEach((notify) => notify());
        }, 30_000);
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
            window.clearInterval(timer);
            timer = null;
        }
    };
}

/** "5 minutes ago", with the absolute date and time in the tooltip and `dateTime` attribute. */
export function RelativeTime({ value, prefix, className }: { value: string | number | Date; prefix?: string; className?: string }) {
    const current = useSyncExternalStore(subscribe, () => now, () => now);
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return (
        <time dateTime={date.toISOString()} title={formatDateTime(date)} className={cn("tabular", className)} suppressHydrationWarning>
            {prefix ? `${prefix} ` : ""}{formatRelative(date, current)}
        </time>
    );
}
