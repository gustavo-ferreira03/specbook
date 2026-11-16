import { clsx } from "clsx";
import type { ClassValue } from "clsx";
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

export const cn = function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
};
