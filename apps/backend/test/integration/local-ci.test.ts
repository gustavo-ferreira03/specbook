import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { secretEnvName } from "@specbook/runtime/specbook/guard";
import { stringify } from "yaml";

import { addProfile, resolveRunSecrets } from "../../../cli/src/credentials";
import { backendRoot } from "../../src/core/paths";
import { tempDir } from "../helpers/storage";

const execute = promisify(execFile);
const cli = path.join(backendRoot, "..", "cli", "src", "index.ts");
const tsxImport = import.meta.resolve("tsx");
const command = async (
  directory: string,
  arguments_: string[],
  environment: Record<string, string> = {}
) => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("SPECBOOK_") &&
        !key.startsWith("GITHUB_") &&
        !key.startsWith("CI_")
    )
  );
  try {
    const result = await execute(
      process.execPath,
      ["--import", tsxImport, cli, "ci", ...arguments_, "--json"],
      {
        cwd: directory,
        env: {
          ...inherited,
          SPECBOOK_HOME: path.join(directory, "home"),
          ...environment,
        },
        timeout: 15_000,
        maxBuffer: 2_000_000,
      }
    );
    return { code: 0, output: result.stdout, error: result.stderr };
  } catch (error) {
    const failure = error as Error & {
      code: number;
      stdout: string;
      stderr: string;
    };
    if (typeof failure.code !== "number") {
      throw error;
    }
    return {
      code: failure.code,
      output: failure.stdout,
      error: failure.stderr,
    };
  }
};
const writeSpec = async (directory: string, name: string, secret: boolean) => {
  const target = path.join(directory, ".specbook", "specs", "flows", name);
  await fs.mkdir(target, { recursive: true });
  const steps = secret ? ["Open app", "Enter credential"] : ["Open app"];
  await fs.writeFile(
    path.join(target, "spec.yml"),
    stringify({
      title: name,
      preconditions: [],
      steps,
      expectedResult: "Heading is ready",
      postconditions: [],
    })
  );
  await fs.writeFile(
    path.join(target, "spec.ts"),
    [
      'import { test, expect } from "specbook";',
      `test(${JSON.stringify(name)}, async ({ page, step${secret ? ", secret" : ""} }) => {`,
      ' await step("Open app", async () => { await page.goto("/"); });',
      ...(secret
        ? [
            ' await step("Enter credential", async () => { await page.getByRole("textbox").fill(secret("shop", "api_username")); });',
          ]
        : []),
      ' await step("Heading is ready", async () => { await expect(page.getByRole("heading")).toHaveText("Ready"); });',
      "});",
    ].join("\n")
  );
};
const workspace = async () => {
  const directory = tempDir("specbook-local-ci-");
  await fs.mkdir(path.join(directory, ".specbook", "specs", "flows"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(directory, ".specbook", "config.yml"),
    stringify({ version: 1, baseUrl: "https://unused-base.example" })
  );
  await fs.writeFile(
    path.join(directory, ".specbook", "specs", "flows", "feature.yml"),
    stringify({ title: "Flows", description: "" })
  );
  await Promise.all([
    writeSpec(directory, "passing", false),
    writeSpec(directory, "failing", true),
  ]);
  return directory;
};

test(
  "repository CI selects local Specs, overrides the base URL and writes scrubbed passing and failing reports",
  { timeout: 45_000 },
  async () => {
    const directory = await workspace();
    const server = http.createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        '<h1>Ready</h1><input aria-label="Credential"><script>document.querySelector("input").addEventListener("input",e=>{document.querySelector("h1").textContent=e.target.value})</script>'
      );
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const value = `sensitive-${randomUUID()}`;
    try {
      const passing = await command(
        directory,
        ["flows/passing", "--timeout", "30"],
        { SPECBOOK_BASE_URL: baseUrl }
      );
      assert.equal(passing.code, 0, passing.output + passing.error);
      const passed = JSON.parse(passing.output);
      assert.equal(passed.qualityGate.passed, true);
      assert.equal(passed.results.length, 1);
      assert.equal(passed.results[0].specId, "specs/flows/passing");
      assert.equal(passed.url, undefined);
      assert.match(await fs.readFile(passed.report, "utf-8"), /passing/u);
      assert.match(await fs.readFile(passed.junit, "utf-8"), /failures="0"/u);
      assert.match(
        await fs.readFile(passed.summary, "utf-8"),
        /Quality gate: passed/u
      );

      const failing = await command(
        directory,
        ["flows/failing", "--base-url", baseUrl, "--timeout", "30"],
        { SPECBOOK_SECRET_SHOP_API_USERNAME: value }
      );
      assert.equal(failing.code, 1, failing.output + failing.error);
      const failed = JSON.parse(failing.output);
      assert.equal(failed.qualityGate.passed, false);
      assert.equal(failed.qualityGate.failures, 1);
      assert.equal(failed.results[0].status, "failed");
      assert.match(failed.results[0].failReason, /Step "Heading is ready"/u);
      assert.ok(!failing.output.includes(value));
      const [report, junit, summary] = await Promise.all(
        [failed.report, failed.junit, failed.summary].map((file) =>
          fs.readFile(file, "utf-8")
        )
      );
      assert.match(junit, /failures="1"/u);
      assert.match(summary, /Quality gate: failed/u);
      assert.ok(
        !report.includes(value) &&
          !junit.includes(value) &&
          !summary.includes(value)
      );
      assert.match(junit, /\[REDACTED\]/u);

      const rejected = await command(directory, ["flows/passing"], {
        SPECBOOK_TOKEN: "orphan-project-token",
      });
      assert.equal(rejected.code, 1);
      assert.match(JSON.parse(rejected.output).error, /without SPECBOOK_URL/u);
      const remoteOption = await command(directory, [
        "flows/passing",
        "--environment",
        "Staging",
      ]);
      assert.equal(remoteOption.code, 1);
      assert.match(JSON.parse(remoteOption.output).error, /a Specbook server/u);
    } finally {
      server.closeAllConnections();
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  }
);

test("local credential environment values override saved profiles and scrub sensitive underscore fields", async () => {
  const oldHome = process.env.SPECBOOK_HOME;
  const variables = [
    "SPECBOOK_SECRET_SHOP_PASSWORD",
    "SPECBOOK_SECRET_SHOP_API_USERNAME",
    "SPECBOOK_SECRET_SHOP_USERNAME",
    "SPECBOOK_SECRET_SHOP_ORIGINS",
  ];
  const previous = variables.map((key) => process.env[key]);
  const password = `password-${randomUUID()}`;
  const opaque = `api-${randomUUID()}`;
  process.env.SPECBOOK_HOME = tempDir("specbook-ci-credentials-");
  process.env.SPECBOOK_SECRET_SHOP_PASSWORD = password;
  process.env.SPECBOOK_SECRET_SHOP_API_USERNAME = opaque;
  process.env.SPECBOOK_SECRET_SHOP_USERNAME = "public-test-user";
  process.env.SPECBOOK_SECRET_SHOP_ORIGINS = "https://identity.example";
  try {
    await addProfile(
      "shop",
      { password: "saved-password", username: "saved-user" },
      ["https://saved.example"]
    );
    const refs = ["password", "api_username", "username"].map((field) => ({
      profile: "shop",
      field,
      envName: secretEnvName("shop", field),
    }));
    const resolved = await resolveRunSecrets(refs, "https://preview.example");
    assert.equal(resolved.secretEnv.SPECBOOK_SECRET_SHOP_PASSWORD, password);
    assert.deepEqual(
      resolved.secretOrigins.byRef.SPECBOOK_SECRET_SHOP_PASSWORD,
      ["https://identity.example"]
    );
    assert.ok(
      resolved.secretOrigins.publicRefs.includes(
        "SPECBOOK_SECRET_SHOP_USERNAME"
      )
    );
    assert.ok(
      !resolved.secretOrigins.publicRefs.includes(
        "SPECBOOK_SECRET_SHOP_API_USERNAME"
      )
    );
    assert.equal(
      resolved.scrub(`${password} ${opaque} public-test-user`),
      "[REDACTED] [REDACTED] public-test-user"
    );
  } finally {
    if (oldHome === undefined) {
      Reflect.deleteProperty(process.env, "SPECBOOK_HOME");
    } else {
      process.env.SPECBOOK_HOME = oldHome;
    }
    for (const [index, key] of variables.entries()) {
      if (previous[index] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = previous[index];
      }
    }
  }
});

test(
  "local CI cancellation also bounds the first Chromium installation",
  { timeout: 20_000 },
  async () => {
    const directory = await workspace();
    const server = http.createServer((_request, _response) => {
      /* Keep the controlled browser download pending until cancellation. */
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const started = Date.now();
      const result = await command(
        directory,
        ["flows/passing", "--base-url", origin, "--timeout", "0.5"],
        {
          PLAYWRIGHT_BROWSERS_PATH: path.join(directory, "empty-browsers"),
          PLAYWRIGHT_DOWNLOAD_HOST: origin,
        }
      );
      assert.equal(result.code, 1);
      assert.ok(Date.now() - started < 10_000, result.output + result.error);
      assert.match(result.error, /Downloading Chromium/u);
    } finally {
      server.closeAllConnections();
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  }
);
