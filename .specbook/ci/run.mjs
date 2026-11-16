#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tester = (
  process.env.SPECBOOK_TESTER_URL ?? "http://127.0.0.1:4001"
).replace(/\/$/u, "");
const target = (
  process.env.SPECBOOK_TARGET_URL ?? "http://127.0.0.1:5001"
).replace(/\/$/u, "");
// The workspace holds the Specs; this harness lives in its ci/ folder.
const book = path.join(import.meta.dirname, "..");
const fixtureAdmin = {
  email: "admin@dogfood.local",
  password: "dogfood-elbAHa9N8x6i",
};

let cookie = "";

const api = async function api(method, route, body) {
  const response = await fetch(`${tester}/api${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Specbook-Request": "1",
      Origin: tester,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length) {
    cookie = setCookies.map((value) => value.split(";")[0]).join("; ");
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${route} returned ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
};

const waitFor = async function waitFor(url) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each operation depends on the preceding attempt or updates ordered browser/evidence state.
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      /* Cleanup is best effort; preserve the original result. */
      /* Cleanup is best effort; preserve the original result. */
    }
    // oxlint-disable-next-line no-await-in-loop, promise/avoid-new -- Each operation depends on the preceding attempt or updates ordered browser/evidence state. Bridge a callback or deadline into a promise; there is no promise-returning operation to await.
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
  }
  throw new Error(`${url} did not become ready`);
};

const specCount = function specCount(directory) {
  return fs
    .readdirSync(directory, { recursive: true })
    .filter((entry) => path.basename(String(entry)) === "spec.yml").length;
};

await waitFor(`${tester}/api/health`);
await waitFor(`${target}/login`);

await api("POST", "/setup/admin", {
  name: "Specbook CI",
  email: "ci@specbook.local",
  password: crypto.randomBytes(24).toString("base64url"),
});
const { project } = await api("POST", "/projects", {
  name: "Specbook",
  baseUrl: target,
});
await api("POST", `/projects/${project.id}/credentials`, {
  name: "dogfood-admin",
  allowedOrigins: [target],
  fields: [
    { key: "username", value: fixtureAdmin.email, sensitive: false },
    { key: "password", value: fixtureAdmin.password, sensitive: true },
  ],
});

const { token: gitToken, remote } = await api(
  "POST",
  `/projects/${project.id}/git/remote/token`
);
const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "specbook-book-"));
const git = (...args) =>
  execFileSync(
    "git",
    [
      "-c",
      `http.extraHeader=Authorization: Basic ${Buffer.from(`ci:${gitToken}`).toString("base64")}`,
      "-c",
      "user.name=Specbook CI",
      "-c",
      "user.email=ci@specbook.local",
      ...args,
    ],
    { cwd: checkout, stdio: "inherit" }
  );
git("clone", "--branch", remote.branch, remote.cloneUrl, ".");
fs.cpSync(path.join(book, "specs"), path.join(checkout, "specs"), {
  recursive: true,
});
fs.copyFileSync(
  path.join(book, "context.yml"),
  path.join(checkout, "context.yml")
);
git("add", "--all");
git("commit", "--message", "Add Specbook's own Specs");
git("push", "origin", `HEAD:${remote.branch}`);

const expected = specCount(path.join(book, "specs"));
let indexed = 0;
for (let attempt = 0; attempt < 30 && indexed < expected; attempt += 1) {
  // oxlint-disable-next-line no-await-in-loop -- Each operation depends on the preceding attempt or updates ordered browser/evidence state.
  const tree = await api("GET", `/projects/${project.id}/tree`);
  indexed = tree.specs.length;
  if (indexed < expected) {
    // oxlint-disable-next-line no-await-in-loop, promise/avoid-new -- Each operation depends on the preceding attempt or updates ordered browser/evidence state. Bridge a callback or deadline into a promise; there is no promise-returning operation to await.
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
  }
}
if (indexed !== expected) {
  throw new Error(
    `Expected ${expected} Specs after the push, found ${indexed}`
  );
}
console.log(`Specbook: ${indexed} Specs pushed to the tester project`);

const { token: ciToken } = await api(
  "POST",
  `/projects/${project.id}/ci/token`
);
const run = spawnSync(
  process.execPath,
  [path.join(book, "..", "apps", "cli", "dist", "index.js"), "ci"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      SPECBOOK_URL: `${tester}/api`,
      SPECBOOK_PROJECT: project.id,
      SPECBOOK_TOKEN: ciToken,
    },
  }
);
process.exitCode = run.status ?? 1;
