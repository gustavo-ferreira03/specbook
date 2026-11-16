import { readFileSync } from "node:fs";

export const specWritingRules = function specWritingRules(): string {
  return readFileSync(
    new URL("assets/spec-writing-rules.txt", import.meta.url),
    "utf-8"
  ).trimEnd();
};
