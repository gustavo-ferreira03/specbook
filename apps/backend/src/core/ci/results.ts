import { jobsRepository } from "../../infra/repositories/jobs";
import { runsRepository } from "../../infra/repositories/runs";
import type { RunBatch } from "../runner/batch";
import { requireValue } from "../utils/require-value";

export const knownBugSpecIds = async function knownBugSpecIds(
  projectId: string
): Promise<string[]> {
  const [items, jobs] = await Promise.all([
    jobsRepository.itemsByKind(projectId, "bug_report", ["pending"]),
    jobsRepository.list(projectId),
  ]);
  const ids = items
    .filter((item) => item.kind === "bug_report" && item.status === "pending")
    .flatMap((item) => {
      const id =
        typeof item.payload.specId === "string"
          ? item.payload.specId
          : jobs.find((job) => job.id === item.jobId)?.specId;
      return id ? [id] : [];
    });
  return [...new Set(ids)];
};

export const ciResult = async function ciResult(
  batch: RunBatch,
  frontendOrigin = process.env.FRONTEND_ORIGIN ?? ""
) {
  const frontend = frontendOrigin.replace(/\/$/u, "");
  const url = `${frontend}/p/${batch.projectId}/settings?tab=automation#ci-batch-${batch.id}`;
  const known = new Set(batch.ci?.knownBugSpecIds);
  const gate = batch.ci?.qualityGate ?? {
    failOnFlaky: false,
    failOnKnownBugs: false,
  };
  const results = await Promise.all(
    // oxlint-disable-next-line complexity -- Keep the results decision tree together so state transitions and error ordering remain explicit.
    batch.specs.map(async (item) => {
      const run = await runsRepository.getRun(item.runId);
      const retry = await runsRepository.retryFor(item.runId);
      const flaky = run?.flaky === true || retry?.status === "passed";
      const knownBug = known.has(item.specId);
      const status = run?.status ?? item.status;
      const failed = ["failed", "error"].includes(status);
      const awaitingDeploy =
        failed && (run?.awaitingDeploy ?? item.awaitingDeploy ?? false);
      const pending =
        status === "running" ||
        retry?.status === "running" ||
        (failed &&
          !awaitingDeploy &&
          run?.automationPending === true &&
          !retry);
      const failsGate =
        !pending &&
        !awaitingDeploy &&
        ((flaky && gate.failOnFlaky) ||
          (failed && !flaky && (!knownBug || gate.failOnKnownBugs)));
      return {
        ...item,
        status,
        failReason: run?.failReason ?? item.failReason,
        flaky,
        knownBug,
        awaitingDeploy,
        pending,
        failsGate,
        retryRunId: retry?.id ?? null,
        url: `${frontend}/p/${batch.projectId}/specs/${item.specId}#run-${item.runId}`,
        evidenceUrl: `/runs/${item.runId}/evidence`,
      };
    })
  );
  const complete =
    batch.status !== "running" && results.every((item) => !item.pending);
  const infrastructureError =
    batch.status === "error" &&
    !results.some((item) => ["failed", "error"].includes(item.status));
  const failures =
    results.filter((item) => item.failsGate).length +
    (infrastructureError ? 1 : 0);
  const passed = complete && failures === 0 && !infrastructureError;
  const status = (() => {
    if (complete) {
      if (passed) {
        return "passed";
      }
      if (batch.status === "error") {
        return "error";
      }
      return "failed";
    }
    return "running";
  })();
  return {
    batch,
    status,
    complete,
    qualityGate: {
      passed,
      failures,
      flaky: results.filter((item) => item.flaky && !item.awaitingDeploy)
        .length,
      knownBugs: results.filter(
        (item) =>
          item.knownBug &&
          !item.awaitingDeploy &&
          ["failed", "error"].includes(item.status)
      ).length,
      awaitingDeploy: results.filter((item) => item.awaitingDeploy).length,
    },
    url,
    results,
  };
};

const xml = function xml(value: string) {
  return (
    value
      // oxlint-disable-next-line no-control-regex -- Match control characters explicitly at the sanitization boundary.
      .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
      .replaceAll(/[<>&"']/gu, (char) =>
        requireValue(
          {
            "<": "&lt;",
            ">": "&gt;",
            "&": "&amp;",
            '"': "&quot;",
            "'": "&apos;",
          }[char]
        )
      )
  );
};

export const junitResult = function junitResult(result: CiResult): string {
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
  result: CiResult
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

export type CiResult = Awaited<ReturnType<typeof ciResult>>;

const markdown = (value: string) =>
  value.replaceAll(/[\\`*_{}[\]<>|]/gu, "\\$&").replaceAll(/[\r\n]+/gu, " ");
