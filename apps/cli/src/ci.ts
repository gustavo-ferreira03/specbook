import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { junitResult, markdownResult } from "@specbook/runtime/ci-report";
import type { CiReport } from "@specbook/runtime/ci-report";
import { z } from "zod";

import { ciCommentContext, publishCiComment, scrubCi } from "./ci-comment";
import { scrub } from "./credentials";
import {
  normalizeServerUrl,
  request,
  responseJson,
  RemoteError,
  scrubTokens,
  rememberToken,
} from "./remote";
import { runLocal } from "./run";
import { workspaceDirectory } from "./workspace";

const ciResultSchema = z.object({
  batch: z.object({
    id: z.string(),
    durationMs: z.number().nullable().optional(),
    environment: z.object({ name: z.string() }).nullable().optional(),
  }),
  status: z.string(),
  complete: z.boolean(),
  url: z.string(),
  qualityGate: z.object({
    passed: z.boolean(),
    failures: z.number(),
    flaky: z.number(),
    knownBugs: z.number(),
    awaitingDeploy: z.number().default(0),
  }),
  results: z.array(
    z.object({
      specId: z.string(),
      runId: z.string(),
      title: z.string(),
      status: z.string(),
      failReason: z.string().nullable().optional(),
      durationMs: z.number().nullable().optional(),
      flaky: z.boolean(),
      knownBug: z.boolean(),
      failsGate: z.boolean(),
      awaitingDeploy: z.boolean().default(false),
      url: z.string(),
    })
  ),
});
export interface CiOptions {
  url?: string;
  token?: string;
  project?: string;
  environment?: string;
  baseUrl?: string;
  featureId?: string;
  specIds?: string;
  timeout?: string;
  report?: string;
  junit?: string;
  summary?: string;
  commitSha?: string;
  ref?: string;
  buildUrl?: string;
  failOnFlaky?: boolean;
  failOnKnownBugs?: boolean;
  comment?: string;
}
const flag = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value === "false" || value === "0") {
    return false;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  throw new Error(`${name} must be true or false`);
};
const required = (value: string | undefined, name: string) => {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const timeoutMs = (options: CiOptions): number => {
  const value =
    Number(options.timeout ?? process.env.SPECBOOK_TIMEOUT_SECONDS ?? 3600) *
    1000;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Use a positive timeout in seconds");
  }
  return value;
};
const reportFiles = (options: CiOptions) => {
  const files = {
    report: path.resolve(
      options.report ??
        process.env.SPECBOOK_REPORT_PATH ??
        "specbook-report.html"
    ),
    junit: path.resolve(
      options.junit ?? process.env.SPECBOOK_JUNIT_PATH ?? "specbook-junit.xml"
    ),
    summary: path.resolve(
      options.summary ??
        process.env.SPECBOOK_SUMMARY_PATH ??
        "specbook-summary.md"
    ),
  };
  if (new Set(Object.values(files)).size !== 3) {
    throw new Error("Report, JUnit and summary paths must be different");
  }
  return files;
};
const writeArtifact = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf-8");
};
const SERVER_ONLY = [
  ["token", "--token", "SPECBOOK_TOKEN"],
  ["project", "--project", "SPECBOOK_PROJECT"],
  ["environment", "--environment", "SPECBOOK_ENVIRONMENT"],
  ["featureId", "--feature-id", "SPECBOOK_FEATURE_ID"],
  ["specIds", "--spec-ids", "SPECBOOK_SPEC_IDS"],
  ["failOnFlaky", "--fail-on-flaky", "SPECBOOK_FAIL_ON_FLAKY"],
  ["failOnKnownBugs", "--fail-on-known-bugs", "SPECBOOK_FAIL_ON_KNOWN_BUGS"],
] as const;
const appUrl = (value: string): void => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "SPECBOOK_BASE_URL or --base-url must be a full HTTP(S) URL"
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "SPECBOOK_BASE_URL or --base-url must be an HTTP(S) URL without credentials"
    );
  }
};
const safe = async (text: string) => scrubCi(await scrub(text));

const runLocalCi = async (options: CiOptions, selector?: string) => {
  if (
    options.token ??
    options.project ??
    process.env.SPECBOOK_TOKEN ??
    process.env.SPECBOOK_PROJECT
  ) {
    throw new Error(
      "SPECBOOK_TOKEN or SPECBOOK_PROJECT is set without SPECBOOK_URL. Set SPECBOOK_URL to run a Specbook server's Specs, or unset them to run this repository's Specs"
    );
  }
  const serverOnly = SERVER_ONLY.flatMap(([key, flagName, variable]) => {
    if (options[key] !== undefined) {
      return [flagName];
    }
    if (
      process.env[variable] &&
      !["false", "0"].includes(process.env[variable] ?? "")
    ) {
      return [variable];
    }
    return [];
  });
  if (serverOnly.length) {
    throw new Error(
      `${serverOnly.join(", ")} need${serverOnly.length === 1 ? "s" : ""} a Specbook server. Set SPECBOOK_URL, or remove ${serverOnly.length === 1 ? "it" : "them"} to run this repository's Specs`
    );
  }
  let workspace: string;
  try {
    workspace = await workspaceDirectory();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("There is no .specbook workspace")
    ) {
      throw new Error(
        "There is no .specbook workspace here. Run specbook ci from the directory that holds .specbook, or set SPECBOOK_URL to run a Specbook server's Specs",
        { cause: error }
      );
    }
    throw error;
  }
  const baseUrl = options.baseUrl ?? process.env.SPECBOOK_BASE_URL;
  if (baseUrl) {
    appUrl(baseUrl);
  }
  const files = reportFiles(options);
  const context = await ciCommentContext(
    options.comment ?? process.env.SPECBOOK_COMMENT_PROVIDER ?? "none"
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Timed out running Specs")),
    timeoutMs(options)
  );
  const cancel = () => controller.abort(new Error("Cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let run: Awaited<ReturnType<typeof runLocal>>;
  try {
    run = await runLocal(workspace, selector, {
      signal: controller.signal,
      baseUrl,
    });
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  const results = await Promise.all(
    run.results.map(async (item) => ({
      specId: item.path,
      runId: run.id,
      title: item.title,
      status: item.status,
      failReason:
        item.status === "passed"
          ? null
          : await safe(
              [item.failedStep && `Step "${item.failedStep}"`, item.failReason]
                .filter(Boolean)
                .join(": ") || "Spec failed"
            ),
      durationMs: item.durationMs,
      flaky: false,
      knownBug: false,
      failsGate: item.status !== "passed",
      awaitingDeploy: false,
    }))
  );
  const failures = results.filter((item) => item.failsGate).length;
  const report: CiReport = {
    status: run.status,
    complete: true,
    batch: {
      durationMs: run.durationMs,
      environment: null,
      ci: {
        commitSha: options.commitSha ?? process.env.SPECBOOK_COMMIT_SHA,
        ref: options.ref ?? process.env.SPECBOOK_REF,
      },
    },
    qualityGate: {
      passed: failures === 0,
      failures,
      flaky: 0,
      knownBugs: 0,
      awaitingDeploy: 0,
    },
    results: results.map((item) => ({ ...item, pending: false })),
  };
  await writeArtifact(
    files.report,
    await safe(await fs.readFile(run.report, "utf-8"))
  );
  await writeArtifact(files.junit, await safe(junitResult(report)));
  const summary = await safe(markdownResult(report));
  await writeArtifact(files.summary, summary);
  await publishCiComment(context, "local", "specbook", summary);
  return {
    batchId: run.id,
    status: run.status,
    environment: null,
    durationMs: run.durationMs,
    qualityGate: report.qualityGate,
    results,
    ...files,
    url: undefined,
  };
};

// oxlint-disable-next-line complexity -- Keep the ci decision tree together so state transitions and error ordering remain explicit.
export const runCi = async function runCi(
  options: CiOptions,
  selector?: string
) {
  if (!(options.url ?? process.env.SPECBOOK_URL)) {
    return await runLocalCi(options, selector);
  }
  if (selector) {
    throw new Error(
      "A Spec path selects this repository's Specs; with a Specbook server, use --feature-id or --spec-ids"
    );
  }
  const token = required(
    options.token ?? process.env.SPECBOOK_TOKEN,
    "SPECBOOK_TOKEN or --token"
  );
  rememberToken(token);
  let api = normalizeServerUrl(
    required(options.url ?? process.env.SPECBOOK_URL, "SPECBOOK_URL or --url")
  );
  const project = required(
    options.project ?? process.env.SPECBOOK_PROJECT,
    "SPECBOOK_PROJECT or --project"
  );
  if (!z.string().uuid().safeParse(project).success) {
    throw new Error("Use the project id for SPECBOOK_PROJECT or --project");
  }
  const deadline = Date.now() + timeoutMs(options);
  const files = reportFiles(options);
  const context = await ciCommentContext(
    options.comment ?? process.env.SPECBOOK_COMMENT_PROVIDER ?? "none"
  );
  const specIds = (options.specIds ?? process.env.SPECBOOK_SPEC_IDS)
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const featureId = options.featureId ?? process.env.SPECBOOK_FEATURE_ID;
  if (featureId && specIds?.length) {
    throw new Error("Select a feature or Specs, not both");
  }
  if (
    (featureId && !z.string().uuid().safeParse(featureId).success) ||
    specIds?.some((id) => !z.string().uuid().safeParse(id).success)
  ) {
    throw new Error("Use remote ids for --feature-id and --spec-ids");
  }
  const baseUrl = options.baseUrl ?? process.env.SPECBOOK_BASE_URL;
  const buildUrl = options.buildUrl ?? process.env.SPECBOOK_BUILD_URL;
  if (baseUrl) {
    normalizeServerUrl(baseUrl);
  }
  if (buildUrl) {
    normalizeServerUrl(buildUrl);
  }
  const input = {
    environment: options.environment ?? process.env.SPECBOOK_ENVIRONMENT,
    ...(featureId ? { featureId } : {}),
    ...(specIds?.length ? { specIds } : {}),
    baseUrl,
    commitSha: options.commitSha ?? process.env.SPECBOOK_COMMIT_SHA,
    ref: options.ref ?? process.env.SPECBOOK_REF,
    buildUrl,
    qualityGate: {
      failOnFlaky: options.failOnFlaky ?? flag("SPECBOOK_FAIL_ON_FLAKY"),
      failOnKnownBugs:
        options.failOnKnownBugs ?? flag("SPECBOOK_FAIL_ON_KNOWN_BUGS"),
    },
  };
  const get = async (route: string, method = "GET", body?: unknown) => {
    for (let attempt = 0; ; attempt += 1) {
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for Specbook results");
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
        return await request({ url: api, token }, route, {
          method,
          body,
          timeoutMs: Math.max(1, Math.min(35_000, deadline - Date.now())),
          frontendFallback: method === "POST",
        });
      } catch (error) {
        if (
          method !== "GET" ||
          (error instanceof RemoteError && error.status < 500) ||
          attempt >= 4 ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
        await wait(
          Math.max(1, Math.min(5000, 500 * 2 ** attempt, deadline - Date.now()))
        );
      }
    }
  };
  const route = `/ci/projects/${encodeURIComponent(project)}/runs`;
  const started = await get(route, "POST", input);
  api = started.url.slice(0, -route.length);
  let result = await responseJson(started, ciResultSchema);
  const resultRoute = `/ci/runs/${encodeURIComponent(result.batch.id)}`;
  while (!result.complete) {
    // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    result = await responseJson(
      // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
      await get(`${resultRoute}?wait=true`),
      ciResultSchema
    );
  }
  let summaryText = "";
  for (const [format, file] of [
    ["html", files.report],
    ["junit", files.junit],
    ["markdown", files.summary],
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    const getValue1 = await get(`${resultRoute}?format=${format}`);
    const text = scrubCi(
      // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
      await scrubTokens(await scrub(await getValue1.text()))
    );
    // oxlint-disable-next-line no-await-in-loop -- Write each downloaded artifact in order after scrubbing it.
    await writeArtifact(file, text);
    if (format === "markdown") {
      summaryText = text;
    }
  }
  await publishCiComment(context, api, project, summaryText);
  return {
    batchId: result.batch.id,
    status: result.status,
    environment: result.batch.environment?.name ?? input.environment ?? null,
    durationMs: result.batch.durationMs ?? null,
    qualityGate: result.qualityGate,
    results: result.results,
    ...files,
    url: result.url,
  };
};

export type CiResult = Awaited<ReturnType<typeof runCi>>;
