import { readFileSync } from "node:fs";

declare const SPECBOOK_CLI_VERSION: string;
export const CLI_VERSION: string =
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- The version identifier is an optional build-time macro and can be undeclared during source execution.
  typeof SPECBOOK_CLI_VERSION === "undefined"
    ? JSON.parse(
        readFileSync(
          new URL("../../../cli/package.json", import.meta.url),
          "utf-8"
        )
      ).version
    : SPECBOOK_CLI_VERSION;
