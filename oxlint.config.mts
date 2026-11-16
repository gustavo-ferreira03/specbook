import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  env: core.env,
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  options: { reportUnusedDisableDirectives: "error" },
  overrides: [
    {
      files: ["apps/frontend/**"],
      plugins: [
        ...(core.plugins ?? []),
        ...(react.plugins ?? []),
        ...(next.plugins ?? []),
      ],
      rules: { ...react.rules, ...next.rules },
    },
  ],
});
