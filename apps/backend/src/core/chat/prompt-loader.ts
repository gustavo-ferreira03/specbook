import { readFileSync } from "node:fs";

export function loadPrompt(name: string): string {
    return readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trimEnd();
}
