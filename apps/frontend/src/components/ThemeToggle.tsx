"use client";

import { Moon, Sun } from "lucide-react";
import { resolveTheme, setThemePreference, useThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function ThemeToggle({ className }: { className?: string }) {
    const preference = useThemePreference();

    function toggle() {
        setThemePreference(resolveTheme(preference) === "dark" ? "light" : "dark");
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    aria-label="Toggle dark theme"
                    onClick={toggle}
                    className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-md text-ink-subtle outline-none transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring",
                        className,
                    )}
                >
                    <Moon size={15} aria-hidden="true" className="dark:hidden" />
                    <Sun size={15} aria-hidden="true" className="hidden dark:block" />
                </button>
            </TooltipTrigger>
            <TooltipContent>Toggle dark theme</TooltipContent>
        </Tooltip>
    );
}
