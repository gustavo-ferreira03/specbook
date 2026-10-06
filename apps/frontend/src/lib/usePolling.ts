"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `poll` every `intervalMs` while the document is visible. Polling pauses in background tabs
 * and runs once as soon as the tab becomes visible again. The latest `poll` is always used, so
 * the interval is not restarted when the callback identity changes (e.g. on route changes).
 * The caller is responsible for the initial fetch.
 */
export function useVisiblePolling(poll: () => void, intervalMs: number): void {
    const pollRef = useRef(poll);
    useEffect(() => {
        pollRef.current = poll;
    });

    useEffect(() => {
        let timer: number | null = null;
        const startTimer = () => {
            if (timer === null) timer = window.setInterval(() => pollRef.current(), intervalMs);
        };
        const stopTimer = () => {
            if (timer !== null) {
                window.clearInterval(timer);
                timer = null;
            }
        };
        const handleVisibility = () => {
            if (document.hidden) {
                stopTimer();
                return;
            }
            pollRef.current();
            startTimer();
        };
        if (!document.hidden) startTimer();
        document.addEventListener("visibilitychange", handleVisibility);
        return () => {
            stopTimer();
            document.removeEventListener("visibilitychange", handleVisibility);
        };
    }, [intervalMs]);
}
