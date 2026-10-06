"use client";

import { useCallback, useSyncExternalStore } from "react";

const DEFAULT_ENVIRONMENT = "Production";
const CHANGE_EVENT = "specbook:run-environment-change";

function storageKey(projectId: string) {
    return `specbook:run-environment:${projectId}`;
}

function read(projectId: string): string {
    try {
        return window.localStorage.getItem(storageKey(projectId)) || DEFAULT_ENVIRONMENT;
    } catch {
        return DEFAULT_ENVIRONMENT;
    }
}

function subscribe(onChange: () => void) {
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
        window.removeEventListener(CHANGE_EVENT, onChange);
        window.removeEventListener("storage", onChange);
    };
}

/**
 * The environment runs target in this project. One choice is shared by every page and the sidebar,
 * so the selector shown next to a Run button always matches what the other run actions use.
 */
export function useRunEnvironment(projectId: string): [string, (environment: string) => void] {
    const environment = useSyncExternalStore(subscribe, () => read(projectId), () => DEFAULT_ENVIRONMENT);
    const setEnvironment = useCallback((next: string) => {
        try {
            if (next === DEFAULT_ENVIRONMENT) window.localStorage.removeItem(storageKey(projectId));
            else window.localStorage.setItem(storageKey(projectId), next);
        } catch {
            // Storage can be unavailable; the event still updates this tab.
        }
        window.dispatchEvent(new Event(CHANGE_EVENT));
    }, [projectId]);
    return [environment, setEnvironment];
}
