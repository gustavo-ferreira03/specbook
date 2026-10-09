"use client";

import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "./theme-script";

export { THEME_STORAGE_KEY };

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_EVENT = "specbook:theme-change";

function readPreference(): ThemePreference {
    try {
        const value = window.localStorage.getItem(THEME_STORAGE_KEY);
        return value === "light" || value === "dark" ? value : "system";
    } catch {
        return "system";
    }
}

function systemPrefersDark(): boolean {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
    if (preference === "system") return systemPrefersDark() ? "dark" : "light";
    return preference;
}

function applyTheme(preference: ThemePreference) {
    const root = document.documentElement;
    root.classList.toggle("dark", resolveTheme(preference) === "dark");
    root.dataset.theme = preference;
}

export function setThemePreference(preference: ThemePreference) {
    try {
        if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
        else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
    }
    applyTheme(preference);
    window.dispatchEvent(new Event(THEME_EVENT));
}

function subscribe(onChange: () => void) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystem = () => {
        if (readPreference() === "system") applyTheme("system");
        onChange();
    };
    const handleStorage = (event: StorageEvent) => {
        if (event.key !== THEME_STORAGE_KEY) return;
        applyTheme(readPreference());
        onChange();
    };
    media.addEventListener("change", handleSystem);
    window.addEventListener("storage", handleStorage);
    window.addEventListener(THEME_EVENT, onChange);
    return () => {
        media.removeEventListener("change", handleSystem);
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener(THEME_EVENT, onChange);
    };
}

export function useThemePreference(): ThemePreference {
    return useSyncExternalStore(subscribe, readPreference, () => "system");
}
