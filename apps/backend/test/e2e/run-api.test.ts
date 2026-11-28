import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { RUNNER_PROTOCOL_VERSION } from "@specbook/runtime/runner-protocol";
import { Hono } from "hono";

import type { RunBatch } from "../../src/core/runner/batch";
import { requireValue } from "../../src/core/utils/require-value";
import { HUMAN_SPEC, useTempStorage, VALID_SPEC } from "../helpers/storage";

const chromiumAvailable = async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("@playwright/test");
    await (async () => {
      const awaitedValue644 = await chromium.launch({ headless: true });
      return awaitedValue644.close();
    })();
    return true;
  } catch {
    return false;
  }
};

useTempStorage();
const { runMigrations } = await import("../../src/infra/db/migrate");
const { environmentsRepository } =
  await import("../../src/infra/repositories/environments");
const { projectsRepository } =
  await import("../../src/infra/repositories/projects");
const { repoGit } = await import("../../src/core/repo/git");
const { repoBare } = await import("../../src/core/repo/bare");
const writer = await import("../../src/core/repo/writer");
const { executeSpec } = await import("../../src/core/runner/run");
const { createRunsRouter } = await import("../../src/infra/web/routes/runs");
const { createProfile } = await import("../../src/core/credentials/profiles");
const { jobsRepository } = await import("../../src/infra/repositories/jobs");
const { stewardRepository } =
  await import("../../src/infra/repositories/steward");
const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
const { enqueueIntent, processProjectSteward } =
  await import("../../src/core/steward/engine");

const available = await chromiumAvailable();
let site: http.Server;
let baseUrl = "";
const flakyRequests = new Map<string, number>();
const previewCredentials: string[] = [];

before(async () => {
  await runMigrations();
  site = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/credential-preview") {
      response.end(
        `<form method="post" action="/credential-receiver"><label>Password <input type="password" name="password" oninput="fetch('/credential-receiver', { method: 'POST', body: this.value })"></label><button>Continue</button></form>`
      );
      return;
    }
    if (request.url === "/credential-receiver") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        previewCredentials.push(body);
        response.end("<h1>Credentials received</h1>");
      });
      return;
    }
    if (request.url?.startsWith("/flaky")) {
      const count = (flakyRequests.get(request.url) ?? 0) + 1;
      flakyRequests.set(request.url, count);
      response.end(`<h1>${count > 1 ? "Ready" : "Loading"}</h1>`);
      return;
    }
    response.end(
      '<h1>Store</h1><label>Password <input type="password"></label>'
    );
  });
  // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
  await new Promise<void>((resolve) => {
    site.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});

after(() => site?.close());

const app = new Hono();
app.route("/", createRunsRouter());

test("chat events disable compression and buffering in the frontend proxy", async () => {
  const { createChatsRouter } =
    await import("../../src/infra/web/routes/chats");
  const project = await projectsRepository.createProject(
    "Streaming",
    "https://example.com"
  );
  const chatApp = new Hono().route("/", createChatsRouter());
  const { createChat } = await import("../../src/core/chat/session-store");
  const chat = await createChat(project.id);
  const response = await chatApp.request(`/chats/${chat.id}/events`);
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = requireValue(response.body).getReader();
  try {
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /event: connected/u);
  } finally {
    await reader.cancel();
  }
});

test("runner dispatch keeps credential lookup local and survives backend recovery", async () => {
  const { runsRepository } = await import("../../src/infra/repositories/runs");
  const { runnersRepository } =
    await import("../../src/infra/repositories/runners");
  const { completeRunnerWork } =
    await import("../../src/core/private-runner/queue");
  const { issueRunnerToken, authenticateRunnerToken } =
    await import("../../src/core/private-runner/tokens");
  const { getRunBatch, markInterruptedBatches } =
    await import("../../src/core/runner/batch");
  const { runsDir } = await import("../../src/core/paths");
  const {
    encodeReplay,
    MAX_REPLAY_BYTES,
    MAX_REPLAY_RAW_BYTES,
    readReplay,
    REPLAY_FILE,
  } = await import("@specbook/runtime/replay");
  const { gzipSync } = await import("node:zlib");
  const project = await projectsRepository.createProject(
    "Runner recovery",
    "http://private-app.invalid:4300"
  );
  const secretValue = "server-known-replay-secret";
  await createProfile(project.id, {
    name: "protected",
    fields: [{ key: "password", value: secretValue }],
  });
  await createProfile(project.id, {
    name: "short",
    fields: [{ key: "token", value: "1", sensitive: true }],
  });
  await repoGit.ensureProjectRepo(project.id, { create: true });
  const production = requireValue(
    await (async () => {
      const awaitedValue5647 = await environmentsRepository.list(project.id);
      return awaitedValue5647[0];
    })()
  );
  await environmentsRepository.update(production, {
    ...production,
    executor: "runner",
    runnerGroup: "recovery",
  });
  const feature = await writer.createFeatureInRepo(
    project.id,
    null,
    "Private",
    ""
  );
  const { spec } = await writer.createSpecInRepo({
    projectId: project.id,
    featureId: feature.id,
    title: "Local credentials",
    description: "",
    humanSpec: {
      preconditions: [],
      steps: ["Enter password"],
      expectedResult: "",
      postconditions: [],
    },
    testSource:
      'import { test } from "specbook"; test("Local credentials", async ({ page, step, secret }) => { await step("Enter password", async () => { await page.goto("/"); await page.getByLabel("Password").fill(secret("private", "password")); }); });',
  });
  const response = await app.request(`/specs/${spec.id}/run`, {
    method: "POST",
  });
  assert.equal(response.status, 202, await response.clone().text());
  const body = await response.json();
  const queued = requireValue(
    await (async () => {
      const awaitedValue6711 = await runnersRepository.pending();
      return awaitedValue6711.find((job) => job.batchId === body.batchId);
    })()
  );
  assert.ok(queued, "missing server credentials do not block runner dispatch");
  assert.equal(queued.payload.baseUrl, project.baseUrl);
  assert.equal(queued.payload.networkPolicy.allowPrivate, true);
  assert.equal("secretEnv" in queued.payload, false);
  assert.equal("credentialOverrides" in queued.payload, false);
  await runsRepository.markInterruptedRuns();
  await markInterruptedBatches();
  assert.equal(
    requireValue(await runsRepository.getRun(body.run.id)).status,
    "running"
  );
  assert.equal(requireValue(await getRunBatch(body.batchId)).status, "running");
  const issued = await issueRunnerToken("Recovery", "recovery");
  const token = requireValue(
    await authenticateRunnerToken(`Bearer ${issued.token}`)
  );
  await runnersRepository.reportInstance(token.id, token.id, {
    version: "0.1.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    concurrency: 1,
  });
  const lease = requireValue(await runnersRepository.claim(token, 60_000));
  const complete = (artifacts: { path: string; content: string }[]) =>
    completeRunnerWork(lease.id, token.id, {
      leaseId: requireValue(lease.leaseId),
      durationMs: 100,
      processFailure: null,
      results: [
        {
          runId: body.run.id,
          status: "passed",
          durationMs: 100,
          failReason: null,
          failedStep: null,
          artifacts,
        },
      ],
    });
  await assert.rejects(
    () =>
      complete([
        {
          path: "../escaped.json",
          content: Buffer.from("unsafe").toString("base64"),
        },
      ]),
    /Invalid runner artifact path/u
  );
  await assert.rejects(
    () =>
      complete([
        {
          path: REPLAY_FILE,
          content: Buffer.from("invalid gzip").toString("base64"),
        },
      ]),
    /Invalid runner replay/u
  );
  await assert.rejects(
    () =>
      complete([
        {
          path: REPLAY_FILE,
          content: Buffer.alloc(MAX_REPLAY_BYTES + 1).toString("base64"),
        },
      ]),
    /compressed limit/u
  );
  const bomb = gzipSync(Buffer.alloc(MAX_REPLAY_RAW_BYTES + 1));
  await assert.rejects(
    () => complete([{ path: REPLAY_FILE, content: bomb.toString("base64") }]),
    /Invalid runner replay/u
  );
  const replay = requireValue(
    await encodeReplay([
      {
        type: 4,
        timestamp: 1000,
        data: { href: "https://example.com", width: 800, height: 600 },
      },
      {
        type: 2,
        timestamp: 1001,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: "html",
                attributes: {},
                childNodes: [
                  {
                    type: 2,
                    id: 3,
                    tagName: "head",
                    attributes: {},
                    childNodes: [],
                  },
                  {
                    type: 2,
                    id: 4,
                    tagName: "body",
                    attributes: {},
                    childNodes: [
                      { type: 3, id: 5, textContent: `${secretValue} 1` },
                    ],
                  },
                ],
              },
            ],
          },
          initialOffset: { left: 0, top: 0 },
        },
      },
    ])
  );
  assert.ok(replay);
  const outside = await fs.mkdtemp(path.join(runsDir, ".outside-upload-"));
  const sentinel = path.join(outside, "keep.txt");
  await fs.writeFile(sentinel, secretValue);
  await fs.symlink(outside, path.join(runsDir, body.run.id, "evidence"));
  await complete([
    { path: REPLAY_FILE, content: replay.toString("base64") },
    {
      path: "evidence.json",
      content: Buffer.from(
        JSON.stringify({
          steps: [],
          video: null,
          failedStep: null,
          replay: { file: REPLAY_FILE, bytes: replay.length },
          diagnostics: [{ kind: "console", message: secretValue }],
        })
      ).toString("base64"),
    },
  ]);
  assert.equal(
    requireValue(await runsRepository.getRun(body.run.id)).status,
    "passed"
  );
  assert.equal(
    await fs.readFile(sentinel, "utf-8"),
    secretValue,
    "uploads replace evidence symlinks without touching their targets"
  );
  await fs.rm(outside, { recursive: true, force: true });
  const directory = path.join(runsDir, body.run.id);
  const savedReplay = await readReplay(directory);
  assert.ok(savedReplay);
  assert.ok(
    !JSON.stringify(savedReplay).includes(secretValue),
    "replays scrub sensitive page content before storage"
  );
  assert.equal(
    savedReplay[0].timestamp,
    1000,
    "short sensitive values do not corrupt replay metadata"
  );
  assert.ok(JSON.stringify(savedReplay).includes('"textContent":"•••• ••••"'));
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, "evidence.json"), "utf-8")
  );
  assert.equal(manifest.replay.file, REPLAY_FILE);
  assert.equal(
    manifest.replay.bytes,
    await (async () => {
      const awaitedValue11662 = await fs.stat(
        path.join(directory, REPLAY_FILE)
      );
      return awaitedValue11662.size;
    })()
  );
  assert.ok(!JSON.stringify(manifest).includes(secretValue));
  const report = await app.request(`/runs/${body.run.id}/report`);
  assert.equal(report.status, 200);
  const html = await report.text();
  assert.ok(html.includes("Replay"));
  assert.ok(!html.includes(secretValue));
  assert.match(
    requireValue(report.headers.get("content-security-policy")),
    /script-src 'sha256-/u
  );
});

test("runner cancellation removes pending execution and isolated candidate verification preserves Spec health", async () => {
  const { runsRepository } = await import("../../src/infra/repositories/runs");
  const { specsRepository } =
    await import("../../src/infra/repositories/specs");
  const { runnersRepository } =
    await import("../../src/infra/repositories/runners");
  const { completeRunnerWork } =
    await import("../../src/core/private-runner/queue");
  const { issueRunnerToken, authenticateRunnerToken } =
    await import("../../src/core/private-runner/tokens");
  const { verifyRunnerCandidate } = await import("../../src/core/runner/batch");
  const { resolveRunEnvironment } = await import("../../src/core/environments");
  const { runsDir } = await import("../../src/core/paths");
  const { serializeSpecYaml } = await import("@specbook/runtime/yaml");
  const project = await projectsRepository.createProject(
    "Runner cancellation",
    "http://private-app.invalid:4300"
  );
  await repoGit.ensureProjectRepo(project.id, { create: true });
  const production = requireValue(
    await (async () => {
      const awaitedValue13203 = await environmentsRepository.list(project.id);
      return awaitedValue13203[0];
    })()
  );
  await environmentsRepository.update(production, {
    ...production,
    executor: "runner",
    runnerGroup: "candidate",
  });
  const environment = await resolveRunEnvironment(project.id);
  const feature = await writer.createFeatureInRepo(
    project.id,
    null,
    "Private",
    ""
  );
  const { spec } = await writer.createSpecInRepo({
    projectId: project.id,
    featureId: feature.id,
    title: "Open the application",
    description: "",
    humanSpec: HUMAN_SPEC,
    testSource: VALID_SPEC,
  });
  const markdown = serializeSpecYaml({
    title: "Open the application",
    description: "",
    humanSpec: HUMAN_SPEC,
  });
  const directory = path.join(runsDir, "proposals", project.id, "candidate");
  await assert.rejects(
    () =>
      verifyRunnerCandidate({
        specId: spec.id,
        testSource: "invalid source",
        markdown,
        environment,
        directory,
      }),
    /invalid/u
  );
  assert.deepEqual(await runsRepository.listRuns(spec.id), []);
  const pending = async () => {
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = await (async () => {
        const awaitedValue14369 = await runnersRepository.pending();
        return awaitedValue14369.find((row) => row.projectId === project.id);
      })();
      if (job) {
        return job;
      }
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    /* oxlint-enable no-await-in-loop */
    throw new Error("Runner work was not queued");
  };
  const controller = new AbortController();
  const cancelled = executeSpec(spec.id, {
    environment,
    signal: controller.signal,
  });
  const cancelledAssertion = assert.rejects(cancelled, /Stopped/u);
  await pending();
  controller.abort(new Error("Stopped by the user"));
  await cancelledAssertion;
  assert.equal(
    await (async () => {
      const awaitedValue14966 = await runnersRepository.pending();
      return awaitedValue14966.some((row) => row.projectId === project.id);
    })(),
    false
  );
  assert.equal(
    await (async () => {
      const awaitedValue15094 = await runsRepository.listRuns(spec.id);
      return awaitedValue15094[0].errorCode;
    })(),
    "cancelled"
  );
  const candidateAbort = new AbortController();
  const cancelledCandidate = verifyRunnerCandidate({
    specId: spec.id,
    testSource: VALID_SPEC,
    markdown,
    environment,
    directory,
    signal: candidateAbort.signal,
  });
  const candidateAssertion = assert.rejects(
    cancelledCandidate,
    /Candidate stopped/u
  );
  await pending();
  candidateAbort.abort(new Error("Candidate stopped"));
  await candidateAssertion;
  assert.equal(
    await (async () => {
      const awaitedValue15629 = await runnersRepository.pending();
      return awaitedValue15629.some((row) => row.projectId === project.id);
    })(),
    false
  );
  assert.equal(
    await (async () => {
      const awaitedValue15757 = await runsRepository.listRuns(spec.id);
      return awaitedValue15757.length;
    })(),
    1,
    "isolated candidates leave no public runs"
  );
  const verifying = verifyRunnerCandidate({
    specId: spec.id,
    testSource: VALID_SPEC,
    markdown,
    environment,
    directory,
  });
  const job = await pending();
  const issued = await issueRunnerToken("Candidate", "candidate");
  const token = requireValue(
    await authenticateRunnerToken(`Bearer ${issued.token}`)
  );
  await runnersRepository.reportInstance(token.id, token.id, {
    version: "0.1.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    concurrency: 1,
  });
  const lease = requireValue(await runnersRepository.claim(token, 60_000));
  assert.equal(lease.id, job.id);
  await completeRunnerWork(lease.id, token.id, {
    leaseId: requireValue(lease.leaseId),
    durationMs: 100,
    processFailure: null,
    results: [
      {
        runId: lease.payload.specs[0].runId,
        status: "passed",
        durationMs: 100,
        failReason: null,
        failedStep: null,
        artifacts: [],
      },
    ],
  });
  const verified = await verifying;
  assert.equal(verified.status, "passed");
  assert.equal(
    requireValue(await specsRepository.getSpec(spec.id)).status,
    "unverified"
  );
  assert.equal(
    await (async () => {
      const awaitedValue16955 = await runsRepository.listRuns(spec.id);
      return awaitedValue16955.length;
    })(),
    1
  );
  assert.equal(
    await fs.readFile(path.join(directory, "spec.ts"), "utf-8"),
    VALID_SPEC
  );
  const { startContextDiscovery } =
    await import("../../src/core/chat/discovery");
  await assert.rejects(
    () =>
      startContextDiscovery(project.id, {
        goal: "Explore",
        startUrl: environment.baseUrl,
        safetyNotes: [],
      }),
    /exploration is unavailable/u
  );
  const { createProjectContextsRouter } =
    await import("../../src/infra/web/routes/project-contexts");
  const contextApp = new Hono().route("/", createProjectContextsRouter());
  const discoveryResponse = await contextApp.request(
    `/projects/${project.id}/context-discoveries`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }
  );
  assert.equal(discoveryResponse.status, 409);
});

test("queued runner runs release Spec locks, expire with a reason, and stop after three abandoned leases", async () => {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../../src/infra/db/client");
  const { runnerJobs } = await import("../../src/infra/db/schema");
  const { areSpecsLocked } = await import("../../src/core/specs/lifecycle");
  const { runnersRepository } =
    await import("../../src/infra/repositories/runners");
  const { runsRepository } = await import("../../src/infra/repositories/runs");
  const { maintainRunnerQueue, releaseRunnerWork } =
    await import("../../src/core/private-runner/queue");
  const { startSpecBatch, getRunBatch } =
    await import("../../src/core/runner/batch");
  const { issueRunnerToken, authenticateRunnerToken } =
    await import("../../src/core/private-runner/tokens");
  const project = await projectsRepository.createProject(
    "Runner deadlines",
    "http://private-app.invalid:4601"
  );
  await repoGit.ensureProjectRepo(project.id, { create: true });
  const environment = requireValue(
    await (async () => {
      const awaitedValue18930 = await environmentsRepository.list(project.id);
      return awaitedValue18930[0];
    })()
  );
  await environmentsRepository.update(environment, {
    ...environment,
    executor: "runner",
    runnerGroup: "deadline",
  });
  const feature = await writer.createFeatureInRepo(
    project.id,
    null,
    "Private",
    ""
  );
  const { spec } = await writer.createSpecInRepo({
    projectId: project.id,
    featureId: feature.id,
    title: "Open the application",
    description: "",
    humanSpec: HUMAN_SPEC,
    testSource: VALID_SPEC,
  });
  const waiting = executeSpec(spec.id);
  let job;
  /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
  for (let attempt = 0; attempt < 100 && !job; attempt += 1) {
    job = await (async () => {
      const awaitedValue19566 = await runnersRepository.pending();
      return awaitedValue19566.find((row) => row.projectId === project.id);
    })();
    if (!job) {
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  /* oxlint-enable no-await-in-loop */
  assert.ok(job);
  assert.equal(
    areSpecsLocked([spec.id]),
    false,
    "waiting for an offline runner must allow publication and edits"
  );
  await db
    .update(runnerJobs)
    .set({ queueExpiresAt: new Date(0).toISOString() })
    .where(eq(runnerJobs.id, job.id));
  await maintainRunnerQueue();
  const expired = await waiting;
  assert.equal(expired.status, "error");
  assert.match(
    requireValue(expired.failReason),
    /Runner work expired.*waiting.*for a runner/u
  );
  await runsRepository.acknowledgeAutomation(expired.id);
  assert.match(
    requireValue(requireValue(await getRunBatch(job.batchId)).failReason),
    /Runner work expired/u
  );
  const next = await startSpecBatch(project.id, [spec.id], "Abandoned leases");
  const issued = await issueRunnerToken("Deadline", "deadline");
  const token = requireValue(
    await authenticateRunnerToken(`Bearer ${issued.token}`)
  );
  await runnersRepository.reportInstance(token.id, token.id, {
    version: "0.1.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    concurrency: 1,
  });
  /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lease = requireValue(await runnersRepository.claim(token, 60_000));
    assert.equal(lease.batchId, next.id);
    await db
      .update(runnerJobs)
      .set({ leaseExpiresAt: new Date(0).toISOString() })
      .where(eq(runnerJobs.id, lease.id));
    await maintainRunnerQueue();
  }
  /* oxlint-enable no-await-in-loop */
  assert.equal(await runnersRepository.claim(token, 60_000), null);
  assert.match(
    requireValue(requireValue(await getRunBatch(next.id)).failReason),
    /stopped after 3 attempts.*lease expired/u
  );
  assert.equal(
    requireValue(await runsRepository.getRun(next.specs[0].runId)).status,
    "error"
  );
  await runsRepository.acknowledgeAutomation(next.specs[0].runId);
  const refused = await startSpecBatch(project.id, [spec.id], "Origin refusal");
  const refusedLease = requireValue(
    await runnersRepository.claim(token, 60_000)
  );
  await releaseRunnerWork(
    refusedLease.id,
    token.id,
    requireValue(refusedLease.leaseId),
    "Runner refused this job: its origins are outside the runner allowlist."
  );
  assert.match(
    requireValue(requireValue(await getRunBatch(refused.id)).failReason),
    /outside the runner allowlist/u
  );
  assert.equal(
    await runnersRepository.claim(token, 60_000),
    null,
    "refused work must not be claimed repeatedly"
  );
  await runsRepository.acknowledgeAutomation(refused.specs[0].runId);
});

test("broken runner finalization cannot poison claims, queue notices or metrics", async () => {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../../src/infra/db/client");
  const { runnerJobs } = await import("../../src/infra/db/schema");
  const { runnersRepository } =
    await import("../../src/infra/repositories/runners");
  const { maintainRunnerQueue, claimRunnerWork, releaseRunnerWork } =
    await import("../../src/core/private-runner/queue");
  const { runnerQueueSnapshot } =
    await import("../../src/core/private-runner/visibility");
  const { queueMetrics } =
    await import("../../src/core/private-runner/metrics");
  const { startSpecBatch, getRunBatch, getRunBatchDirectory } =
    await import("../../src/core/runner/batch");
  const { runsRepository } = await import("../../src/infra/repositories/runs");
  const { runsDir } = await import("../../src/core/paths");
  const { issueRunnerToken, authenticateRunnerToken } =
    await import("../../src/core/private-runner/tokens");
  const project = await projectsRepository.createProject(
    "Broken runner finish",
    "http://private-app.invalid:4601"
  );
  await repoGit.ensureProjectRepo(project.id, { create: true });
  const environment = requireValue(
    await (async () => {
      const awaitedValue23339 = await environmentsRepository.list(project.id);
      return awaitedValue23339[0];
    })()
  );
  await environmentsRepository.update(environment, {
    ...environment,
    executor: "runner",
    runnerGroup: "broken",
  });
  const feature = await writer.createFeatureInRepo(
    project.id,
    null,
    "Private",
    ""
  );
  const makeSpec = async (title: string) =>
    await (async () => {
      const awaitedValue23675 = await writer.createSpecInRepo({
        projectId: project.id,
        featureId: feature.id,
        title,
        description: "",
        humanSpec: HUMAN_SPEC,
        testSource: VALID_SPEC.replace("Open the application", title),
      });
      return awaitedValue23675.spec;
    })();
  /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
  for (const corruption of [
    "missing batch",
    "invalid batch",
    "missing Spec",
    "finish error",
    "batch directory",
  ]) {
    const spec = await makeSpec(corruption);
    const abort = new AbortController();
    const waiting =
      corruption === "batch directory"
        ? executeSpec(spec.id, { signal: abort.signal })
        : null;
    let batch: RunBatch;
    if (waiting) {
      let pending;
      for (let attempt = 0; attempt < 100 && !pending; attempt += 1) {
        pending = await (async () => {
          const awaitedValue24451 = await runnersRepository.pending();
          return awaitedValue24451.find((row) =>
            row.payload.specs.some((entry) => entry.specId === spec.id)
          );
        })();
        if (!pending) {
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
      }
      assert.ok(pending);
      batch = requireValue(await getRunBatch(pending.batchId));
    } else {
      batch = await startSpecBatch(project.id, [spec.id], corruption);
    }
    const job = requireValue(
      await (async () => {
        const awaitedValue24876 = await runnersRepository.pending();
        return awaitedValue24876.find((row) => row.batchId === batch.id);
      })()
    );
    if (corruption === "missing Spec") {
      assert.equal(
        requireValue(await runsRepository.getRun(batch.specs[0].runId))
          .awaitingDeploy,
        false
      );
      const published = await writer.readProjectSpecFiles(project.id);
      const current = requireValue(
        published.specs.find((entry) => entry.path === spec.path)
      );
      await writer.publishSpecsInRepo(project.id, environment.id, [
        {
          path: spec.path,
          baseRevision: current.revision,
          files: current.files,
          feature: published.features[0],
        },
      ]);
    }
    const batchFile = path.join(getRunBatchDirectory(batch.id), "batch.json");
    if (corruption === "missing batch") {
      await fs.rm(batchFile);
    }
    if (corruption === "invalid batch") {
      await fs.writeFile(batchFile, "{invalid");
    }
    if (corruption === "batch directory") {
      await fs.rm(batchFile);
      await fs.mkdir(batchFile);
    }
    if (corruption === "missing Spec") {
      await fs.rm(path.join(runsDir, batch.specs[0].runId, "spec.ts"));
    }
    const original = runsRepository.finishRun;
    if (corruption === "finish error") {
      runsRepository.finishRun = () => {
        try {
          throw new Error("Simulated finish failure");
        } catch (error) {
          return Promise.reject(error);
        }
      };
    }
    await db
      .update(runnerJobs)
      .set({ queueExpiresAt: new Date(0).toISOString() })
      .where(eq(runnerJobs.id, job.id));
    try {
      await maintainRunnerQueue();
    } finally {
      runsRepository.finishRun = original;
    }
    const retired = requireValue(await runnersRepository.job(job.id));
    assert.equal(retired.status, "completed", corruption);
    assert.match(
      requireValue(retired.lastFailure),
      /could not be finalized/u,
      corruption
    );
    if (waiting) {
      const timeout = setTimeout(
        () => abort.abort(new Error("Terminal runner waiter did not finish")),
        3000
      );
      try {
        const result = await waiting;
        assert.equal(
          result.status,
          "error",
          "waiter must finish even when batch metadata cannot be repaired"
        );
        assert.match(
          requireValue(result.failReason),
          /could not be finalized/u
        );
      } finally {
        clearTimeout(timeout);
      }
      await fs.rm(batchFile, { recursive: true, force: true });
    } else {
      assert.equal(
        requireValue(await getRunBatch(batch.id)).status,
        "error",
        corruption
      );
    }
    if (corruption === "missing Spec") {
      const recovered = requireValue(
        await runsRepository.getRun(batch.specs[0].runId)
      );
      assert.equal(
        recovered.awaitingDeploy,
        true,
        "fallback must retain deployment waiting created after this run started"
      );
      assert.equal(recovered.automationPending, false);
      assert.equal(
        requireValue(await getRunBatch(batch.id)).specs[0].awaitingDeploy,
        true
      );
      const { projectOverview } = await import("../../src/core/jobs/overview");
      assert.equal(
        await (async () => {
          const awaitedValue27871 = await projectOverview(project.id);
          return awaitedValue27871.specHealth[spec.id].status;
        })(),
        "awaiting_deploy"
      );
    }
    await runsRepository.acknowledgeAutomation(batch.specs[0].runId);
    if (corruption === "finish error") {
      await runsRepository.finishRun(
        batch.specs[0].runId,
        "error",
        0,
        "Verification finished"
      );
    }
  }
  /* oxlint-enable no-await-in-loop */
  const healthy = await makeSpec("Healthy work");
  const batch = await startSpecBatch(project.id, [healthy.id], "Healthy work");
  const queue = await runnerQueueSnapshot();
  assert.equal(requireValue(queue.batchQueues.get(batch.id)).queued, 1);
  assert.equal(
    requireValue(
      queueMetrics(queue.queues).groups.find(
        (entry) => entry.group === "broken"
      )
    ).queued,
    1
  );
  const issued = await issueRunnerToken("Healthy runner", "broken");
  const token = requireValue(
    await authenticateRunnerToken(`Bearer ${issued.token}`)
  );
  await runnersRepository.reportInstance(token.id, token.id, {
    version: "0.1.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    concurrency: 1,
  });
  const lease = await claimRunnerWork(
    token,
    new AbortController().signal,
    token.id
  );
  assert.equal(requireValue(lease).batchId, batch.id);
  await releaseRunnerWork(
    requireValue(lease).id,
    token.id,
    requireValue(requireValue(lease).leaseId),
    "Verification finished"
  );
  await runsRepository.acknowledgeAutomation(batch.specs[0].runId);
});

test("runner execution gets its full budget after waiting and stale completion recovers capacity", async () => {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../../src/infra/db/client");
  const { runnerJobs } = await import("../../src/infra/db/schema");
  const { runnersRepository, runnerJobDeadline, RUNNER_EXECUTION_GRACE_MS } =
    await import("../../src/infra/repositories/runners");
  const { recoverRunnerCompletions, releaseRunnerWork, heartbeatRunnerWork } =
    await import("../../src/core/private-runner/queue");
  const { startSpecBatch } = await import("../../src/core/runner/batch");
  const { runsRepository } = await import("../../src/infra/repositories/runs");
  const { issueRunnerToken, authenticateRunnerToken } =
    await import("../../src/core/private-runner/tokens");
  const project = await projectsRepository.createProject(
    "Runner completion recovery",
    "http://private-app.invalid:4601"
  );
  await repoGit.ensureProjectRepo(project.id, { create: true });
  const environment = requireValue(
    await (async () => {
      const awaitedValue30270 = await environmentsRepository.list(project.id);
      return awaitedValue30270[0];
    })()
  );
  await environmentsRepository.update(environment, {
    ...environment,
    executor: "runner",
    runnerGroup: "stale",
  });
  const feature = await writer.createFeatureInRepo(
    project.id,
    null,
    "Private",
    ""
  );
  const { spec } = await writer.createSpecInRepo({
    projectId: project.id,
    featureId: feature.id,
    title: "Open the application",
    description: "",
    humanSpec: HUMAN_SPEC,
    testSource: VALID_SPEC,
  });
  const batch = await startSpecBatch(
    project.id,
    [spec.id],
    "Recover completion"
  );
  const job = requireValue(
    await (async () => {
      const awaitedValue30892 = await runnersRepository.pending();
      return awaitedValue30892.find((row) => row.batchId === batch.id);
    })()
  );
  await db
    .update(runnerJobs)
    .set({
      createdAt: new Date(
        Date.now() - job.payload.timeoutMs - 61_000
      ).toISOString(),
      queueExpiresAt: new Date(Date.now() + 200).toISOString(),
    })
    .where(eq(runnerJobs.id, job.id));
  const issued = await issueRunnerToken("Recovery runner", "stale");
  const token = requireValue(
    await authenticateRunnerToken(`Bearer ${issued.token}`)
  );
  await runnersRepository.reportInstance(token.id, token.id, {
    version: "0.1.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    concurrency: 1,
  });
  let lease = requireValue(await runnersRepository.claim(token, 60_000));
  assert.equal(lease.id, job.id, "queued time must not consume execution time");
  assert.ok(
    runnerJobDeadline(lease) >=
      Date.now() + lease.payload.timeoutMs + RUNNER_EXECUTION_GRACE_MS - 1000
  );
  // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
  assert.ok(
    await heartbeatRunnerWork(lease.id, token.id, requireValue(lease.leaseId)),
    "execution remains valid after its queue TTL elapses"
  );
  await db
    .update(runnerJobs)
    .set({ queueExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() })
    .where(eq(runnerJobs.id, lease.id));
  /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
  for (let scaleDown = 0; scaleDown < 5; scaleDown += 1) {
    await releaseRunnerWork(lease.id, token.id, requireValue(lease.leaseId));
    lease = requireValue(await runnersRepository.claim(token, 60_000));
    assert.equal(lease.attempts, 0);
  }
  /* oxlint-enable no-await-in-loop */
  await runnersRepository.reserveCompletion(lease.id);
  await db
    .update(runnerJobs)
    .set({ completionStartedAt: new Date(0).toISOString() })
    .where(eq(runnerJobs.id, lease.id));
  await runnersRepository.reclaim();
  lease = requireValue(await runnersRepository.claim(token, 60_000));
  assert.equal(lease.attempts, 1);
  await runnersRepository.reserveCompletion(lease.id);
  await recoverRunnerCompletions();
  lease = requireValue(await runnersRepository.claim(token, 60_000));
  assert.equal(
    lease.attempts,
    2,
    "startup recovers completing rows immediately"
  );
  await releaseRunnerWork(
    lease.id,
    token.id,
    requireValue(lease.leaseId),
    "Verification finished"
  );
  await runsRepository.acknowledgeAutomation(batch.specs[0].runId);
});

test("tunnel waits release Spec locks and expire with a clear reason", async () => {
  const { areSpecsLocked } = await import("../../src/core/specs/lifecycle");
  const { startSpecBatch, getRunBatch } =
    await import("../../src/core/runner/batch");
  const { runsRepository } = await import("../../src/infra/repositories/runs");
  const { tunnelQueueEntries } = await import("../../src/core/tunnel/registry");
  const project = await projectsRepository.createProject(
    "Tunnel wait deadline",
    "http://private-app.invalid:4601"
  );
  await repoGit.ensureProjectRepo(project.id, { create: true });
  const environment = requireValue(
    await (async () => {
      const awaitedValue33777 = await environmentsRepository.list(project.id);
      return awaitedValue33777[0];
    })()
  );
  await environmentsRepository.update(environment, {
    ...environment,
    executor: "tunnel",
    runnerGroup: "offline-tunnel",
  });
  const feature = await writer.createFeatureInRepo(
    project.id,
    null,
    "Private",
    ""
  );
  const { spec } = await writer.createSpecInRepo({
    projectId: project.id,
    featureId: feature.id,
    title: "Open the application",
    description: "",
    humanSpec: HUMAN_SPEC,
    testSource: VALID_SPEC,
  });
  const previous = process.env.SPECBOOK_TUNNEL_QUEUE_TIMEOUT_SECONDS;
  process.env.SPECBOOK_TUNNEL_QUEUE_TIMEOUT_SECONDS = "0.2";
  try {
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const single of [false, true]) {
      const running = single
        ? executeSpec(spec.id)
        : startSpecBatch(project.id, [spec.id], "Offline tunnel");
      for (
        let attempt = 0;
        attempt < 50 &&
        !(await (async () => {
          const awaitedValue34673 = await tunnelQueueEntries();
          return awaitedValue34673.some(
            (entry) => entry.projectId === project.id
          );
        })());
        attempt += 1
      ) {
        // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      assert.equal(areSpecsLocked([spec.id]), false);
      assert.match(
        requireValue(
          requireValue(
            await (async () => {
              const awaitedValue34956 = await tunnelQueueEntries();
              return awaitedValue34956.find(
                (entry) => entry.projectId === project.id
              );
            })()
          ).reason
        ),
        /No tunnel connected/u
      );
      if (single) {
        const result = await running;
        assert.equal(result.status, "error");
        assert.match(
          requireValue(result.failReason),
          /Tunnel work expired.*No tunnel connected/u
        );
      } else {
        const batch = await running;
        let complete = await getRunBatch(batch.id);
        for (
          let attempt = 0;
          attempt < 100 && complete?.status === "running";
          attempt += 1
        ) {
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
          complete = await getRunBatch(batch.id);
        }
        assert.equal(requireValue(complete).status, "error");
        assert.match(
          requireValue(requireValue(complete).failReason),
          /Tunnel work expired.*No tunnel connected/u
        );
      }
      const run = await (async () => {
        const awaitedValue35885 = await runsRepository.listRuns(spec.id);
        return awaitedValue35885[0];
      })();
      await runsRepository.acknowledgeAutomation(run.id);
    }
    /* oxlint-enable no-await-in-loop */
  } finally {
    if (previous === undefined) {
      delete process.env.SPECBOOK_TUNNEL_QUEUE_TIMEOUT_SECONDS;
    } else {
      process.env.SPECBOOK_TUNNEL_QUEUE_TIMEOUT_SECONDS = previous;
    }
  }
});

test("runner completion keeps heartbeats available and preserves deployment state through revocation and expiry", async () => {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../../src/infra/db/client");
  const { runnerJobs } = await import("../../src/infra/db/schema");
  const { startSpecBatch } = await import("../../src/core/runner/batch");
  const { runnersRepository } =
    await import("../../src/infra/repositories/runners");
  const { runsRepository } = await import("../../src/infra/repositories/runs");
  const { specsRepository } =
    await import("../../src/infra/repositories/specs");
  const {
    completeRunnerWork,
    heartbeatRunnerWork,
    maintainRunnerQueue,
    revokeRunnerToken,
  } = await import("../../src/core/private-runner/queue");
  const { issueRunnerToken, authenticateRunnerToken } =
    await import("../../src/core/private-runner/tokens");
  const project = await projectsRepository.createProject(
    "Runner completion",
    "http://private-app.invalid:4601"
  );
  await repoGit.ensureProjectRepo(project.id, { create: true });
  const environment = requireValue(
    await (async () => {
      const awaitedValue37327 = await environmentsRepository.list(project.id);
      return awaitedValue37327[0];
    })()
  );
  await environmentsRepository.update(environment, {
    ...environment,
    executor: "runner",
    runnerGroup: "completion",
  });
  const feature = await writer.createFeatureInRepo(
    project.id,
    null,
    "Private",
    ""
  );
  const { spec } = await writer.createSpecInRepo({
    projectId: project.id,
    featureId: feature.id,
    title: "Open the application",
    description: "",
    humanSpec: HUMAN_SPEC,
    testSource: VALID_SPEC,
  });
  const batch = await startSpecBatch(project.id, [spec.id], "Before publish");
  const issued = await issueRunnerToken("Completion", "completion");
  const token = requireValue(
    await authenticateRunnerToken(`Bearer ${issued.token}`)
  );
  await runnersRepository.reportInstance(token.id, token.id, {
    version: "0.1.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    concurrency: 1,
  });
  const lease = requireValue(await runnersRepository.claim(token, 60_000));
  const files = await writer.readProjectSpecFiles(project.id);
  await writer.publishSpecsInRepo(project.id, environment.id, [
    {
      path: spec.path,
      baseRevision: files.specs[0].revision,
      files: files.specs[0].files,
      feature: files.features[0],
    },
  ]);
  const original = fs.rename;
  let started!: () => void;
  let resume!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
  const moving = new Promise<void>((resolve) => {
    started = resolve;
  });
  // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
  const hold = new Promise<void>((resolve) => {
    resume = resolve;
  });
  fs.rename = async (source, destination) => {
    if (String(source).includes(".runner-upload")) {
      started();
      await hold;
    }
    return original(source, destination);
  };
  const completing = completeRunnerWork(lease.id, token.id, {
    leaseId: requireValue(lease.leaseId),
    durationMs: 100,
    processFailure: null,
    results: [
      {
        runId: batch.specs[0].runId,
        status: "failed",
        durationMs: 100,
        failReason: "The old deployment still fails",
        failedStep: "Open the page",
        artifacts: [
          {
            path: "evidence.json",
            content: Buffer.from("{}").toString("base64"),
          },
        ],
      },
    ],
  });
  try {
    await moving;
    assert.equal(
      requireValue(await runnersRepository.job(lease.id)).status,
      "completing"
    );
    const heartbeat = await Promise.race([
      heartbeatRunnerWork(lease.id, token.id, requireValue(lease.leaseId)),
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 1000);
      }),
    ]);
    assert.ok(heartbeat, "file moves must not hold the global queue lock");
    await db
      .update(runnerJobs)
      .set({
        claimedAt: new Date(0).toISOString(),
        completionStartedAt: new Date(0).toISOString(),
      })
      .where(eq(runnerJobs.id, lease.id));
    await revokeRunnerToken(token.id);
    await maintainRunnerQueue();
    assert.equal(
      requireValue(await runnersRepository.job(lease.id)).status,
      "completing",
      "an accepted completion must finish once even if its token is revoked or its deadline elapses during storage"
    );
  } finally {
    resume();
    fs.rename = original;
  }
  await completing;
  const run = requireValue(await runsRepository.getRun(batch.specs[0].runId));
  assert.equal(run.awaitingDeploy, true);
  assert.equal(
    run.automationPending,
    false,
    "a failure received after publish must not start triage"
  );
  assert.equal(
    requireValue(await specsRepository.getSpec(spec.id)).status,
    "awaiting_deploy"
  );
});

test("historical evidence maps step kinds by title and falls back for unknown labels", async () => {
  const { runsRepository } = await import("../../src/infra/repositories/runs");
  const { runsDir } = await import("../../src/core/paths");
  const { serializeSpecYaml } = await import("@specbook/runtime/yaml");
  const project = await projectsRepository.createProject(
    "Historical evidence",
    baseUrl
  );
  await repoGit.ensureProjectRepo(project.id, { create: true });
  const feature = await writer.createFeatureInRepo(
    project.id,
    null,
    "Store",
    ""
  );
  const { spec } = await writer.createSpecInRepo({
    projectId: project.id,
    featureId: feature.id,
    title: "Open the application",
    description: "",
    humanSpec: HUMAN_SPEC,
    testSource: VALID_SPEC,
  });
  const run = await runsRepository.createRun({
    specId: spec.id,
    sourceHash: spec.sourceHash,
    commitSha: await repoGit.getHeadSha(project.id),
  });
  await runsRepository.finishRun(run.id, "passed", 1, null);
  const directory = path.join(runsDir, run.id);
  await fs.mkdir(path.join(directory, "evidence"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "spec.yml"),
    serializeSpecYaml({
      title: "Historical",
      description: "",
      humanSpec: {
        ...HUMAN_SPEC,
        preconditions: ["An account exists"],
        postconditions: ["Sign out"],
      },
    })
  );
  await fs.writeFile(
    path.join(directory, "evidence.json"),
    JSON.stringify({
      steps: [
        {
          number: 1,
          label: " open   THE page.; ",
          file: "evidence/step-01.png",
        },
        { number: 2, label: "The page is shown", file: "evidence/step-02.png" },
        {
          number: 3,
          label: "Unknown historical action",
          file: "evidence/step-03.png",
        },
      ],
      video: null,
      failedStep: null,
    })
  );
  /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
  for (const number of [1, 2, 3]) {
    await fs.writeFile(
      path.join(directory, "evidence", `step-0${number}.png`),
      "png"
    );
  }
  /* oxlint-enable no-await-in-loop */
  const response = await app.request(`/runs/${run.id}/evidence`);
  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.deepEqual(
    evidence.steps.map((step: { kind: string; ordinal: number | null }) => [
      step.kind,
      step.ordinal,
    ]),
    [
      ["step", 1],
      ["expected", null],
      ["step", 3],
    ]
  );
  assert.equal(evidence.replay, null);
  assert.equal(evidence.replayUnavailable, null);
  assert.equal(
    await (async () => {
      const awaitedValue43337 = await app.request(`/runs/${run.id}/replay`);
      return awaitedValue43337.status;
    })(),
    404,
    "older runs have no replay"
  );
  assert.equal(
    await (async () => {
      const awaitedValue43457 = await app.request(
        "/runs/00000000-0000-4000-8000-000000000000/replay"
      );
      return awaitedValue43457.status;
    })(),
    404
  );
  const screenshot = await app.request(
    `/runs/${run.id}/artifacts/evidence/step-01.png`
  );
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.headers.get("content-type"), "image/png");
  await fs.writeFile(
    path.join(directory, "spec.yml"),
    serializeSpecYaml({
      title: "Duplicate titles",
      description: "",
      humanSpec: {
        preconditions: ["Check state"],
        steps: ["Check state"],
        expectedResult: "Check state",
        postconditions: ["Check state"],
      },
    })
  );
  await fs.writeFile(
    path.join(directory, "spec.ts"),
    'import { test } from "specbook"; test("Duplicate titles", async ({ step, page }) => { await step("Check state", async () => { await page.goto("/"); }); await step("Check state", async () => {}); await step("Check state", async () => {}); await step("Check state", async () => {}); });'
  );
  await fs.writeFile(path.join(directory, "evidence/step-04.png"), "png");
  await fs.writeFile(
    path.join(directory, "evidence.json"),
    JSON.stringify({
      steps: [1, 2, 3, 4].map((number) => ({
        number,
        label: "Check state",
        file: `evidence/step-0${number}.png`,
      })),
      video: null,
      failedStep: null,
    })
  );
  const duplicates = await (async () => {
    const awaitedValue44843 = await app.request(`/runs/${run.id}/evidence`);
    return awaitedValue44843.json();
  })();
  assert.deepEqual(
    duplicates.steps.map((step: { kind: string; ordinal: number | null }) => [
      step.kind,
      step.ordinal,
    ]),
    [
      ["precondition", null],
      ["step", 1],
      ["expected", null],
      ["postcondition", null],
    ]
  );

  const { encodeReplay, REPLAY_FILE, restoreReplayEvents } =
    await import("@specbook/runtime/replay");
  const { readOfflineReplay } = await import("@specbook/runtime/replay-data");
  const image = "data:image/webp;base64,aW1hZ2U=";
  const replay = requireValue(
    await encodeReplay([
      {
        type: 4,
        timestamp: 1000,
        data: { href: baseUrl, width: 800, height: 600 },
      },
      {
        type: 2,
        timestamp: 1001,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: "img",
                attributes: { src: image, onload: "alert('unsafe')" },
                childNodes: [],
              },
              {
                type: 2,
                id: 3,
                tagName: "img",
                attributes: { src: image },
                childNodes: [],
              },
              {
                type: 2,
                id: 4,
                tagName: "input",
                attributes: {
                  type: "password",
                  value: "********",
                  "data-specbook-mask": "",
                },
                childNodes: [],
              },
              {
                type: 2,
                id: 5,
                tagName: "iframe",
                attributes: {
                  src: "https://outside.invalid/",
                  srcdoc: "<script>unsafe()</script>",
                },
                childNodes: [],
              },
              {
                type: 3,
                id: 6,
                textContent:
                  '@import "https://outside.invalid/style.css"; .page{background:url(https://outside.invalid/image.png)}',
              },
            ],
          },
          initialOffset: { left: 0, top: 0 },
        },
      },
      {
        type: 3,
        timestamp: 1002,
        data: {
          source: 0,
          texts: [],
          removes: [],
          adds: [],
          attributes: [
            {
              id: 2,
              attributes: {
                src: image,
                onclick: "unsafe()",
                href: "https://outside.invalid/",
              },
            },
          ],
        },
      },
    ])
  );
  await fs.writeFile(path.join(directory, REPLAY_FILE), replay);
  await fs.writeFile(
    path.join(directory, "evidence.json"),
    JSON.stringify({
      steps: [],
      video: null,
      failedStep: null,
      replay: { file: REPLAY_FILE, bytes: replay.length },
    })
  );
  const replayResponse = await app.request(`/runs/${run.id}/replay`);
  assert.equal(replayResponse.status, 200);
  assert.equal(
    replayResponse.headers.get("cache-control"),
    "private, no-store"
  );
  assert.equal(replayResponse.headers.get("x-content-type-options"), "nosniff");
  const recording = await replayResponse.json();
  assert.deepEqual(
    recording,
    await readOfflineReplay(directory),
    "the app receives the report's packed, sanitized recording"
  );
  assert.ok(recording);
  assert.equal(recording.version, 1);
  assert.deepEqual(recording.assets, [image]);
  const events = requireValue(restoreReplayEvents(recording));
  const nodes = (
    events[1].data as {
      node: {
        childNodes: {
          attributes?: Record<string, string>;
          textContent?: string;
        }[];
      };
    }
  ).node.childNodes;
  assert.deepEqual(nodes[0].attributes, { src: image });
  assert.deepEqual(nodes[3].attributes, {});
  assert.equal(nodes[2].attributes?.value, "********");
  assert.equal(nodes[2].attributes?.["data-specbook-mask"], "");
  assert.ok(!JSON.stringify(recording).includes("outside.invalid"));
  assert.ok(!JSON.stringify(recording).includes("unsafe()"));
  assert.deepEqual(
    (
      events[2].data as {
        attributes: { id: number; attributes: Record<string, string> }[];
      }
    ).attributes,
    [{ id: 2, attributes: { src: image } }]
  );
  const withReplay = await (async () => {
    const awaitedValue49045 = await app.request(`/runs/${run.id}/evidence`);
    return awaitedValue49045.json();
  })();
  assert.deepEqual(withReplay.replay, {
    file: REPLAY_FILE,
    bytes: replay.length,
  });

  await fs.writeFile(path.join(directory, REPLAY_FILE), "invalid gzip");
  assert.equal(
    await (async () => {
      const awaitedValue49298 = await app.request(`/runs/${run.id}/replay`);
      return awaitedValue49298.status;
    })(),
    404,
    "invalid replay data fails closed"
  );
  await fs.rm(path.join(directory, REPLAY_FILE));
  await fs.symlink(
    path.join(directory, "spec.yml"),
    path.join(directory, REPLAY_FILE)
  );
  assert.equal(
    await (async () => {
      const awaitedValue49576 = await app.request(`/runs/${run.id}/replay`);
      return awaitedValue49576.status;
    })(),
    404,
    "replay reads reject symlinks"
  );
  await fs.rm(path.join(directory, REPLAY_FILE));
  await fs.writeFile(
    path.join(directory, "evidence.json"),
    JSON.stringify({
      steps: [],
      video: null,
      failedStep: null,
      replayUnavailable:
        "Replay omitted because it exceeded the recording limit.",
    })
  );
  const unavailable = await (async () => {
    const awaitedValue50007 = await app.request(`/runs/${run.id}/evidence`);
    return awaitedValue50007.json();
  })();
  assert.equal(unavailable.replay, null);
  assert.equal(
    unavailable.replayUnavailable,
    "Replay omitted because it exceeded the recording limit."
  );
});

test("an offline runner retry leaves other projects' failure processing available", async () => {
  const { runsRepository } = await import("../../src/infra/repositories/runs");
  const { runnersRepository } =
    await import("../../src/infra/repositories/runners");
  const { completeRunnerWork } =
    await import("../../src/core/private-runner/queue");
  const { issueRunnerToken, authenticateRunnerToken } =
    await import("../../src/core/private-runner/tokens");
  const { resolveRunEnvironment } = await import("../../src/core/environments");
  const { processRunFailures } = await import("../../src/core/jobs/failures");
  const { runsDir } = await import("../../src/core/paths");
  const createFailure = async (name: string, remote: boolean) => {
    const project = await projectsRepository.createProject(name, baseUrl);
    await repoGit.ensureProjectRepo(project.id, { create: true });
    const production = requireValue(
      await (async () => {
        const awaitedValue51160 = await environmentsRepository.list(project.id);
        return awaitedValue51160[0];
      })()
    );
    if (remote) {
      await environmentsRepository.update(production, {
        ...production,
        executor: "runner",
        runnerGroup: "monitor",
      });
    }
    const environment = await resolveRunEnvironment(project.id);
    const feature = await writer.createFeatureInRepo(
      project.id,
      null,
      "Store",
      ""
    );
    const { spec } = await writer.createSpecInRepo({
      projectId: project.id,
      featureId: feature.id,
      title: "Open the application",
      description: "",
      humanSpec: HUMAN_SPEC,
      testSource: VALID_SPEC,
    });
    const run = await runsRepository.createRun({
      specId: spec.id,
      sourceHash: spec.sourceHash,
      commitSha: await repoGit.getHeadSha(project.id),
      automate: true,
      environment,
    });
    await runsRepository.finishRun(
      run.id,
      "failed",
      100,
      "Original failure",
      "assertion"
    );
    const directory = path.join(runsDir, run.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(
      path.join(repoGit.getRepoDir(project.id), writer.specYamlFile(spec.path)),
      path.join(directory, "spec.yml")
    );
    return { project, spec, run, environment };
  };
  const offline = await createFailure("Offline runner monitor", true);
  const local = await createFailure("Local monitor", false);
  const retry = await runsRepository.createRun({
    specId: local.spec.id,
    sourceHash: local.spec.sourceHash,
    commitSha: local.run.commitSha,
    automate: true,
    retryOf: local.run.id,
    environment: local.environment,
  });
  await runsRepository.finishRun(retry.id, "passed", 100, null);
  let timeout: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    processRunFailures().then(() => true),
    // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 1000);
    }),
  ]);
  clearTimeout(timeout);
  assert.equal(
    completed,
    true,
    "runner retries do not hold the shared failure monitor"
  );
  assert.equal(
    requireValue(await runsRepository.getRun(local.run.id)).automationPending,
    false
  );
  assert.equal(
    requireValue(await runsRepository.getRun(local.run.id)).flaky,
    true
  );
  let job;
  /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
  for (let attempt = 0; attempt < 150; attempt += 1) {
    job = await (async () => {
      const awaitedValue53502 = await runnersRepository.pending();
      return awaitedValue53502.find(
        (row) => row.projectId === offline.project.id
      );
    })();
    if (job) {
      break;
    }
    // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  /* oxlint-enable no-await-in-loop */
  assert.ok(job);
  await processRunFailures();
  assert.equal(
    await (async () => {
      const awaitedValue53770 = await runnersRepository.pending();
      return awaitedValue53770.filter(
        (row) => row.projectId === offline.project.id
      ).length;
    })(),
    1
  );
  assert.equal(
    await (async () => {
      const awaitedValue53906 = await runsRepository.listRuns(offline.spec.id);
      return awaitedValue53906.length;
    })(),
    2
  );
  const issued = await issueRunnerToken("Monitor", "monitor");
  const token = requireValue(
    await authenticateRunnerToken(`Bearer ${issued.token}`)
  );
  await runnersRepository.reportInstance(token.id, token.id, {
    version: "0.1.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    concurrency: 1,
  });
  const lease = requireValue(await runnersRepository.claim(token, 60_000));
  await completeRunnerWork(lease.id, token.id, {
    leaseId: requireValue(lease.leaseId),
    durationMs: 100,
    processFailure: null,
    results: [
      {
        runId: lease.payload.specs[0].runId,
        status: "passed",
        durationMs: 100,
        failReason: null,
        failedStep: null,
        artifacts: [],
      },
    ],
  });
  await processRunFailures();
  assert.equal(
    requireValue(await runsRepository.getRun(offline.run.id)).automationPending,
    false
  );
  assert.equal(
    requireValue(await runsRepository.getRun(offline.run.id)).flaky,
    true
  );
});

describe(
  "executeSpec (real browser)",
  {
    skip: available ? false : "Chromium for @playwright/test is not installed",
  },
  () => {
    test(
      "published Specs wait for deploy only in their target environment until a passing run",
      { timeout: 120_000 },
      async () => {
        const { createProject } = await import("../../src/core/projects");
        const { specsRepository } =
          await import("../../src/infra/repositories/specs");
        const { runsRepository } =
          await import("../../src/infra/repositories/runs");
        const { specEnvironmentsRepository } =
          await import("../../src/infra/repositories/spec-environments");
        const { processRunFailures } =
          await import("../../src/core/jobs/failures");
        const { currentFailure } = await import("../../src/core/jobs/triage");
        const { projectOverview } =
          await import("../../src/core/jobs/overview");
        const { serializeSpecYaml } = await import("@specbook/runtime/yaml");
        const project = await createProject("Await deployment", baseUrl);
        const environment = requireValue(
          await (async () => {
            const awaitedValue56010 = await environmentsRepository.list(
              project.id
            );
            return awaitedValue56010[0];
          })()
        );
        const staging = await environmentsRepository.create(project.id, {
          name: "Staging",
          baseUrl,
          allowedOrigins: [],
          credentialOverrides: {},
        });
        const source =
          'import { test, expect } from "specbook"; test("Deployment", async ({ page, step }) => { await step("Open store", async () => { await page.goto("/"); }); await step("The store is available", async () => { await expect(page.getByRole("heading")).toHaveText("Store", { timeout: 100 }); }); });';
        const input = {
          path: "specs/store/deployment",
          baseRevision: null,
          files: {
            "spec.yml": serializeSpecYaml({
              title: "Deployment",
              description: "",
              humanSpec: {
                preconditions: [],
                steps: ["Open store"],
                expectedResult: "The store is available",
                postconditions: [],
              },
            }),
            "spec.ts": source,
          },
          feature: { path: "specs/store", source: "title: Store\n" },
        };
        const { specs: published } = await writer.publishSpecsInRepo(
          project.id,
          environment.id,
          [input]
        );
        const spec = requireValue(
          await specsRepository.getSpec(requireValue(published[0]).id)
        );
        const failed = await executeSpec(spec.id, {
          baseUrl: `${baseUrl}flaky/await-deploy`,
          automate: true,
        });
        assert.equal(failed.status, "failed");
        assert.equal(failed.awaitingDeploy, true);
        assert.equal(failed.automationPending, false);
        await processRunFailures();
        assert.equal(await runsRepository.retryFor(failed.id), null);
        assert.equal(await currentFailure(project.id, failed.id), null);
        assert.deepEqual(await jobsRepository.inbox(project.id), []);
        assert.equal(
          await (async () => {
            const awaitedResult62143 = await specsRepository.getSpec(spec.id);
            return awaitedResult62143?.status;
          })(),
          "awaiting_deploy"
        );
        const overview = await projectOverview(project.id);
        assert.equal(overview.summary.specHealth.failing, 0);
        assert.equal(overview.summary.specHealth.awaiting_deploy, 1);
        assert.equal(overview.specHealth[spec.id]?.status, "awaiting_deploy");
        assert.equal(overview.recentRuns[0]?.counts.awaiting_deploy, 1);
        const otherFailure = await executeSpec(spec.id, {
          environment: staging.name,
          baseUrl: `${baseUrl}flaky/staging`,
        });
        assert.equal(otherFailure.status, "failed");
        assert.equal(otherFailure.awaitingDeploy, false);
        assert.equal(
          await (async () => {
            const awaitedResult62872 = await specsRepository.getSpec(spec.id);
            return awaitedResult62872?.status;
          })(),
          "failed",
          "a failure outside the waiting environment remains a normal failure"
        );
        assert.ok(await currentFailure(project.id, otherFailure.id));
        const otherEnvironment = await executeSpec(spec.id, {
          environment: staging.name,
        });
        assert.equal(otherEnvironment.status, "passed");
        assert.equal(otherEnvironment.awaitingDeploy, false);
        assert.equal(
          await (async () => {
            const awaitedResult63364 = await specsRepository.getSpec(spec.id);
            return awaitedResult63364?.status;
          })(),
          "awaiting_deploy",
          "another environment cannot promote the awaiting target"
        );
        const previewPass = await executeSpec(spec.id, {
          baseUrl: `${baseUrl}preview/`,
        });
        assert.equal(previewPass.status, "passed");
        assert.equal(
          await (async () => {
            const awaitedResult63715 = await specsRepository.getSpec(spec.id);
            return awaitedResult63715?.status;
          })(),
          "awaiting_deploy",
          "a passing preview URL cannot promote the configured deployment"
        );
        assert.equal(
          await specEnvironmentsRepository.awaiting(spec, environment.id),
          true
        );
        const passing = await executeSpec(spec.id);
        assert.equal(passing.status, "passed");
        assert.equal(passing.awaitingDeploy, true);
        assert.equal(
          await (async () => {
            const awaitedResult64187 = await specsRepository.getSpec(spec.id);
            return awaitedResult64187?.status;
          })(),
          "passed"
        );
        assert.equal(
          await specEnvironmentsRepository.awaiting(spec, environment.id),
          false
        );
        const regularFailure = await executeSpec(spec.id, {
          baseUrl: `${baseUrl}flaky/regular`,
          automate: true,
        });
        assert.equal(regularFailure.status, "failed");
        assert.equal(regularFailure.awaitingDeploy, false);
        assert.equal(regularFailure.automationPending, true);
        const changed = {
          ...input,
          baseRevision: requireValue(published[0]).revision,
          files: {
            ...input.files,
            "spec.yml": input.files["spec.yml"].replace(
              'description: ""',
              "description: Published again"
            ),
          },
        };
        await writer.publishSpecsInRepo(project.id, environment.id, [changed]);
        assert.equal(
          await (async () => {
            const awaitedResult65152 = await specsRepository.getSpec(spec.id);
            return awaitedResult65152?.status;
          })(),
          "awaiting_deploy"
        );
      }
    );

    test(
      "single-Spec batches preserve retry options and discard temporary failures",
      { timeout: 120_000 },
      async () => {
        const { runsRepository } =
          await import("../../src/infra/repositories/runs");
        const { specsRepository } =
          await import("../../src/infra/repositories/specs");
        const { runsDir } = await import("../../src/core/paths");
        const project = await projectsRepository.createProject(
          "Temporary run",
          baseUrl
        );
        await repoGit.ensureProjectRepo(project.id, { create: true });
        const feature = await writer.createFeatureInRepo(
          project.id,
          null,
          "Store",
          ""
        );
        const { spec } = await writer.createSpecInRepo({
          projectId: project.id,
          featureId: feature.id,
          title: "Checkout",
          description: "",
          humanSpec: {
            preconditions: [],
            steps: ["Check checkout"],
            expectedResult: "",
            postconditions: [],
          },
          testSource:
            'import { test, expect } from "specbook"; test("Checkout", async ({ page, step }) => { await step("Check checkout", async () => { await page.goto("/"); await expect(page.getByRole("heading")).toHaveText("Checkout", { timeout: 100 }); }); });',
        });
        await assert.rejects(
          () =>
            executeSpec(spec.id, {
              signal: AbortSignal.abort(new Error("Cancelled before starting")),
            }),
          /Cancelled before starting/u
        );
        assert.deepEqual(await runsRepository.listRuns(spec.id), []);
        const original = await runsRepository.createRun({
          specId: spec.id,
          sourceHash: spec.sourceHash,
          commitSha: await repoGit.getHeadSha(project.id),
        });
        await runsRepository.finishRun(
          original.id,
          "failed",
          1,
          "Original failure"
        );
        const run = await executeSpec(spec.id, {
          persistFailures: false,
          automate: true,
          healOnFailure: false,
          retryOf: original.id,
          expected: {
            sourceHash: spec.sourceHash,
            markdownHash: spec.markdownHash,
          },
        });
        assert.equal(run.status, "failed");
        assert.equal(run.failedStep, "Check checkout");
        assert.equal(run.automationPending, true);
        assert.equal(run.healOnFailure, false);
        assert.equal(run.retryOf, original.id);
        assert.equal(await runsRepository.getRun(run.id), null);
        await assert.rejects(() => fs.stat(path.join(runsDir, run.id)), {
          code: "ENOENT",
        });
        await assert.rejects(() =>
          repoGit
            .getProjectGit(project.id)
            .raw(["rev-parse", "--verify", `refs/specbook/runs/${run.id}`])
        );
        assert.equal(
          await (async () => {
            const awaitedResult68197 = await specsRepository.getSpec(spec.id);
            return awaitedResult68197?.status;
          })(),
          "unverified"
        );
        const { createRun: originalCreateRun } = runsRepository;
        runsRepository.createRun = async function createRun(input) {
          const created = await originalCreateRun.call(this, input);
          await fs.mkdir(runsDir, { recursive: true });
          await fs.writeFile(
            path.join(runsDir, created.id),
            "Output directory unavailable"
          );
          return created;
        };
        try {
          const blocked = await executeSpec(spec.id);
          assert.equal(blocked.status, "error");
          assert.equal(
            await (async () => {
              const awaitedResult68824 = await runsRepository.getRun(
                blocked.id
              );
              return awaitedResult68824?.status;
            })(),
            "error",
            "artifact failures still finish the run"
          );
          assert.equal(blocked.automationPending, false);
          assert.equal(blocked.healOnFailure, true);
          await fs.rm(path.join(runsDir, blocked.id));
        } finally {
          runsRepository.createRun = originalCreateRun;
        }
      }
    );

    test(
      "blocks redirected navigation outside the configured project origins",
      { timeout: 120_000 },
      async () => {
        let privateRequests = 0;
        const privateSite = http.createServer((_request, response) => {
          privateRequests += 1;
          response.end("Internal service");
        });
        // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
        await new Promise<void>((resolve) => {
          privateSite.listen(0, "127.0.0.1", resolve);
        });
        const destination = `http://127.0.0.1:${(privateSite.address() as AddressInfo).port}/`;
        const preview = http.createServer((_request, response) => {
          response.writeHead(302, { location: destination });
          response.end();
        });
        // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
        await new Promise<void>((resolve) => {
          preview.listen(0, "127.0.0.1", resolve);
        });
        try {
          const project = await projectsRepository.createProject(
            "Redirect check",
            `http://127.0.0.1:${(preview.address() as AddressInfo).port}`
          );
          await repoGit.ensureProjectRepo(project.id, { create: true });
          const feature = await writer.createFeatureInRepo(
            project.id,
            null,
            "Redirect",
            ""
          );
          const { spec } = await writer.createSpecInRepo({
            projectId: project.id,
            featureId: feature.id,
            title: "Open preview",
            description: "",
            humanSpec: {
              preconditions: [],
              steps: ["Open preview"],
              expectedResult: "",
              postconditions: [],
            },
            testSource:
              'import { test, expect } from "specbook"; test("Open preview", async ({ page, step }) => { await step("Open preview", async () => { await page.goto("/"); }); });',
          });
          const run = await executeSpec(spec.id);
          assert.equal(run.status, "failed", run.failReason ?? "");
          assert.match(
            run.failReason ?? "",
            /BLOCKED_BY_CLIENT|blockedbyclient/iu
          );
          assert.ok(
            (run.durationMs ?? Infinity) < 20_000,
            "unavailable evidence frames do not consume the Spec timeout"
          );
          assert.equal(
            privateRequests,
            0,
            "the redirect target receives no browser request"
          );
        } finally {
          /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
          for (const server of [preview, privateSite]) {
            server.closeAllConnections();
            // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
          }
          /* oxlint-enable no-await-in-loop */
        }
      }
    );

    test(
      "signs in through an identity provider on another origin trusted by the environment and the credential",
      { timeout: 120_000 },
      async () => {
        const delayMs = Number(process.env.SPECBOOK_TEST_SIGN_IN_DELAY_MS ?? 0);
        const listen = async (
          handler: (
            request: http.IncomingMessage,
            response: http.ServerResponse
          ) => void
        ) => {
          const server = http.createServer((request, response) => {
            setTimeout(() => handler(request, response), delayMs);
          });
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          return {
            server,
            origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          };
        };
        const submitted: string[] = [];
        const provider = await listen((request, response) => {
          if (request.method === "POST") {
            let body = "";
            request.on("data", (chunk) => {
              body += chunk;
            });
            request.on("end", () => {
              submitted.push(body);
              response
                .writeHead(302, { location: `${application.origin}/callback` })
                .end();
            });
            return;
          }
          response
            .writeHead(200, { "content-type": "text/html" })
            .end(
              '<h1>Single sign-on</h1><form method="post" action="/realms/demo/auth"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>'
            );
        });
        const application = await listen((request, response) => {
          if (request.url === "/callback") {
            response
              .writeHead(302, {
                location: "/",
                "set-cookie": "session=1; Path=/; HttpOnly",
              })
              .end();
            return;
          }
          if (!request.headers.cookie?.includes("session=1")) {
            response
              .writeHead(302, {
                location: `${provider.origin}/realms/demo/auth`,
              })
              .end();
            return;
          }
          response
            .writeHead(200, { "content-type": "text/html" })
            .end("<h1>Dashboard</h1>");
        });
        try {
          const project = await projectsRepository.createProject(
            "Single sign-on",
            application.origin
          );
          const production = requireValue(
            await (async () => {
              const awaitedValue70212 = await environmentsRepository.list(
                project.id
              );
              return awaitedValue70212[0];
            })()
          );
          await repoGit.ensureProjectRepo(project.id, { create: true });
          await createProfile(project.id, {
            name: "member",
            allowedOrigins: [provider.origin],
            fields: [
              { key: "username", value: "maria", sensitive: false },
              { key: "password", value: "sso-secret-value" },
            ],
          });
          const feature = await writer.createFeatureInRepo(
            project.id,
            null,
            "Sign in",
            ""
          );
          const steps = [
            "Open the application",
            "Sign in",
            "See the dashboard",
          ];
          const { spec } = await writer.createSpecInRepo({
            projectId: project.id,
            featureId: feature.id,
            title: "Single sign-on",
            description: "",
            humanSpec: {
              preconditions: [],
              steps,
              expectedResult: "",
              postconditions: [],
            },
            testSource: `import { test, expect } from "specbook";
test("Single sign-on", async ({ page, step, secret }) => {
    await step("Open the application", async () => {
        await page.goto("/");
    });
    await step("Sign in", async () => {
        await page.getByLabel("Username").fill(secret("member", "username"));
        await page.getByLabel("Password").fill(secret("member", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
    });
    await step("See the dashboard", async () => {
        await expect(page.getByRole("heading")).toHaveText("Dashboard");
    });
});
`,
          });
          assert.equal(spec.status, "unverified", spec.invalidReason ?? "");
          const blocked = await executeSpec(spec.id);
          assert.equal(blocked.status, "failed");
          assert.equal(blocked.failedStep, "Open the application");
          assert.match(
            blocked.failReason ?? "",
            /BLOCKED_BY_CLIENT|blockedbyclient/iu
          );
          await environmentsRepository.update(production, {
            ...production,
            allowedOrigins: [provider.origin],
          });
          const run = await executeSpec(spec.id);
          assert.equal(
            run.status,
            "passed",
            `${run.failedStep}: ${run.failReason} (blocked run: ${blocked.failedStep}: ${blocked.failReason})`
          );
          assert.deepEqual(submitted, [
            "username=maria&password=sso-secret-value",
          ]);
        } finally {
          /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
          for (const { server } of [application, provider]) {
            server.closeAllConnections();
            // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
          }
          /* oxlint-enable no-await-in-loop */
        }
      }
    );

    test(
      "tells a slow page from an unreachable app, and a longer wait in the Spec or the environment gets past it",
      { timeout: 240_000 },
      async () => {
        const slow = http.createServer((request, response) => {
          if (request.url === "/slow.css") {
            setTimeout(
              () =>
                response.writeHead(200, { "content-type": "text/css" }).end(""),
              40_000
            );
            return;
          }
          response
            .writeHead(200, { "content-type": "text/html" })
            .end('<h1>Reports</h1><img src="/slow.css" alt="">');
        });
        // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
        await new Promise<void>((resolve) => {
          slow.listen(0, "127.0.0.1", resolve);
        });
        try {
          const project = await projectsRepository.createProject(
            "Slow page",
            `http://127.0.0.1:${(slow.address() as AddressInfo).port}`
          );
          await repoGit.ensureProjectRepo(project.id, { create: true });
          const feature = await writer.createFeatureInRepo(
            project.id,
            null,
            "Reports",
            ""
          );
          // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
          const source = (
            goto: string,
            assertion: string
          ) => `import { test, expect } from "specbook";
test("Open reports", async ({ page, step }) => {
    await step("Open reports", async () => {
        await page.goto(${goto});
        await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible(${assertion});
    });
});
`;
          const { spec } = await writer.createSpecInRepo({
            projectId: project.id,
            featureId: feature.id,
            title: "Open reports",
            description: "",
            humanSpec: {
              preconditions: [],
              steps: ["Open reports"],
              expectedResult: "",
              postconditions: [],
            },
            testSource: source('"/"', ""),
          });
          assert.equal(spec.status, "unverified", spec.invalidReason ?? "");
          const timedOut = await executeSpec(spec.id);
          assert.equal(timedOut.status, "failed");
          assert.match(timedOut.failReason ?? "", /Timeout 30000ms exceeded/u);
          assert.match(
            timedOut.failReason ?? "",
            /it is slow, not unreachable/u
          );
          assert.notEqual(
            timedOut.errorCode,
            "environment",
            "a slow page is not reported as an unreachable app"
          );
          const production = requireValue(
            await (async () => {
              const awaitedValue75589 = await environmentsRepository.list(
                project.id
              );
              return awaitedValue75589[0];
            })()
          );
          await environmentsRepository.update(production, {
            ...production,
            timeoutScale: 2,
          });
          const waitedLonger = await executeSpec(spec.id);
          assert.equal(
            waitedLonger.status,
            "passed",
            `the unchanged Spec passes when the environment waits longer: ${waitedLonger.failReason}`
          );
          await environmentsRepository.update(production, {
            ...production,
            timeoutScale: 1,
          });
          const { spec: repaired } = await writer.updateSpecInRepo(spec, {
            testSource: source(
              '"/", { waitUntil: "domcontentloaded", timeout: 60000 }',
              "{ timeout: 30000 }"
            ),
          });
          assert.equal(
            repaired.status,
            "unverified",
            repaired.invalidReason ?? ""
          );
          const run = await executeSpec(spec.id);
          assert.equal(run.status, "passed", run.failReason ?? "");
        } finally {
          slow.closeAllConnections();
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          await new Promise<void>((resolve) => {
            slow.close(() => resolve());
          });
        }
      }
    );

    test(
      "stores the run with sourceHash, evidence and report links, and scrubs secrets",
      { timeout: 120_000 },
      async () => {
        const project = await projectsRepository.createProject("Loja", baseUrl);
        await repoGit.ensureProjectRepo(project.id, { create: true });
        await repoBare.ensureBareRepo(
          project.id,
          repoGit.getRepoDir(project.id)
        );
        await createProfile(project.id, {
          name: "shopper",
          fields: [{ key: "password", value: "s3cret-value" }],
        });
        const feature = await writer.createFeatureInRepo(
          project.id,
          null,
          "Loja",
          ""
        );
        const steps = ["Open the store", "Type the password", "See the store"];
        const testSource = `import { test, expect } from "specbook";
test("Store", async ({ page, step, secret }) => {
    await step("Open the store", async () => {
        await page.goto("/");
    });
    await step("Type the password", async () => {
        await page.getByLabel("Password").fill(secret("shopper", "password"));
    });
    await step("See the store", async () => {
        await expect(page.getByRole("heading")).toHaveText("Checkout", { timeout: 500 });
    });
});
`;
        const { spec } = await writer.createSpecInRepo({
          projectId: project.id,
          featureId: feature.id,
          title: "Store",
          description: "",
          humanSpec: {
            preconditions: [],
            steps,
            expectedResult: "",
            postconditions: [],
          },
          testSource,
        });
        assert.equal(spec.status, "unverified", spec.invalidReason ?? "");
        const run = await executeSpec(spec.id);
        assert.equal(run.status, "failed");
        assert.equal(run.failedStep, "See the store");
        assert.equal(run.errorCode, "assertion");
        assert.equal(run.sourceHash, spec.sourceHash);
        assert.match(run.failReason ?? "", /toHaveText/u);
        assert.doesNotMatch(
          run.failReason ?? "",
          /\/tmp\/specbook|node_modules|src\/core\/runner|\n\s+at /u
        );

        const evidence = (await (async () => {
          const awaitedValue79019 = await app.request(
            `/runs/${run.id}/evidence`
          );
          return awaitedValue79019.json();
        })()) as {
          steps: { label: string; file: string }[];
          video: string | null;
          failedStep: string | null;
          reportUrl: string | null;
        };
        assert.deepEqual(
          evidence.steps.map((step) => step.label),
          steps
        );
        assert.equal(evidence.failedStep, "See the store");
        assert.equal(
          evidence.video,
          null,
          "secret runs never record failure videos"
        );
        assert.equal(
          evidence.reportUrl,
          `/runs/${run.id}/report`,
          "runs that type secrets still get a report"
        );
        const report = await app.request(`/runs/${run.id}/report`);
        assert.equal(report.status, 200);
        assert.ok(
          !(await (async () => {
            const awaitedValue79853 = await report.text();
            return awaitedValue79853.includes("s3cret-value");
          })()),
          "the report never contains secrets"
        );
        const screenshot = await app.request(
          `/runs/${run.id}/artifacts/${evidence.steps[0].file}`
        );
        assert.equal(screenshot.headers.get("content-type"), "image/webp");
        assert.equal(
          screenshot.headers.get("content-security-policy"),
          "sandbox"
        );

        const { files } = (await (async () => {
          const awaitedValue80303 = await app.request(
            `/runs/${run.id}/artifacts`
          );
          return awaitedValue80303.json();
        })()) as { files: string[] };
        assert.ok(files.includes("results.json") && files.includes("spec.ts"));
        assert.ok(!files.some((file) => file.startsWith("work/")));
        const { runsDir } = await import("../../src/core/paths");
        /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
        for (const file of files.filter((name) =>
          /\.(?<capture1>json|ts|yml)$/u.test(name)
        )) {
          assert.ok(
            !(await (async () => {
              const awaitedValue80756 = await fs.readFile(
                path.join(runsDir, run.id, file),
                "utf-8"
              );
              return awaitedValue80756.includes("s3cret-value");
            })()),
            file
          );
        }
        /* oxlint-enable no-await-in-loop */
      }
    );

    test(
      "a preview override cannot receive saved credentials until its origin is explicitly allowed",
      { timeout: 120_000 },
      async () => {
        const { getProfileByName, updateProfile } =
          await import("../../src/core/credentials/profiles");
        const project = await projectsRepository.createProject(
          "Preview credential boundary",
          "http://127.0.0.1:1"
        );
        await environmentsRepository.update(
          requireValue(
            await (async () => {
              const awaitedValue81404 = await environmentsRepository.list(
                project.id
              );
              return awaitedValue81404[0];
            })()
          ),
          {
            ...requireValue(
              await (async () => {
                const awaitedValue81484 = await environmentsRepository.list(
                  project.id
                );
                return awaitedValue81484[0];
              })()
            ),
            allowedOrigins: [new URL(baseUrl).origin],
          }
        );
        await repoGit.ensureProjectRepo(project.id, { create: true });
        await createProfile(project.id, {
          name: "shopper",
          fields: [{ key: "password", value: "preview-trust-secret" }],
        });
        const feature = await writer.createFeatureInRepo(
          project.id,
          null,
          "Sign in",
          ""
        );
        const steps = ["Open preview", "Enter password", "Submit credentials"];
        const testSource = `import { test, expect } from "specbook";
test("Preview credentials", async ({ page, step, secret }) => {
    await step("Open preview", async () => {
        await page.goto("/credential-preview");
    });
    await step("Enter password", async () => {
        await page.getByLabel("Password").fill(secret("shopper", "password"));
    });
    await step("Submit credentials", async () => {
        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("heading")).toHaveText("Credentials received");
    });
});
`;
        const { spec } = await writer.createSpecInRepo({
          projectId: project.id,
          featureId: feature.id,
          title: "Preview credentials",
          description: "",
          humanSpec: {
            preconditions: [],
            steps,
            expectedResult: "",
            postconditions: [],
          },
          testSource,
        });
        assert.equal(spec.status, "unverified", spec.invalidReason ?? "");
        previewCredentials.length = 0;
        const blocked = await executeSpec(spec.id, { baseUrl });
        assert.equal(blocked.status, "failed");
        assert.equal(blocked.failedStep, "Enter password");
        assert.match(
          blocked.failReason ?? "",
          /current page origin is not allowed/u
        );
        assert.deepEqual(
          previewCredentials,
          [],
          "neither typing events nor form submission may expose the saved secret"
        );
        const profile = requireValue(
          await getProfileByName(project.id, "shopper")
        );
        await updateProfile(profile, {
          allowedOrigins: [new URL(baseUrl).origin],
          fields: [{ key: "password" }],
        });
        const allowed = await executeSpec(spec.id, { baseUrl });
        assert.equal(allowed.status, "passed", allowed.failReason ?? "");
        assert.ok(
          previewCredentials.some(
            (body) =>
              body === "preview-trust-secret" ||
              body === "password=preview-trust-secret"
          ),
          "explicitly trusted preview receives the credential"
        );
        assert.equal(
          await (async () => {
            const awaitedResult89207 = await projectsRepository.getProject(
              project.id
            );
            return awaitedResult89207?.baseUrl;
          })(),
          "http://127.0.0.1:1",
          "a run override does not change the canonical trusted origin"
        );
      }
    );

    test(
      "named environments select their credential overrides without trusting one-off previews",
      { timeout: 120_000 },
      async () => {
        const { getProfileByName, updateProfile } =
          await import("../../src/core/credentials/profiles");
        const { createCiRouter } =
          await import("../../src/infra/web/routes/ci");
        const { issueCiToken } = await import("../../src/core/ci/tokens");
        const { runsRepository } =
          await import("../../src/infra/repositories/runs");
        const receivers = [[], []] as string[][];
        const servers = receivers.map((received) =>
          http.createServer(async (request, response) => {
            response.setHeader("Content-Type", "text/html");
            if (request.url === "/credential-receiver") {
              let body = "";
              for await (const chunk of request) {
                body += chunk;
              }
              received.push(body);
              response.end("Received");
            } else {
              response.end(
                `<label>Password <input type="password" oninput="fetch('/credential-receiver', { method: 'POST', body: this.value })"></label>`
              );
            }
          })
        );
        /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
        for (const server of servers) {
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
        }
        /* oxlint-enable no-await-in-loop */
        const [stagingUrl, previewUrl] = servers.map(
          (server) =>
            `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        );
        try {
          const project = await projectsRepository.createProject(
            "Environment credentials",
            baseUrl
          );
          await repoGit.ensureProjectRepo(project.id, { create: true });
          await createProfile(project.id, {
            name: "shopper",
            fields: [{ key: "password", value: "production-secret-only" }],
          });
          const stagingProfile = await createProfile(project.id, {
            name: "staging-shopper",
            fields: [{ key: "password", value: "staging-secret-only" }],
          });
          await environmentsRepository.create(project.id, {
            name: "Staging",
            baseUrl: requireValue(stagingUrl),
            allowedOrigins: [requireValue(previewUrl)],
            credentialOverrides: { shopper: stagingProfile.id },
          });
          const feature = await writer.createFeatureInRepo(
            project.id,
            null,
            "Sign in",
            ""
          );
          const { spec } = await writer.createSpecInRepo({
            projectId: project.id,
            featureId: feature.id,
            title: "Environment sign-in",
            description: "",
            humanSpec: {
              preconditions: [],
              steps: ["Enter password"],
              expectedResult: "",
              postconditions: [],
            },
            testSource:
              'import { test, expect } from "specbook"; test("Environment sign-in", async ({ page, step, secret }) => { await step("Enter password", async () => { await page.goto("/credential-preview"); await page.getByLabel("Password").fill(secret("shopper", "password")); await expect(page.getByLabel("Password")).toBeVisible(); }); });',
          });
          previewCredentials.length = 0;
          const productionRun = await executeSpec(spec.id);
          assert.equal(
            productionRun.status,
            "passed",
            productionRun.failReason ?? ""
          );
          assert.equal(productionRun.environment?.name, "Production");
          assert.ok(previewCredentials.includes("production-secret-only"));
          const stagingRun = await executeSpec(spec.id, {
            environment: "staging",
          });
          assert.equal(
            stagingRun.status,
            "passed",
            stagingRun.failReason ?? ""
          );
          assert.equal(stagingRun.environment?.name, "Staging");
          assert.deepEqual(receivers[0], ["staging-secret-only"]);
          const blocked = await executeSpec(spec.id, {
            environment: "Staging",
            baseUrl: previewUrl,
          });
          assert.equal(blocked.status, "failed");
          assert.match(
            blocked.failReason ?? "",
            /current page origin is not allowed/u
          );
          assert.deepEqual(
            receivers[1],
            [],
            "a network allowlist does not authorize a credential override on previews"
          );
          const profile = requireValue(
            await getProfileByName(project.id, "staging-shopper")
          );
          await updateProfile(profile, {
            allowedOrigins: [requireValue(previewUrl)],
            fields: [{ key: "password" }],
          });
          const allowed = await executeSpec(spec.id, {
            environment: "Staging",
            baseUrl: previewUrl,
          });
          assert.equal(allowed.status, "passed", allowed.failReason ?? "");
          assert.deepEqual(receivers[1], ["staging-secret-only"]);
          const evidence = await (async () => {
            const awaitedValue89570 = await app.request(
              `/runs/${allowed.id}/evidence`
            );
            return awaitedValue89570.json();
          })();
          assert.equal(evidence.environment.name, "Staging");
          assert.ok(!JSON.stringify(evidence).includes("staging-secret-only"));
          const ci = new Hono().route("/", createCiRouter());
          const { token } = await issueCiToken(project.id);
          const headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          };
          const started = await ci.request(`/ci/projects/${project.id}/runs`, {
            method: "POST",
            headers,
            body: JSON.stringify({ environment: "staging" }),
          });
          assert.equal(started.status, 202, await started.clone().text());
          const initial = await started.json();
          assert.equal(initial.batch.environment.name, "Staging");
          const completed = await (async () => {
            const awaitedValue90482 = await ci.request(
              `/ci/runs/${initial.batch.id}?wait=true`,
              {
                headers,
              }
            );
            return awaitedValue90482.json();
          })();
          assert.equal(completed.qualityGate.passed, true);
          assert.deepEqual(
            completed.results.map(
              (result: { specId: string }) => result.specId
            ),
            [spec.id]
          );
          const run = await runsRepository.getRun(completed.results[0].runId);
          assert.equal(run?.environment?.name, "Staging");
          assert.deepEqual(receivers[0], [
            "staging-secret-only",
            "staging-secret-only",
          ]);
          assert.equal(
            await (async () => {
              const awaitedResult96331 = await projectsRepository.getProject(
                project.id
              );
              return awaitedResult96331?.baseUrl;
            })(),
            baseUrl
          );
        } finally {
          /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
          for (const server of servers) {
            server.closeAllConnections();
            // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
          }
          /* oxlint-enable no-await-in-loop */
        }
      }
    );
  }
);

describe(
  "proposal verification",
  { skip: available ? false : "Chromium is not installed" },
  () => {
    test("verifies in the failed preview environment, preserves the contract, and applies on approval", async () => {
      const { jobsRepository: jobsRepositoryInTest } =
        await import("../../src/infra/repositories/jobs");
      const { specsRepository } =
        await import("../../src/infra/repositories/specs");
      const { jobLimitsSchema: jobLimitsSchemaInTest } =
        await import("../../src/core/jobs/schemas");
      const { proposeMutation, applyProposal } =
        await import("../../src/core/jobs/proposals");
      const { verifyProposal } =
        await import("../../src/core/jobs/verification");
      const { VALID_SPEC: VALID_SPECInTest, HUMAN_SPEC: HUMAN_SPECInTest } =
        await import("../helpers/storage");
      const project = await projectsRepository.createProject(
        "Candidate",
        baseUrl
      );
      await repoGit.ensureProjectRepo(project.id, { create: true });
      const feature = await writer.createFeatureInRepo(
        project.id,
        null,
        "Candidate",
        ""
      );
      const { spec } = await writer.createSpecInRepo({
        projectId: project.id,
        featureId: feature.id,
        title: "Candidate",
        description: "",
        humanSpec: HUMAN_SPECInTest,
        testSource: VALID_SPECInTest,
      });
      const directory = path.join(repoGit.getRepoDir(project.id), spec.path);
      const yaml = await fs.readFile(path.join(directory, "spec.yml"), "utf-8");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const originalRun = await runsRepository.createRun({
        specId: spec.id,
        commitSha: await repoGit.getHeadSha(project.id),
        sourceHash: spec.sourceHash,
        baseUrl,
      });
      await runsRepository.finishRun(
        originalRun.id,
        "failed",
        1,
        "Preview locator drift"
      );
      await projectsRepository.updateProject(project.id, {
        baseUrl: "http://127.0.0.1:1",
      });
      await environmentsRepository.update(
        requireValue(
          await (async () => {
            const awaitedValue93611 = await environmentsRepository.list(
              project.id
            );
            return awaitedValue93611[0];
          })()
        ),
        {
          ...requireValue(
            await (async () => {
              const awaitedValue93687 = await environmentsRepository.list(
                project.id
              );
              return awaitedValue93687[0];
            })()
          ),
          allowedOrigins: [new URL(baseUrl).origin],
        }
      );
      const job = await jobsRepositoryInTest.create({
        projectId: project.id,
        runId: originalRun.id,
        chatId: "candidate-test",
        trigger: "manual",
        kind: "failure_triage",
        specId: spec.id,
        goal: "Heal",
        limits: jobLimitsSchemaInTest.parse({}),
      });
      const running = requireValue(await jobsRepositoryInTest.claim(job.id));
      await jobsRepositoryInTest.update(job.id, {
        classification: "test_drift",
      });
      await assert.rejects(
        () =>
          proposeMutation(running, "update_spec", {
            specId: spec.id,
            humanSpec: HUMAN_SPECInTest,
            testSource: VALID_SPECInTest,
          }),
        /implementation/u
      );
      const proposal = await proposeMutation(running, "update_spec", {
        specId: spec.id,
        testSource: VALID_SPECInTest.replace(
          'page.goto("/")',
          'page.goto("/home")'
        ),
      });
      await assert.rejects(
        () => applyProposal(proposal),
        /passing verification/u
      );
      const head = await repoGit.getHeadSha(project.id);
      const result = await verifyProposal(running, proposal);
      assert.equal(result.status, "passed", result.failReason ?? "");
      assert.equal(result.baseUrl, baseUrl);
      assert.ok(result.screenshots.length);
      assert.equal(await repoGit.getHeadSha(project.id), head);
      assert.equal(
        await (async () => {
          const awaitedResult100546 = await specsRepository.getSpec(spec.id);
          return awaitedResult100546?.status;
        })(),
        "unverified"
      );
      assert.equal(
        await fs.readFile(path.join(directory, "spec.ts"), "utf-8"),
        VALID_SPECInTest
      );
      await writer.createFeatureInRepo(project.id, null, "Unrelated", "");
      await applyProposal(
        requireValue(await jobsRepositoryInTest.item(proposal.id))
      );
      assert.equal(
        await fs.readFile(path.join(directory, "spec.yml"), "utf-8"),
        yaml
      );
      assert.equal(
        await fs.readFile(path.join(directory, "spec.ts"), "utf-8"),
        VALID_SPECInTest.replace('page.goto("/")', 'page.goto("/home")')
      );
    });
  }
);

describe("scheduled runs", () => {
  test("evaluates numeric cron expressions in UTC and rejects invalid or impossible dates", async () => {
    const { nextCronAt, automationSettingsSchema } =
      await import("../../src/core/jobs/schedules");
    assert.equal(
      nextCronAt("*/15 9-17 * * 1-5", new Date("2026-10-06T17:59:00Z")),
      "2026-10-07T09:00:00.000Z"
    );
    assert.equal(
      nextCronAt("30 4 1,15 * 5", new Date("2026-10-01T04:30:00Z")),
      "2026-10-02T04:30:00.000Z"
    );
    assert.equal(
      nextCronAt("0 0 29 2 *", new Date("2025-01-01T00:00:00Z")),
      "2028-02-29T00:00:00.000Z"
    );
    assert.equal(
      nextCronAt("0 0 * * 7", new Date("2026-10-06T00:00:00Z")),
      "2026-10-11T00:00:00.000Z"
    );
    assert.equal(
      nextCronAt("*/35 * * * *", new Date("2026-10-06T00:35:00Z")),
      "2026-10-06T01:00:00.000Z"
    );
    for (const cron of [
      "60 * * * *",
      "* * *",
      "*/0 * * * *",
      "0 0 30 2 *",
      "0 0 * * 8",
    ]) {
      assert.throws(() => nextCronAt(cron), /Cron|cron/u, cron);
    }
    assert.ok(
      automationSettingsSchema.safeParse({}).success,
      "every setting is optional"
    );
    for (const webhookUrl of [
      "not-a-url",
      "file:///tmp/private",
      "https://name:password@example.com/hook",
    ]) {
      assert.equal(
        automationSettingsSchema.safeParse({ webhookUrl }).success,
        false
      );
    }
  });

  test("keeps webhook credentials encrypted and accepts partial optional settings", async () => {
    const { createSchedulesRouter } =
      await import("../../src/infra/web/routes/schedules");
    const { db } = await import("../../src/infra/db/client");
    const { projectAutomations } = await import("../../src/infra/db/schema");
    const { eq } = await import("drizzle-orm");
    const project = await projectsRepository.createProject(
      "Schedules",
      baseUrl
    );
    const router = createSchedulesRouter();
    const endpoint = `/projects/${project.id}/automation`;
    const update = (body: unknown) =>
      router.request(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal(
      await (async () => {
        const awaitedValue98051 = await router.request(
          "/projects/missing/automation"
        );
        return awaitedValue98051.status;
      })(),
      404
    );
    const initial = await (async () => {
      const awaitedValue98157 = await router.request(endpoint);
      return awaitedValue98157.json();
    })();
    assert.equal(initial.automation.cron, null);
    assert.equal(initial.automation.healFailures, true);
    assert.equal(initial.automation.allowPrivateWebhook, false);
    assert.deepEqual(initial.automation.specIds, []);
    assert.equal(
      await (async () => {
        const awaitedValue98440 = await update({});
        return awaitedValue98440.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedValue98490 = await update({ cron: "no cron" });
        return awaitedValue98490.status;
      })(),
      400
    );
    assert.equal(
      await (async () => {
        const awaitedValue98564 = await update({
          specIds: ["00000000-0000-4000-8000-000000000001"],
        });
        return awaitedValue98564.status;
      })(),
      400
    );
    assert.equal(
      await (async () => {
        const awaitedValue98692 = await update({ webhookUrl: baseUrl });
        return awaitedValue98692.status;
      })(),
      400,
      "local webhooks require explicit permission even for a local project"
    );
    assert.equal(
      await (async () => {
        const awaitedValue98858 = await update({
          webhookUrl: baseUrl,
          allowPrivateWebhook: true,
        });
        return awaitedValue98858.status;
      })(),
      200
    );
    const webhookUrl = "https://8.8.8.8/hooks/private-token";
    const saved = await (async () => {
      const awaitedValue99036 = await update({
        cron: "0 12 * * *",
        webhookUrl,
        healFailures: false,
        allowPrivateWebhook: false,
      });
      return awaitedValue99036.json();
    })();
    assert.ok(
      Array.isArray(saved.notifications),
      "saving returns the same response shape as loading"
    );
    assert.equal(saved.automation.webhookConfigured, true);
    assert.equal(saved.automation.webhookHost, "8.8.8.8");
    assert.ok(saved.automation.nextRunAt);
    assert.ok(!JSON.stringify(saved).includes("private-token"));
    const [stored] = await db
      .select()
      .from(projectAutomations)
      .where(eq(projectAutomations.projectId, project.id));
    assert.ok(stored?.webhookUrl?.startsWith("v1:"));
    assert.ok(!stored?.webhookUrl?.includes("private-token"));
    const disabled = await (async () => {
      const awaitedValue99826 = await update({ cron: null });
      return awaitedValue99826.json();
    })();
    assert.equal(disabled.automation.nextRunAt, null);
    assert.equal(
      disabled.automation.webhookConfigured,
      true,
      "omitting the URL preserves it"
    );
    assert.equal(disabled.automation.healFailures, false);
    const removed = await (async () => {
      const awaitedValue100125 = await update({ webhookUrl: null });
      return awaitedValue100125.json();
    })();
    assert.equal(removed.automation.webhookConfigured, false);
  });

  test("pins webhook DNS, rejects rebinding and never follows redirects", async () => {
    const { postWebhook } = await import("../../src/core/network/webhook");
    const requests: string[] = [];
    const webhook = http.createServer((request, response) => {
      requests.push(requireValue(request.url));
      response.writeHead(302, { location: "/internal" });
      response.end();
    });
    // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
    await new Promise<void>((resolve) => {
      webhook.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://webhook.invalid:${(webhook.address() as AddressInfo).port}/events`;
    let resolutions = 0;
    const resolver = () => {
      try {
        resolutions += 1;
        return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
      } catch (error) {
        return Promise.reject(error);
      }
    };
    try {
      await assert.rejects(
        () =>
          postWebhook(
            url,
            { text: "status" },
            { allowPrivate: false, signal: AbortSignal.timeout(1000), resolver }
          ),
        /not allowed/u
      );
      assert.deepEqual(requests, []);
      assert.equal(
        await postWebhook(
          url,
          { text: "status" },
          { allowPrivate: true, signal: AbortSignal.timeout(1000), resolver }
        ),
        302
      );
      assert.deepEqual(
        requests,
        ["/events"],
        "redirect does not expose the payload to another endpoint"
      );
      assert.equal(
        resolutions,
        2,
        "each send resolves once; HTTP transport uses the checked address"
      );
    } finally {
      webhook.closeAllConnections();
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      await new Promise<void>((resolve) => {
        webhook.close(() => resolve());
      });
    }
  });

  test(
    "scheduled prerequisites ask once and resume the saved selection in observation mode",
    { skip: !available, timeout: 120_000 },
    async () => {
      const { schedulesRepository } =
        await import("../../src/infra/repositories/schedules");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const { updateAutomation, processSchedules } =
        await import("../../src/core/jobs/schedules");
      const { getRunBatch } = await import("../../src/core/runner/batch");
      const { stopJobWorker } = await import("../../src/core/jobs/worker");
      const { VALID_SPEC: VALID_SPECInTest, HUMAN_SPEC: HUMAN_SPECInTest } =
        await import("../helpers/storage");
      stopJobWorker();
      const project = await projectsRepository.createProject(
        "Scheduled sign-in",
        baseUrl
      );
      await repoGit.ensureProjectRepo(project.id, { create: true });
      await stewardRepository.update(project.id, { autonomy: "observe" });
      const feature = await writer.createFeatureInRepo(
        project.id,
        null,
        "Sign in",
        ""
      );
      const source = VALID_SPECInTest.replace(
        "({ page, step })",
        "({ page, step, secret })"
      ).replace(
        'await page.goto("/");',
        'await page.goto("/");\n        await page.getByLabel("Password").fill(secret("shopper", "password"));'
      );
      const { spec } = await writer.createSpecInRepo({
        projectId: project.id,
        featureId: feature.id,
        title: "Scheduled sign-in",
        description: "",
        humanSpec: HUMAN_SPECInTest,
        testSource: source,
      });
      const { spec: unselected } = await writer.createSpecInRepo({
        projectId: project.id,
        featureId: feature.id,
        title: "Unselected",
        description: "",
        humanSpec: HUMAN_SPECInTest,
        testSource: VALID_SPECInTest,
      });
      const head = await repoGit.getHeadSha(project.id);
      await updateAutomation(project.id, {
        cron: "* * * * *",
        specIds: [spec.id],
        healFailures: false,
        webhookUrl: new URL("/schedule-events", baseUrl).href,
        allowPrivateWebhook: true,
      });
      const at = new Date();
      const dueAt = new Date(at.getTime() - 300_000).toISOString();
      try {
        await schedulesRepository.update(project.id, { nextRunAt: dueAt });
        await Promise.all([processSchedules(at), processSchedules(at)]);
        const questions = await jobsRepository.inbox(project.id);
        assert.equal(questions.length, 1);
        const question = requireValue(questions[0]);
        const [intent] = await stewardRepository.intents(project.id);
        assert.equal(intent?.source, "event");
        assert.equal(question.payload.waitingFor, "credentials");
        assert.equal(question.payload.runIntentId, intent?.id);
        assert.equal(
          await (async () => {
            const awaitedResult110985 = await jobsRepository.get(
              question.jobId
            );
            return awaitedResult110985?.status;
          })(),
          "blocked"
        );
        assert.deepEqual(await runsRepository.listRuns(spec.id), []);
        assert.deepEqual(
          await (async () => {
            const awaitedValue104909 = await stewardRepository.signals(
              project.id
            );
            return awaitedValue104909.map((signal) => signal.kind);
          })(),
          ["schedule"]
        );
        assert.equal(
          await (async () => {
            const awaitedResult111425 = await schedulesRepository.get(
              project.id
            );
            return awaitedResult111425?.lastBatchId;
          })(),
          null
        );

        /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
        for (let index = 0; index < 301; index += 1) {
          await stewardRepository.signal({
            projectId: project.id,
            key: `later-event:${index}`,
            kind: "observation",
            title: "Later observation",
            body: "No requested work.",
          });
        }
        /* oxlint-enable no-await-in-loop */
        assert.equal(
          await (async () => {
            const awaitedValue105492 = await stewardRepository.signals(
              project.id
            );
            return awaitedValue105492.length;
          })(),
          300
        );
        assert.equal(
          await (async () => {
            const awaitedValue105584 = await stewardRepository.signals(
              project.id
            );
            return awaitedValue105584.some(
              (signal) => signal.kind === "schedule"
            );
          })(),
          false,
          "the original occurrence is outside the presentation window"
        );

        await schedulesRepository.update(project.id, {
          nextRunAt: new Date(at.getTime() - 1000).toISOString(),
        });
        await processSchedules(at);
        await processProjectSteward(project.id, false);
        assert.equal(
          await (async () => {
            const awaitedValue106057 = await jobsRepository.inbox(project.id);
            return awaitedValue106057.length;
          })(),
          1,
          "missed ticks reuse the unresolved prerequisite"
        );
        assert.equal(
          await (async () => {
            const awaitedValue106210 = await stewardRepository.intents(
              project.id
            );
            return awaitedValue106210.length;
          })(),
          1
        );

        await stewardRepository.update(project.id, { paused: true });
        await createProfile(project.id, {
          name: "shopper",
          fields: [{ key: "password", value: "scheduled-test-secret" }],
        });
        await stewardRepository.signal({
          projectId: project.id,
          key: "credentials:scheduled-test",
          kind: "credentials_changed",
          title: "Access available",
          body: "The requested profile is available.",
        });
        await processProjectSteward(project.id, false);
        assert.equal(
          await (async () => {
            const awaitedResult113533 = await jobsRepository.item(question.id);
            return awaitedResult113533?.status;
          })(),
          "pending"
        );
        assert.deepEqual(await runsRepository.listRuns(spec.id), []);

        await updateAutomation(project.id, {
          specIds: [unselected.id],
          healFailures: true,
        });
        await stewardRepository.update(project.id, { paused: false });
        await Promise.all([
          processProjectSteward(project.id, false),
          processProjectSteward(project.id, false),
        ]);
        const resumed = await (async () => {
          const awaitedValue107357 = await stewardRepository.intents(
            project.id
          );
          return awaitedValue107357.filter((row) =>
            row.key.startsWith(`resume-run:${requireValue(intent).id}:`)
          );
        })();
        assert.equal(resumed.length, 1);
        assert.equal(resumed[0]?.source, "event");
        assert.deepEqual(resumed[0]?.intent.specIds, [spec.id]);
        let batch = await getRunBatch(
          requireValue(requireValue(resumed[0]).batchId)
        );
        assert.equal(batch?.trigger, "schedule");
        assert.equal(
          await (async () => {
            const awaitedResult114603 = await schedulesRepository.get(
              project.id
            );
            return awaitedResult114603?.lastBatchId;
          })(),
          batch?.id
        );
        assert.equal(
          await (async () => {
            const awaitedResult114724 = await runsRepository.getRun(
              requireValue(requireValue(batch).specs[0]).runId
            );
            return awaitedResult114724?.healOnFailure;
          })(),
          false
        );
        assert.equal(
          await (async () => {
            const awaitedResult114879 = await jobsRepository.item(question.id);
            return awaitedResult114879?.status;
          })(),
          "answered"
        );
        const deadline = Date.now() + 60_000;
        /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
        while (batch?.status === "running" && Date.now() < deadline) {
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          batch = await getRunBatch(
            requireValue(requireValue(resumed[0]).batchId)
          );
        }
        /* oxlint-enable no-await-in-loop */
        assert.equal(batch?.status, "passed", batch?.failReason ?? "");
        assert.deepEqual(
          batch?.specs.map((entry) => entry.specId),
          [spec.id]
        );
        assert.deepEqual(await runsRepository.listRuns(unselected.id), []);
        await updateAutomation(project.id, { cron: null });
        await processSchedules();
        assert.equal(
          await (async () => {
            const awaitedResult115630 = await schedulesRepository.get(
              project.id
            );
            return awaitedResult115630?.lastBatchStatus;
          })(),
          "passed"
        );
        assert.equal(
          await (async () => {
            const awaitedResult115754 = await schedulesRepository.get(
              project.id
            );
            return awaitedResult115754?.lastError;
          })(),
          null
        );
        assert.deepEqual(
          await (async () => {
            const awaitedValue109001 = await schedulesRepository.notifications(
              project.id
            );
            return awaitedValue109001.map((row) => row.status).toSorted();
          })(),
          ["passed", "running"]
        );
        assert.equal(
          await (async () => {
            const awaitedValue109178 = await jobsRepository.list(project.id);
            return awaitedValue109178.length;
          })(),
          1
        );
        assert.equal(
          await (async () => {
            const awaitedResult116292 = await jobsRepository.get(
              question.jobId
            );
            return awaitedResult116292?.tokensUsed;
          })(),
          0
        );
        assert.equal(
          await (async () => {
            const awaitedResult116384 = await jobsRepository.get(
              question.jobId
            );
            return awaitedResult116384?.actionsUsed;
          })(),
          0
        );
        assert.equal(await repoGit.getHeadSha(project.id), head);
      } finally {
        await updateAutomation(project.id, { cron: null, webhookUrl: null });
      }
    }
  );

  test(
    "coalesces missed ticks, avoids overlap and persists webhook retries and recovered status",
    { skip: !available, timeout: 120_000 },
    async () => {
      const { schedulesRepository } =
        await import("../../src/infra/repositories/schedules");
      const { specsRepository } =
        await import("../../src/infra/repositories/specs");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const {
        updateAutomation,
        processSchedules,
        deliverWebhookNotifications,
      } = await import("../../src/core/jobs/schedules");
      const { getRunBatch, getRunBatchDirectory, markInterruptedBatches } =
        await import("../../src/core/runner/batch");
      const { VALID_SPEC: VALID_SPECInTest, HUMAN_SPEC: HUMAN_SPECInTest } =
        await import("../helpers/storage");
      const { db } = await import("../../src/infra/db/client");
      const { webhookNotifications } =
        await import("../../src/infra/db/schema");
      const { eq } = await import("drizzle-orm");
      const messages: Record<string, unknown>[] = [];
      let calls = 0;
      let alwaysReject = false;
      const webhook = http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        messages.push(JSON.parse(body));
        response.statusCode = (calls += 1) === 1 || alwaysReject ? 503 : 200;
        response.end();
      });
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      await new Promise<void>((resolve) => {
        webhook.listen(0, "127.0.0.1", resolve);
      });
      try {
        const project = await projectsRepository.createProject(
          "Scheduled store",
          baseUrl
        );
        await repoGit.ensureProjectRepo(project.id, { create: true });
        const feature = await writer.createFeatureInRepo(
          project.id,
          null,
          "Scheduled",
          ""
        );
        const { spec } = await writer.createSpecInRepo({
          projectId: project.id,
          featureId: feature.id,
          title: "Store",
          description: "",
          humanSpec: HUMAN_SPECInTest,
          testSource: VALID_SPECInTest,
        });
        await specsRepository.createSpecRecord({
          projectId: project.id,
          featureId: feature.id,
          title: "Invalid",
          description: "",
          path: "specs/invalid",
          sourceHash: "",
          markdownHash: "",
          status: "invalid",
        });
        await updateAutomation(project.id, {
          cron: "* * * * *",
          healFailures: false,
          allowPrivateWebhook: true,
          webhookUrl: `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/private-token`,
        });
        const at = new Date();
        await schedulesRepository.update(project.id, {
          nextRunAt: new Date(at.getTime() - 300_000).toISOString(),
        });
        await processSchedules(at);
        const scheduled = requireValue(
          await schedulesRepository.get(project.id)
        );
        assert.ok(scheduled.lastBatchId);
        assert.ok(
          Date.parse(requireValue(scheduled.nextRunAt)) > at.getTime(),
          "missed occurrences become one batch"
        );
        const batch = requireValue(
          await getRunBatch(requireValue(scheduled.lastBatchId))
        );
        assert.equal(batch.specs.length, 1, "all means runnable Specs only");
        assert.equal(batch.specs[0]?.specId, spec.id);
        assert.equal(
          await (async () => {
            const awaitedResult120093 = await runsRepository.getRun(
              requireValue(batch.specs[0]).runId
            );
            return awaitedResult120093?.automationPending;
          })(),
          true
        );
        assert.equal(
          await (async () => {
            const awaitedResult120250 = await runsRepository.getRun(
              requireValue(batch.specs[0]).runId
            );
            return awaitedResult120250?.healOnFailure;
          })(),
          false
        );
        await schedulesRepository.update(project.id, {
          nextRunAt: new Date(at.getTime() - 1000).toISOString(),
        });
        await processSchedules(new Date(at.getTime() + 1));
        assert.equal(
          await (async () => {
            const awaitedResult120584 = await schedulesRepository.get(
              project.id
            );
            return awaitedResult120584?.lastBatchId;
          })(),
          batch.id,
          "active batch is retained"
        );
        const [retry] = await schedulesRepository.notifications(project.id);
        assert.equal(retry?.attempts, 1);
        assert.equal(retry?.lastError, "Webhook returned HTTP 503");
        assert.ok(retry?.nextAttemptAt);
        const [rawNotification] = await db
          .select()
          .from(webhookNotifications)
          .where(eq(webhookNotifications.id, requireValue(retry).id));
        assert.ok(rawNotification?.webhookUrl.startsWith("v1:"));
        assert.ok(
          !JSON.stringify(rawNotification?.payload).includes("private-token")
        );
        await deliverWebhookNotifications(
          new Date(requireValue(requireValue(retry).nextAttemptAt))
        );
        const [delivered] = await schedulesRepository.notifications(project.id);
        assert.equal(delivered?.attempts, 2);
        assert.ok(delivered?.deliveredAt);
        assert.equal(
          messages[0]?.eventId,
          messages[1]?.eventId,
          "retry uses a stable event id"
        );
        assert.ok(
          typeof messages[0]?.text === "string",
          "payload works with Slack incoming webhooks"
        );
        /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
        for (
          let attempt = 0;
          attempt < 100 &&
          (await (async () => {
            const awaitedResult121897 = await getRunBatch(batch.id);
            return awaitedResult121897?.status;
          })()) === "running";
          attempt += 1
        ) {
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
        }
        /* oxlint-enable no-await-in-loop */
        assert.equal(
          await (async () => {
            const awaitedResult122089 = await getRunBatch(batch.id);
            return awaitedResult122089?.status;
          })(),
          "passed"
        );
        await updateAutomation(project.id, { cron: null });
        await processSchedules(new Date(at.getTime() + 12_000));
        assert.equal(
          await (async () => {
            const awaitedResult122296 = await schedulesRepository.get(
              project.id
            );
            return awaitedResult122296?.lastBatchStatus;
          })(),
          "passed"
        );
        assert.equal(
          messages.filter((message) => message.status === "passed").length,
          1
        );
        await processSchedules(new Date(at.getTime() + 13_000));
        assert.equal(
          messages.filter((message) => message.status === "passed").length,
          1,
          "polling does not duplicate events"
        );

        const interrupted = {
          ...requireValue(await getRunBatch(batch.id)),
          id: crypto.randomUUID(),
          status: "running",
        };
        const directory = getRunBatchDirectory(interrupted.id);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(
          path.join(directory, "batch.json"),
          JSON.stringify(interrupted)
        );
        await schedulesRepository.update(project.id, {
          lastBatchId: interrupted.id,
          lastBatchStatus: "running",
        });
        await markInterruptedBatches();
        await processSchedules(new Date(at.getTime() + 14_000));
        assert.equal(
          await (async () => {
            const awaitedResult123428 = await schedulesRepository.get(
              project.id
            );
            return awaitedResult123428?.lastBatchStatus;
          })(),
          "error"
        );
        assert.equal(
          messages.filter((message) => message.status === "error").length,
          1
        );

        alwaysReject = true;
        const failedDeliveryId = crypto.randomUUID();
        await schedulesRepository.recordBatch(
          project.id,
          failedDeliveryId,
          "failed",
          {
            webhookUrl: requireValue(
              requireValue(await schedulesRepository.get(project.id)).webhookUrl
            ),
            payload: { text: "Bounded retry" },
          }
        );
        /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await deliverWebhookNotifications(
            new Date(at.getTime() + (attempt + 1) * 600_001)
          );
        }
        /* oxlint-enable no-await-in-loop */
        const exhausted = await (async () => {
          const awaitedValue117059 = await schedulesRepository.notifications(
            project.id
          );
          return awaitedValue117059.find(
            (item) => item.batchId === failedDeliveryId
          );
        })();
        assert.equal(exhausted?.attempts, 5);
        assert.equal(exhausted?.nextAttemptAt, null);
        assert.equal(exhausted?.lastError, "Webhook returned HTTP 503");
      } finally {
        webhook.closeAllConnections();
        // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
        await new Promise<void>((resolve) => {
          webhook.close(() => resolve());
        });
      }
    }
  );
});

describe(
  "failure retry",
  { skip: available ? false : "Chromium is not installed" },
  () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
    const failingSpec = async function failingSpec(route: string) {
      const project = await projectsRepository.createProject("Retry", baseUrl);
      await repoGit.ensureProjectRepo(project.id, { create: true });
      const feature = await writer.createFeatureInRepo(
        project.id,
        null,
        "Retry",
        ""
      );
      const source = `import { test, expect } from "specbook";
test("Store", async ({ page, step }) => {
    await step("See the store", async () => {
        await page.goto("${route}");
        await expect(page.getByRole("heading")).toHaveText("Ready", { timeout: 500 });
    });
});`;
      const humanSpec = {
        preconditions: [],
        steps: ["See the store"],
        expectedResult: "",
        postconditions: [],
      };
      const { spec } = await writer.createSpecInRepo({
        projectId: project.id,
        featureId: feature.id,
        title: "Store",
        description: "",
        humanSpec,
        testSource: source,
      });
      return { project, spec, source, humanSpec };
    };

    test("pass on retry retains both attempts, marks flaky, and skips healing even after recovery", async () => {
      const { processRunFailures } =
        await import("../../src/core/jobs/failures");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const { jobsRepository: jobsRepositoryInTest } =
        await import("../../src/infra/repositories/jobs");
      const { stewardRepository: stewardRepositoryInTest } =
        await import("../../src/infra/repositories/steward");
      const { db } = await import("../../src/infra/db/client");
      const { runs } = await import("../../src/infra/db/schema");
      const { eq } = await import("drizzle-orm");
      const { project, spec } = await failingSpec("/flaky");
      const original = await executeSpec(spec.id, { automate: true });
      assert.equal(original.status, "failed");
      await processRunFailures();
      const history = await runsRepository.listRuns(spec.id);
      assert.equal(history.length, 2);
      const retry = requireValue(
        history.find((run) => run.retryOf === original.id)
      );
      assert.equal(retry.status, "passed", retry.failReason ?? "");
      assert.ok(history.every((run) => run.flaky));
      assert.equal(
        await (async () => {
          const awaitedValue119878 = await jobsRepositoryInTest.list(
            project.id
          );
          return awaitedValue119878.length;
        })(),
        0
      );
      assert.equal(
        await (async () => {
          const awaitedValue119949 = await stewardRepositoryInTest.signals(
            project.id
          );
          return awaitedValue119949.length;
        })(),
        0
      );
      assert.equal(
        await (async () => {
          const awaitedResult127507 = await runsRepository.getRun(original.id);
          return awaitedResult127507?.automationPending;
        })(),
        false
      );
      await db
        .update(runs)
        .set({ automationPending: true })
        .where(eq(runs.id, original.id));
      await processRunFailures();
      assert.equal(
        await (async () => {
          const awaitedValue120295 = await runsRepository.listRuns(spec.id);
          return awaitedValue120295.length;
        })(),
        2
      );
      assert.equal(
        await (async () => {
          const awaitedValue120367 = await jobsRepositoryInTest.list(
            project.id
          );
          return awaitedValue120367.length;
        })(),
        0
      );
    });

    test("healer opt-out still retries once, while a changed contract skips both retry and healing", async () => {
      const { processRunFailures } =
        await import("../../src/core/jobs/failures");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const { jobsRepository: jobsRepositoryInTest } =
        await import("../../src/infra/repositories/jobs");
      const { project, spec } = await failingSpec("/always-fails");
      const original = await executeSpec(spec.id, {
        automate: true,
        healOnFailure: false,
      });
      await processRunFailures();
      const history = await runsRepository.listRuns(spec.id);
      assert.equal(history.length, 2);
      assert.ok(history.every((run) => run.status === "failed" && !run.flaky));
      assert.equal(
        await (async () => {
          const awaitedValue121236 = await jobsRepositoryInTest.list(
            project.id
          );
          return awaitedValue121236.length;
        })(),
        0
      );
      await processRunFailures();
      assert.equal(
        await (async () => {
          const awaitedValue121341 = await runsRepository.listRuns(spec.id);
          return awaitedValue121341.length;
        })(),
        2
      );

      const changed = await failingSpec("/changed-contract");
      const stale = await executeSpec(changed.spec.id, { automate: true });
      await writer.updateSpecWithLock(changed.spec.id, {
        humanSpec: { ...changed.humanSpec, expectedResult: "New behavior" },
      });
      await processRunFailures();
      assert.equal(
        await (async () => {
          const awaitedValue121730 = await runsRepository.listRuns(
            changed.spec.id
          );
          return awaitedValue121730.length;
        })(),
        1
      );
      assert.equal(
        await (async () => {
          const awaitedResult129716 = await runsRepository.getRun(stale.id);
          return awaitedResult129716?.automationPending;
        })(),
        false
      );
      assert.equal(
        await (async () => {
          const awaitedValue121921 = await jobsRepositoryInTest.list(
            changed.project.id
          );
          return awaitedValue121921.length;
        })(),
        0
      );
      assert.equal(
        await (async () => {
          const awaitedResult129991 = await runsRepository.getRun(original.id);
          return awaitedResult129991?.automationPending;
        })(),
        false
      );
    });

    test("project and global agent pause do not prevent the retry from completing CI reporting", async () => {
      const { processRunFailures } =
        await import("../../src/core/jobs/failures");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const { settingsRepository } =
        await import("../../src/infra/repositories/settings");
      const { ciResult } = await import("../../src/core/ci/results");
      /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
      for (const global of [false, true]) {
        const { project, spec } = await failingSpec(`/flaky-paused-${global}`);
        const original = await executeSpec(spec.id, { automate: true });
        await stewardRepository.update(project.id, { paused: !global });
        await settingsRepository.setAgentPaused(global);
        try {
          await processRunFailures();
          const retry = requireValue(
            await runsRepository.retryFor(original.id)
          );
          assert.equal(retry.status, "passed", retry.failReason ?? "");
          assert.equal(
            await (async () => {
              const awaitedResult131119 = await runsRepository.getRun(
                original.id
              );
              return awaitedResult131119?.automationPending;
            })(),
            false
          );
          const result = await ciResult({
            id: "paused-ci",
            projectId: project.id,
            label: "CI",
            baseUrl,
            status: "failed",
            startedAt: original.startedAt,
            durationMs: original.durationMs,
            failReason: original.failReason,
            specs: [
              {
                runId: original.id,
                specId: spec.id,
                commitSha: original.commitSha,
                sourceHash: original.sourceHash,
                markdownHash: spec.markdownHash,
                title: spec.title,
                status: "failed",
                durationMs: original.durationMs,
                failReason: original.failReason,
              },
            ],
          });
          assert.equal(result.complete, true);
          assert.equal(result.qualityGate.flaky, 1);
          assert.equal(result.qualityGate.passed, true);
          assert.equal(
            await (async () => {
              const awaitedValue124179 = await jobsRepository.list(project.id);
              return awaitedValue124179.length;
            })(),
            0
          );
        } finally {
          await settingsRepository.setAgentPaused(false);
        }
      }
      /* oxlint-enable no-await-in-loop */
    });

    test("failed retry emits one original-failure signal even after a crash before acknowledgement", async (t) => {
      const { processRunFailures } =
        await import("../../src/core/jobs/failures");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const { stewardRepository: stewardRepositoryInTest } =
        await import("../../src/infra/repositories/steward");
      const { project, spec } = await failingSpec("/failure-signal");
      const original = await executeSpec(spec.id, { automate: true });
      const acknowledge =
        runsRepository.acknowledgeAutomation.bind(runsRepository);
      const interruptedAck = t.mock.method(
        runsRepository,
        "acknowledgeAutomation",
        async (id: string) => {
          if (id === original.id) {
            throw new Error(
              "Backend stopped before acknowledging the original failure"
            );
          }
          await acknowledge(id);
        }
      );
      await processRunFailures();
      interruptedAck.mock.restore();
      const retry = requireValue(await runsRepository.retryFor(original.id));
      assert.equal(retry.status, "failed");
      assert.equal(
        await (async () => {
          const awaitedResult133617 = await (async () => {
            const awaitedValue125528 = await stewardRepositoryInTest.signals(
              project.id
            );
            return awaitedValue125528[0];
          })();
          return awaitedResult133617?.payload.runId;
        })(),
        retry.id
      );
      assert.equal(
        await (async () => {
          const awaitedResult133821 = await (async () => {
            const awaitedValue125647 = await stewardRepositoryInTest.signals(
              project.id
            );
            return awaitedValue125647[0];
          })();
          return awaitedResult133821?.key;
        })(),
        `failure:${original.id}`
      );
      assert.equal(
        await (async () => {
          const awaitedResult134031 = await (async () => {
            const awaitedValue125772 = await stewardRepositoryInTest.signals(
              project.id
            );
            return awaitedValue125772[0];
          })();
          return awaitedResult134031?.payload.originalRunId;
        })(),
        original.id
      );
      assert.equal(
        await (async () => {
          const awaitedResult134246 = await runsRepository.getRun(original.id);
          return awaitedResult134246?.automationPending;
        })(),
        true
      );
      assert.equal(
        await (async () => {
          const awaitedResult134359 = await runsRepository.getRun(retry.id);
          return awaitedResult134359?.automationPending;
        })(),
        false
      );
      await processRunFailures();
      assert.equal(
        await (async () => {
          const awaitedValue126151 = await stewardRepositoryInTest.signals(
            project.id
          );
          return awaitedValue126151.length;
        })(),
        1
      );
      assert.equal(
        await (async () => {
          const awaitedValue126228 = await runsRepository.listRuns(spec.id);
          return awaitedValue126228.length;
        })(),
        2
      );
      assert.equal(
        await (async () => {
          const awaitedResult134823 = await runsRepository.getRun(original.id);
          return awaitedResult134823?.automationPending;
        })(),
        false
      );

      const recovered = await failingSpec("/interrupted-retry");
      const failed = await executeSpec(recovered.spec.id, { automate: true });
      const interrupted = await runsRepository.createRun({
        specId: recovered.spec.id,
        commitSha: failed.commitSha,
        sourceHash: failed.sourceHash,
        retryOf: failed.id,
      });
      await runsRepository.markInterruptedRuns();
      await processRunFailures();
      await processRunFailures();
      assert.equal(
        await (async () => {
          const awaitedValue126894 = await runsRepository.listRuns(
            recovered.spec.id
          );
          return awaitedValue126894.length;
        })(),
        2
      );
      assert.equal(
        await (async () => {
          const awaitedResult135599 = await (async () => {
            const awaitedValue127000 = await stewardRepositoryInTest.signals(
              recovered.project.id
            );
            return awaitedValue127000[0];
          })();
          return awaitedResult135599?.payload.runId;
        })(),
        interrupted.id
      );
      assert.equal(
        await (async () => {
          const awaitedValue127146 = await stewardRepositoryInTest.signals(
            recovered.project.id
          );
          return awaitedValue127146.length;
        })(),
        1
      );
    });

    test("retry preparation failures back off without skipping the flaky check or starting triage", async (t) => {
      const { processRunFailures } =
        await import("../../src/core/jobs/failures");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const { project, spec } = await failingSpec("/flaky-deferred-retry");
      const original = await executeSpec(spec.id, { automate: true });
      const unsaved = path.join(repoGit.getRepoDir(project.id), "pending.txt");
      await fs.writeFile(unsaved, "Temporarily uncommitted changes");
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      try {
        await processRunFailures();
        assert.equal(await runsRepository.retryFor(original.id), null);
        assert.equal(
          await (async () => {
            const awaitedResult136827 = await runsRepository.getRun(
              original.id
            );
            return awaitedResult136827?.automationPending;
          })(),
          true
        );
        assert.equal(
          await (async () => {
            const awaitedValue128168 = await stewardRepository.signals(
              project.id
            );
            return awaitedValue128168.length;
          })(),
          0
        );
        assert.equal(
          await (async () => {
            const awaitedValue128247 = await jobsRepository.list(project.id);
            return awaitedValue128247.length;
          })(),
          0
        );
        now += 15_000;
        await processRunFailures();
        assert.equal(await runsRepository.retryFor(original.id), null);
        await fs.unlink(unsaved);
        now += 15_000;
        await processRunFailures();
        assert.equal(
          await runsRepository.retryFor(original.id),
          null,
          "the second preparation error doubles the retry delay"
        );
        now += 15_000;
        await processRunFailures();
        const retry = requireValue(await runsRepository.retryFor(original.id));
        assert.equal(retry.status, "passed", retry.failReason ?? "");
        assert.equal(retry.flaky, true);
        assert.equal(
          await (async () => {
            const awaitedResult137912 = await runsRepository.getRun(
              original.id
            );
            return awaitedResult137912?.automationPending;
          })(),
          false
        );
        assert.equal(
          await (async () => {
            const awaitedValue129073 = await stewardRepository.signals(
              project.id
            );
            return awaitedValue129073.length;
          })(),
          0
        );
        assert.equal(
          await (async () => {
            const awaitedValue129152 = await jobsRepository.list(project.id);
            return awaitedValue129152.length;
          })(),
          0
        );
        assert.equal(
          await (async () => {
            const awaitedValue129225 = await runsRepository.listRuns(spec.id);
            return awaitedValue129225.length;
          })(),
          2
        );
      } finally {
        t.mock.restoreAll();
        await fs.rm(unsaved, { force: true });
      }
    });

    test("retry retains the preview URL even when the project's base URL changes", async () => {
      const { processRunFailures } =
        await import("../../src/core/jobs/failures");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const { project, spec } = await failingSpec("/flaky-preview");
      const original = await executeSpec(spec.id, { automate: true, baseUrl });
      assert.equal(original.status, "failed");
      await projectsRepository.updateProject(project.id, {
        baseUrl: "http://127.0.0.1:1",
      });
      await environmentsRepository.update(
        requireValue(
          await (async () => {
            const awaitedValue130024 = await environmentsRepository.list(
              project.id
            );
            return awaitedValue130024[0];
          })()
        ),
        {
          ...requireValue(
            await (async () => {
              const awaitedValue130100 = await environmentsRepository.list(
                project.id
              );
              return awaitedValue130100[0];
            })()
          ),
          allowedOrigins: [new URL(baseUrl).origin],
        }
      );
      await processRunFailures();
      const retry = requireValue(await runsRepository.retryFor(original.id));
      assert.equal(retry.status, "passed", retry.failReason ?? "");
      assert.equal(retry.baseUrl, baseUrl);
      assert.equal(retry.flaky, true);
    });
  }
);

describe("autonomous pause and decisions", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
  const projectWithWork = async function projectWithWork() {
    const project = await projectsRepository.createProject(
      "Continuation",
      baseUrl
    );
    await stewardRepository.update(project.id, { autonomy: "propose" });
    return project;
  };

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
  const createWork = function createWork(projectId: string) {
    try {
      return Promise.resolve(
        jobsRepository.create({
          projectId,
          chatId: crypto.randomUUID(),
          trigger: "steward",
          kind: "explore",
          goal: "Investigate checkout",
          limits: jobLimitsSchema.parse({}),
        })
      );
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const router = createJobsRouter();
  const post = (url: string, body?: unknown) =>
    router.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  before(async () => {
    const { stopJobWorker } = await import("../../src/core/jobs/worker");
    await stopJobWorker();
    const { createStewardRouter } =
      await import("../../src/infra/web/routes/steward");
    const { createSettingsRouter } =
      await import("../../src/infra/web/routes/settings");
    router.route("/", createStewardRouter());
    router.route("/", createSettingsRouter());
  });

  const put = (url: string, body: unknown) =>
    router.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("migration preserves investigations and audit while removing quota storage", async () => {
    const { createClient } = await import("@libsql/client");
    const { tempDir } = await import("../helpers/storage");
    const client = createClient({
      url: `file:${path.join(tempDir(), "pause-migration.db")}`,
    });
    try {
      await client.executeMultiple(`
                CREATE TABLE app_settings (id INTEGER PRIMARY KEY, llm TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE project_stewards (project_id TEXT PRIMARY KEY, autonomy TEXT NOT NULL, extra_usage TEXT, updated_at TEXT NOT NULL);
                CREATE TABLE jobs (id TEXT PRIMARY KEY, budget TEXT NOT NULL, daily_usage TEXT, status TEXT NOT NULL, actions_used INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL, tokens_used INTEGER NOT NULL, retry_at TEXT);
                CREATE TABLE job_actions (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
                CREATE TABLE inbox_items (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
            `);
      await client.execute({
        sql: "INSERT INTO app_settings VALUES (1, ?, ?)",
        args: [
          JSON.stringify({ provider: "saved", model: "selected" }),
          "2026-10-01T00:00:00.000Z",
        ],
      });
      await client.execute({
        sql: "INSERT INTO project_stewards VALUES (?, ?, ?, ?)",
        args: [
          "project",
          "act",
          JSON.stringify({
            date: "2026-10-01",
            tokens: 1000,
            wallTimeMs: 1000,
          }),
          "2026-10-01T00:00:00.000Z",
        ],
      });
      await client.execute({
        sql: "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          "investigation",
          JSON.stringify({
            maxTokens: 100_000,
            maxActions: 80,
            wallTimeMs: 600_000,
          }),
          JSON.stringify({
            date: "2026-10-01",
            tokens: 100_000,
            wallTimeMs: 600_000,
          }),
          "budget_exceeded",
          87,
          650_000,
          120_000,
          null,
        ],
      });
      await client.execute(
        "INSERT INTO job_actions VALUES (1, 'investigation', 'inspected', 'Checkout button changed')"
      );
      await client.execute(
        "INSERT INTO inbox_items VALUES ('question', 'investigation', 'pending', 'Which account should sign in?')"
      );
      const migration = await fs.readFile(
        new URL("../../drizzle/0016_colossal_warpath.sql", import.meta.url),
        "utf-8"
      );
      /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
      for (const statement of migration.split("--> statement-breakpoint")) {
        await client.execute(statement.trim());
      }
      /* oxlint-enable no-await-in-loop */
      const migrated = requireValue(
        await (async () => {
          const awaitedValue134789 = await client.execute("SELECT * FROM jobs");
          return awaitedValue134789.rows[0];
        })()
      );
      assert.equal(migrated.status, "stalled");
      assert.equal(migrated.actions_used, 87);
      assert.equal(migrated.elapsed_ms, 650_000);
      assert.equal(migrated.tokens_used, 120_000);
      assert.deepEqual(JSON.parse(String(migrated.limits)), {
        maxActions: 587,
        wallTimeMs: 4_250_000,
      });
      assert.ok(migrated.retry_at);
      assert.ok(migrated.stop_reason);
      assert.equal(migrated.safety_retries, 0);
      assert.equal("budget" in migrated, false);
      assert.equal("daily_usage" in migrated, false);
      const settings = requireValue(
        await (async () => {
          const awaitedValue135417 = await client.execute(
            "SELECT * FROM app_settings"
          );
          return awaitedValue135417.rows[0];
        })()
      );
      assert.equal(settings.agent_paused, 0);
      assert.deepEqual(JSON.parse(String(settings.llm)), {
        provider: "saved",
        model: "selected",
      });
      const steward = requireValue(
        await (async () => {
          const awaitedValue135680 = await client.execute(
            "SELECT * FROM project_stewards"
          );
          return awaitedValue135680.rows[0];
        })()
      );
      assert.equal(steward.autonomy, "act");
      assert.equal(steward.paused, 0);
      assert.equal("extra_usage" in steward, false);
      assert.equal(
        await (async () => {
          const awaitedResult145617 = await (async () => {
            const awaitedValue135921 = await client.execute(
              "SELECT detail FROM job_actions"
            );
            return awaitedValue135921.rows[0];
          })();
          return awaitedResult145617?.detail;
        })(),
        "Checkout button changed"
      );
      assert.equal(
        await (async () => {
          const awaitedResult145858 = await (async () => {
            const awaitedValue136077 = await client.execute(
              "SELECT status FROM inbox_items"
            );
            return awaitedValue136077.rows[0];
          })();
          return awaitedResult145858?.status;
        })(),
        "pending"
      );
    } finally {
      client.close();
    }
  });

  test("project pause persists and resumes the same work while preserving questions and usage", async () => {
    const project = await projectWithWork();
    const queued = await createWork(project.id);
    await jobsRepository.recordUsage(queued.id, 25_000, 60_000);
    await jobsRepository.update(queued.id, { actionsUsed: 37 });
    const running = await createWork(project.id);
    await jobsRepository.claim(running.id);
    const blocked = await createWork(project.id);
    await jobsRepository.update(blocked.id, { status: "blocked" });
    const question = await jobsRepository.addItem({
      projectId: project.id,
      jobId: blocked.id,
      kind: "question",
      title: "Which account should sign in?",
      body: "Add access to continue.",
    });
    const endpoint = `/projects/${project.id}/steward`;
    assert.deepEqual(
      await (async () => {
        const awaitedValue137092 = await router.request(endpoint);
        return awaitedValue137092.json();
      })(),
      {
        autonomy: "propose",
        paused: false,
        globallyPaused: false,
      }
    );
    assert.deepEqual(
      await (async () => {
        const awaitedValue137247 = await put(endpoint, { paused: true });
        return awaitedValue137247.json();
      })(),
      {
        autonomy: "propose",
        paused: true,
        globallyPaused: false,
      }
    );
    assert.equal(
      await (async () => {
        const awaitedResult147434 = await jobsRepository.get(queued.id);
        return awaitedResult147434?.status;
      })(),
      "paused"
    );
    assert.equal(
      await (async () => {
        const awaitedResult147509 = await jobsRepository.get(running.id);
        return awaitedResult147509?.status;
      })(),
      "paused"
    );
    assert.equal(
      await (async () => {
        const awaitedResult147585 = await jobsRepository.get(blocked.id);
        return awaitedResult147585?.status;
      })(),
      "blocked"
    );
    const intent = await enqueueIntent(
      project.id,
      {
        kind: "explore",
        goal: "Explore checkout",
        reason: "Human requested exploration",
      },
      "pause-pending",
      "user"
    );
    await processProjectSteward(project.id, false);
    assert.equal(
      await (async () => {
        const awaitedResult147945 = await (async () => {
          const awaitedValue137909 = await stewardRepository.intents(
            project.id
          );
          return awaitedValue137909.find((row) => row.id === intent.id);
        })();
        return awaitedResult147945?.status;
      })(),
      "pending"
    );
    await jobsRepository.recover();
    assert.equal(
      await (async () => {
        const awaitedResult148213 = await jobsRepository.get(queued.id);
        return awaitedResult148213?.status;
      })(),
      "paused"
    );
    assert.equal(
      await (async () => {
        const awaitedValue138167 = await stewardRepository.get(project.id);
        return awaitedValue138167.paused;
      })(),
      true
    );
    await put(endpoint, { autonomy: "observe" });
    await put(endpoint, { autonomy: "propose" });
    assert.equal(
      await (async () => {
        const awaitedValue138348 = await stewardRepository.get(project.id);
        return awaitedValue138348.paused;
      })(),
      true,
      "autonomy changes must not implicitly resume the agent"
    );
    const resumed = await put(endpoint, { paused: false });
    assert.equal(resumed.status, 200);
    assert.deepEqual(await resumed.json(), {
      autonomy: "propose",
      paused: false,
      globallyPaused: false,
    });
    const retained = requireValue(await jobsRepository.get(queued.id));
    assert.equal(retained.status, "queued");
    assert.equal(retained.tokensUsed, 25_000);
    assert.equal(retained.elapsedMs, 60_000);
    assert.equal(retained.actionsUsed, 37);
    assert.deepEqual(retained.limits, queued.limits);
    assert.equal(
      await (async () => {
        const awaitedResult149324 = await jobsRepository.get(running.id);
        return awaitedResult149324?.status;
      })(),
      "queued"
    );
    assert.equal(
      await (async () => {
        const awaitedResult149400 = await jobsRepository.get(blocked.id);
        return awaitedResult149400?.status;
      })(),
      "blocked"
    );
    assert.equal(
      await (async () => {
        const awaitedResult149477 = await jobsRepository.item(question.id);
        return awaitedResult149477?.status;
      })(),
      "pending"
    );
    assert.equal(
      await (async () => {
        const awaitedValue139254 = await jobsRepository.list(project.id);
        return awaitedValue139254.length;
      })(),
      3
    );
    assert.equal(
      await (async () => {
        const awaitedValue139330 = await post(
          `/projects/${project.id}/continue-now`
        );
        return awaitedValue139330.status;
      })(),
      404
    );
  });

  test("global pause overrides project resume and preserves local pauses and model settings", async () => {
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    const { isAgentPaused } = await import("../../src/core/jobs/pause");
    const local = await projectWithWork();
    const other = await projectWithWork();
    const localJob = await createWork(local.id);
    const otherJob = await createWork(other.id);
    await settingsRepository.updateLlmSettings({
      provider: "local-test",
      model: "no-provider-call",
    });
    assert.deepEqual(
      await (async () => {
        const awaitedValue140023 = await router.request("/settings/agent");
        return awaitedValue140023.json();
      })(),
      {
        paused: false,
      }
    );
    await put(`/projects/${local.id}/steward`, { paused: true });
    assert.deepEqual(
      await (async () => {
        const awaitedValue140204 = await put("/settings/agent", {
          paused: true,
        });
        return awaitedValue140204.json();
      })(),
      { paused: true }
    );
    assert.equal(await isAgentPaused(local.id), true);
    assert.equal(await isAgentPaused(other.id), true);
    assert.equal(
      await (async () => {
        const awaitedResult151060 = await jobsRepository.get(otherJob.id);
        return awaitedResult151060?.status;
      })(),
      "paused"
    );
    const stillPaused = await put(`/projects/${other.id}/steward`, {
      paused: false,
    });
    assert.deepEqual(await stillPaused.json(), {
      autonomy: "propose",
      paused: false,
      globallyPaused: true,
    });
    assert.equal(
      await (async () => {
        const awaitedResult151368 = await jobsRepository.get(otherJob.id);
        return awaitedResult151368?.status;
      })(),
      "paused"
    );
    await jobsRepository.recover();
    assert.equal(await settingsRepository.getAgentPaused(), true);
    await settingsRepository.updateLlmSettings({
      provider: "local-test",
      model: "still-no-provider-call",
    });
    assert.equal(
      await settingsRepository.getAgentPaused(),
      true,
      "editing the model must preserve global pause"
    );
    await put("/settings/agent", { paused: false });
    assert.equal(await isAgentPaused(local.id), true);
    assert.equal(await isAgentPaused(other.id), false);
    assert.equal(
      await (async () => {
        const awaitedResult151977 = await jobsRepository.get(localJob.id);
        return awaitedResult151977?.status;
      })(),
      "paused"
    );
    assert.equal(
      await (async () => {
        const awaitedResult152054 = await jobsRepository.get(otherJob.id);
        return awaitedResult152054?.status;
      })(),
      "queued"
    );
    assert.deepEqual(await settingsRepository.getLlmSettings(), {
      provider: "local-test",
      model: "still-no-provider-call",
    });
    await settingsRepository.updateLlmSettings({ provider: "", model: "" });
  });

  test("pausing retains queued triage evidence and running follow-up instructions", async () => {
    const project = await projectWithWork();
    const triageInstructions =
      "Investigate failed step Checkout using screenshot /evidence/failed.png and ARIA snapshot. Keep spec.yml unchanged.";
    const queued = await jobsRepository.create({
      projectId: project.id,
      chatId: crypto.randomUUID(),
      trigger: "spec_failure",
      kind: "failure_triage",
      goal: "Investigate Checkout",
      pendingMessage: triageInstructions,
      limits: jobLimitsSchema.parse({}),
    });
    const running = await createWork(project.id);
    const followUp =
      "Human answer: use the operator account. Verify the saved draft before repeating the submission.";
    await jobsRepository.update(running.id, { pendingMessage: followUp });
    await jobsRepository.claim(running.id);
    const endpoint = `/projects/${project.id}/steward`;
    await put(endpoint, { paused: true });
    assert.equal(
      await (async () => {
        const awaitedResult153358 = await jobsRepository.get(queued.id);
        return awaitedResult153358?.pendingMessage;
      })(),
      triageInstructions
    );
    const retained = requireValue(
      await jobsRepository.get(running.id)
    ).pendingMessage;
    assert.match(retained, /The human paused/u);
    assert.ok(retained.endsWith(followUp));
    await put(endpoint, { paused: false });
    assert.equal(
      await (async () => {
        const awaitedResult153694 = await jobsRepository.get(queued.id);
        return awaitedResult153694?.pendingMessage;
      })(),
      triageInstructions
    );
    await jobsRepository.claim(running.id);
    await put(endpoint, { paused: true });
    assert.equal(
      await (async () => {
        const awaitedResult153892 = await jobsRepository.get(running.id);
        return awaitedResult153892?.pendingMessage;
      })(),
      retained,
      "repeated pauses must not duplicate the reminder or replace the original request"
    );
  });

  test(
    "completion cannot replace a pause made while reading the final response",
    { timeout: 10_000 },
    async (t) => {
      const { startJobWorker, stopJobWorker } =
        await import("../../src/core/jobs/worker");
      const { createChat, openSession, flushSessionFile } =
        await import("../../src/core/chat/session-store");
      const { tryReserveChatTurn, releaseChatTurn } =
        await import("../../src/core/chat/chat-registry");
      const project = await projectWithWork();
      const chat = await createChat(project.id);
      const session = requireValue(await openSession(chat.id));
      session.appendCustomMessageEntry(
        "result",
        "The checkout investigation is ready for review.",
        true
      );
      flushSessionFile(session);
      const job = await jobsRepository.create({
        projectId: project.id,
        chatId: chat.id,
        trigger: "manual",
        goal: "Investigate checkout",
        limits: jobLimitsSchema.parse({}),
      });
      const read = jobsRepository.get.bind(jobsRepository);
      const log = jobsRepository.log.bind(jobsRepository);
      let runningReads = 0;
      let notifyStopped!: () => void;
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      const stopped = new Promise<void>((resolve) => {
        notifyStopped = resolve;
      });
      t.mock.method(jobsRepository, "queued", async () => {
        const row = await read(job.id);
        return row?.status === "queued" ? [row] : [];
      });
      t.mock.method(jobsRepository, "get", async (id: string) => {
        const snapshot = await read(id);
        if (
          id === job.id &&
          snapshot?.status === "running" &&
          (runningReads += 1) === 2
        ) {
          await stewardRepository.update(project.id, { paused: true });
          await jobsRepository.transition(job.id, "running", "paused");
        }
        return snapshot;
      });
      t.mock.method(
        jobsRepository,
        "log",
        async (id: string, action: string, detail = "") => {
          await log(id, action, detail);
          if (id === job.id && action === "stopped") {
            notifyStopped();
          }
        }
      );
      assert.equal(tryReserveChatTurn(chat.id), true);
      try {
        await startJobWorker();
        await stopped;
        assert.equal(
          await (async () => {
            const awaitedResult156374 = await read(job.id);
            return awaitedResult156374?.status;
          })(),
          "paused"
        );
        assert.equal(
          await (async () => {
            const awaitedResult156436 = await read(job.id);
            return awaitedResult156436?.startedAt;
          })(),
          null
        );
        assert.equal(
          await (async () => {
            const awaitedValue145844 = await jobsRepository.inbox(project.id);
            return awaitedValue145844.length;
          })(),
          0,
          "a paused attempt must not publish a completion note"
        );
      } finally {
        await stopJobWorker();
        releaseChatTurn(chat.id);
      }
    }
  );

  test("environment retry cannot replace a pause made while recording the finding", async (t) => {
    const { createTriageTools } = await import("../../src/core/jobs/triage");
    const project = await projectWithWork();
    const instructions =
      "Investigate Checkout using the failed step and screenshot. Preserve spec.yml and all assertions.";
    const job = await jobsRepository.create({
      projectId: project.id,
      chatId: crypto.randomUUID(),
      trigger: "spec_failure",
      kind: "failure_triage",
      goal: "Investigate Checkout",
      pendingMessage: instructions,
      limits: jobLimitsSchema.parse({}),
    });
    const running = requireValue(await jobsRepository.claim(job.id));
    const addItem = jobsRepository.addItem.bind(jobsRepository);
    let retained = "";
    t.mock.method(
      jobsRepository,
      "addItem",
      async (...args: Parameters<typeof addItem>) => {
        const item = await addItem(...args);
        if (item.jobId === job.id) {
          assert.equal(
            await (async () => {
              const awaitedValue147107 = await put(
                `/projects/${project.id}/steward`,
                { paused: true }
              );
              return awaitedValue147107.status;
            })(),
            200
          );
          retained = requireValue(
            await jobsRepository.get(job.id)
          ).pendingMessage;
        }
        return item;
      }
    );
    let aborted = false;
    const tool = requireValue(
      createTriageTools(running, () => {
        aborted = true;
      }).find((toolInTest) => toolInTest.name === "triage_failure")
    );
    await tool.execute(
      "environment-result",
      {
        classification: "environment",
        reason: "The application returns HTTP 503 from checkout.",
        reproduction: ["Open checkout"],
        evidence: ["The checkout response returned HTTP 503"],
      },
      undefined,
      undefined,
      {} as never
    );
    const paused = requireValue(await jobsRepository.get(job.id));
    assert.equal(paused.status, "paused");
    assert.equal(paused.retryAt, null);
    assert.equal(paused.pendingMessage, retained);
    assert.ok(paused.pendingMessage.endsWith(instructions));
    assert.equal(aborted, true);
  });

  test("concurrent resume requests preserve one investigation and reject invalid pause inputs", async () => {
    const project = await projectWithWork();
    const job = await createWork(project.id);
    const endpoint = `/projects/${project.id}/steward`;
    assert.equal(
      await (async () => {
        const awaitedValue148401 = await put(endpoint, {});
        return awaitedValue148401.status;
      })(),
      400
    );
    assert.equal(
      await (async () => {
        const awaitedValue148458 = await put(endpoint, { paused: "true" });
        return awaitedValue148458.status;
      })(),
      400
    );
    assert.equal(
      await (async () => {
        const awaitedValue148538 = await put(endpoint, {
          paused: true,
          extraUsage: 1000,
        });
        return awaitedValue148538.status;
      })(),
      400
    );
    assert.equal(
      await (async () => {
        const awaitedValue148638 = await put("/settings/agent", {});
        return awaitedValue148638.status;
      })(),
      400
    );
    assert.equal(
      await (async () => {
        const awaitedValue148711 = await put("/settings/agent", {
          paused: "false",
        });
        return awaitedValue148711.status;
      })(),
      400
    );
    assert.equal(
      await (async () => {
        const awaitedValue148812 = await put("/settings/agent", {
          paused: true,
          autonomy: "observe",
        });
        return awaitedValue148812.status;
      })(),
      400
    );
    assert.equal(
      await (async () => {
        const awaitedValue148940 = await put("/projects/missing/steward", {
          paused: true,
        });
        return awaitedValue148940.status;
      })(),
      404
    );
    assert.equal(
      await (async () => {
        const awaitedValue149048 = await router.request(
          "/projects/missing/steward"
        );
        return awaitedValue149048.status;
      })(),
      404
    );
    await put(endpoint, { paused: true });
    const results = await Promise.all([
      put(endpoint, { paused: false }),
      put(endpoint, { paused: false }),
    ]);
    assert.deepEqual(
      results.map((response) => response.status),
      [200, 200]
    );
    assert.equal(
      await (async () => {
        const awaitedResult160969 = await jobsRepository.get(job.id);
        return awaitedResult160969?.status;
      })(),
      "queued"
    );
    assert.equal(
      await (async () => {
        const awaitedValue149481 = await stewardRepository.get(project.id);
        return awaitedValue149481.paused;
      })(),
      false
    );
    assert.equal(
      await (async () => {
        const awaitedValue149556 = await jobsRepository.list(project.id);
        return awaitedValue149556.length;
      })(),
      1
    );
    assert.deepEqual(
      await (async () => {
        const awaitedResult161359 = await jobsRepository.get(job.id);
        return awaitedResult161359?.limits;
      })(),
      job.limits
    );
    assert.equal(
      await (async () => {
        const awaitedValue149710 = await jobsRepository.actions(job.id);
        return awaitedValue149710.filter((entry) => entry.action === "resumed")
          .length;
      })(),
      1
    );
  });

  test("past token and time usage never prevents a requested investigation", async () => {
    const project = await projectWithWork();
    const previous = await createWork(project.id);
    await jobsRepository.recordUsage(previous.id, 2_000_000, 36_000_000);
    await jobsRepository.update(previous.id, {
      status: "completed",
      actionsUsed: 3000,
    });
    const intent = await enqueueIntent(
      project.id,
      {
        kind: "explore",
        goal: "Investigate checkout",
        reason: "Human requested exploration",
      },
      "no-usage-gate",
      "user"
    );
    await Promise.all([
      processProjectSteward(project.id, false),
      processProjectSteward(project.id, false),
    ]);
    const next = requireValue(await jobsRepository.get(intent.id));
    assert.ok(next);
    assert.equal(next.status, "queued");
    assert.deepEqual(next.limits, { maxActions: 500, wallTimeMs: 3_600_000 });
    assert.equal(next.tokensUsed, 0);
    assert.equal(
      await (async () => {
        const awaitedValue150818 = await jobsRepository.list(project.id);
        return awaitedValue150818.length;
      })(),
      2
    );
    assert.equal(
      await (async () => {
        const awaitedResult162805 = await jobsRepository.get(previous.id);
        return awaitedResult162805?.tokensUsed;
      })(),
      2_000_000
    );
  });

  test("stalled work retries with backoff twice, asks once, then uses the human answer", async () => {
    const { stallJob, retryStalledJob, MAX_SAFETY_RETRIES } =
      await import("../../src/core/jobs/retry");
    const project = await projectWithWork();
    const job = await createWork(project.id);
    await jobsRepository.claim(job.id);
    await jobsRepository.recordUsage(job.id, 900_000, 3_600_000);
    await jobsRepository.update(job.id, { actionsUsed: 500 });
    await jobsRepository.log(
      job.id,
      "browser_click:error",
      "The Checkout button remains unavailable after signing in."
    );
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let attempt = 0; attempt <= MAX_SAFETY_RETRIES; attempt += 1) {
      const beforeInTest = Date.now();
      await stallJob(
        requireValue(await jobsRepository.get(job.id)),
        "No confirmed result"
      );
      const stalled = requireValue(await jobsRepository.get(job.id));
      assert.equal(stalled.status, "stalled");
      assert.equal(stalled.safetyRetries, attempt);
      assert.match(
        stalled.stopReason ?? "",
        /Checkout button remains unavailable/u
      );
      await jobsRepository.update(job.id, { startedAt: null });
      if (attempt === MAX_SAFETY_RETRIES) {
        await Promise.all([retryStalledJob(stalled), retryStalledJob(stalled)]);
        break;
      }
      assert.ok(
        Date.parse(requireValue(stalled.retryAt)) >=
          beforeInTest + 60_000 * 2 ** attempt
      );
      await retryStalledJob(stalled);
      assert.equal(
        await (async () => {
          const awaitedResult164382 = await jobsRepository.get(job.id);
          return awaitedResult164382?.status;
        })(),
        "stalled",
        "a retry must respect its persisted backoff"
      );
      await jobsRepository.update(job.id, {
        retryAt: "2000-01-01T00:00:00.000Z",
      });
      await Promise.all([retryStalledJob(stalled), retryStalledJob(stalled)]);
      const next = requireValue(await jobsRepository.get(job.id));
      assert.equal(next.status, "queued");
      assert.equal(next.safetyRetries, attempt + 1);
      assert.deepEqual(next.limits, {
        maxActions: next.actionsUsed + 500,
        wallTimeMs: next.elapsedMs + 3_600_000,
      });
      assert.equal(next.tokensUsed, 900_000);
      assert.match(next.pendingMessage, /different approach/u);
      await jobsRepository.claim(job.id);
      await jobsRepository.update(job.id, {
        actionsUsed: next.limits.maxActions,
        elapsedMs: next.limits.wallTimeMs,
      });
    }
    /* oxlint-enable no-await-in-loop */
    const blocked = requireValue(await jobsRepository.get(job.id));
    assert.equal(blocked.status, "blocked");
    await retryStalledJob(blocked);
    const questions = await (async () => {
      const awaitedValue153491 = await jobsRepository.inbox(project.id);
      return awaitedValue153491.filter((item) => item.kind === "question");
    })();
    assert.equal(questions.length, 1);
    assert.equal(questions[0]?.payload.waitingFor, "investigation");
    assert.match(
      requireValue(questions[0]).body,
      /Checkout button remains unavailable/u
    );
    const answer = await post(
      `/projects/${project.id}/inbox/${requireValue(questions[0]).id}/review`,
      {
        action: "answer",
        answer: "Sign in with the manager profile before opening checkout.",
      }
    );
    assert.equal(answer.status, 200);
    const resumed = requireValue(await jobsRepository.get(job.id));
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.tokensUsed, blocked.tokensUsed);
    assert.equal(resumed.actionsUsed, blocked.actionsUsed);
    assert.equal(resumed.elapsedMs, blocked.elapsedMs);
    assert.deepEqual(resumed.limits, {
      maxActions: blocked.actionsUsed + 500,
      wallTimeMs: blocked.elapsedMs + 3_600_000,
    });
    assert.equal(resumed.safetyRetries, 0);
    assert.equal(resumed.stopReason, null);
    assert.match(resumed.pendingMessage, /manager profile/u);
    assert.equal(
      await (async () => {
        const awaitedResult166715 = await jobsRepository.item(
          requireValue(questions[0]).id
        );
        return awaitedResult166715?.status;
      })(),
      "answered"
    );

    const interrupted = await createWork(project.id);
    await jobsRepository.update(interrupted.id, {
      status: "blocked",
      safetyRetries: MAX_SAFETY_RETRIES,
      stopReason: "The Checkout button remains unavailable after signing in.",
    });
    await processProjectSteward(project.id, false);
    await processProjectSteward(project.id, false);
    const recoveredQuestions = await (async () => {
      const awaitedValue155097 = await jobsRepository.inbox(project.id);
      return awaitedValue155097.filter(
        (item) => item.jobId === interrupted.id && item.kind === "question"
      );
    })();
    assert.equal(
      recoveredQuestions.length,
      1,
      "restart between blocking and writing the question must recover it exactly once"
    );
    assert.equal(recoveredQuestions[0]?.payload.waitingFor, "investigation");
  });

  test("project and global pause stop tools before mutation without token-based limits", async () => {
    const { createJobPolicy } = await import("../../src/core/jobs/policy");
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    const { Type } = await import("typebox");
    const { z } = await import("zod");
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const scope of ["project", "global"]) {
      const project = await projectWithWork();
      const job = await createWork(project.id);
      const running = requireValue(await jobsRepository.claim(job.id));
      let mutations = 0;
      let aborted = false;
      const policy = createJobPolicy(running, () => {
        aborted = true;
      });
      const tool = requireValue(
        policy.tools([
          {
            name: "local_test_mutation",
            label: "Local test",
            description: "Count a local mutation",
            parameters: Type.Unsafe(z.object({}).toJSONSchema()),
            execute() {
              try {
                mutations += 1;
                return Promise.resolve({ content: [], details: undefined });
              } catch (error) {
                return Promise.reject(error);
              }
            },
          },
        ])[0]
      );
      policy.tokens(5_000_000);
      await policy.flush();
      await tool.execute("before-pause", {}, undefined, undefined, {} as never);
      assert.equal(
        mutations,
        1,
        "token accounting is audit, not a scheduling or tool limit"
      );
      try {
        await (scope === "global"
          ? settingsRepository.setAgentPaused(true)
          : stewardRepository.update(project.id, { paused: true }));
        await assert.rejects(
          () =>
            tool.execute("after-pause", {}, undefined, undefined, {} as never),
          /paused/iu
        );
        assert.equal(mutations, 1);
        assert.equal(aborted, true);
        const paused = requireValue(await jobsRepository.get(job.id));
        assert.equal(paused.status, "paused");
        assert.equal(paused.tokensUsed, 5_000_000);
        assert.equal(paused.actionsUsed, 1);
        assert.deepEqual(paused.limits, running.limits);
      } finally {
        await settingsRepository.setAgentPaused(false);
      }
    }
    /* oxlint-enable no-await-in-loop */
  });

  test("backend recovery counts recorded active time once and excludes downtime", async () => {
    const { retryStalledJob } = await import("../../src/core/jobs/retry");
    const project = await projectWithWork();
    const job = await createWork(project.id);
    await jobsRepository.recordUsage(job.id, 1500, 5000);
    const startedAt = new Date(Date.now() - 86_400_000).toISOString();
    await jobsRepository.update(job.id, {
      status: "running",
      startedAt,
      heartbeatAt: new Date(Date.parse(startedAt) + 30_000).toISOString(),
    });
    const stalled = await createWork(project.id);
    await jobsRepository.update(stalled.id, {
      status: "stalled",
      retryAt: "2000-01-01T00:00:00.000Z",
      startedAt,
      heartbeatAt: new Date(Date.parse(startedAt) + 20_000).toISOString(),
    });
    const paused = await createWork(project.id);
    await jobsRepository.update(paused.id, {
      status: "paused",
      startedAt,
      heartbeatAt: new Date(Date.parse(startedAt) + 10_000).toISOString(),
    });
    const missingHeartbeat = await createWork(project.id);
    await jobsRepository.update(missingHeartbeat.id, {
      status: "running",
      startedAt,
    });
    await jobsRepository.recover();
    const recovered = requireValue(await jobsRepository.get(job.id));
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.startedAt, null);
    assert.equal(recovered.heartbeatAt, null);
    assert.equal(recovered.elapsedMs, 35_000);
    assert.equal(recovered.tokensUsed, 1500);
    const interruptedStall = requireValue(await jobsRepository.get(stalled.id));
    assert.equal(interruptedStall.status, "stalled");
    assert.equal(interruptedStall.startedAt, null);
    assert.equal(interruptedStall.elapsedMs, 20_000);
    assert.equal(
      await (async () => {
        const awaitedResult171641 = await jobsRepository.get(paused.id);
        return awaitedResult171641?.status;
      })(),
      "paused"
    );
    assert.equal(
      await (async () => {
        const awaitedResult171716 = await jobsRepository.get(paused.id);
        return awaitedResult171716?.elapsedMs;
      })(),
      10_000
    );
    assert.equal(
      await (async () => {
        const awaitedResult171799 = await jobsRepository.get(
          missingHeartbeat.id
        );
        return awaitedResult171799?.elapsedMs;
      })(),
      0,
      "unknown active time must not include a day of backend downtime"
    );
    await retryStalledJob(interruptedStall);
    assert.equal(
      await (async () => {
        const awaitedResult172008 = await jobsRepository.get(stalled.id);
        return awaitedResult172008?.status;
      })(),
      "queued"
    );
    assert.equal(
      await (async () => {
        const awaitedResult172084 = await jobsRepository.get(stalled.id);
        return awaitedResult172084?.safetyRetries;
      })(),
      1
    );
    await jobsRepository.recover();
    assert.equal(
      await (async () => {
        const awaitedResult172203 = await jobsRepository.get(job.id);
        return awaitedResult172203?.elapsedMs;
      })(),
      recovered.elapsedMs
    );
    assert.equal(
      await (async () => {
        const awaitedValue160062 = await jobsRepository.actions(job.id);
        return awaitedValue160062.filter(
          (entry) => entry.action === "recovered"
        ).length;
      })(),
      1
    );
  });

  test("execution checkpoints cannot charge twice or update a later attempt", async () => {
    const project = await projectWithWork();
    const job = await createWork(project.id);
    const running = requireValue(await jobsRepository.claim(job.id));
    assert.equal(running.heartbeatAt, running.startedAt);
    await Promise.all([
      jobsRepository.recordUsage(job.id, 20),
      jobsRepository.recordUsage(job.id, 30),
    ]);
    await jobsRepository.heartbeat(job.id, requireValue(running.startedAt));
    assert.ok(
      Date.parse(
        requireValue(requireValue(await jobsRepository.get(job.id)).heartbeatAt)
      ) >= Date.parse(requireValue(running.startedAt))
    );
    await jobsRepository.finishExecution(
      job.id,
      requireValue(running.startedAt),
      1500
    );
    await jobsRepository.finishExecution(
      job.id,
      requireValue(running.startedAt),
      1500
    );
    await jobsRepository.heartbeat(job.id, requireValue(running.startedAt));
    const finished = requireValue(await jobsRepository.get(job.id));
    assert.equal(finished.elapsedMs, 1500);
    assert.equal(finished.tokensUsed, 50);
    assert.equal(finished.startedAt, null);
    assert.equal(finished.heartbeatAt, null);
    const nextStartedAt = new Date(
      Date.parse(requireValue(running.startedAt)) + 10_000
    ).toISOString();
    await jobsRepository.update(job.id, {
      startedAt: nextStartedAt,
      heartbeatAt: nextStartedAt,
    });
    await jobsRepository.finishExecution(
      job.id,
      requireValue(running.startedAt),
      1500
    );
    await jobsRepository.heartbeat(job.id, requireValue(running.startedAt));
    assert.equal(
      await (async () => {
        const awaitedResult174121 = await jobsRepository.get(job.id);
        return awaitedResult174121?.startedAt;
      })(),
      nextStartedAt
    );
    assert.equal(
      await (async () => {
        const awaitedResult174208 = await jobsRepository.get(job.id);
        return awaitedResult174208?.heartbeatAt;
      })(),
      nextStartedAt
    );
    assert.equal(
      await (async () => {
        const awaitedResult174301 = await jobsRepository.get(job.id);
        return awaitedResult174301?.elapsedMs;
      })(),
      1500
    );
  });

  test("infrastructure failures persist a delayed retry and scrub details without asking the human", async () => {
    const { retryInfrastructure } = await import("../../src/core/jobs/retry");
    const project = await projectWithWork();
    await createProfile(project.id, {
      name: "operator",
      fields: [{ key: "password", value: "infrastructure-secret-value" }],
    });
    const job = await createWork(project.id);
    const running = requireValue(await jobsRepository.claim(job.id));
    const beforeInTest = Date.now();
    await retryInfrastructure(
      running,
      "Browser unavailable: infrastructure-secret-value"
    );
    const queued = requireValue(await jobsRepository.get(job.id));
    assert.equal(queued.status, "queued");
    assert.equal(queued.infrastructureRetries, 1);
    assert.ok(
      Date.parse(requireValue(queued.retryAt)) >= beforeInTest + 15_000
    );
    assert.ok(!queued.systemError?.includes("infrastructure-secret-value"));
    assert.match(queued.pendingMessage ?? "", /not a question for the human/u);
    await jobsRepository.recover();
    await retryInfrastructure(running, "Duplicate callback");
    assert.equal(
      await (async () => {
        const awaitedResult175512 = await jobsRepository.get(job.id);
        return awaitedResult175512?.retryAt;
      })(),
      queued.retryAt
    );
    assert.equal(
      await (async () => {
        const awaitedResult175591 = await jobsRepository.get(job.id);
        return awaitedResult175591?.infrastructureRetries;
      })(),
      1
    );
    await retryInfrastructure(
      requireValue(await jobsRepository.claim(job.id)),
      "LLM provider temporarily unavailable"
    );
    const second = requireValue(await jobsRepository.get(job.id));
    assert.equal(second.infrastructureRetries, 2);
    assert.ok(
      Date.parse(requireValue(second.retryAt)) >= beforeInTest + 30_000
    );
    assert.deepEqual(await jobsRepository.inbox(project.id), []);
    const actions = await jobsRepository.actions(job.id);
    assert.equal(
      actions.filter((entry) => entry.action === "service_retry").length,
      2
    );
    assert.ok(!JSON.stringify(actions).includes("infrastructure-secret-value"));
  });

  test("report bug rejects a suggested fix once, leaves both files untouched and enforces project isolation", async () => {
    const { VALID_SPEC: VALID_SPECInTest, HUMAN_SPEC: HUMAN_SPECInTest } =
      await import("../helpers/storage");
    const { proposeMutation } = await import("../../src/core/jobs/proposals");
    const project = await projectWithWork();
    const other = await projectWithWork();
    await repoGit.ensureProjectRepo(project.id, { create: true });
    const feature = await writer.createFeatureInRepo(
      project.id,
      null,
      "Checkout",
      ""
    );
    const { spec } = await writer.createSpecInRepo({
      projectId: project.id,
      featureId: feature.id,
      title: "Checkout",
      description: "",
      humanSpec: HUMAN_SPECInTest,
      testSource: VALID_SPECInTest,
    });
    const job = await createWork(project.id);
    const item = await proposeMutation(job, "update_spec", {
      specId: spec.id,
      testSource: VALID_SPECInTest.replace(
        'page.goto("/")',
        'page.goto("/checkout")'
      ),
    });
    const directory = path.join(repoGit.getRepoDir(project.id), spec.path);
    const yaml = await fs.readFile(path.join(directory, "spec.yml"), "utf-8");
    const head = await repoGit.getHeadSha(project.id);
    const endpoint = `/projects/${project.id}/inbox/${item.id}/review`;
    assert.equal(
      await (async () => {
        const awaitedValue165083 = await post(
          `/projects/${other.id}/inbox/${item.id}/review`,
          {
            action: "report_bug",
          }
        );
        return awaitedValue165083.status;
      })(),
      404
    );
    assert.equal(
      await (async () => {
        const awaitedResult177883 = await jobsRepository.item(item.id);
        return awaitedResult177883?.status;
      })(),
      "pending"
    );
    const responses = await Promise.all([
      post(endpoint, { action: "report_bug" }),
      post(endpoint, { action: "report_bug" }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).toSorted(),
      [200, 409]
    );
    assert.equal(
      await (async () => {
        const awaitedResult178209 = await jobsRepository.item(item.id);
        return awaitedResult178209?.status;
      })(),
      "rejected"
    );
    assert.equal(
      await (async () => {
        const awaitedValue165650 = await post(endpoint, { action: "approve" });
        return awaitedValue165650.status;
      })(),
      409
    );
    const reports = await (async () => {
      const awaitedValue165730 = await jobsRepository.inbox(project.id);
      return awaitedValue165730.filter((row) => row.kind === "bug_report");
    })();
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.payload.sourceItemId, item.id);
    assert.equal(reports[0]?.payload.specId, spec.id);
    assert.deepEqual(await jobsRepository.inbox(other.id), []);
    assert.equal(
      await fs.readFile(path.join(directory, "spec.ts"), "utf-8"),
      VALID_SPECInTest
    );
    assert.equal(
      await fs.readFile(path.join(directory, "spec.yml"), "utf-8"),
      yaml
    );
    assert.equal(await repoGit.getHeadSha(project.id), head);
  });

  test("ignore stops requested work and automatic repairs of the same Spec version", async () => {
    const { VALID_SPEC: VALID_SPECInTest, HUMAN_SPEC: HUMAN_SPECInTest } =
      await import("../helpers/storage");
    const project = await projectWithWork();
    await repoGit.ensureProjectRepo(project.id, { create: true });
    const feature = await writer.createFeatureInRepo(
      project.id,
      null,
      "Checkout",
      ""
    );
    const { spec } = await writer.createSpecInRepo({
      projectId: project.id,
      featureId: feature.id,
      title: "Checkout",
      description: "",
      humanSpec: HUMAN_SPECInTest,
      testSource: VALID_SPECInTest,
    });
    const input = {
      kind: "regenerate",
      specIds: [spec.id],
      goal: "Repair checkout implementation",
      reason: "Checkout implementation is invalid",
    };
    const intent = await enqueueIntent(
      project.id,
      input,
      "first-check",
      "user"
    );
    await processProjectSteward(project.id, false);
    const job = requireValue(
      await (async () => {
        const awaitedValue167313 = await jobsRepository.list(project.id);
        return awaitedValue167313[0];
      })()
    );
    assert.equal(job.id, intent.id);
    await jobsRepository.update(job.id, { status: "stalled" });
    const item = await jobsRepository.addItem({
      jobId: job.id,
      projectId: project.id,
      kind: "question",
      title: "Continue checking checkout?",
      body: "The update still does not work.",
    });
    assert.equal(
      await (async () => {
        const awaitedValue167704 = await post(
          `/projects/${project.id}/inbox/${item.id}/review`,
          {
            action: "ignore",
          }
        );
        return awaitedValue167704.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedResult180853 = await jobsRepository.get(job.id);
        return awaitedResult180853?.status;
      })(),
      "cancelled"
    );
    assert.equal(
      await (async () => {
        const awaitedResult180935 = await jobsRepository.item(item.id);
        return awaitedResult180935?.payload.ignoredCheck;
      })(),
      true
    );
    assert.equal(
      await (async () => {
        const awaitedValue168051 = await post(
          `/projects/${project.id}/continue-now`
        );
        return awaitedValue168051.status;
      })(),
      404
    );
    const next = await enqueueIntent(project.id, input, "later-check");
    await processProjectSteward(project.id, false);
    const ignored = requireValue(
      await (async () => {
        const awaitedValue168273 = await stewardRepository.intents(project.id);
        return awaitedValue168273.find((row) => row.id === next.id);
      })()
    );
    assert.equal(ignored.status, "ignored");
    assert.match(ignored.reason, /human rejected/iu);
    assert.equal(
      await (async () => {
        const awaitedValue168483 = await jobsRepository.list(project.id);
        return awaitedValue168483.length;
      })(),
      1
    );
  });

  test("scope migration retires unsolicited work while retaining human requests and findings", async () => {
    const { createClient } = await import("@libsql/client");
    const { tempDir } = await import("../helpers/storage");
    const client = createClient({
      url: `file:${path.join(tempDir(), "event-scope-migration.db")}`,
    });
    try {
      await client.executeMultiple(`
                CREATE TABLE project_stewards (project_id TEXT PRIMARY KEY, last_planner_at TEXT);
                CREATE TABLE steward_intents (id TEXT PRIMARY KEY, key TEXT NOT NULL, intent TEXT NOT NULL, job_id TEXT, status TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, retry_at TEXT, stop_reason TEXT, updated_at TEXT NOT NULL, tokens_used INTEGER NOT NULL);
                CREATE TABLE job_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE inbox_items (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
                INSERT INTO project_stewards VALUES ('project', '2026-10-01T00:00:00.000Z');
            `);
      const rows = [
        ["planner", "planner", "steward", "queued", "planner:date"],
        ["coverage", "coverage", "steward", "blocked", "signal:empty"],
        ["explore", "explore", "steward", "running", "run-blocker:previous"],
        ["manual", "explore", "manual", "queued", null],
        ["chat", "explore", "steward", "blocked", "chat:session:tool"],
        [
          "interrupted-chat",
          "explore",
          "steward",
          "queued",
          "chat:session:interrupted-tool",
        ],
        ["regression", "coverage", "steward", "queued", "regression:item"],
        ["manual-intent", "coverage", "manual", "paused", "signal:human"],
        [
          "triage",
          "failure_triage",
          "spec_failure",
          "queued",
          "signal:failure",
        ],
        ["past-planner", "planner", "steward", "completed", "planner:past"],
      ];
      /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
      for (const [id, kind, trigger, status, key] of rows) {
        await client.execute({
          sql: "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
          args: [
            requireValue(id),
            requireValue(kind),
            requireValue(trigger),
            requireValue(status),
            "2026-10-06T00:00:00.000Z",
            "2026-10-01T00:00:00.000Z",
            12_345,
          ],
        });
        if (key) {
          await client.execute({
            sql: "INSERT INTO steward_intents VALUES (?, ?, ?, ?, ?, ?, ?)",
            args: [
              requireValue(id),
              key,
              JSON.stringify({
                kind: kind === "failure_triage" ? "triage" : kind,
              }),
              requireValue(id),
              status === "completed" ? "completed" : "running",
              "Original request",
              "2026-10-01T00:00:00.000Z",
            ],
          });
        }
        await client.execute({
          sql: "INSERT INTO inbox_items VALUES (?, ?, 'question', 'pending', ?, ?)",
          args: [
            `question-${id}`,
            requireValue(id),
            JSON.stringify({ evidence: "preserved" }),
            "2026-10-01T00:00:00.000Z",
          ],
        });
      }
      /* oxlint-enable no-await-in-loop */
      await client.execute(
        "UPDATE steward_intents SET job_id = NULL WHERE id = 'interrupted-chat'"
      );
      await client.execute(
        "INSERT INTO steward_intents VALUES ('resume', 'resume-run:chat:answer', '{\"kind\":\"run_specs\"}', NULL, 'pending', 'Continue requested run', '2026-10-01T00:00:00.000Z')"
      );
      await client.execute(
        "INSERT INTO job_actions (job_id, action, detail, created_at) VALUES ('coverage', 'inspected', 'Evidence from checkout', '2026-10-01T00:00:00.000Z')"
      );
      await client.execute(
        "INSERT INTO inbox_items VALUES ('bug', 'coverage', 'bug_report', 'pending', '{\"steps\":[\"Open checkout\"]}', '2026-10-01T00:00:00.000Z')"
      );
      await client.execute(
        "INSERT INTO inbox_items VALUES ('proposal', 'coverage', 'new_spec', 'pending', '{\"testSource\":\"preserved\"}', '2026-10-01T00:00:00.000Z')"
      );
      const migration = await fs.readFile(
        new URL("../../drizzle/0017_rapid_sunspot.sql", import.meta.url),
        "utf-8"
      );
      /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
      for (const statement of migration.split("--> statement-breakpoint")) {
        await client.execute(statement.trim());
      }
      /* oxlint-enable no-await-in-loop */
      const jobs = await (async () => {
        const awaitedValue173191 = await client.execute("SELECT * FROM jobs");
        return awaitedValue173191.rows;
      })();
      /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
      for (const id of ["planner", "coverage", "explore"]) {
        assert.equal(
          jobs.find((row) => row.id === id)?.status,
          "cancelled",
          id
        );
        const question = requireValue(
          await (async () => {
            const awaitedValue173450 = await client.execute({
              sql: "SELECT * FROM inbox_items WHERE id = ?",
              args: [`question-${id}`],
            });
            return awaitedValue173450.rows[0];
          })()
        );
        assert.equal(question.status, "dismissed");
        assert.deepEqual(JSON.parse(String(question.payload)), {
          evidence: "preserved",
          retiredByScope: true,
        });
        assert.equal(
          await (async () => {
            const awaitedResult187365 = await (async () => {
              const awaitedValue173841 = await client.execute({
                sql: "SELECT status FROM steward_intents WHERE id = ?",
                args: [id],
              });
              return awaitedValue173841.rows[0];
            })();
            return awaitedResult187365?.status;
          })(),
          "ignored"
        );
      }
      /* oxlint-enable no-await-in-loop */
      /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
      for (const id of [
        "manual",
        "chat",
        "interrupted-chat",
        "regression",
        "manual-intent",
        "triage",
      ]) {
        assert.notEqual(
          jobs.find((row) => row.id === id)?.status,
          "cancelled",
          id
        );
        assert.equal(
          await (async () => {
            const awaitedResult187986 = await (async () => {
              const awaitedValue174377 = await client.execute({
                sql: "SELECT status FROM inbox_items WHERE id = ?",
                args: [`question-${id}`],
              });
              return awaitedValue174377.rows[0];
            })();
            return awaitedResult187986?.status;
          })(),
          "pending"
        );
      }
      /* oxlint-enable no-await-in-loop */
      /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
      for (const id of [
        "chat",
        "interrupted-chat",
        "regression",
        "manual-intent",
        "resume",
      ]) {
        assert.equal(
          await (async () => {
            const awaitedResult188474 = await (async () => {
              const awaitedValue174780 = await client.execute({
                sql: "SELECT source FROM steward_intents WHERE id = ?",
                args: [id],
              });
              return awaitedValue174780.rows[0];
            })();
            return awaitedResult188474?.source;
          })(),
          "user",
          id
        );
      }
      /* oxlint-enable no-await-in-loop */
      assert.equal(
        jobs.find((row) => row.id === "past-planner")?.status,
        "completed"
      );
      assert.ok(jobs.every((row) => row.tokens_used === 12_345));
      assert.equal(
        await (async () => {
          const awaitedResult188992 = await (async () => {
            const awaitedValue175213 = await client.execute(
              "SELECT detail FROM job_actions WHERE action = 'inspected'"
            );
            return awaitedValue175213.rows[0];
          })();
          return awaitedResult188992?.detail;
        })(),
        "Evidence from checkout"
      );
      assert.equal(
        await (async () => {
          const awaitedResult189292 = await (async () => {
            const awaitedValue175428 = await client.execute(
              "SELECT count(*) AS count FROM job_actions WHERE action = 'retired'"
            );
            return awaitedValue175428.rows[0];
          })();
          return awaitedResult189292?.count;
        })(),
        3
      );
      assert.equal(
        await (async () => {
          const awaitedResult189577 = await (async () => {
            const awaitedValue175628 = await client.execute(
              "SELECT status FROM inbox_items WHERE id = 'bug'"
            );
            return awaitedValue175628.rows[0];
          })();
          return awaitedResult189577?.status;
        })(),
        "pending"
      );
      assert.equal(
        await (async () => {
          const awaitedResult189852 = await (async () => {
            const awaitedValue175818 = await client.execute(
              "SELECT payload FROM inbox_items WHERE id = 'proposal'"
            );
            return awaitedValue175818.rows[0];
          })();
          return awaitedResult189852?.payload;
        })(),
        '{"testSource":"preserved"}'
      );
      assert.equal(
        await (async () => {
          const awaitedValue176034 = await client.execute(
            "PRAGMA table_info(project_stewards)"
          );
          return awaitedValue176034.rows.some(
            (row) => row.name === "last_planner_at"
          );
        })(),
        false
      );
    } finally {
      client.close();
    }
  });

  test("an unchanged empty project stays idle without a planner or unsolicited exploration", async () => {
    const project = await projectWithWork();
    await processProjectSteward(project.id);
    await processProjectSteward(project.id);
    assert.deepEqual(await stewardRepository.signals(project.id), []);
    assert.deepEqual(await stewardRepository.intents(project.id), []);
    assert.deepEqual(await jobsRepository.list(project.id), []);
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const kind of [
      "empty_project",
      "context_changed",
      "app_unavailable",
    ]) {
      await stewardRepository.signal({
        projectId: project.id,
        key: `old:${kind}`,
        kind,
        title: "Old automatic observation",
        body: "Previously queued automatic work",
      });
    }
    /* oxlint-enable no-await-in-loop */
    await processProjectSteward(project.id, false);
    assert.deepEqual(await stewardRepository.intents(project.id), []);
    assert.deepEqual(await jobsRepository.list(project.id), []);
    assert.ok(
      await (async () => {
        const awaitedValue177229 = await stewardRepository.signals(project.id);
        return awaitedValue177229.every(
          (signal) => signal.status === "handled"
        );
      })()
    );
  });

  test("explicit tasks run under observe and concurrent duplicate requests share the same work", async () => {
    const project = await projectWithWork();
    await stewardRepository.update(project.id, { autonomy: "observe" });
    const endpoint = `/projects/${project.id}/tasks`;
    const requests = await Promise.all([
      post(endpoint, { kind: "coverage" }),
      post(endpoint, { kind: "coverage" }),
    ]);
    assert.deepEqual(
      requests.map((response) => response.status),
      [202, 202]
    );
    const [first, duplicate] = await Promise.all(
      requests.map((response) => response.json())
    );
    assert.deepEqual(first, duplicate);
    assert.equal(first.status, "queued");
    const intent = requireValue(
      await (async () => {
        const awaitedValue178077 = await stewardRepository.intents(project.id);
        return awaitedValue178077[0];
      })()
    );
    assert.equal(intent.id, first.intentId);
    assert.equal(intent.source, "user");
    assert.equal(
      await (async () => {
        const awaitedResult192616 = await jobsRepository.get(intent.id);
        return awaitedResult192616?.kind;
      })(),
      "coverage"
    );
    assert.equal(
      await (async () => {
        const awaitedValue178306 = await jobsRepository.list(project.id);
        return awaitedValue178306.length;
      })(),
      1
    );
    await jobsRepository.update(intent.id, { status: "completed" });
    await processProjectSteward(project.id, false);
    const next = await post(endpoint, { kind: "coverage" });
    assert.equal(next.status, 202);
    const repeated = await next.json();
    assert.notEqual(
      repeated.intentId,
      first.intentId,
      "an explicit request must bypass the automatic cooldown"
    );
    assert.equal(
      await (async () => {
        const awaitedResult193248 = await jobsRepository.get(repeated.intentId);
        return awaitedResult193248?.status;
      })(),
      "queued"
    );
    await jobsRepository.update(repeated.intentId, { status: "completed" });
    const explore = await post(endpoint, {
      kind: "explore",
      goal: "Explore checkout with a guest account",
    });
    const exploration = await explore.json();
    assert.equal(
      await (async () => {
        const awaitedResult193599 = await jobsRepository.get(
          exploration.intentId
        );
        return awaitedResult193599?.kind;
      })(),
      "explore"
    );
    assert.match(
      (await (async () => {
        const awaitedResult193702 = await jobsRepository.get(
          exploration.intentId
        );
        return awaitedResult193702?.goal;
      })()) ?? "",
      /guest account/u
    );
    assert.equal(
      await (async () => {
        const awaitedValue179341 = await stewardRepository.get(project.id);
        return awaitedValue179341.autonomy;
      })(),
      "observe"
    );
  });

  test("requested tasks persist through local and global pause without required setup", async () => {
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    const project = await projectWithWork();
    await stewardRepository.update(project.id, {
      autonomy: "observe",
      paused: true,
    });
    const response = await post(`/projects/${project.id}/tasks`, {
      kind: "explore",
    });
    const pending = await response.json();
    assert.equal(response.status, 202);
    assert.equal(pending.status, "paused");
    assert.deepEqual(await jobsRepository.list(project.id), []);
    assert.equal(
      await (async () => {
        const awaitedResult194628 = await (async () => {
          const awaitedValue180073 = await stewardRepository.intents(
            project.id
          );
          return awaitedValue180073[0];
        })();
        return awaitedResult194628?.source;
      })(),
      "user"
    );
    await jobsRepository.recover();
    try {
      await put("/settings/agent", { paused: true });
      await put(`/projects/${project.id}/steward`, { paused: false });
      assert.deepEqual(await jobsRepository.list(project.id), []);
      assert.equal(
        await (async () => {
          const awaitedResult195057 = await (async () => {
            const awaitedValue180417 = await stewardRepository.intents(
              project.id
            );
            return awaitedValue180417[0];
          })();
          return awaitedResult195057?.status;
        })(),
        "pending"
      );
      await put("/settings/agent", { paused: false });
      assert.equal(
        await (async () => {
          const awaitedResult195310 = await jobsRepository.get(
            pending.intentId
          );
          return awaitedResult195310?.status;
        })(),
        "queued"
      );
      assert.equal(
        await (async () => {
          const awaitedValue180684 = await jobsRepository.list(project.id);
          return awaitedValue180684.length;
        })(),
        1
      );
    } finally {
      await settingsRepository.setAgentPaused(false);
    }
  });

  test("task requests reject internal kinds and enforce project boundaries", async () => {
    const project = await projectWithWork();
    const endpoint = `/projects/${project.id}/tasks`;
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const body of [
      {},
      { kind: "planner" },
      { kind: "triage" },
      { kind: "explore", source: "user" },
      { kind: "explore", goal: " " },
      { kind: "coverage", specIds: [] },
    ]) {
      assert.equal(
        await (async () => {
          const awaitedValue181247 = await post(endpoint, body);
          return awaitedValue181247.status;
        })(),
        400
      );
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(
      await (async () => {
        const awaitedValue181320 = await post("/projects/missing/tasks", {
          kind: "explore",
        });
        return awaitedValue181320.status;
      })(),
      404
    );
    assert.deepEqual(await stewardRepository.intents(project.id), []);
    assert.deepEqual(await jobsRepository.list(project.id), []);
    assert.equal(
      await (async () => {
        const awaitedValue181566 = await router.request(
          `/projects/${project.id}/activity`
        );
        return awaitedValue181566.status;
      })(),
      404
    );
    assert.equal(
      await (async () => {
        const awaitedValue181674 = await router.request(
          `/projects/${project.id}/inbox`
        );
        return awaitedValue181674.status;
      })(),
      404
    );
  });

  test("chat requests are durable user intents but autonomous jobs cannot spawn more work", async () => {
    const { createBackgroundTaskTool } =
      await import("../../src/core/steward/tools");
    const { createJobPolicy } = await import("../../src/core/jobs/policy");
    const project = await projectWithWork();
    await stewardRepository.update(project.id, { autonomy: "observe" });
    const tool = createBackgroundTaskTool(project.id, "chat:human-session");
    const input = {
      kind: "explore" as const,
      goal: "Explore guest checkout",
      reason: "The user asked to investigate guest checkout",
    };
    await tool.execute("requested", input, undefined, undefined, {} as never);
    await tool.execute("requested", input, undefined, undefined, {} as never);
    const intents = await stewardRepository.intents(project.id);
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.source, "user");
    await processProjectSteward(project.id, false);
    const job = requireValue(
      await jobsRepository.get(requireValue(intents[0]).id)
    );
    const policy = createJobPolicy(job, () => {});
    assert.equal(
      policy
        .tools([tool])
        .some((candidate) => candidate.name === "start_background_task"),
      false
    );
    assert.equal(
      policy
        .tools([tool])
        .some((candidate) => candidate.name === "propose_intents"),
      false
    );
    assert.equal(
      await (async () => {
        const awaitedValue183166 = await jobsRepository.list(project.id);
        return awaitedValue183166.length;
      })(),
      1
    );
  });

  test(
    "missing run credentials ask once and the answer resumes the same selection without an agent turn",
    { skip: available ? false : "Chromium is not installed", timeout: 120_000 },
    async () => {
      const { VALID_SPEC: VALID_SPECInTest, HUMAN_SPEC: HUMAN_SPECInTest } =
        await import("../helpers/storage");
      const { getRunBatch } = await import("../../src/core/runner/batch");
      const { runsRepository } =
        await import("../../src/infra/repositories/runs");
      const project = await projectsRepository.createProject(
        "Requested preview check",
        "http://127.0.0.1:1"
      );
      await environmentsRepository.update(
        requireValue(
          await (async () => {
            const awaitedValue183866 = await environmentsRepository.list(
              project.id
            );
            return awaitedValue183866[0];
          })()
        ),
        {
          ...requireValue(
            await (async () => {
              const awaitedValue183942 = await environmentsRepository.list(
                project.id
              );
              return awaitedValue183942[0];
            })()
          ),
          allowedOrigins: [new URL(baseUrl).origin],
        }
      );
      await stewardRepository.update(project.id, { autonomy: "observe" });
      await repoGit.ensureProjectRepo(project.id, { create: true });
      const feature = await writer.createFeatureInRepo(
        project.id,
        null,
        "Sign in",
        ""
      );
      const source = VALID_SPECInTest.replace(
        "({ page, step })",
        "({ page, step, secret })"
      ).replace(
        'await page.goto("/");',
        'await page.goto("/");\n        await page.getByLabel("Password").fill(secret("shopper", "password"));'
      );
      const { spec } = await writer.createSpecInRepo({
        projectId: project.id,
        featureId: feature.id,
        title: "Sign in",
        description: "",
        humanSpec: HUMAN_SPECInTest,
        testSource: source,
      });
      const { spec: unselected } = await writer.createSpecInRepo({
        projectId: project.id,
        featureId: feature.id,
        title: "Unselected check",
        description: "",
        humanSpec: HUMAN_SPECInTest,
        testSource: VALID_SPECInTest,
      });
      const head = await repoGit.getHeadSha(project.id);
      const intent = await enqueueIntent(
        project.id,
        {
          kind: "run_specs",
          goal: "Check sign-in on the preview",
          reason: "The user requested this preview check",
          specIds: [spec.id],
          baseUrl,
        },
        "chat:preview:run",
        "user"
      );
      await processProjectSteward(project.id, false);
      const blocked = requireValue(await jobsRepository.get(intent.id));
      assert.equal(blocked.kind, "review");
      assert.equal(blocked.status, "blocked");
      assert.ok(blocked.stopReason);
      assert.equal(blocked.tokensUsed, 0);
      assert.equal(blocked.actionsUsed, 0);
      await Promise.all([
        processProjectSteward(project.id, false),
        processProjectSteward(project.id, false),
      ]);
      const questions = await jobsRepository.inbox(project.id);
      assert.equal(questions.length, 1);
      assert.equal(questions[0]?.payload.runIntentId, intent.id);
      assert.equal(questions[0]?.payload.waitingFor, "credentials");
      assert.deepEqual(
        await (async () => {
          const awaitedValue186230 = await jobsRepository.list(project.id);
          return awaitedValue186230.map((job) => job.kind);
        })(),
        ["review"]
      );
      await createProfile(project.id, {
        name: "shopper",
        allowedOrigins: [new URL(baseUrl).origin],
        fields: [{ key: "password", value: "local-test-secret" }],
      });
      const answer = await post(
        `/projects/${project.id}/inbox/${requireValue(questions[0]).id}/review`,
        { action: "answer", answer: "The shopper profile is available now." }
      );
      assert.equal(answer.status, 200);
      assert.equal(
        await (async () => {
          const awaitedResult202322 = await jobsRepository.get(intent.id);
          return awaitedResult202322?.status;
        })(),
        "completed"
      );
      await Promise.all([
        processProjectSteward(project.id, false),
        processProjectSteward(project.id, false),
      ]);
      const resumed = await (async () => {
        const awaitedValue186981 = await stewardRepository.intents(project.id);
        return awaitedValue186981.filter((row) =>
          row.key.startsWith(`resume-run:${intent.id}:`)
        );
      })();
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0]?.source, "user");
      assert.deepEqual(resumed[0]?.intent.specIds, [spec.id]);
      assert.equal(resumed[0]?.intent.baseUrl, baseUrl);
      let batch = await getRunBatch(
        requireValue(requireValue(resumed[0]).batchId)
      );
      const deadline = Date.now() + 60_000;
      /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
      while (batch?.status === "running" && Date.now() < deadline) {
        // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        batch = await getRunBatch(
          requireValue(requireValue(resumed[0]).batchId)
        );
      }
      /* oxlint-enable no-await-in-loop */
      assert.equal(batch?.status, "passed", batch?.failReason ?? "");
      assert.deepEqual(
        batch?.specs.map((entry) => entry.specId),
        [spec.id]
      );
      assert.equal(batch?.baseUrl, baseUrl);
      assert.deepEqual(await runsRepository.listRuns(unselected.id), []);
      assert.equal(
        await (async () => {
          const awaitedValue187928 = await jobsRepository.list(project.id);
          return awaitedValue187928.length;
        })(),
        1
      );
      assert.equal(
        await (async () => {
          const awaitedResult203786 = await jobsRepository.get(intent.id);
          return awaitedResult203786?.tokensUsed;
        })(),
        0
      );
      assert.equal(await repoGit.getHeadSha(project.id), head);
    }
  );

  test("discuss opens a visible human chat with suggestion context and reuses it", async () => {
    const { createChat, getChatMessages, listChats } =
      await import("../../src/core/chat/session-store");
    const { isChatBusy } = await import("../../src/core/chat/chat-registry");
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    await settingsRepository.updateLlmSettings({ provider: "", model: "" });
    const project = await projectWithWork();
    const other = await projectWithWork();
    const internal = await createChat(project.id);
    const job = await jobsRepository.create({
      projectId: project.id,
      chatId: internal.id,
      trigger: "steward",
      kind: "explore",
      goal: "Investigate checkout",
      limits: jobLimitsSchema.parse({}),
    });
    const item = await jobsRepository.addItem({
      jobId: job.id,
      projectId: project.id,
      kind: "question",
      title: "Should checkout allow guests?",
      body: "Guest checkout is unavailable.",
    });
    assert.deepEqual(await listChats(project.id), []);
    assert.equal(
      await (async () => {
        const awaitedValue189266 = await post(
          `/projects/${other.id}/inbox/${item.id}/discuss`
        );
        return awaitedValue189266.status;
      })(),
      404
    );
    const endpoint = `/projects/${project.id}/inbox/${item.id}/discuss`;
    const response = await post(endpoint);
    assert.equal(response.status, 200);
    const { chatId } = await response.json();
    assert.notEqual(chatId, internal.id);
    const repeated = await post(endpoint);
    assert.equal(
      await (async () => {
        const awaitedValue189658 = await repeated.json();
        return awaitedValue189658.chatId;
      })(),
      chatId
    );
    const deadline = Date.now() + 5000;
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    while (isChatBusy(chatId) && Date.now() < deadline) {
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(isChatBusy(chatId), false);
    assert.deepEqual(
      await (async () => {
        const awaitedValue189939 = await listChats(project.id);
        return awaitedValue189939.map((chat) => chat.id);
      })(),
      [chatId]
    );
    assert.deepEqual(await listChats(other.id), []);
    const messages = await getChatMessages(chatId);
    const context = messages?.filter((message) => message.role === "user");
    assert.equal(context?.length, 1);
    assert.match(
      requireValue(requireValue(context)[0]).content,
      /Should checkout allow guests/u
    );
    assert.match(
      requireValue(requireValue(context)[0]).content,
      /Guest checkout is unavailable/u
    );
    assert.match(
      requireValue(requireValue(context)[0]).content,
      /Do not change files unless I ask/u
    );
    assert.equal(
      await (async () => {
        const awaitedResult206600 = await jobsRepository.item(item.id);
        return awaitedResult206600?.status;
      })(),
      "pending"
    );
    assert.equal(
      await (async () => {
        const awaitedValue190550 = await jobsRepository.list(project.id);
        return awaitedValue190550.length;
      })(),
      1
    );
  });
});

describe(
  "run repository recovery",
  { skip: available ? false : "Chromium is not installed" },
  () => {
    test("refreshes an outdated index without weakening retry content guards or saving unreviewed edits", async () => {
      const { specsRepository } =
        await import("../../src/infra/repositories/specs");
      const { StaleRunError } = await import("../../src/core/runner/run");
      const project = await projectsRepository.createProject(
        "Reindex on run",
        baseUrl
      );
      await repoGit.ensureProjectRepo(project.id, { create: true });
      const feature = await writer.createFeatureInRepo(
        project.id,
        null,
        "Home",
        ""
      );
      const testSource =
        'import { test, expect } from "specbook"; test("Home", async ({ page, step }) => { await step("Open", async () => { await page.goto("/"); await expect(page.getByRole("heading", { name: "Store" })).toBeVisible(); }); });';
      const { spec } = await writer.createSpecInRepo({
        projectId: project.id,
        featureId: feature.id,
        title: "Home",
        description: "",
        humanSpec: {
          preconditions: [],
          steps: ["Open"],
          expectedResult: "",
          postconditions: [],
        },
        testSource,
      });
      const sourceFile = path.join(
        repoGit.getRepoDir(project.id),
        spec.path,
        "spec.ts"
      );
      const changed = testSource.replace(
        'page.goto("/")',
        'page.goto("/changed")'
      );
      await fs.writeFile(sourceFile, changed);
      const head = await repoGit.getHeadSha(project.id);
      await assert.rejects(() => executeSpec(spec.id), /pending file edits/u);
      assert.equal(await repoGit.getHeadSha(project.id), head);
      await repoGit.withRepoLock(project.id, () =>
        repoGit.commitAll(project.id, "External edit")
      );
      assert.equal(
        await (async () => {
          const awaitedResult208749 = await specsRepository.getSpec(spec.id);
          return awaitedResult208749?.sourceHash;
        })(),
        spec.sourceHash,
        "the index is still the old version"
      );
      await assert.rejects(
        () =>
          executeSpec(spec.id, {
            expected: {
              sourceHash: spec.sourceHash,
              markdownHash: spec.markdownHash,
            },
          }),
        StaleRunError
      );
      const run = await executeSpec(spec.id);
      assert.equal(run.status, "passed", run.failReason ?? "");
      assert.equal(run.sourceHash, writer.sourceHashOf(changed));
      assert.equal(
        await (async () => {
          const awaitedResult209335 = await specsRepository.getSpec(spec.id);
          return awaitedResult209335?.sourceHash;
        })(),
        run.sourceHash
      );
    });
  }
);
