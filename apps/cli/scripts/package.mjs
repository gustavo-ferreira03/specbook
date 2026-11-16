import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const cli = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(cli, "../..");
const output = path.resolve(
  root,
  process.argv[2] ?? "dist/release/specbook.tgz"
);
const manifest = JSON.parse(
  await fs.readFile(path.join(cli, "package.json"), "utf-8")
);
const lock = JSON.parse(
  await fs.readFile(path.join(cli, "npm-shrinkwrap.json"), "utf-8")
);
const locked = lock.packages?.[""];
const lockMessage =
  "Regenerate apps/cli/npm-shrinkwrap.json from the production manifest before packaging a new version or changing dependencies.";
assert.equal(lock.name, manifest.name, lockMessage);
assert.equal(lock.version, manifest.version, lockMessage);
assert.equal(locked?.name, manifest.name, lockMessage);
assert.equal(locked?.version, manifest.version, lockMessage);
assert.deepEqual(locked?.dependencies, manifest.dependencies, lockMessage);

const { overrides } = parseYaml(
  await fs.readFile(path.join(root, "pnpm-workspace.yaml"), "utf-8")
);
const piVersion = manifest.dependencies["@earendil-works/pi-ai"];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location) {
    continue;
  }
  const name = entry.name ?? location.split("node_modules/").at(-1);
  if (name.startsWith("@earendil-works/")) {
    assert.equal(
      entry.version,
      piVersion,
      "Keep the locked PI family compatible"
    );
  }
  for (const [selector, range] of Object.entries(overrides)) {
    const separator = selector.lastIndexOf("@");
    const dependency = selector.slice(0, separator);
    const major = Number(selector.slice(separator + 1));
    const [actualMajor, actualMinor, actualPatch] = entry.version
      .split(".")
      .map(Number);
    if (name !== dependency || actualMajor !== major) {
      continue;
    }
    const minimum = range.match(
      /^\^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u
    );
    assert.ok(
      minimum,
      `Unsupported production override: ${selector}: ${range}`
    );
    const [requiredMajor, requiredMinor, requiredPatch] = minimum
      .slice(1)
      .map(Number);
    assert.ok(
      actualMajor === requiredMajor &&
        (actualMinor > requiredMinor ||
          (actualMinor === requiredMinor && actualPatch >= requiredPatch)),
      `${name}@${entry.version} must retain the workspace security override ${range}`
    );
  }
}

const run = async (command, args, cwd) => {
  // oxlint-disable-next-line promise/avoid-new -- Wait for the package manager or compiler child process to finish.
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} stopped (${signal ?? `exit ${code}`})`));
      }
    });
  });
};

await run(process.execPath, ["scripts/build.mjs"], cli);
const staging = await fs.mkdtemp(path.join(os.tmpdir(), "specbook-package-"));
const temporaryOutput = `${output}.tmp-${process.pid}`;
try {
  const production = {
    ...manifest,
    bundleDependencies: [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
    ],
  };
  delete production.devDependencies;
  delete production.scripts;
  await fs.writeFile(
    path.join(staging, "package.json"),
    `${JSON.stringify(production, null, 2)}\n`
  );
  await fs.writeFile(
    path.join(staging, "npm-shrinkwrap.json"),
    `${JSON.stringify(lock, null, 2)}\n`
  );
  await fs.cp(path.join(cli, "dist"), path.join(staging, "dist"), {
    recursive: true,
  });
  await fs.copyFile(
    path.join(cli, "README.md"),
    path.join(staging, "README.md")
  );
  await fs.copyFile(path.join(root, "LICENSE"), path.join(staging, "LICENSE"));

  // The lock is honored while this is the installation root. The PI dependency
  // closure is then bundled so consumer projects cannot hoist incompatible APIs.
  await run(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    staging
  );
  await fs.rm(path.join(staging, "npm-shrinkwrap.json"));
  const packed = path.join(staging, "packed");
  await fs.mkdir(packed);
  await run(
    "npm",
    ["pack", "--ignore-scripts", "--silent", "--pack-destination", packed],
    staging
  );
  const [filename, ...extraFiles] = await fs.readdir(packed);
  assert.ok(filename?.endsWith(".tgz") && extraFiles.length === 0);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.copyFile(path.join(packed, filename), temporaryOutput);
  await fs.rename(temporaryOutput, output);
  process.stdout.write(`Packaged ${output}\n`);
} finally {
  await fs.rm(temporaryOutput, { force: true });
  await fs.rm(staging, { recursive: true, force: true });
}
