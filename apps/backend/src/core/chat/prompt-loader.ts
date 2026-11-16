import { readFileSync } from "node:fs";

export const loadPrompt = function loadPrompt(name: string): string {
  return readFileSync(
    new URL(`prompts/${name}`, import.meta.url),
    "utf-8"
  ).trimEnd();
};
