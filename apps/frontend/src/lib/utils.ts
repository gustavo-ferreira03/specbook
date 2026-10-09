import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

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
