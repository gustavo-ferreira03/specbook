import crypto from "node:crypto";
import fs from "node:fs/promises";

import { remoteFetch } from "./network";
import { requiredValue } from "./values";

export const scrubCi = function scrubCi(input: string): string {
  let value = input;
  for (const token of [
    process.env.SPECBOOK_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.SPECBOOK_GITLAB_TOKEN,
    process.env.CI_JOB_TOKEN,
  ]
    .filter((candidateValue): candidateValue is string => !!candidateValue)
    .toSorted((a, b) => b.length - a.length)) {
    value = value.replaceAll(token, "[REDACTED]");
  }
  return value;
};

const required = function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const httpUrl = function httpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be an HTTP(S) URL without credentials, query or fragment`
    );
  }
  return url.href.replace(/\/$/u, "");
};

const number = function number(value: unknown, name: string): string {
  if (!/^[1-9]\d*$/u.test(String(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return String(value);
};

export interface CiCommentContext {
  provider: "github" | "gitlab";
  api: string;
  route: string;
  repository?: string;
  headers: Record<string, string>;
}

export const ciCommentContext = async function ciCommentContext(
  provider: string
): Promise<CiCommentContext | null> {
  if (provider === "none") {
    return null;
  }
  if (provider === "github") {
    let pullRequest: unknown = process.env.SPECBOOK_PR_NUMBER;
    if (!pullRequest && process.env.GITHUB_EVENT_PATH) {
      const event = JSON.parse(
        await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf-8")
      ) as { pull_request?: { number?: number } };
      pullRequest = event.pull_request?.number;
    }
    if (!pullRequest) {
      return null;
    }
    const repository = required("GITHUB_REPOSITORY");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new Error("GITHUB_REPOSITORY must be owner/repository");
    }
    return {
      provider,
      api: httpUrl(
        process.env.GITHUB_API_URL ?? "https://api.github.com",
        "GITHUB_API_URL"
      ),
      route: `/repos/${repository}/issues/${number(pullRequest, "Pull request number")}/comments`,
      repository,
      headers: {
        Authorization: `Bearer ${required("GITHUB_TOKEN")}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
  }
  if (provider !== "gitlab") {
    throw new Error("Comment provider must be github, gitlab or none");
  }
  const mergeRequest = process.env.CI_MERGE_REQUEST_IID;
  if (!mergeRequest) {
    return null;
  }
  if (!process.env.SPECBOOK_GITLAB_TOKEN) {
    throw new Error(
      "GitLab note publishing requires SPECBOOK_GITLAB_TOKEN: a project access token with api scope. CI_JOB_TOKEN cannot create or update merge-request notes."
    );
  }
  const project =
    process.env.CI_MERGE_REQUEST_PROJECT_ID || required("CI_PROJECT_ID");
  return {
    provider,
    api: httpUrl(required("CI_API_V4_URL"), "CI_API_V4_URL"),
    route: `/projects/${encodeURIComponent(project)}/merge_requests/${number(mergeRequest, "Merge request number")}/notes`,
    headers: { "PRIVATE-TOKEN": required("SPECBOOK_GITLAB_TOKEN") },
  };
};

interface ProviderComment {
  id: number;
  body: string;
  user?: { login: string };
  author?: { id: number };
  system?: boolean;
}

export const publishCiComment = async function publishCiComment(
  context: CiCommentContext | null,
  api: string,
  project: string,
  summary: string
): Promise<void> {
  if (!context) {
    return;
  }
  const deadline = Date.now() + 60_000;
  const request = async function request(
    route: string,
    method = "GET",
    body?: { body: string }
  ): Promise<unknown> {
    if (Date.now() >= deadline) {
      throw new Error("Timed out publishing the Specbook comment");
    }
    const response = await remoteFetch(
      `${requiredValue(context).api}${route}`,
      {
        method,
        headers: {
          ...requiredValue(context).headers,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.min(30_000, Math.max(1, deadline - Date.now()))
        ),
      }
    );
    if (!response.ok) {
      throw new Error(
        `${requiredValue(context).provider === "github" ? "GitHub" : "GitLab"} comment API returned HTTP ${response.status}; reports are saved locally`
      );
    }
    return response.status === 204 ? null : response.json();
  };
  const marker = `<!-- specbook:${crypto.createHash("sha256").update(`${api}/${project}`).digest("hex")} -->`;
  let body = `${marker}\n${scrubCi(summary)}`;
  if (Buffer.byteLength(body, "utf-8") > 60_000) {
    body = `${Buffer.from(body)
      .subarray(0, 55_000)
      .toString("utf-8")
      .replace(
        /\uFFFD$/u,
        ""
      )}\n\nSummary truncated. Download specbook-summary.md from the job artifacts for all results.`;
  }
  const author =
    context.provider === "gitlab"
      ? number(
          ((await request("/user")) as { id: number }).id,
          "GitLab token user ID"
        )
      : null;
  const matches: ProviderComment[] = [];
  for (let page = 1; ; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
    const comments = await request(
      `${context.route}?per_page=100&page=${page}`
    );
    if (!Array.isArray(comments)) {
      throw new TypeError("Comment API returned an invalid list");
    }
    matches.push(
      ...(comments as ProviderComment[]).filter(
        (comment) =>
          typeof comment.body === "string" &&
          comment.body.startsWith(marker) &&
          (context.provider === "github"
            ? comment.user?.login === "github-actions[bot]"
            : String(comment.author?.id) === author && !comment.system)
      )
    );
    if (comments.length < 100) {
      break;
    }
    if (page === 100) {
      throw new Error(
        "Too many comments to safely locate the Specbook summary"
      );
    }
  }
  const route = (comment: ProviderComment) =>
    context.provider === "github"
      ? `/repos/${context.repository}/issues/comments/${number(comment.id, "Comment ID")}`
      : `${context.route}/${number(comment.id, "Note ID")}`;
  if (matches.length) {
    await request(
      route(requiredValue(matches[0])),
      context.provider === "github" ? "PATCH" : "PUT",
      { body }
    );
    for (const duplicate of matches.slice(1)) {
      // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
      await request(route(duplicate), "DELETE");
    }
  } else {
    await request(context.route, "POST", { body });
  }
};
