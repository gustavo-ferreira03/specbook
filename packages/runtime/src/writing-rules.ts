import { readFileSync } from "node:fs";

export function specWritingRules(): string {
    return readFileSync(new URL("./assets/spec-writing-rules.txt", import.meta.url), "utf8").trimEnd();
}
