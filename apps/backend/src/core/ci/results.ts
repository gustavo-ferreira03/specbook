import { jobsRepository } from "../../infra/repositories/jobs";
import { runsRepository } from "../../infra/repositories/runs";
import type { RunBatch } from "../runner/batch";

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

export { junitResult, markdownResult } from "@specbook/runtime/ci-report";

export type CiResult = Awaited<ReturnType<typeof ciResult>>;
