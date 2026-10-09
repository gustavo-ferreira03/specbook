"use client";

import { useEffect, useRef } from "react";

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
