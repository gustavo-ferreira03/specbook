import { readFileSync } from "node:fs";

declare const SPECBOOK_CLI_VERSION: string;
export const CLI_VERSION: string = typeof SPECBOOK_CLI_VERSION === "undefined"
    ? JSON.parse(readFileSync(new URL("../../../cli/package.json", import.meta.url), "utf8")).version
    : SPECBOOK_CLI_VERSION;
