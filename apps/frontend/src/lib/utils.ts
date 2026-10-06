import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge about the custom type scale (globals.css @theme --text-*), otherwise it
// treats `text-control` as a color and drops it when combined with `text-ink`.
const twMerge = extendTailwindMerge({
    extend: {
        theme: {
            text: ["label", "meta", "control", "body", "section", "title", "display"],
            shadow: ["popover", "dialog", "composer"],
            container: ["reading", "data", "chat"],
        },
    },
});

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
