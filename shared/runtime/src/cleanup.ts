import { specTimeouts } from "./timeouts.ts";

export const CLEANUP_WARNING_ATTACHMENT = "specbook-cleanup-warning";
export const CLEANUP_WARNING_LIMIT = 500;

const LEFTOVERS = "Data created by this Spec may remain.";

export const cleanupWarning = function cleanupWarning(
  problem: { error: unknown } | { timeoutMs: number }
): string {
  if ("timeoutMs" in problem) {
    return `Cleanup did not finish within ${Math.round(problem.timeoutMs / 1000)}s. ${LEFTOVERS}`;
  }
  const { error } = problem;
  const [reason = ""] = (error instanceof Error ? error.message : String(error))
    // oxlint-disable-next-line no-control-regex -- Playwright colors its error messages with ANSI escapes.
    .replaceAll(/\u001B\[[\d;]*m/gu, "")
    .split("\n");
  const room = CLEANUP_WARNING_LIMIT - LEFTOVERS.length - 20;
  return `Cleanup failed: ${reason.slice(0, room).replace(/[.\s]+$/u, "")}. ${LEFTOVERS}`;
};

// Extra time a run needs so that each cleanup can use as long as a test.
export const cleanupAllowanceMs = function cleanupAllowanceMs(
  specs: { analysis: { hasCleanup: boolean } }[]
): number {
  return (
    specs.filter((spec) => spec.analysis.hasCleanup).length *
    specTimeouts().test
  );
};
