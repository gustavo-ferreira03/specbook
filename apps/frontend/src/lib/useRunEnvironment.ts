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

export function useRunEnvironment(projectId: string): [string, (environment: string) => void] {
    const environment = useSyncExternalStore(subscribe, () => read(projectId), () => DEFAULT_ENVIRONMENT);
    const setEnvironment = useCallback((next: string) => {
        try {
            if (next === DEFAULT_ENVIRONMENT) window.localStorage.removeItem(storageKey(projectId));
            else window.localStorage.setItem(storageKey(projectId), next);
        } catch {
        }
        window.dispatchEvent(new Event(CHANGE_EVENT));
    }, [projectId]);
    return [environment, setEnvironment];
}
