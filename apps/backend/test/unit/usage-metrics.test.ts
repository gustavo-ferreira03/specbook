import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import type { ChatTurnMetrics } from "../../src/core/chat/metrics";
import type { ModelCallRecord } from "../../src/core/llm/call-log";
import { useTempStorage } from "../helpers/storage";

const storage = useTempStorage();
const { describeModel, modelCallsPath, reportedUsage, summarizePayload } =
  await import("../../src/core/llm/call-log");
const { TurnMetricsRecorder, chatTurnMetricsPath } =
  await import("../../src/core/chat/metrics");

const readLines = async function readLines<T>(file: string): Promise<T[]> {
  const text = await fs.readFile(file, "utf-8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
};

const runDirectory = async function runDirectory(
  name: string
): Promise<string> {
  const directory = path.join(storage, "runs", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "spec.yml"),
    "title: Example\ndescription: Example.\npreconditions: []\nsteps:\n  - Open the page\nexpectedResult: The page is shown.\npostconditions: []\n"
  );
  await fs.writeFile(path.join(directory, "spec.ts"), "// test source\n");
  return directory;
};

const reviewCalls = async function reviewCalls(
  runId: string
): Promise<ModelCallRecord[]> {
  const calls = await readLines<ModelCallRecord>(modelCallsPath);
  return calls.filter(
    (line) => line.purpose === "evidence_review" && line.context.runId === runId
  );
};

describe("usage reporting", () => {
  test("keeps a field the provider did not report apart from zero", () => {
    assert.equal(reportedUsage(undefined), null);
    assert.deepEqual(reportedUsage({ input: 0, output: 12, totalTokens: 12 }), {
      input: 0,
      output: 12,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      totalTokens: 12,
      cost: null,
    });
    assert.deepEqual(
      reportedUsage({
        input: 5,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.3,
        },
      })?.cost,
      {
        input: 0.1,
        output: 0.2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.3,
      }
    );
  });

  test("summarizes a provider request without its conversation, prompts or tool schemas", () => {
    const summary = summarizePayload({
      model: "example-model",
      max_tokens: 400,
      temperature: 0.2,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 1024 },
      system: "secret system prompt",
      metadata: { user_id: "someone" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "private" },
            { type: "image", source: { data: "aaaa" } },
          ],
        },
      ],
      tools: [
        { name: "browser_click", input_schema: {} },
        { name: "run_spec", input_schema: {} },
      ],
    });
    assert.ok(summary);
    assert.deepEqual(summary.parameters, {
      model: "example-model",
      max_tokens: 400,
      temperature: 0.2,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    assert.equal(summary.messageCount, 1);
    assert.equal(summary.toolCount, 2);
    assert.equal(summary.imageCount, 1);
    assert.ok(summary.keys.includes("system"));
    assert.doesNotMatch(
      JSON.stringify(summary),
      /private|secret system prompt|someone|aaaa/u
    );
    assert.equal(summarizePayload("not an object"), null);
  });

  test("describes the model with its catalog rates", () => {
    assert.deepEqual(
      describeModel({
        provider: "p",
        id: "m",
        api: "a",
        baseUrl: "https://example.com",
        reasoning: true,
        contextWindow: 1000,
        maxTokens: 100,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }),
      {
        provider: "p",
        id: "m",
        api: "a",
        baseUrl: "https://example.com",
        reasoning: true,
        contextWindow: 1000,
        maxTokens: 100,
        costRates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }
    );
    assert.equal(describeModel(null), null);
  });

  test("a chat turn records which assistant messages carried usage", async () => {
    const recorder = new TurnMetricsRecorder("chat-usage", "message");
    recorder.setModel(
      {
        provider: "p",
        id: "m",
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
      { thinkingLevel: "medium", sendScreenshotsToModel: true }
    );
    recorder.providerRequest({
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    recorder.providerRequest({ model: "m", max_tokens: 99, messages: [] });
    recorder.assistantMessage({
      provider: "p",
      model: "m",
      stopReason: "toolUse",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.03,
        },
      },
    });
    recorder.assistantMessage({
      provider: "p",
      model: "m",
      stopReason: "error",
    });
    recorder.assistantMessage({
      provider: "p",
      model: "m",
      stopReason: "stop",
      usage: { input: 3, output: 1 },
    });
    await recorder.finish();
    const records = await readLines<ChatTurnMetrics>(chatTurnMetricsPath);
    const record = records.find((line) => line.chatId === "chat-usage");
    assert.ok(record);
    assert.deepEqual(record.tokens, {
      input: 13,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 15,
    });
    assert.deepEqual(record.usageReported, {
      assistantMessages: 3,
      withUsage: 2,
      withoutUsage: 1,
      fields: {
        input: 2,
        output: 2,
        cacheRead: 1,
        cacheWrite: 1,
        reasoning: 0,
        totalTokens: 1,
        costTotal: 1,
      },
    });
    assert.equal(record.modelCalls.length, 3);
    assert.equal(record.modelCalls[1].usage, null);
    assert.equal(record.modelCalls[2].usage?.totalTokens, null);
    assert.equal(record.modelInfo?.id, "m");
    assert.equal(record.thinkingLevel, "medium");
    assert.equal(record.sendScreenshotsToModel, true);
    assert.equal(record.providerRequests, 2);
    assert.equal(record.firstProviderRequest?.parameters.max_tokens, 10);
  });
});

describe("evidence review usage", () => {
  test("records skipped, completed, cached, unusable and failed reviews without inventing usage", async (t) => {
    const { runMigrations } = await import("../../src/infra/db/migrate");
    await runMigrations();
    const { reviewRunEvidence } =
      await import("../../src/core/runner/evidence-review");
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    const { modelRegistryPromise, modelRuntimePromise } =
      await import("../../src/core/llm/runtime");

    const skipped = await runDirectory("review-skipped");
    assert.equal(await reviewRunEvidence(skipped, { status: "passed" }), null);
    const [skippedCall] = await reviewCalls("review-skipped");
    assert.equal(skippedCall.outcome, "skipped");
    assert.equal(skippedCall.usage, null);
    assert.equal(skippedCall.model, null);

    const registry = await modelRegistryPromise;
    const runtime = await modelRuntimePromise;
    const [model] = registry.getAll();
    assert.ok(model);
    await settingsRepository.updateLlmSettings({
      provider: model.provider,
      model: model.id,
    });
    t.mock.method(registry, "hasConfiguredAuth", () => true);
    const usage = {
      input: 900,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 940,
      cost: {
        input: 0.009,
        output: 0.004,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.013,
      },
    };
    const replies: (() => unknown)[] = [
      () => ({
        stopReason: "stop",
        usage,
        content: [
          {
            type: "text",
            text: '{"verdict":"matches","reason":"The page is shown."}',
          },
        ],
      }),
      () => ({
        stopReason: "stop",
        usage,
        content: [{ type: "text", text: "no json here" }],
      }),
      () => ({ stopReason: "error", errorMessage: "overloaded", content: [] }),
      () => {
        throw new Error("network down");
      },
    ];
    t.mock.method(
      runtime,
      "completeSimple",
      (
        _model: unknown,
        _context: unknown,
        options: {
          onPayload?: (payload: unknown) => unknown;
          maxTokens?: number;
        }
      ) => {
        assert.equal(options.maxTokens, 400);
        options.onPayload?.({
          model: model.id,
          max_tokens: 400,
          messages: [{ role: "user", content: "x" }],
        });
        const reply = replies.shift();
        assert.ok(reply);
        return Promise.resolve().then(reply);
      }
    );
    try {
      const completed = await runDirectory("review-completed");
      assert.deepEqual(
        await reviewRunEvidence(completed, { status: "passed" }),
        { verdict: "matches", reason: "The page is shown." }
      );
      assert.deepEqual(
        await reviewRunEvidence(completed, { status: "passed" }),
        { verdict: "matches", reason: "The page is shown." }
      );
      const [first, second] = await reviewCalls("review-completed");
      assert.equal(first.outcome, "completed");
      assert.equal(first.usage?.totalTokens, 940);
      assert.equal(first.usage?.cost?.total, 0.013);
      assert.equal(first.usage?.reasoning, null);
      assert.equal(first.model?.id, model.id);
      assert.equal(first.request?.maxTokens, 400);
      assert.equal(first.request?.imagesAttached, 0);
      assert.equal(first.payload?.parameters.max_tokens, 400);
      assert.equal(first.context.verdict, "matches");
      assert.equal(second.outcome, "cached");
      assert.equal(second.usage, null);

      const unusable = await runDirectory("review-unusable");
      assert.equal(
        await reviewRunEvidence(unusable, { status: "passed" }),
        null
      );
      const [unusableCall] = await reviewCalls("review-unusable");
      assert.equal(unusableCall.outcome, "invalid_response");
      assert.equal(unusableCall.usage?.totalTokens, 940);

      const errored = await runDirectory("review-errored");
      assert.equal(
        await reviewRunEvidence(errored, {
          status: "failed",
          failReason: "boom",
        }),
        null
      );
      const [erroredCall] = await reviewCalls("review-errored");
      assert.equal(erroredCall.outcome, "provider_error");
      assert.equal(erroredCall.reason, "overloaded");
      assert.equal(erroredCall.usage, null);

      const thrown = await runDirectory("review-thrown");
      assert.equal(await reviewRunEvidence(thrown, { status: "failed" }), null);
      const [thrownCall] = await reviewCalls("review-thrown");
      assert.equal(thrownCall.outcome, "provider_error");
      assert.match(thrownCall.reason ?? "", /network down/u);
      assert.equal(thrownCall.usage, null);
    } finally {
      await settingsRepository.updateLlmSettings({ provider: "", model: "" });
    }
  });
});
