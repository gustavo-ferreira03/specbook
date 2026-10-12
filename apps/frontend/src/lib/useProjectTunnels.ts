"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getProjectTunnels, isAbortError } from "./api";
import { matchesInvalidation, onInvalidate } from "./invalidation";
import type { ProjectTunnel } from "./types";
import { useVisiblePolling } from "./usePolling";

export function useProjectTunnels(projectId: string): { tunnels: ProjectTunnel[] | null; error: string } {
    const [tunnels, setTunnels] = useState<ProjectTunnel[] | null>(null);
    const [error, setError] = useState("");
    const request = useRef<AbortController | null>(null);
    const refresh = useCallback(() => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        getProjectTunnels(projectId, controller.signal).then(({ tunnels }) => {
            if (!controller.signal.aborted) { setTunnels(tunnels); setError(""); }
        }).catch((reason) => {
            if (!isAbortError(reason)) setError(errorMessage(reason));
        });
    }, [projectId]);
    useEffect(() => {
        setTunnels(null); setError(""); refresh();
        return () => request.current?.abort();
    }, [refresh]);
    useEffect(() => onInvalidate((event) => {
        if (matchesInvalidation(event, "projects", projectId)) refresh();
    }), [projectId, refresh]);
    useVisiblePolling(refresh, 5000);
    return { tunnels, error };
}
