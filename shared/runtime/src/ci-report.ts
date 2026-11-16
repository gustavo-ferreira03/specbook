// JUnit and Markdown summaries of a CI run, shared by the server's CI batches and the CLI's local mode.
export interface CiReportItem {
  title: string;
  status: string;
  failReason?: string | null;
  durationMs?: number | null;
  flaky: boolean;
  knownBug: boolean;
  awaitingDeploy: boolean;
  pending: boolean;
  failsGate: boolean;
}

export interface CiReport {
  status: string;
  complete: boolean;
  batch: {
    durationMs?: number | null;
    failReason?: string | null;
    environment?: { name: string } | null;
    ci?: { commitSha?: string | null; ref?: string | null } | null;
  };
  qualityGate: {
    passed: boolean;
    failures: number;
    flaky: number;
    knownBugs: number;
    awaitingDeploy: number;
  };
  results: CiReportItem[];
}

const XML_ENTITIES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};
const xml = (value: string): string =>
  value
    // oxlint-disable-next-line no-control-regex -- Remove forbidden XML control characters before serializing CI results.
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
    .replaceAll(/[<>&"']/gu, (character) => XML_ENTITIES[character]);

export const junitResult = function junitResult(result: CiReport): string {
  const tests = result.results.map((item) => {
    const skipped =
      item.pending ||
      (!item.failsGate &&
        (item.flaky || ["failed", "error"].includes(item.status)));
    const detail = (() => {
      if (item.failsGate) {
        return `<failure message="${xml(item.failReason ?? (item.flaky ? "Passed only after retry" : "Spec failed"))}"/>`;
      }
      if (skipped) {
        return `<skipped message="${(() => {
          if (item.pending) {
            return "Still running";
          }
          if (item.awaitingDeploy) {
            return "Waiting for deploy";
          }
          if (item.flaky) {
            return "Flaky: passed on retry";
          }
          return "Open bug report";
        })()}"/>`;
      }
      return "";
    })();
    return `  <testcase name="${xml(item.title)}" classname="Specbook" time="${((item.durationMs ?? 0) / 1000).toFixed(3)}">${detail}</testcase>`;
  });
  if (
    result.qualityGate.failures >
    result.results.filter((item) => item.failsGate).length
  ) {
    tests.push(
      `  <testcase name="Batch execution" classname="Specbook"><failure message="${xml(result.batch.failReason ?? "Batch execution failed")}"/></testcase>`
    );
  }
  const skipped = result.results.filter(
    (item) =>
      item.pending ||
      (!item.failsGate &&
        (item.flaky || ["failed", "error"].includes(item.status)))
  ).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Specbook" tests="${tests.length}" failures="${result.qualityGate.failures}" skipped="${skipped}" time="${((result.batch.durationMs ?? 0) / 1000).toFixed(3)}">\n${tests.join("\n")}\n</testsuite>\n`;
};

export const markdownResult = function markdownResult(
  result: CiReport
): string {
  const lines = [`## Specbook: ${result.status}`, ""];
  if (result.batch.environment) {
    lines.push(`Environment: ${markdown(result.batch.environment.name)}`, "");
  }
  if (result.batch.ci?.commitSha) {
    lines.push(`Commit: ${markdown(result.batch.ci.commitSha)}`, "");
  }
  if (result.batch.ci?.ref) {
    lines.push(`Ref: ${markdown(result.batch.ci.ref)}`, "");
  }
  lines.push("| Spec | Result |", "| --- | --- |");
  for (const item of result.results) {
    const status = (() => {
      if (item.pending) {
        return "Running";
      }
      if (item.awaitingDeploy) {
        return "Waiting for deploy";
      }
      if (item.flaky) {
        return "Flaky (passed on retry)";
      }
      if (item.knownBug && ["failed", "error"].includes(item.status)) {
        return "Known bug";
      }
      return item.status;
    })();
    lines.push(
      `| ${markdown(item.title)} | ${status}${item.failsGate ? " · fails gate" : ""} |`
    );
  }
  lines.push(
    "",
    `Quality gate: ${(() => {
      if (result.complete) {
        if (result.qualityGate.passed) {
          return "passed";
        }
        return "failed";
      }
      return "pending";
    })()}. ${result.qualityGate.failures} failure(s), ${result.qualityGate.flaky} flaky, ${result.qualityGate.knownBugs} known bug(s), ${result.qualityGate.awaitingDeploy} waiting for deploy.`,
    ""
  );
  return lines.join("\n");
};

const markdown = (value: string) =>
  value.replaceAll(/[\\`*_{}[\]<>|]/gu, "\\$&").replaceAll(/[\r\n]+/gu, " ");
