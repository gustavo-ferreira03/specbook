"use client";

import { useCallback, useSyncExternalStore } from "react";

const DEFAULT_ENVIRONMENT = "Production";
const CHANGE_EVENT = "specbook:run-environment-change";

const storageKey = function storageKey(projectId: string) {
  return `specbook:run-environment:${projectId}`;
};

const read = function read(projectId: string): string {
  try {
    return (
      window.localStorage.getItem(storageKey(projectId)) || DEFAULT_ENVIRONMENT
    );
  } catch {
    return DEFAULT_ENVIRONMENT;
  }
};

const subscribe = function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
};

export const useRunEnvironment = function useRunEnvironment(
  projectId: string
): [string, (environment: string) => void] {
  const environment = useSyncExternalStore(
    subscribe,
    () => read(projectId),
    () => DEFAULT_ENVIRONMENT
  );
  const setEnvironment = useCallback(
    (next: string) => {
      try {
        if (next === DEFAULT_ENVIRONMENT) {
          window.localStorage.removeItem(storageKey(projectId));
        } else {
          window.localStorage.setItem(storageKey(projectId), next);
        }
      } catch {
        // Keep the last usable state if this optional operation fails.
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [projectId]
  );
  return [environment, setEnvironment];
};
