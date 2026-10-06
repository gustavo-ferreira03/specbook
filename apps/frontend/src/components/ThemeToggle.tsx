"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light theme", icon: Sun },
    { value: "system", label: "Match system theme", icon: Monitor },
    { value: "dark", label: "Dark theme", icon: Moon },
];

/** Three-way Light / System / Dark switch. Arrow keys move between options (radio group). */
export function ThemeToggle({ className }: { className?: string }) {
    const preference = useThemePreference();

    function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const index = OPTIONS.findIndex((option) => option.value === preference);
        const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length];
        setThemePreference(next.value);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
    }

    return (
        <div role="radiogroup" aria-label="Color theme" onKeyDown={handleKeyDown} className={cn("inline-flex items-center gap-0.5 rounded-lg bg-surface-hover p-0.5", className)}>
            {OPTIONS.map(({ value, label, icon: Icon }) => {
                const active = preference === value;
                return (
                    <Tooltip key={value}>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                role="radio"
                                aria-checked={active}
                                aria-label={label}
                                data-value={value}
                                tabIndex={active ? 0 : -1}
                                onClick={() => setThemePreference(value)}
                                className={cn(
                                    "flex size-7 items-center justify-center rounded-md text-ink-subtle outline-none transition-[color,background-color,box-shadow] duration-150 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring",
                                    active && "bg-thumb text-ink shadow-xs",
                                )}
                            >
                                <Icon size={14} aria-hidden="true" />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent>{label}</TooltipContent>
                    </Tooltip>
                );
            })}
        </div>
    );
}
