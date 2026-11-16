"use client";

import { useSyncExternalStore } from "react";

import { THEME_STORAGE_KEY } from "./theme-script";

export { THEME_STORAGE_KEY };

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_EVENT = "specbook:theme-change";

const readPreference = function readPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
};

const systemPrefersDark = function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

export const resolveTheme = function resolveTheme(
  preference: ThemePreference
): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark() ? "dark" : "light";
  }
  return preference;
};

const applyTheme = function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveTheme(preference) === "dark");
  root.dataset.theme = preference;
};

export const setThemePreference = function setThemePreference(
  preference: ThemePreference
) {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Keep the last usable state if this optional operation fails.
  }
  applyTheme(preference);
  window.dispatchEvent(new Event(THEME_EVENT));
};

const subscribe = function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystem = () => {
    if (readPreference() === "system") {
      applyTheme("system");
    }
    onChange();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) {
      return;
    }
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
};

export const useThemePreference =
  function useThemePreference(): ThemePreference {
    return useSyncExternalStore(subscribe, readPreference, () => "system");
  };
