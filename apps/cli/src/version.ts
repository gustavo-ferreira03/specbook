import { readFileSync } from "node:fs";

declare const SPECBOOK_CLI_VERSION: string;
export const CLI_VERSION: string =
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- The build constant is intentionally absent when running from source.
  typeof SPECBOOK_CLI_VERSION === "undefined"
    ? JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf-8")
      ).version
    : SPECBOOK_CLI_VERSION;
