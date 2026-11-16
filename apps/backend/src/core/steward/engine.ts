import fs from "node:fs/promises";
import path from "node:path";

import { errorCodeOf } from "@specbook/runtime/errors";
import type { ErrorCode } from "@specbook/runtime/errors";
import { readEvidenceManifest } from "@specbook/runtime/evidence";

import { logger } from "../../infra/logger";
import { chatsRepository } from "../../infra/repositories/chats";
import { jobsRepository } from "../../infra/repositories/jobs";
import type { InboxItem, Job } from "../../infra/repositories/jobs";
import { projectContextsRepository } from "../../infra/repositories/project-contexts";
import { projectsRepository } from "../../infra/repositories/projects";
import { runsRepository } from "../../infra/repositories/runs";
import { specsRepository } from "../../infra/repositories/specs";
import type { Spec } from "../../infra/repositories/specs";
import { stewardRepository } from "../../infra/repositories/steward";
import type { Intent, ProjectSignal } from "../../infra/repositories/steward";
import { createChat } from "../chat/session-store";
import { createProjectScrubber } from "../credentials/scrub";
import { canRunAgentJob, isAgentPaused } from "../jobs/pause";
import {
  isCredentialFailure,
  runFailureKind,
} from "../jobs/presentation-errors";
import { enqueueJob } from "../jobs/queue";
import { retryStalledJob } from "../jobs/retry";
import { recordScheduledBatch } from "../jobs/schedule-batches";
import { payloadOf, jobLimitsSchema } from "../jobs/schemas";
import { ACTIVE_JOB_STATUSES } from "../jobs/shared";
import { currentFailure, StaleTriageError } from "../jobs/triage";
import { createKeyedLock } from "../operations/keyed-lock";
import { runsDir } from "../paths";
import { markdownHashOf } from "../repo/writer";
import { getRunBatch, startSpecBatch } from "../runner/batch";
import { areSpecsLocked } from "../specs/lifecycle";
import { requireValue } from "../utils/require-value";
import { applyVerifiedRepairs } from "./approval";
import { stewardIntentSchema } from "./schemas";
import type { StewardIntent } from "./schemas";
import {
  collectProjectSignals,
  fingerprint,
  runSignalForIntent,
  runTriggerForIntent,
} from "./signals";

class IntentDeferredError extends Error {
  name = "IntentDeferredError";
}

export const withProjectLock = async function withProjectLock<T>(
  id: string,
  work: () => Promise<T>
): Promise<T> {
  return await locks.run(id, work);
};

const intentFingerprint = async function intentFingerprint(
  projectId: string,
  intent: StewardIntent,
  source: "user" | "event",
  key: string,
  specsInput?: Spec[]
): Promise<string> {
  let specs = specsInput;

  specs ??= await specsRepository.listSpecs(projectId);
  const run =
    intent.kind === "triage" && intent.runId
      ? await runsRepository.getRun(intent.runId)
      : null;
  if (run) {
    const spec = specs.find((specValue) => specValue.id === run.specId);
    if (!spec || intent.specIds?.some((id) => id !== spec.id)) {
      throw new Error(
        "The failed run must belong to the selected Spec in this project"
      );
    }
    const yaml = await fs
      .readFile(path.join(runsDir, run.id, "spec.yml"), "utf-8")
      .catch(() => null);
    const evidence = await readEvidenceManifest(path.join(runsDir, run.id));
    const failureKind = runFailureKind(run);
    const project = await projectsRepository.getProject(projectId);
    return fingerprint({
      kind: "triage",
      specId: spec.id,
      sourceHash: run.sourceHash,
      markdownHash: yaml === null ? null : markdownHashOf(yaml),
      failureKind,
      failedStep: evidence.failedStep ?? null,
      baseUrl: run.baseUrl ?? intent.baseUrl ?? project?.baseUrl,
    });
  }
  const context =
    await projectContextsRepository.getLatestConfirmedProjectContext(projectId);
  const targets = specs
    .filter(
      (spec) => !intent.specIds?.length || intent.specIds.includes(spec.id)
    )
    .map((spec) => [spec.id, spec.sourceHash, spec.markdownHash])
    .toSorted();
  if (intent.kind === "regenerate") {
    return fingerprint({ kind: intent.kind, targets });
  }
  return fingerprint({
    kind: intent.kind,
    targets,
    context: context?.context,
    baseUrl: intent.baseUrl,
    environment: intent.environment,
    goal:
      source === "user"
        ? intent.goal.replaceAll(/\s+/gu, " ").trim().toLowerCase()
        : undefined,
    regressionKey: key.startsWith("regression:") ? key : undefined,
  });
};

export const enqueueIntent = async function enqueueIntent(
  projectId: string,
  input: unknown,
  key: string,
  source: "user" | "event" = "event",
  options: { sourceChatId?: string | null } = {}
): Promise<Intent> {
  if (!(await projectsRepository.getProject(projectId))) {
    throw new Error("Project not found");
  }
  if (options.sourceChatId) {
    const chat = await chatsRepository.getChatRow(options.sourceChatId);
    if (!chat || chat.projectId !== projectId) {
      throw new Error("The source conversation must belong to this project.");
    }
  }
  const intent = stewardIntentSchema.parse(input);
  if (source !== "user" && ["coverage", "explore"].includes(intent.kind)) {
    throw new Error(
      "Coverage and exploration require an explicit human request"
    );
  }
  const specs = await specsRepository.listSpecs(projectId);
  if (intent.specIds?.some((id) => !specs.some((spec) => spec.id === id))) {
    throw new Error("Selected Specs must belong to this project");
  }
  const scrub = createProjectScrubber(projectId);
  intent.goal = await scrub(intent.goal);
  intent.reason = await scrub(intent.reason);
  return stewardRepository.addIntent({
    projectId,
    key,
    source,
    sourceChatId: options.sourceChatId,
    intent,
    priority: intent.priority,
    reason: intent.reason,
    fingerprint: await intentFingerprint(projectId, intent, source, key, specs),
  });
};

export const recordFailureSignal = async function recordFailureSignal(
  projectId: string,
  runId: string,
  specId: string,
  title: string,
  originalRunId = runId
): Promise<void> {
  await stewardRepository.signal({
    projectId,
    key: `failure:${originalRunId}`,
    kind: "spec_failure",
    title: `“${title}” failed`,
    body: "Investigate the failed step and evidence to distinguish test drift, an application bug, or an environment problem.",
    payload: { runId, originalRunId, specIds: [specId] },
  });
};

const signalSpec = async function signalSpec(
  signal: ProjectSignal
): Promise<Spec | null> {
  const specId = Array.isArray(signal.payload.specIds)
    ? signal.payload.specIds[0]
    : null;
  const spec =
    typeof specId === "string" ? await specsRepository.getSpec(specId) : null;
  return spec &&
    spec.projectId === signal.projectId &&
    spec.sourceHash === signal.payload.sourceHash &&
    spec.markdownHash === signal.payload.markdownHash
    ? spec
    : null;
};

const isCurrentSignal = async function isCurrentSignal(
  signal: ProjectSignal
): Promise<boolean> {
  if (signal.kind === "spec_failure") {
    return !!(await currentFailure(
      signal.projectId,
      typeof signal.payload.runId === "string"
        ? signal.payload.runId
        : undefined
    ));
  }
  if (signal.kind === "invalid_spec") {
    return (
      (await (async () => {
        const resolvedValue7198 = await signalSpec(signal);
        return resolvedValue7198?.status;
      })()) === "invalid"
    );
  }
  if (signal.kind === "spec_changed") {
    const spec = await signalSpec(signal);
    const { observation } = await stewardRepository.get(signal.projectId);
    return (
      !!spec &&
      spec.status !== "invalid" &&
      signal.payload.generation !== undefined &&
      observation.specGenerations?.[spec.id] === signal.payload.generation
    );
  }
  if (signal.kind === "deployment_changed") {
    const { deployment } = await (async () => {
      const awaitedValue7548 = await stewardRepository.get(signal.projectId);
      return awaitedValue7548.observation;
    })();
    return (
      !!deployment &&
      deployment.baseUrl === signal.payload.baseUrl &&
      deployment.fingerprint === signal.payload.fingerprint &&
      deployment.generation === signal.payload.generation
    );
  }
  if (signal.kind === "deployment") {
    const latest = await (async () => {
      const awaitedValue7895 = await stewardRepository.signals(
        signal.projectId,
        null
      );
      return awaitedValue7895.find(
        (other) =>
          other.kind === "deployment" &&
          other.payload.environment === signal.payload.environment
      );
    })();
    return latest?.id === signal.id;
  }
  return true;
};

export const resumeCurrentSignals = async function resumeCurrentSignals(
  projectId: string
): Promise<void> {
  await withProjectLock(projectId, async () => {
    for (const signal of await stewardRepository.signals(projectId, null)) {
      if (signal.status !== "observed") {
        continue;
      }
      const applicable =
        ["spec_changed", "deployment_changed", "deployment"].includes(
          signal.kind
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        ) && (await isCurrentSignal(signal));
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await stewardRepository.acknowledge(
        signal.id,
        applicable ? "pending" : "handled"
      );
    }
    const specs = await specsRepository.listSpecs(projectId);
    for (const spec of specs) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      const run = await (async () => {
        const awaitedValue8861 = await runsRepository.listRuns(spec.id, {
          limit: 1,
        });
        return awaitedValue8861[0];
      })();
      if (
        !run ||
        run.automationPending ||
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        !(await currentFailure(projectId, run.id))
      ) {
        continue;
      }
      const original = run.retryOf
        ? // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          await runsRepository.getRun(run.retryOf)
        : run;
      if (!original?.healOnFailure) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await recordFailureSignal(
        projectId,
        run.id,
        spec.id,
        spec.title,
        original.id
      );
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      const signal = await (async () => {
        const awaitedValue9387 = await stewardRepository.signals(
          projectId,
          null
        );
        return awaitedValue9387.find(
          (row) => row.key === `failure:${original.id}`
        );
      })();
      if (signal) {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await stewardRepository.acknowledge(signal.id, "pending");
      }
    }
  });
};

// oxlint-disable-next-line complexity -- Keep the engine decision tree together so state transitions and error ordering remain explicit.
const handleSignal = async function handleSignal(
  signal: ProjectSignal,
  observe: boolean
): Promise<void> {
  if (await isAgentPaused(signal.projectId)) {
    return;
  }
  if (observe && !["credentials_changed", "schedule"].includes(signal.kind)) {
    await stewardRepository.acknowledge(signal.id, "observed");
    return;
  }
  if (!(await isCurrentSignal(signal))) {
    await stewardRepository.acknowledge(signal.id, "handled");
    return;
  }
  const specIds = Array.isArray(signal.payload.specIds)
    ? (signal.payload.specIds as string[])
    : undefined;
  const runId =
    typeof signal.payload.runId === "string" ? signal.payload.runId : undefined;
  const kinds: Record<string, StewardIntent["kind"]> = {
    spec_failure: "triage",
    invalid_spec: "regenerate",
    deployment_changed: "run_specs",
    deployment: "run_specs",
    spec_changed: "run_specs",
    schedule: "run_specs",
  };
  if (signal.kind === "credentials_changed") {
    for (const item of await jobsRepository.itemsByKind(
      signal.projectId,
      "question",
      ["pending"]
    )) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      if (await isAgentPaused(signal.projectId)) {
        return;
      }
      if (
        item.kind !== "question" ||
        item.status !== "pending" ||
        payloadOf(item).waitingFor !== "credentials"
      ) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      const job = await jobsRepository.get(item.jobId);
      if (
        job?.status !== "blocked" ||
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        !(await canRunAgentJob(job)) ||
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        !(await jobsRepository.claimItem(item.id))
      ) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await jobsRepository.answer(
          item,
          "Credential profiles changed. Check the available profiles and continue if the requested access is now available."
        );
      } catch {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await jobsRepository.updateItem(item.id, { status: "pending" });
      }
    }
  } else if (kinds[signal.kind]) {
    await enqueueIntent(
      signal.projectId,
      {
        kind: kinds[signal.kind],
        goal: signal.body,
        reason: signal.title,
        specIds,
        runId,
        baseUrl:
          typeof signal.payload.url === "string"
            ? signal.payload.url
            : undefined,
        environment:
          typeof signal.payload.environment === "string"
            ? signal.payload.environment
            : undefined,
        priority: (() => {
          if (signal.kind === "spec_failure") {
            return 100;
          }
          if (signal.kind === "invalid_spec") {
            return 80;
          }
          return 40;
        })(),
      },
      `signal:${signal.id}`
    );
  }
  await stewardRepository.acknowledge(
    signal.id,
    observe ? "observed" : "handled"
  );
};

const askForRunPrerequisite = async function askForRunPrerequisite(
  row: Intent,
  reason: string,
  code?: ErrorCode | null
): Promise<void> {
  let job = await jobsRepository.get(row.id);
  if (!job) {
    const chat = await createChat(row.projectId);
    job = await jobsRepository.create({
      id: row.id,
      projectId: row.projectId,
      chatId: chat.id,
      sourceChatId: row.sourceChatId,
      kind: "review",
      status: "blocked",
      stopReason: reason,
      errorCode: code,
      trigger: row.source === "user" ? "manual" : "steward",
      goal: row.intent.goal,
      specId: row.intent.specIds?.[0],
      limits: jobLimitsSchema.parse({}),
    });
  }
  await jobsRepository.transition(job.id, "queued", "blocked", {
    stopReason: reason,
    ...(code ? { errorCode: code } : {}),
  });
  const existing = await (async () => {
    const awaitedValue13126 = await jobsRepository.itemsForJob(job.id);
    return awaitedValue13126.some(
      (item) =>
        item.jobId === requireValue(job).id &&
        payloadOf(item).runIntentId === row.id
    );
  })();
  if (!existing) {
    const question = (() => {
      if (isCredentialFailure(reason, code ?? job.errorCode, "prerequisite")) {
        return {
          title: "Can you provide access to run these Specs?",
          body: "Add the missing sign-in details in Settings → Credentials, then answer here. Do not paste passwords in your answer.",
          waitingFor: "credentials",
        };
      }
      if (
        (code ?? job.errorCode)
          ? (code ?? job.errorCode) === "repository_dirty"
          : /uncommitted|repository.*dirty/iu.test(reason)
      ) {
        return {
          title:
            "Can you save or discard the pending edits before running these Specs?",
          body: "Save or discard the pending edits in the project repository, then answer here to retry.",
          waitingFor: "run_prerequisite",
        };
      }
      return {
        title: "Can you resolve this prerequisite so the Specs can run?",
        body: "The requested Specs could not start. Resolve the prerequisite described below, then answer here to retry.",
        waitingFor: "run_prerequisite",
      };
    })();
    await jobsRepository.addItem({
      projectId: row.projectId,
      jobId: job.id,
      kind: "question",
      title: question.title,
      body: `${question.body}\n\n${reason}`,
      payload: {
        errorCode: code ?? job.errorCode,
        runIntentId: row.id,
        waitingFor: question.waitingFor,
        language: "en",
        specId: job.specId,
      },
    });
  }
  await stewardRepository.updateIntent(row.id, {
    status: "running",
    jobId: job.id,
    reason,
  });
};

export const recordScheduledPrerequisite =
  async function recordScheduledPrerequisite(
    projectId: string,
    specIds: string[],
    dueAt: string,
    reason: string,
    healFailures: boolean,
    code?: ErrorCode
  ): Promise<void> {
    await withProjectLock(projectId, async () => {
      if (await isAgentPaused(projectId)) {
        return;
      }
      const [intents, signals, jobs] = await Promise.all([
        stewardRepository.intents(projectId),
        stewardRepository.signals(projectId, null),
        jobsRepository.list(projectId),
      ]);
      const selection = JSON.stringify([...specIds].toSorted());
      const existing = intents.find(
        (intent) =>
          intent.intent.kind === "run_specs" &&
          runTriggerForIntent(intent, intents, signals) === "schedule" &&
          JSON.stringify([...(intent.intent.specIds ?? [])].toSorted()) ===
            selection &&
          jobs.some(
            (job) =>
              job.id === intent.jobId &&
              job.status === "blocked" &&
              job.stopReason === reason
          )
      );
      if (existing) {
        await askForRunPrerequisite(existing, reason, code);
        return;
      }
      const key = `schedule:${dueAt}`;
      await stewardRepository.signal({
        projectId,
        key,
        kind: "schedule",
        title: "A scheduled run needs a prerequisite",
        body: reason,
        payload: { specIds, healFailures },
      });
      const signal = requireValue(
        await (async () => {
          const awaitedValue16376 = await stewardRepository.signals(
            projectId,
            null
          );
          return awaitedValue16376.find((row) => row.key === key);
        })()
      );
      const intent = stewardIntentSchema.parse({
        kind: "run_specs",
        specIds,
        priority: 70,
        goal: "Run the Specs selected for this scheduled occurrence after its prerequisite is resolved.",
        reason: "Scheduled run",
      });
      const row = await stewardRepository.addIntent({
        projectId,
        key: `signal:${signal.id}`,
        source: "event",
        intent,
        priority: intent.priority,
        reason: intent.reason,
        fingerprint: fingerprint({ projectId, key, specIds }),
      });
      await stewardRepository.acknowledge(signal.id, "handled");
      await askForRunPrerequisite(row, reason, code);
    });
  };

const driftWithoutFix = function driftWithoutFix(
  intent: Intent,
  jobs: Job[],
  inbox: InboxItem[]
): boolean {
  const job = jobs.find((jobValue) => jobValue.id === intent.jobId);
  return (
    job?.kind === "failure_triage" &&
    job.classification === "test_drift" &&
    !inbox.some((item) => item.jobId === job.id && item.kind === "spec_fix")
  );
};

// oxlint-disable-next-line complexity -- Keep the engine decision tree together so state transitions and error ordering remain explicit.
const dispatchIntent = async function dispatchIntent(
  row: Intent
): Promise<void> {
  if (await isAgentPaused(row.projectId)) {
    return;
  }
  const relatedIntents = await stewardRepository.intents(row.projectId);
  const signals = await stewardRepository.signals(row.projectId, null);
  const runTrigger = runTriggerForIntent(row, relatedIntents, signals);
  if (
    (await (async () => {
      const awaitedValue17891 = await stewardRepository.get(row.projectId);
      return awaitedValue17891.autonomy;
    })()) === "observe" &&
    row.source !== "user" &&
    !(row.intent.kind === "run_specs" && runTrigger === "schedule")
  ) {
    return;
  }
  if (
    row.intent.kind === "triage" &&
    !(await currentFailure(row.projectId, row.intent.runId))
  ) {
    await stewardRepository.updateIntent(row.id, {
      status: "ignored",
      reason: "The failure was superseded by a newer run or Spec change.",
    });
    return;
  }
  const signal = runSignalForIntent(row, relatedIntents, signals);
  if (row.source === "event" && signal && !(await isCurrentSignal(signal))) {
    await stewardRepository.updateIntent(row.id, {
      status: "ignored",
      reason: "A newer project state superseded this event.",
    });
    return;
  }
  const projectJobs = await jobsRepository.list(row.projectId);
  const existing = await jobsRepository.get(row.id);
  if (existing) {
    await (row.intent.kind === "run_specs" &&
    existing.status === "blocked" &&
    existing.stopReason
      ? askForRunPrerequisite(row, existing.stopReason, existing.errorCode)
      : stewardRepository.updateIntent(row.id, {
          status: "running",
          jobId: existing.id,
        }));
    return;
  }
  for (const job of projectJobs.filter((jobValue) =>
    ["queued", "running"].includes(jobValue.status)
  )) {
    // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
    if (await canRunAgentJob(job)) {
      return;
    }
  }
  if (
    relatedIntents.some(
      (other) =>
        other.id !== row.id && other.status === "running" && other.batchId
    )
  ) {
    return;
  }
  const inbox = await jobsRepository.itemsForJobs(
    row.projectId,
    relatedIntents.flatMap((intent) => (intent.jobId ? [intent.jobId] : []))
  );
  const allSpecs = await specsRepository.listSpecs(row.projectId);
  const currentSubject =
    row.intent.kind === "triage"
      ? await intentFingerprint(
          row.projectId,
          row.intent,
          row.source,
          row.key,
          allSpecs
        )
      : row.fingerprint;
  const previous: Intent[] = [];
  for (const other of relatedIntents) {
    if (other.id === row.id || !(other.jobId || other.batchId)) {
      continue;
    }
    const subject =
      other.intent.kind === "triage"
        ? // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          await intentFingerprint(
            other.projectId,
            other.intent,
            other.source,
            other.key,
            allSpecs
          ).catch(() => null)
        : other.fingerprint;
    if (subject === currentSubject) {
      previous.push(other);
    }
  }
  const rejected = previous.some((other) =>
    inbox.some(
      (item) =>
        item.jobId === other.jobId &&
        (item.status === "rejected" || payloadOf(item).ignoredCheck === true)
    )
  );
  if (
    (row.source === "event" && row.intent.kind !== "run_specs" && rejected) ||
    previous.some((other) =>
      projectJobs.some(
        (job) =>
          job.id === other.jobId && ACTIVE_JOB_STATUSES.includes(job.status)
      )
    ) ||
    (row.source === "event" &&
      row.intent.kind !== "run_specs" &&
      previous.some(
        (other) =>
          Date.now() - Date.parse(other.updatedAt) < 6 * 3_600_000 &&
          !driftWithoutFix(other, projectJobs, inbox)
      ))
  ) {
    await stewardRepository.updateIntent(row.id, {
      status: "ignored",
      reason: rejected
        ? "A human rejected this proposal for the current Spec/context version."
        : "Equivalent work is already active or was handled recently.",
    });
    return;
  }
  if (row.intent.kind === "run_specs") {
    const selected = allSpecs.filter(
      (spec) =>
        !row.intent.specIds?.length || row.intent.specIds.includes(spec.id)
    );
    if (
      row.intent.specIds?.length &&
      (row.intent.specIds.some(
        (id) => !allSpecs.some((spec) => spec.id === id)
      ) ||
        selected.some((spec) => spec.status === "invalid"))
    ) {
      throw new Error(
        "Some selected Specs are missing or invalid. Restore or update those Specs before retrying this selection."
      );
    }
    const specs = selected.filter((spec) => spec.status !== "invalid");
    if (!specs.length) {
      await stewardRepository.updateIntent(row.id, {
        status: "ignored",
        reason: "No runnable Specs yet.",
      });
      return;
    }
    if (
      areSpecsLocked(specs.map((spec) => spec.id)) ||
      (await runsRepository.hasRunningRuns(specs.map((spec) => spec.id)))
    ) {
      return;
    }
    if (await isAgentPaused(row.projectId)) {
      return;
    }
    await startSpecBatch(
      row.projectId,
      specs.map((spec) => spec.id),
      row.intent.reason,
      {
        baseUrl: row.intent.baseUrl,
        environment: row.intent.environment,
        trigger: runTrigger,
        healFailures: signal?.payload.healFailures !== false,
        onPrepared: async (batch) => {
          if (
            stopped ||
            (await isAgentPaused(row.projectId)) ||
            (row.source === "event" &&
              runTrigger !== "schedule" &&
              (await (async () => {
                const awaitedValue22964 = await stewardRepository.get(
                  row.projectId
                );
                return awaitedValue22964.autonomy;
              })()) === "observe")
          ) {
            throw new IntentDeferredError(
              "Automatic execution was deferred before the Specs started"
            );
          }
          if (runTrigger === "schedule") {
            await recordScheduledBatch(batch);
          }
          await stewardRepository.updateIntent(row.id, {
            status: "running",
            batchId: batch.id,
          });
        },
      }
    );
    return;
  }
  const kind =
    row.intent.kind === "triage" ? "failure_triage" : row.intent.kind;
  const decisions = await (async () => {
    const awaitedValue23585 = await jobsRepository.decisions(row.projectId);
    return awaitedValue23585.map((item) => ({
      title: item.title,
      status: item.status,
    }));
  })();
  const goal = `${row.intent.goal}\nReason: ${row.intent.reason}\n${row.intent.specIds?.length ? `Selected Specs: ${row.intent.specIds.join(", ")}.` : ""}\n${KIND_INSTRUCTIONS[kind]}\nRecent human decisions: ${JSON.stringify(decisions)}`;
  const job = await enqueueJob(
    row.projectId,
    {
      kind,
      goal: goal.slice(0, 12_000),
      trigger: (() => {
        if (row.source === "user") {
          return "manual";
        }
        if (row.intent.kind === "triage") {
          return "spec_failure";
        }
        return "steward";
      })(),
      specId: row.intent.specIds?.[0],
      runId: row.intent.runId,
      limits: jobLimitsSchema.parse({}),
    },
    row.id,
    { sourceChatId: row.sourceChatId }
  );
  await stewardRepository.updateIntent(row.id, {
    status: "running",
    jobId: job.id,
  });
};

export const processProjectSteward = async function processProjectSteward(
  projectId: string,
  collect = true
): Promise<void> {
  // oxlint-disable-next-line complexity -- Keep the engine decision tree together so state transitions and error ordering remain explicit.
  await withProjectLock(projectId, async () => {
    const project = await projectsRepository.getProject(projectId);
    if (!project) {
      return;
    }
    const settings = await stewardRepository.get(projectId);
    if (await isAgentPaused(projectId)) {
      return;
    }
    const projectJobs = await jobsRepository.list(projectId);
    for (const blocked of projectJobs.filter(
      (job) => job.status === "blocked" && job.safetyRetries > 0
    )) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      if (await canRunAgentJob(blocked)) {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await retryStalledJob(blocked);
      }
    }
    const runnable = await Promise.all(
      projectJobs
        .filter((job) => ["queued", "running"].includes(job.status))
        .map(canRunAgentJob)
    );
    if (!runnable.some(Boolean)) {
      for (const stalled of projectJobs.filter(
        (job) => job.status === "stalled"
      )) {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        if (await canRunAgentJob(stalled)) {
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          await retryStalledJob(stalled);
        }
      }
    }
    if (collect) {
      await stewardRepository.update(projectId, {
        observation: await collectProjectSignals(project, settings.observation),
      });
    }
    for (const signal of await stewardRepository.pendingSignals(projectId)) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await handleSignal(signal, settings.autonomy === "observe");
    }
    const intents = await stewardRepository.intents(projectId);
    for (const intent of intents.filter(
      (intentValue) => intentValue.status === "running"
    )) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      const job = intent.jobId ? await jobsRepository.get(intent.jobId) : null;
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      const batch = intent.batchId ? await getRunBatch(intent.batchId) : null;
      if (
        intent.intent.kind === "run_specs" &&
        job?.status === "blocked" &&
        job.stopReason
      ) {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await askForRunPrerequisite(intent, job.stopReason, job.errorCode);
      }
      if (job && ["completed", "cancelled"].includes(job.status)) {
        if (intent.intent.kind === "run_specs" && job.status === "completed") {
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          const answered = await (async () => {
            const awaitedValue26616 = await jobsRepository.itemsForJob(job.id, {
              statuses: ["answered"],
            });
            return awaitedValue26616.find(
              (item) =>
                item.jobId === job.id &&
                payloadOf(item).runIntentId === intent.id &&
                item.status === "answered"
            );
          })();
          if (answered) {
            // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
            await enqueueIntent(
              projectId,
              intent.intent,
              `resume-run:${intent.id}:${answered.id}`,
              intent.source,
              { sourceChatId: intent.sourceChatId }
            );
          }
        }
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await stewardRepository.updateIntent(intent.id, {
          status: job.status === "completed" ? "completed" : "failed",
        });
      } else if (batch && batch.status !== "running") {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await stewardRepository.updateIntent(intent.id, {
          status: batch.status === "passed" ? "completed" : "failed",
        });
      }
    }
    if (await isAgentPaused(projectId)) {
      return;
    }
    await applyVerifiedRepairs(projectId);
    const pending = await (async () => {
      const awaitedValue27654 = await stewardRepository.intents(projectId);
      return awaitedValue27654.filter((intent) => intent.status === "pending");
    })();
    for (const intent of pending) {
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      if (stopped || (await isAgentPaused(projectId))) {
        break;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        await dispatchIntent(intent);
      } catch (error) {
        if (error instanceof IntentDeferredError) {
          continue;
        }
        if (error instanceof StaleTriageError) {
          // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
          await stewardRepository.updateIntent(intent.id, {
            status: "ignored",
            reason: error.message,
          });
          continue;
        }
        const scrub = createProjectScrubber(projectId);
        // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
        const reason = await scrub(String(error));
        // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
        await (intent.intent.kind === "run_specs"
          ? askForRunPrerequisite(
              intent,
              reason,
              errorCodeOf(error) ?? "failed"
            )
          : stewardRepository.updateIntent(intent.id, {
              status: "failed",
              reason,
            }));
        logger.warn("steward intent failed", {
          projectId,
          intentId: intent.id,
          error,
        });
      }
    }
  });
};

export const processStewards = async function processStewards(): Promise<void> {
  if (processing || stopped) {
    return;
  }
  processing = true;
  try {
    for (const project of await projectsRepository.listProjects()) {
      if (stopped) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- Apply dependent state changes in order and keep resource use bounded.
      await processProjectSteward(project.id).catch((error) =>
        logger.warn("project steward failed", { projectId: project.id, error })
      );
    }
  } finally {
    processing = false;
  }
};

export const startSteward = function startSteward(): void {
  stopped = false;
  timer = setInterval(() => processStewards(), 30_000);
  timer.unref();
  processStewards();
};

export const stopSteward = function stopSteward(): void {
  stopped = true;
  clearInterval(timer);
};

const locks = createKeyedLock();
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;
let processing = false;

const KIND_INSTRUCTIONS = {
  regenerate:
    "Repair only spec.ts to implement the existing spec.yml. Never change the behavior contract. Verify the proposal before requesting approval.",
  explore:
    "Explore only the area requested by the human. Inspect available access and ask through the Inbox when a prerequisite needs human help.",
  coverage:
    "Compare confirmed areas, roles and rules to the existing Specs and propose additional coverage only for the requested scope. Ask when blocked.",
  failure_triage:
    "Investigate the failed Spec and classify its cause without changing expected behavior.",
} as const;
