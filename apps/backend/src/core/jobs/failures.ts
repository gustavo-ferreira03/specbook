import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../../infra/logger";
import { runsRepository } from "../../infra/repositories/runs";
import type { Run } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import { runsDir } from "../paths";
import { markdownHashOf } from "../repo/writer";
import { executeSpec, StaleRunError } from "../runner/run";
import { recordFailureSignal } from "../steward/engine";

const retryFailure = async function retryFailure(
  run: Run,
  error: unknown
): Promise<void> {
  if (error instanceof StaleRunError) {
    retryDelays.delete(run.id);
    await runsRepository.acknowledgeAutomation(run.id);
    return;
  }
  logger.warn("failure retry could not start", { runId: run.id, error });
  const attempts = (retryDelays.get(run.id)?.attempts ?? 0) + 1;
  retryDelays.set(run.id, {
    attempts,
    retryAt: Date.now() + Math.min(15_000 * 2 ** (attempts - 1), 300_000),
  });
};

const failureContent = async function failureContent(
  run: Run
): Promise<{ sourceHash: string; markdownHash: string } | null> {
  const spec = await specsRepository.getSpec(run.specId);
  if (!spec || spec.sourceHash !== run.sourceHash) {
    return null;
  }
  const markdown = await fs
    .readFile(path.join(runsDir, run.id, "spec.yml"), "utf-8")
    .catch(() => null);
  if (markdown === null || markdownHashOf(markdown) !== spec.markdownHash) {
    return null;
  }
  return { sourceHash: run.sourceHash, markdownHash: spec.markdownHash };
};

export const processRunFailures =
  // oxlint-disable-next-line complexity -- Keep the failures decision tree together so state transitions and error ordering remain explicit.
  async function processRunFailures(): Promise<void> {
    if (processing) {
      return;
    }
    processing = true;
    try {
      for (const run of await runsRepository.pendingAutomation()) {
        try {
          if (run.retryOf) {
            // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
            const original = await runsRepository.getRun(run.retryOf);
            if (!original?.automationPending) {
              // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
              await runsRepository.acknowledgeAutomation(run.id);
            }
            continue;
          }
          if (run.status === "passed" || run.awaitingDeploy) {
            retryDelays.delete(run.id);
            // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
            await runsRepository.acknowledgeAutomation(run.id);
            continue;
          }
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          const expected = await failureContent(run);
          if (!expected) {
            retryDelays.delete(run.id);
            // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
            await runsRepository.acknowledgeAutomation(run.id);
            continue;
          }
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          let retry = await runsRepository.retryFor(run.id);
          if (!retry) {
            if (runnerRetries.has(run.id)) {
              continue;
            }
            if ((retryDelays.get(run.id)?.retryAt ?? 0) > Date.now()) {
              continue;
            }
            const options = {
              automate: true,
              healOnFailure: false,
              retryOf: run.id,
              expected,
              baseUrl: run.baseUrl ?? undefined,
              environment: run.environment ?? undefined,
            };
            if (run.environment?.executor === "runner") {
              // An offline runner must not hold the failure monitor for every project.
              const task = executeSpec(run.specId, options)
                // oxlint-disable-next-line promise/always-return -- This continuation performs a side effect; its fulfilled value is intentionally unused.
                .then(() => {
                  /* No action is needed until this callback is replaced or invoked by its owner. */
                })
                // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
                .catch((error: unknown) => retryFailure(run, error));
              runnerRetries.set(run.id, task);
              task
                .finally(() => runnerRetries.delete(run.id))
                // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
                .catch((error: unknown) =>
                  logger.error("runner failure retry failed", {
                    runId: run.id,
                    error,
                  })
                );
              continue;
            }
            try {
              // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
              retry = await executeSpec(run.specId, options);
            } catch (error) {
              // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
              await retryFailure(run, error);
              continue;
            }
          }
          retryDelays.delete(run.id);
          if (retry.status === "running") {
            continue;
          }
          if (retry.status === "passed") {
            // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
            await runsRepository.markFlaky(run.id, retry.id);
            // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          } else if (run.healOnFailure && (await failureContent(run))) {
            // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
            const spec = await specsRepository.getSpec(run.specId);
            if (spec) {
              // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
              await recordFailureSignal(
                spec.projectId,
                retry.id,
                spec.id,
                spec.title,
                run.id
              );
            }
          }
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          await runsRepository.acknowledgeAutomation(retry.id);
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          await runsRepository.acknowledgeAutomation(run.id);
        } catch (error) {
          logger.warn("failure triage could not start", {
            runId: run.id,
            error,
          });
        }
      }
    } finally {
      processing = false;
    }
  };

export const startFailureMonitor = function startFailureMonitor(): void {
  timer = setInterval(
    () =>
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This API requires an event or callback handler.
      processRunFailures().catch((error) =>
        logger.error("failure monitor failed", { error })
      ),
    2000
  );
  timer.unref();
  processRunFailures();
};

export const stopFailureMonitor = function stopFailureMonitor(): void {
  clearInterval(timer);
};

let processing = false;
let timer: ReturnType<typeof setInterval> | undefined;
const retryDelays = new Map<string, { attempts: number; retryAt: number }>();
const runnerRetries = new Map<string, Promise<void>>();
