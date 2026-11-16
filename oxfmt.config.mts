import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // drizzle-kit regenerates its snapshots in its own format.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "apps/backend/drizzle/meta/**",
  ],
});
