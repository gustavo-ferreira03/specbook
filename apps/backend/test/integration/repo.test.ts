import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";

import { sanitizeTechnicalDetails } from "@specbook/runtime/sanitize";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { BrowserMcp } from "../../src/core/browser/mcp";
import type { RunBatch } from "../../src/core/runner/batch";
import { requireValue } from "../../src/core/utils/require-value";
import {
  HUMAN_SPEC,
  tempDir,
  useTempStorage,
  VALID_SPEC,
} from "../helpers/storage";

const api = function api(
  method: string,
  url: string,
  body?: unknown
): Promise<Response> {
  try {
    return Promise.resolve(
      app.request(url, {
        method,
        headers: { [REQUEST_HEADER]: "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
  } catch (error) {
    return Promise.reject(error);
  }
};

const createProject = async function createProject(
  name = "Loja"
): Promise<string> {
  const response = await api("POST", "/projects", {
    name,
    baseUrl: "https://app.example.com",
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { project: { id: string } }).project.id;
};

const createSpec = function createSpec(
  projectId: string,
  featureId: string,
  title: string,
  testSource = VALID_SPEC
) {
  try {
    return Promise.resolve(
      writer.createSpecInRepo({
        projectId,
        featureId,
        title,
        description: "",
        humanSpec: HUMAN_SPEC,
        testSource,
      })
    );
  } catch (error) {
    return Promise.reject(error);
  }
};

const commitCount = async function commitCount(
  projectId: string
): Promise<number> {
  return Number(
    await (async () => {
      const awaitedValue1480 = await repoGit
        .getProjectGit(projectId)
        .raw(["rev-list", "--count", "HEAD"]);
      return awaitedValue1480.trim();
    })()
  );
};

useTempStorage();
const { runMigrations } = await import("../../src/infra/db/migrate");
const { createProjectsRouter } =
  await import("../../src/infra/web/routes/projects");
const { createFeaturesRouter } =
  await import("../../src/infra/web/routes/features");
const { createSpecsRouter } = await import("../../src/infra/web/routes/specs");
const { csrfGuard, REQUEST_HEADER } =
  await import("../../src/infra/web/security");
const writer = await import("../../src/core/repo/writer");
const { reindexProject } = await import("../../src/core/repo/indexer");
const { repoGit } = await import("../../src/core/repo/git");
const { repoBare } = await import("../../src/core/repo/bare");
const { projectsRepository } =
  await import("../../src/infra/repositories/projects");
const { specsRepository } = await import("../../src/infra/repositories/specs");
const { featuresRepository } =
  await import("../../src/infra/repositories/features");
const { runsRepository } = await import("../../src/infra/repositories/runs");

const app = new Hono();
app.use("*", csrfGuard());
// oxlint-disable-next-line promise/prefer-await-to-callbacks -- This handler models the callback interface exercised by the test.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  return c.json(
    { error: err instanceof Error ? err.message : String(err) },
    500
  );
});
app.route("/", createProjectsRouter());
app.route("/", createFeaturesRouter());
app.route("/", createSpecsRouter());

before(async () => {
  await runMigrations();
});

describe("project, feature and spec through the writer", () => {
  test("deleting a waiting environment clears its state and ignores its late run completion", async () => {
    const { environmentsRepository } =
      await import("../../src/infra/repositories/environments");
    const { specEnvironmentsRepository } =
      await import("../../src/infra/repositories/spec-environments");
    const { resolveRunEnvironment } =
      await import("../../src/core/environments");
    const { projectOverview } = await import("../../src/core/jobs/overview");
    const { runsDir } = await import("../../src/core/paths");
    const projectId = await createProject("Removed publish environment");
    const environment = await environmentsRepository.create(projectId, {
      name: "Preview",
      baseUrl: "https://app.example.com",
      allowedOrigins: [],
      credentialOverrides: {},
    });
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Store",
      ""
    );
    const { spec } = await createSpec(
      projectId,
      feature.id,
      "Open application"
    );
    const snapshot = await writer.readProjectSpecFiles(projectId);
    const input = {
      ...requireValue(snapshot.specs[0]),
      baseRevision: requireValue(snapshot.specs[0]).revision,
      feature: requireValue(snapshot.features[0]),
    };
    await writer.publishSpecsInRepo(projectId, environment.id, [input]);
    const run = await runsRepository.createRun({
      specId: spec.id,
      sourceHash: spec.sourceHash,
      commitSha: await repoGit.getHeadSha(projectId),
      awaitingDeploy: true,
      environment: await resolveRunEnvironment(projectId, environment.name),
    });
    await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
    await fs.writeFile(
      path.join(runsDir, run.id, "spec.yml"),
      input.files["spec.yml"]
    );
    await runsRepository.finishRun(
      run.id,
      "failed",
      1,
      "Deployment is unavailable"
    );
    assert.equal(
      await (async () => {
        const awaitedResult5248 = await (async () => {
          const awaitedValue5064 = await projectOverview(projectId);
          return awaitedValue5064.specHealth[spec.id];
        })();
        return awaitedResult5248?.status;
      })(),
      "awaiting_deploy"
    );
    await environmentsRepository.delete(environment.id);
    assert.equal(
      await (async () => {
        const awaitedResult5545 = await specsRepository.getSpec(spec.id);
        return awaitedResult5545?.status;
      })(),
      "unverified"
    );
    assert.equal(
      await (async () => {
        const awaitedResult5645 = await (async () => {
          const awaitedValue5340 = await projectOverview(projectId);
          return awaitedValue5340.specHealth[spec.id];
        })();
        return awaitedResult5645?.status;
      })(),
      "not_checked"
    );
    await specEnvironmentsRepository.set(spec, environment.id, "passed");
    assert.deepEqual(await specEnvironmentsRepository.list(spec), []);
    assert.equal(
      await (async () => {
        const awaitedResult6026 = await specsRepository.getSpec(spec.id);
        return awaitedResult6026?.status;
      })(),
      "unverified"
    );
    const head = await repoGit.getHeadSha(projectId);
    await assert.rejects(
      () => writer.publishSpecsInRepo(projectId, environment.id, [input]),
      /environment was removed/u
    );
    assert.equal(await repoGit.getHeadSha(projectId), head);
  });

  test("publishing retries when a moved Spec was absent from its acquired locks", async () => {
    const { ResourceBusyError } =
      await import("../../src/core/specs/lifecycle");
    const { environmentsRepository } =
      await import("../../src/infra/repositories/environments");
    const { reindexProjectUnlocked } =
      await import("../../src/core/repo/indexer");
    const projectId = await createProject("Concurrent Spec move");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Store",
      ""
    );
    const { spec } = await createSpec(
      projectId,
      feature.id,
      "Open application"
    );
    const snapshot = await writer.readProjectSpecFiles(projectId);
    const pathAfterMove = "specs/store/moved-application";
    const input = {
      path: pathAfterMove,
      baseRevision: requireValue(snapshot.specs[0]).revision,
      files: requireValue(snapshot.specs[0]).files,
      feature: requireValue(snapshot.features[0]),
    };
    const list = specsRepository.listSpecs;
    let moved = false;
    specsRepository.listSpecs = async function listSpecs(id) {
      const rows = await list.call(this, id);
      if (id === projectId && !moved) {
        moved = true;
        await repoGit.withRepoLock(projectId, async () => {
          await fs.rename(
            path.join(repoGit.getRepoDir(projectId), spec.path),
            path.join(repoGit.getRepoDir(projectId), pathAfterMove)
          );
          await repoGit.commitAll(projectId, "spec: move");
          await reindexProjectUnlocked(projectId);
        });
      }
      return rows;
    };
    const environment = requireValue(
      await (async () => {
        const awaitedValue7562 = await environmentsRepository.list(projectId);
        return awaitedValue7562[0];
      })()
    );
    try {
      await assert.rejects(
        () => writer.publishSpecsInRepo(projectId, environment.id, [input]),
        ResourceBusyError
      );
      assert.equal(
        await (async () => {
          const awaitedResult8379 = await specsRepository.getSpec(spec.id);
          return awaitedResult8379?.status;
        })(),
        "unverified"
      );
    } finally {
      specsRepository.listSpecs = list;
    }
    const result = await writer.publishSpecsInRepo(projectId, environment.id, [
      input,
    ]);
    assert.equal(result.specs[0]?.id, spec.id);
    assert.equal(result.specs[0]?.status, "awaiting_deploy");
  });

  test("CLI publishing records the environment and rejects stale batches before writing", async () => {
    const { environmentsRepository } =
      await import("../../src/infra/repositories/environments");
    const { specEnvironmentsRepository } =
      await import("../../src/infra/repositories/spec-environments");
    const { withActor } = await import("../../src/core/accounts/audit");
    const { serializeSpecYaml } = await import("@specbook/runtime/yaml");
    const projectId = await createProject("CLI publishing");
    const environment = requireValue(
      await (async () => {
        const awaitedValue8705 = await environmentsRepository.list(projectId);
        return awaitedValue8705[0];
      })()
    );
    const source = serializeSpecYaml({
      title: "Open application",
      description: "",
      humanSpec: HUMAN_SPEC,
    });
    const input = {
      path: "specs/store/open-application",
      baseRevision: null,
      files: { "spec.yml": source, "spec.ts": VALID_SPEC },
      feature: {
        path: "specs/store",
        source: "title: Store\ndescription: Browsing\n",
      },
    };
    const published = await withActor(
      {
        id: null,
        name: "CLI Developer",
        email: "cli@example.com",
        kind: "user",
      },
      () => writer.publishSpecsInRepo(projectId, environment.id, [input])
    );
    assert.equal(published.specs[0]?.status, "awaiting_deploy");
    assert.equal(
      await repoGit
        .getProjectGit(projectId)
        .raw(["log", "-1", "--format=%an <%ae>"]),
      "CLI Developer <cli@example.com>\n"
    );
    assert.equal(
      await repoGit.getProjectGit(projectId).raw(["log", "-1", "--format=%s"]),
      "spec: publish 1 from CLI\n"
    );
    const snapshot = await writer.readProjectSpecFiles(projectId);
    assert.deepEqual(snapshot.features, [input.feature]);
    assert.deepEqual(snapshot.specs, [
      {
        path: input.path,
        revision: requireValue(published.specs[0]).revision,
        files: input.files,
      },
    ]);
    const spec = requireValue(
      await specsRepository.getSpec(requireValue(published.specs[0]).id)
    );
    assert.equal(
      await (async () => {
        const awaitedResult10925 = await (async () => {
          const awaitedValue10167 = await specEnvironmentsRepository.list(spec);
          return awaitedValue10167[0];
        })();
        return awaitedResult10925?.environmentId;
      })(),
      environment.id
    );
    const unchanged = await writer.publishSpecsInRepo(
      projectId,
      environment.id,
      [{ ...input, baseRevision: requireValue(published.specs[0]).revision }]
    );
    assert.equal(
      unchanged.commitSha,
      published.commitSha,
      "unchanged publishing creates no commit"
    );
    await writer.updateSpecWithLock(spec.id, {
      description: "Changed on the server",
    });
    const head = await repoGit.getHeadSha(projectId);
    const fresh = { ...input, path: "specs/store/another-spec" };
    await assert.rejects(
      () =>
        writer.publishSpecsInRepo(projectId, environment.id, [
          { ...input, baseRevision: requireValue(published.specs[0]).revision },
          fresh,
        ]),
      writer.SpecRevisionConflict
    );
    assert.equal(await repoGit.getHeadSha(projectId), head);
    assert.equal(
      await specsRepository.getSpecByPath(projectId, fresh.path),
      null
    );
    assert.ok(
      await (async () => {
        const awaitedValue11187 = await repoGit
          .getProjectGit(projectId)
          .status();
        return awaitedValue11187.isClean();
      })()
    );
    const current = requireValue(
      await (async () => {
        const awaitedValue11269 = await writer.readProjectSpecFiles(projectId);
        return awaitedValue11269.specs[0];
      })()
    );
    const replacement = await writer.publishSpecsInRepo(
      projectId,
      environment.id,
      [{ ...input, baseRevision: current.revision }]
    );
    assert.equal(replacement.specs[0]?.status, "awaiting_deploy");
    assert.equal(replacement.specs[0]?.revision, published.specs[0]?.revision);
    const invalid = {
      ...fresh,
      files: { ...fresh.files, "spec.ts": "console.log('invalid source');" },
    };
    await assert.rejects(
      () => writer.publishSpecsInRepo(projectId, environment.id, [invalid]),
      /must import|import|test/iu
    );
    assert.equal(
      await specsRepository.getSpecByPath(projectId, fresh.path),
      null
    );
    const apiConflict = await api(
      "POST",
      `/projects/${projectId}/specs/publish`,
      { environment: environment.name, specs: [input] }
    );
    assert.equal(apiConflict.status, 409);
    const body = await apiConflict.json();
    assert.equal(body.code, "revision_conflict");
    assert.equal(body.command, "specbook pull");
  });

  test("creating a project initialises the checkout and the canonical bare repository", async () => {
    const projectId = await createProject();
    assert.ok(existsSync(path.join(repoGit.getRepoDir(projectId), ".git")));
    assert.ok(await repoBare.bareExists(projectId));
    assert.equal(
      await repoBare.getBareHeadSha(projectId),
      await repoGit.getHeadSha(projectId)
    );
    const symlinks = await repoGit
      .getProjectGit(projectId)
      .raw(["config", "--get", "core.symlinks"]);
    assert.equal(symlinks.trim(), "false");
  });

  test("the requests need the CSRF header", async () => {
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", baseUrl: "https://x.test" }),
    });
    assert.equal(response.status, 403);
  });

  test("createSpecInRepo writes the files, commits and publishes", async () => {
    const projectId = await createProject();
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Autenticação",
      "Entrar e sair"
    );
    assert.equal(feature.path, "specs/autenticacao");
    const { spec, commitSha } = await createSpec(
      projectId,
      feature.id,
      "Login válido"
    );
    assert.equal(spec.path, "specs/autenticacao/login-valido");
    assert.equal(spec.status, "unverified");
    const root = repoGit.getRepoDir(projectId);
    assert.equal(
      await fs.readFile(path.join(root, spec.path, "spec.ts"), "utf-8"),
      VALID_SPEC
    );
    assert.equal(commitSha, await repoGit.getHeadSha(projectId));
    assert.equal(await repoBare.getBareHeadSha(projectId), commitSha);
    assert.ok(
      await (async () => {
        const awaitedValue14073 = await repoGit
          .getProjectGit(projectId)
          .status();
        return awaitedValue14073.isClean();
      })()
    );
  });

  test("an invalid spec.ts is stored as an invalid Spec", async () => {
    const projectId = await createProject();
    const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
    const evaluate = VALID_SPEC.replace(
      'await page.goto("/");',
      'await page.evaluate("1");'
    );
    const { spec } = await createSpec(
      projectId,
      feature.id,
      "Avalia",
      evaluate
    );
    assert.equal(spec.status, "invalid");
    assert.match(
      spec.invalidReason ?? "",
      /page\.evaluate\(\) is not allowed/u
    );
  });

  test("step() titles that differ from spec.yml make the Spec invalid", async () => {
    const projectId = await createProject();
    const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
    const { spec } = await createSpec(
      projectId,
      feature.id,
      "Passos",
      VALID_SPEC.replace('step("Open the page"', 'step("Outro passo"')
    );
    assert.equal(spec.status, "invalid");
    assert.match(
      spec.invalidReason ?? "",
      /same titles and order as spec\.yml/u
    );
  });

  test("a manual Spec starts from a valid template", async () => {
    const { createManualSpec } = await import("../../src/core/repo/manual");
    const projectId = await createProject();
    const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
    const spec = await createManualSpec(
      projectId,
      feature.id,
      'Título com "aspas"'
    );
    assert.equal(spec.status, "unverified");
    const source = await fs.readFile(
      path.join(repoGit.getRepoDir(projectId), spec.path, "spec.ts"),
      "utf-8"
    );
    assert.match(source, /^import \{ test, expect \} from "specbook";/u);
  });

  test("a Spec without spec.ts is invalid and can be repaired", async () => {
    const projectId = await createProject();
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Checkout",
      ""
    );
    const { spec } = await createSpec(
      projectId,
      feature.id,
      "Missing implementation"
    );
    await fs.rm(path.join(repoGit.getRepoDir(projectId), spec.path, "spec.ts"));
    await repoGit.commitAll(projectId, "test: remove executable");
    await reindexProject(projectId);
    const invalid = await specsRepository.getSpec(spec.id);
    assert.equal(
      invalid?.invalidReason,
      "This check is incomplete: spec.ts is missing. Repair it in chat."
    );
    const { spec: repaired } = await writer.updateSpecInRepo(
      requireValue(invalid),
      {
        testSource: VALID_SPEC,
      }
    );
    assert.equal(repaired.status, "unverified");
  });

  test("renaming a feature moves its specs and keeps ids, runs and status", async () => {
    const projectId = await createProject();
    const parent = await writer.createFeatureInRepo(
      projectId,
      null,
      "Autenticação",
      ""
    );
    const child = await writer.createFeatureInRepo(
      projectId,
      parent.id,
      "Senha",
      ""
    );
    const { spec } = await createSpec(projectId, parent.id, "Login válido");
    const { spec: nested } = await createSpec(
      projectId,
      child.id,
      "Recuperar senha"
    );
    const run = await runsRepository.createRun({
      specId: spec.id,
      commitSha: await repoGit.getHeadSha(projectId),
      sourceHash: spec.sourceHash,
    });
    await runsRepository.finishRun(run.id, "passed", 1000, null);
    await specsRepository.updateSpecStatus(spec.id, "passed");

    const response = await api("PATCH", `/features/${parent.id}`, {
      title: "Login e sessão",
    });
    assert.equal(response.status, 200);
    const { feature } = (await response.json()) as {
      feature: { path: string; title: string };
    };
    assert.equal(feature.path, "specs/login-e-sessao");

    const moved = await specsRepository.getSpec(spec.id);
    assert.equal(moved?.path, "specs/login-e-sessao/login-valido");
    assert.equal(moved?.status, "passed");
    assert.equal(moved?.featureId, parent.id);
    assert.deepEqual(
      await (async () => {
        const awaitedValue18165 = await runsRepository.listRuns(spec.id);
        return awaitedValue18165.map((item) => item.id);
      })(),
      [run.id]
    );
    assert.equal(
      await (async () => {
        const awaitedResult19725 = await specsRepository.getSpec(nested.id);
        return awaitedResult19725?.path;
      })(),
      "specs/login-e-sessao/senha/recuperar-senha"
    );
    assert.equal(
      await (async () => {
        const awaitedResult19857 = await featuresRepository.getFeature(
          child.id
        );
        return awaitedResult19857?.path;
      })(),
      "specs/login-e-sessao/senha"
    );
    assert.equal(
      await (async () => {
        const awaitedValue18522 = await specsRepository.listSpecs(projectId);
        return awaitedValue18522.length;
      })(),
      2
    );

    const root = repoGit.getRepoDir(projectId);
    assert.ok(!existsSync(path.join(root, "specs", "autenticacao")));
    assert.ok(
      existsSync(
        path.join(root, "specs", "login-e-sessao", "login-valido", "spec.yml")
      )
    );
    assert.ok(
      await (async () => {
        const awaitedValue18839 = await repoGit
          .getProjectGit(projectId)
          .status();
        return awaitedValue18839.isClean();
      })()
    );
  });

  test("a spec directory moved by an external commit keeps its id on reindex", async () => {
    const projectId = await createProject();
    const from = await writer.createFeatureInRepo(
      projectId,
      null,
      "Carrinho",
      ""
    );
    const { spec } = await createSpec(projectId, from.id, "Adicionar item");
    await specsRepository.updateSpecStatus(spec.id, "failed");

    const git = repoGit.getProjectGit(projectId);
    const root = repoGit.getRepoDir(projectId);
    await fs.mkdir(path.join(root, "specs", "checkout"));
    await git.raw([
      "mv",
      "specs/carrinho/adicionar-item",
      "specs/checkout/adicionar-item",
    ]);
    await git.commit("move spec outside Specbook");

    await reindexProject(projectId);
    const moved = await specsRepository.getSpec(spec.id);
    assert.equal(moved?.path, "specs/checkout/adicionar-item");
    assert.equal(
      moved?.status,
      "failed",
      "content did not change, so the status stays"
    );
    const newFeature = await featuresRepository.getFeatureByPath(
      projectId,
      "specs/checkout"
    );
    assert.equal(moved?.featureId, newFeature?.id);
    assert.equal(newFeature?.title, "Checkout");
    assert.equal(
      await (async () => {
        const awaitedValue20132 = await specsRepository.listSpecs(projectId);
        return awaitedValue20132.length;
      })(),
      1
    );
  });

  test("a spec.yml that is a symbolic link makes the spec invalid on reindex", async () => {
    const projectId = await createProject();
    const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
    const { spec } = await createSpec(projectId, feature.id, "Spec");
    const outside = tempDir();
    await fs.writeFile(path.join(outside, "stolen.yml"), "title: segredo\n");
    const yamlPath = path.join(
      repoGit.getRepoDir(projectId),
      spec.path,
      "spec.yml"
    );
    await fs.rm(yamlPath);
    await fs.symlink(path.join(outside, "stolen.yml"), yamlPath);

    const result = await reindexProject(projectId);
    assert.deepEqual(result.invalidSpecs, [spec.id]);
    const invalid = await specsRepository.getSpec(spec.id);
    assert.equal(invalid?.status, "invalid");
    assert.match(invalid?.invalidReason ?? "", /symbolic link/u);
    assert.notEqual(invalid?.title, "segredo", "the link target is never read");
    const detail = await api("GET", `/specs/${spec.id}`);
    assert.ok(
      !(await (async () => {
        const awaitedValue21236 = await detail.text();
        return awaitedValue21236.includes("segredo");
      })()),
      "the API never serves the link target"
    );
  });

  test("deleting a project removes its directories without committing or pushing", async () => {
    const projectId = await createProject();
    const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
    await createSpec(projectId, feature.id, "Spec");

    const checkoutDir = repoGit.getRepoDir(projectId);
    const bareDir = repoBare.getBareRepoDir(projectId);
    const calls: string[] = [];
    const originals = {
      commitAll: repoGit.commitAll,
    };
    repoGit.commitAll = (...args) => {
      try {
        calls.push("commitAll");
        return Promise.resolve(originals.commitAll.apply(repoGit, args));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    try {
      const response = await api("DELETE", `/projects/${projectId}`);
      assert.equal(response.status, 204);
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    } finally {
      Object.assign(repoGit, { commitAll: originals.commitAll });
    }
    assert.deepEqual(calls, []);
    assert.equal(await projectsRepository.getProject(projectId), null);
    assert.deepEqual(await specsRepository.listSpecs(projectId), []);
    assert.deepEqual(await featuresRepository.listFeatures(projectId), []);
    assert.ok(!existsSync(checkoutDir));
    assert.ok(!existsSync(bareDir));
    assert.equal(
      await (async () => {
        const awaitedValue22581 = await api("DELETE", `/projects/${projectId}`);
        return awaitedValue22581.status;
      })(),
      404
    );
  });
});

describe(
  "chat browser lifetime",
  { skip: process.env.SPECBOOK_TEST_VNC !== "1" },
  () => {
    test(
      "keeps the same live browser after tools finish and between chat turns",
      { timeout: 90_000 },
      async () => {
        const { createChatsRouter } =
          await import("../../src/infra/web/routes/chats");
        const { createChat } =
          await import("../../src/core/chat/session-store");
        const { tryReserveChatTurn, releaseChatTurn } =
          await import("../../src/core/chat/chat-registry");
        const {
          getOrCreateChatBrowser,
          beginChatBrowserTool,
          endChatBrowserTool,
          closeChatBrowser,
        } = await import("../../src/core/browser/sessions");
        const { readBrowserSnapshot } =
          await import("../../src/core/browser/mcp");
        const { getVncSession } = await import("../../src/core/browser/vnc");
        const projectId = await createProject("Persistent chat browser");
        const chat = await createChat(projectId);
        const chatApp = new Hono().route("/", createChatsRouter());
        const view = async () => {
          const response = await chatApp.request(`/chats/${chat.id}`);
          assert.equal(response.status, 200);
          return response.json();
        };
        try {
          assert.equal(
            await (async () => {
              const awaitedValue23994 = await view();
              return awaitedValue23994.vncSessionId;
            })(),
            null
          );
          assert.equal(tryReserveChatTurn(chat.id), true);
          const browser = await getOrCreateChatBrowser(chat.id, [
            "https://app.example.com",
          ]);
          await browser.mcp.ensureBrowser();
          beginChatBrowserTool(chat.id, "browser_snapshot");
          assert.equal(
            await (async () => {
              const awaitedValue24337 = await view();
              return awaitedValue24337.vncSessionId;
            })(),
            browser.vnc.id
          );
          await readBrowserSnapshot(browser.mcp);
          endChatBrowserTool(chat.id, "browser_snapshot");
          assert.equal(
            await (async () => {
              const awaitedValue24528 = await view();
              return awaitedValue24528.vncSessionId;
            })(),
            browser.vnc.id,
            "ending a tool does not remove the live browser"
          );
          releaseChatTurn(chat.id);
          assert.equal(
            await (async () => {
              const awaitedValue24718 = await view();
              return awaitedValue24718.busy;
            })(),
            false
          );
          assert.equal(
            await (async () => {
              const awaitedValue24783 = await view();
              return awaitedValue24783.vncSessionId;
            })(),
            browser.vnc.id,
            "the browser remains visible after the reply"
          );
          assert.equal(tryReserveChatTurn(chat.id), true);
          const nextBrowser = await getOrCreateChatBrowser(chat.id, [
            "https://app.example.com",
          ]);
          assert.equal(
            nextBrowser.vnc.id,
            browser.vnc.id,
            "the next turn reuses the browser"
          );
          await readBrowserSnapshot(nextBrowser.mcp);
          releaseChatTurn(chat.id);
          await closeChatBrowser(chat.id);
          assert.equal(getVncSession(browser.vnc.id), null);
          assert.equal(
            await (async () => {
              const awaitedValue25467 = await view();
              return awaitedValue25467.vncSessionId;
            })(),
            null,
            "explicit cleanup releases the session"
          );
        } finally {
          releaseChatTurn(chat.id);
          await closeChatBrowser(chat.id);
          await api("DELETE", `/projects/${projectId}`);
        }
      }
    );

    test(
      "follows a sign-in redirect to an origin the environment trusts, and to no other",
      { timeout: 90_000 },
      async () => {
        const { createServer } = await import("node:http");
        const { createChat } =
          await import("../../src/core/chat/session-store");
        const { chatNavigationOrigins } =
          await import("../../src/core/chat/discovery-policy");
        const { getOrCreateChatBrowser, closeChatBrowser } =
          await import("../../src/core/browser/sessions");
        const { getActiveTabUrl, readBrowserSnapshot } =
          await import("../../src/core/browser/mcp");
        const { resolveRunEnvironment } =
          await import("../../src/core/environments");
        const { environmentsRepository } =
          await import("../../src/infra/repositories/environments");
        const listen = async (handler: Parameters<typeof createServer>[1]) => {
          const server = createServer(handler);
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          return {
            server,
            origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          };
        };
        const provider = await listen((_request, response) => {
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end("<h1>Identity provider sign in</h1>");
        });
        const application = await listen((_request, response) => {
          response
            .writeHead(302, { Location: `${provider.origin}/realms/demo/auth` })
            .end();
        });
        const projectId = await createProject("Chat browser sign-in redirect");
        const chat = await createChat(projectId);
        try {
          const startUrl = `${application.origin}/`;
          const production = requireValue(
            await (async () => {
              const awaitedValue27631 =
                await environmentsRepository.list(projectId);
              return awaitedValue27631[0];
            })()
          );
          const untrusted = chatNavigationOrigins(
            startUrl,
            await resolveRunEnvironment(projectId),
            []
          );
          assert.ok(!untrusted.includes(provider.origin));
          const blocked = await getOrCreateChatBrowser(chat.id, untrusted);
          await blocked.mcp.ensureBrowser();
          await blocked.mcp.navigate(startUrl).catch(() => {
            /* Intentionally ignore this best-effort operation. */
          });
          assert.doesNotMatch(
            await readBrowserSnapshot(blocked.mcp),
            /Identity provider sign in/u
          );

          await environmentsRepository.update(production, {
            ...production,
            allowedOrigins: [provider.origin],
          });
          const trusted = chatNavigationOrigins(
            startUrl,
            await resolveRunEnvironment(projectId),
            []
          );
          assert.ok(trusted.includes(provider.origin));
          const browser = await getOrCreateChatBrowser(chat.id, trusted);
          await browser.mcp.ensureBrowser();
          await browser.mcp.navigate(startUrl);
          assert.equal(
            new URL(requireValue(await getActiveTabUrl(browser.mcp))).origin,
            provider.origin
          );
          assert.match(
            await readBrowserSnapshot(browser.mcp),
            /Identity provider sign in/u
          );
        } finally {
          await closeChatBrowser(chat.id);
          await api("DELETE", `/projects/${projectId}`);
          application.server.close();
          provider.server.close();
        }
      }
    );
  }
);

describe("first-run setup", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
  const setupApp = async function setupApp() {
    const { createSetupRouter } =
      await import("../../src/infra/web/routes/setup");
    const { createSettingsRouter } =
      await import("../../src/infra/web/routes/settings");
    const { createProjectContextsRouter } =
      await import("../../src/infra/web/routes/project-contexts");
    const { handleRequestError } = await import("../../src/infra/web/errors");
    const setup = new Hono();
    setup.use("*", async (c, next) => {
      c.set("user", {
        id: "setup-admin",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        passwordHash: null,
        disabledAt: null,
        createdAt: "",
        updatedAt: "",
      });
      // oxlint-disable-next-line node/callback-return -- The awaited Hono middleware or HTTP helper is not a Node error-first callback.
      await next();
    });
    setup.onError(handleRequestError);
    setup.route("/", createSetupRouter());
    setup.route("/", createSettingsRouter());
    setup.route("/", createProjectContextsRouter());
    return setup;
  };

  test("demo creates an ordinary project with public credentials and discovery requires a connected model", async () => {
    const setup = await setupApp();
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    const { listCredentialValues, listSecretValues } =
      await import("../../src/core/credentials/profiles");
    const { projectContextsRepository } =
      await import("../../src/infra/repositories/project-contexts");
    const { chatsRepository } =
      await import("../../src/infra/repositories/chats");
    await settingsRepository.updateLlmSettings({ provider: "", model: "" });
    const status = await (async () => {
      const awaitedValue30911 = await setup.request("/setup/status");
      return awaitedValue30911.json();
    })();
    assert.equal(status.needsAdmin, true);
    assert.equal(status.modelReady, false);
    assert.equal(status.completed, false);
    const response = await setup.request("/setup/demo", { method: "POST" });
    assert.equal(response.status, 201);
    const { project } = await response.json();
    assert.equal(project.baseUrl, "https://www.saucedemo.com");
    assert.equal(await repoBare.bareExists(project.id), true);
    assert.deepEqual(
      await (async () => {
        const awaitedValue31407 = await listCredentialValues(project.id);
        return awaitedValue31407.map(({ field, value }) => ({
          field,
          value,
        }));
      })(),
      [
        { field: "username", value: "standard_user" },
        { field: "password", value: "secret_sauce" },
      ]
    );
    assert.deepEqual(
      await (async () => {
        const awaitedValue31678 = await listSecretValues(project.id);
        return awaitedValue31678.map(({ field }) => field);
      })(),
      ["password"]
    );
    assert.deepEqual(await chatsRepository.listChatRows(project.id), []);
    const discovery = await setup.request(
      `/projects/${project.id}/context-discoveries`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }
    );
    assert.equal(discovery.status, 409);
    assert.match(
      await (async () => {
        const awaitedValue32127 = await discovery.json();
        return awaitedValue32127.error;
      })(),
      /Connect a model in global Settings/u
    );
    assert.equal(
      await projectContextsRepository.getActiveProjectContextDraft(project.id),
      null
    );
  });

  test("the LLM installation ID is stable under concurrent creation and persists across processes", async () => {
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    const { db } = await import("../../src/infra/db/client");
    const { appSettings } = await import("../../src/infra/db/schema");
    const { eq } = await import("drizzle-orm");
    const { backendRoot } = await import("../../src/core/paths");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await db
      .update(appSettings)
      .set({ llmDeviceId: null })
      .where(eq(appSettings.id, 1));
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => settingsRepository.getLlmDeviceId())
    );
    assert.equal(new Set(ids).size, 1);
    assert.match(
      ids[0],
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
    );
    const [stored] = await db
      .select({ deviceId: appSettings.llmDeviceId })
      .from(appSettings)
      .where(eq(appSettings.id, 1));
    assert.equal(stored.deviceId, ids[0]);
    const script = `
            const { settingsRepository } = await import('./src/infra/repositories/settings.ts');
            process.stdout.write(await settingsRepository.getLlmDeviceId());
        `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: backendRoot, env: process.env, timeout: 10_000 }
    );
    assert.equal(stdout, ids[0]);
    assert.equal(await settingsRepository.getLlmDeviceId(), ids[0]);
  });

  test("LLM settings expose provider authentication methods and support OpenAI subscription login", async (t) => {
    const setup = await setupApp();
    const { modelRuntimePromise } = await import("../../src/core/llm/runtime");
    const runtime = await modelRuntimePromise;
    const response = await setup.request("/settings/llm");
    assert.equal(response.status, 200);
    const { providers } = (await response.json()) as {
      providers: { id: string; authMethods: string[] }[];
    };
    const openai = providers.find((provider) => provider.id === "openai");
    const codex = providers.find((provider) => provider.id === "openai-codex");
    assert.ok(openai);
    assert.ok(codex);
    assert.deepEqual(
      new Set(openai.authMethods),
      new Set(["oauth", "api_key"])
    );
    assert.deepEqual(codex.authMethods, ["oauth"]);

    const login = t.mock.method(
      runtime,
      "login",
      (
        provider: string,
        type: string,
        interaction: Parameters<typeof runtime.login>[2],
        options: Parameters<typeof runtime.login>[3]
      ) => {
        try {
          assert.equal(provider, "openai");
          assert.equal(type, "oauth");
          assert.ok(interaction.signal instanceof AbortSignal);
          assert.ok(options?.getDeviceId);
          const deviceId = options.getDeviceId();
          assert.match(
            deviceId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
          );
          assert.equal(options.getDeviceId(), deviceId);
          interaction.notify({
            type: "auth_url",
            url: "https://auth.example.com/sign-in",
          });

          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      }
    );
    const started = await setup.request(
      "/settings/llm/providers/openai/oauth/start",
      { method: "POST" }
    );
    assert.equal(started.status, 200);
    const { sessionId } = (await started.json()) as { sessionId: string };
    assert.match(sessionId, /^[0-9a-f-]{36}$/u);
    let result: { status: string; url?: string } | undefined;
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const polled = await setup.request(
        `/settings/llm/providers/openai/oauth/poll?sessionId=${sessionId}`
      );
      assert.equal(polled.status, 200);
      result = (await polled.json()) as { status: string; url?: string };
      if (result.status !== "pending") {
        break;
      }
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    /* oxlint-enable no-await-in-loop */
    assert.deepEqual(result, {
      status: "done",
      url: "https://auth.example.com/sign-in",
    });
    assert.equal(login.mock.callCount(), 1);

    const apiOnly = providers.find(
      (provider) =>
        provider.authMethods.length === 1 &&
        provider.authMethods[0] === "api_key"
    );
    assert.ok(apiOnly);
    const unsupported = await setup.request(
      `/settings/llm/providers/${apiOnly.id}/oauth/start`,
      { method: "POST" }
    );
    assert.equal(unsupported.status, 400);
    assert.match(
      await (async () => {
        const awaitedValue36956 = await unsupported.json();
        return awaitedValue36956.error;
      })(),
      /OAuth is not supported/u
    );
    assert.equal(login.mock.callCount(), 1);
  });

  test(
    "OpenAI's real subscription SDK opens sign-in with a persistent installation ID without token requests",
    { timeout: 15_000 },
    async (t) => {
      const pollUntil = async function pollUntil(
        sessionId: string,
        ready: (result: OAuthResult) => boolean
      ): Promise<OAuthResult> {
        const deadline = Date.now() + 3000;
        /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
        while (Date.now() < deadline) {
          const response = await setup.request(
            `/settings/llm/providers/openai/oauth/poll?sessionId=${sessionId}`
          );
          assert.equal(response.status, 200);
          const result = (await response.json()) as OAuthResult;
          if (ready(result)) {
            return result;
          }
          assert.equal(
            result.status,
            "pending",
            result.error ?? "Sign-in ended before the expected event"
          );
          // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        /* oxlint-enable no-await-in-loop */
        assert.fail(
          "OpenAI sign-in did not produce the expected event in time"
        );
      };

      const setup = await setupApp();
      const { settingsRepository } =
        await import("../../src/infra/repositories/settings");
      const deviceId = await settingsRepository.getLlmDeviceId();
      const fetch = t.mock.method(globalThis, "fetch", () => {
        try {
          throw new Error(
            "The sign-in startup test must not make token requests"
          );
        } catch (error) {
          return Promise.reject(error);
        }
      });
      interface OAuthResult {
        status: "pending" | "done" | "error";
        url?: string;
        prompt?: { type: string; placeholder?: string };
        error?: string;
      }

      try {
        /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const started = await setup.request(
            "/settings/llm/providers/openai/oauth/start",
            { method: "POST" }
          );
          assert.equal(started.status, 200);
          const { sessionId } = (await started.json()) as { sessionId: string };
          const pending = await pollUntil(sessionId, (result) =>
            Boolean(result.url && result.prompt)
          );
          assert.equal(pending.status, "pending");
          assert.equal(pending.prompt?.type, "manual_code");
          assert.equal(
            pending.prompt?.placeholder,
            "http://127.0.0.1:1455/auth/callback"
          );
          const url = new URL(requireValue(pending.url));
          assert.equal(url.origin, "https://auth.openai.com");
          assert.equal(
            url.searchParams.get("ext_agent_host_id"),
            `urn:uuid:${deviceId}`
          );
          assert.equal(
            url.searchParams.get("resource"),
            "https://api.openai.com/v1"
          );
          assert.equal(
            url.searchParams.get("redirect_uri"),
            "http://127.0.0.1:1455/auth/callback"
          );
          const input = await setup.request(
            "/settings/llm/providers/openai/oauth/input",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId, input: "not-a-callback" }),
            }
          );
          assert.equal(input.status, 200);
          const failed = await pollUntil(
            sessionId,
            (result) => result.status === "error"
          );
          assert.equal(
            failed.error,
            "Paste the complete address from the final sign-in page, then try again."
          );
          assert.equal(await settingsRepository.getLlmDeviceId(), deviceId);
        }
        /* oxlint-enable no-await-in-loop */
        assert.equal(fetch.mock.callCount(), 0);
      } finally {
        await setup.request("/settings/llm/providers/openai", {
          method: "DELETE",
        });
      }
    }
  );

  test("test connection makes a bounded request and presents provider errors without raw secrets", async (t) => {
    const setup = await setupApp();
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    const { modelRegistryPromise, modelRuntimePromise } =
      await import("../../src/core/llm/runtime");
    const missing = await setup.request("/settings/llm/test", {
      method: "POST",
    });
    assert.equal(missing.status, 400);
    assert.equal(
      await (async () => {
        const awaitedValue41335 = await missing.json();
        return awaitedValue41335.code;
      })(),
      "model_not_configured"
    );
    const registry = await modelRegistryPromise;
    const runtime = await modelRuntimePromise;
    const [model] = registry.getAll();
    assert.ok(model);
    await settingsRepository.updateLlmSettings({
      provider: model.provider,
      model: model.id,
    });
    t.mock.method(registry, "hasConfiguredAuth", () => true);
    let called = 0;
    t.mock.method(
      runtime,
      "completeSimple",
      (
        _model: unknown,
        context: Parameters<typeof runtime.completeSimple>[1],
        options: Parameters<typeof runtime.completeSimple>[2]
      ) => {
        try {
          called += 1;
          assert.equal(context.messages[0].content, "Reply with OK.");
          assert.equal(options?.maxTokens, 16);
          assert.ok(options?.signal instanceof AbortSignal);
          if (called === 1) {
            throw new Error("401 invalid API key sk-never-expose");
          }
          return Promise.resolve({ stopReason: "stop" });
        } catch (error) {
          return Promise.reject(error);
        }
      }
    );
    try {
      const failed = await setup.request("/settings/llm/test", {
        method: "POST",
      });
      assert.equal(failed.status, 400);
      const body = await failed.json();
      assert.equal(body.code, "provider_auth");
      assert.match(body.nextStep, /reconnect/u);
      assert.doesNotMatch(JSON.stringify(body), /sk-never-expose/u);
      const passed = await setup.request("/settings/llm/test", {
        method: "POST",
      });
      assert.equal(passed.status, 200);
      assert.equal(
        await (async () => {
          const awaitedValue42842 = await passed.json();
          return awaitedValue42842.ok;
        })(),
        true
      );
      assert.equal(
        await (async () => {
          const awaitedValue42903 = await (async () => {
            const awaitedValue45355 = await setup.request("/setup/status");
            return awaitedValue45355.json();
          })();
          return awaitedValue42903.modelReady;
        })(),
        true
      );
    } finally {
      await settingsRepository.updateLlmSettings({ provider: "", model: "" });
    }
  });

  test("readiness checks both Chromium builds and reports missing programs with installation instructions", async (t) => {
    const setup = await setupApp();
    const access = fs.access.bind(fs);
    t.mock.method(
      fs,
      "access",
      (
        file: Parameters<typeof fs.access>[0],
        mode: Parameters<typeof fs.access>[1]
      ) => {
        try {
          if (/chrome|chromium|Xvfb|x11vnc/u.test(String(file))) {
            throw new Error("ENOENT /home/server/private");
          }
          return Promise.resolve(access(file, mode));
        } catch (error) {
          return Promise.reject(error);
        }
      }
    );
    const response = await setup.request("/ready");
    assert.equal(response.status, 503);
    const status = await response.json();
    assert.equal(status.ok, false);
    assert.deepEqual(
      status.checks.map((check: { id: string }) => check.id),
      ["database", "storage", "chromium", "mcp_chromium", "xvfb", "x11vnc"]
    );
    assert.equal(status.checks[0].ok, true);
    assert.equal(status.checks[1].ok, true);
    assert.equal(status.checks[2].ok, false);
    assert.equal(status.checks[3].ok, false);
    assert.ok(status.checks[4].nextStep);
    assert.doesNotMatch(JSON.stringify(status), /private|ENOENT/u);
    const { storageRoot } = await import("../../src/core/paths");
    assert.equal(
      await (async () => {
        const awaitedValue44364 = await fs.readdir(storageRoot);
        return awaitedValue44364.some((name) => name.startsWith(".ready-"));
      })(),
      false
    );
  });
});

describe("autonomous job proposals", () => {
  test(
    "a wake-up during a drain requests another queue pass",
    { timeout: 5000 },
    async (t) => {
      const { jobsRepository } =
        await import("../../src/infra/repositories/jobs");
      const { drainJobs } = await import("../../src/core/jobs/worker");
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
      let release = () => {};
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
      let entered = () => {};
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
      let rerun = () => {};
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      const firstRead = new Promise<void>((resolve) => {
        entered = resolve;
      });
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      const secondRead = new Promise<void>((resolve) => {
        rerun = resolve;
      });
      let reads = 0;
      t.mock.method(jobsRepository, "queued", async () => {
        reads += 1;
        if (reads === 1) {
          entered();
          await gate;
        } else {
          rerun();
        }
        return [];
      });
      const draining = drainJobs();
      await firstRead;
      try {
        await drainJobs();
      } finally {
        release();
      }
      await draining;
      await secondRead;
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      assert.equal(reads, 2);
    }
  );

  test("work requested from a chat gets the chat's permissions; autonomous exploration stays read-only", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { createJobPolicy } = await import("../../src/core/jobs/policy");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { Type } = await import("typebox");
    const projectId = await createProject("Requested job permissions");
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const [trigger, scope, direct] of [
      ["manual", "spec", true],
      ["steward", "explore", false],
    ] as const) {
      const row = await jobsRepository.create({
        projectId,
        chatId: crypto.randomUUID(),
        kind: "explore",
        trigger,
        goal: "Create the requested Spec",
        limits: jobLimitsSchema.parse({}),
      });
      const job = requireValue(await jobsRepository.claim(row.id));
      const policy = createJobPolicy(job, () => {});
      assert.equal(policy.browserScope, scope);
      assert.equal(policy.prompt.includes("Requested in a chat"), direct);
      let ran = false;
      const tool = requireValue(
        policy.tools([
          {
            name: "create_spec",
            label: "create_spec",
            description: "test",
            parameters: Type.Object({}),
            execute() {
              ran = true;
              return Promise.resolve({
                content: [{ type: "text" as const, text: "created" }],
                details: undefined,
              });
            },
          },
        ])[0]
      );
      await tool
        .execute("call", {}, undefined, undefined, {} as never)
        .catch(() => null);
      assert.equal(ran, direct);
      await jobsRepository.update(job.id, { status: "cancelled" });
    }
    /* oxlint-enable no-await-in-loop */
  });

  test("job handlers preserve restrictions and use typed tool failures", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { createJobPolicy } = await import("../../src/core/jobs/policy");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { Type } = await import("typebox");
    const projectId = await createProject("Typed job policy");
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const [kind, name, message] of [
      ["coverage", "create_spec", /propose_spec_batch/u],
      ["generate_spec", "update_spec", /selected Spec/u],
    ] as const) {
      const row = await jobsRepository.create({
        projectId,
        chatId: crypto.randomUUID(),
        kind,
        trigger: "manual",
        goal: "Scoped work",
        limits: jobLimitsSchema.parse({}),
      });
      const job = requireValue(await jobsRepository.claim(row.id));
      const tool = requireValue(
        createJobPolicy(job, () => {}).tools([
          {
            name,
            label: name,
            description: "test",
            parameters: Type.Object({}),
            execute() {
              try {
                throw new Error("Original mutation must not run");
              } catch (error) {
                return Promise.reject(error);
              }
            },
          },
        ])[0]
      );
      await assert.rejects(
        () => tool.execute("call", {}, undefined, undefined, {} as never),
        message
      );
      assert.equal(
        await (async () => {
          const awaitedResult51319 = await jobsRepository.get(job.id);
          return awaitedResult51319?.actionsUsed;
        })(),
        1
      );
      await jobsRepository.update(job.id, { status: "cancelled" });
    }
    /* oxlint-enable no-await-in-loop */
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const code of ["environment", "infrastructure"] as const) {
      const row = await jobsRepository.create({
        projectId,
        chatId: crypto.randomUUID(),
        trigger: "manual",
        goal: "Confirm access",
        limits: jobLimitsSchema.parse({}),
      });
      const job = requireValue(await jobsRepository.claim(row.id));
      let aborted = false;
      const tool = requireValue(
        createJobPolicy(job, () => {
          aborted = true;
        }).tools([
          {
            name: "toString",
            label: "toString",
            description: "test",
            parameters: Type.Object({}),
            execute() {
              try {
                return Promise.resolve({
                  isError: true,
                  errorCode: code,
                  content: [
                    {
                      type: "text" as const,
                      text:
                        code === "environment"
                          ? "No LLM model; Xvfb failed"
                          : "Access needed",
                    },
                  ],
                  details: undefined,
                });
              } catch (error) {
                return Promise.reject(error);
              }
            },
          },
        ])[0]
      );
      await tool.execute("call", {}, undefined, undefined, {} as never);
      const changed = requireValue(await jobsRepository.get(job.id));
      assert.equal(changed.errorCode, code);
      assert.equal(aborted, code === "infrastructure");
      assert.equal(
        changed.status,
        code === "infrastructure" ? "queued" : "running"
      );
      await jobsRepository.update(job.id, { status: "cancelled" });
    }
    /* oxlint-enable no-await-in-loop */
  });

  test("Inbox queries isolate jobs, kinds and statuses", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const projectId = await createProject("Inbox query scope");
    const first = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "manual",
      goal: "First",
      limits: jobLimitsSchema.parse({}),
    });
    const second = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "manual",
      goal: "Second",
      limits: jobLimitsSchema.parse({}),
    });
    const question = await jobsRepository.addItem({
      jobId: first.id,
      projectId,
      kind: "question",
      title: "First question",
      body: "Question",
    });
    const note = await jobsRepository.addItem({
      jobId: first.id,
      projectId,
      kind: "note",
      title: "First note",
      body: "Note",
    });
    await jobsRepository.addItem({
      jobId: second.id,
      projectId,
      kind: "question",
      title: "Second question",
      body: "Question",
    });
    await jobsRepository.updateItem(question.id, { status: "answered" });
    assert.deepEqual(
      await (async () => {
        const awaitedValue49998 = await jobsRepository.itemsForJob(first.id, {
          kind: "question",
          statuses: ["answered"],
        });
        return awaitedValue49998.map((item) => item.id);
      })(),
      [question.id]
    );
    assert.deepEqual(
      await (async () => {
        const awaitedValue50213 = await jobsRepository.itemsForJobs(
          projectId,
          [first.id],
          {
            kind: "note",
          }
        );
        return awaitedValue50213.map((item) => item.id);
      })(),
      [note.id]
    );
    assert.equal(
      await (async () => {
        const awaitedValue50396 = await jobsRepository.itemsByKind(
          projectId,
          "question",
          ["pending"]
        );
        return awaitedValue50396.length;
      })(),
      1
    );
    assert.equal(
      await (async () => {
        const awaitedValue50516 = await jobsRepository.itemsForJob(second.id);
        return awaitedValue50516.length;
      })(),
      1
    );
    assert.deepEqual(await jobsRepository.itemsForJobs(projectId, []), []);
    const sourceChatId = crypto.randomUUID();
    await jobsRepository.updateItem(note.id, { payload: { sourceChatId } });
    assert.deepEqual(
      await (async () => {
        const awaitedValue50801 = await jobsRepository.itemsForChat(
          projectId,
          sourceChatId,
          [],
          []
        );
        return awaitedValue50801.map((item) => item.id);
      })(),
      [note.id]
    );
    assert.deepEqual(
      await (async () => {
        const awaitedValue50961 = await jobsRepository.itemsForChat(
          projectId,
          crypto.randomUUID(),
          [],
          [question.id]
        );
        return awaitedValue50961.map((item) => item.id);
      })(),
      [question.id]
    );
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const job of [first, second]) {
      await jobsRepository.update(job.id, { status: "cancelled" });
    }
    /* oxlint-enable no-await-in-loop */
  });

  test("Inbox file previews match the committed bytes for additions and behavior changes", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { proposeMutation, applyProposal } =
      await import("../../src/core/jobs/proposals");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { createJobsRouter } =
      await import("../../src/infra/web/routes/jobs");
    const projectId = await createProject("Review diffs");
    const job = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "manual",
      goal: "Propose coverage",
      limits: jobLimitsSchema.parse({}),
    });
    const router = createJobsRouter();
    const preview = async (id: string) => {
      const response = await router.request(`/projects/${projectId}/overview`);
      assert.equal(response.status, 200);
      const { items } = (await response.json()) as {
        items: {
          id: string;
          payload: {
            files: { path: string; before: string | null; after: string }[];
          };
        }[];
      };
      return requireValue(items.find((item) => item.id === id)).payload.files;
    };
    const featureProposal = await proposeMutation(job, "create_feature", {
      title: "Checkout",
      description: "Coupons: discounts\nPayment",
    });
    const featureFiles = await preview(featureProposal.id);
    assert.equal(featureFiles[0]?.before, null);
    await applyProposal(featureProposal);
    const feature = requireValue(
      await (async () => {
        const awaitedValue52840 =
          await featuresRepository.listFeatures(projectId);
        return awaitedValue52840[0];
      })()
    );
    assert.equal(
      await fs.readFile(
        path.join(repoGit.getRepoDir(projectId), feature.path, "feature.yml"),
        "utf-8"
      ),
      featureFiles[0]?.after
    );
    const proposal = await proposeMutation(job, "create_spec", {
      featureId: feature.id,
      title: "Checkout",
      description: "",
      humanSpec: HUMAN_SPEC,
      testSource: VALID_SPEC,
    });
    const added = await preview(proposal.id);
    assert.equal(added.length, 2);
    assert.ok(added.every((file) => file.before === null));
    await applyProposal(proposal);
    const spec = requireValue(
      await (async () => {
        const awaitedValue53481 = await specsRepository.listSpecs(projectId);
        return awaitedValue53481[0];
      })()
    );
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const file of added) {
      assert.equal(
        await fs.readFile(
          path.join(repoGit.getRepoDir(projectId), spec.path, file.path),
          "utf-8"
        ),
        file.after
      );
    }
    /* oxlint-enable no-await-in-loop */
    const yamlFile = path.join(
      repoGit.getRepoDir(projectId),
      spec.path,
      "spec.yml"
    );
    const original = `# Human contract\n${await fs.readFile(yamlFile, "utf-8")}`;
    await fs.writeFile(yamlFile, original);
    await repoGit.commitAll(projectId, "test: annotate contract");
    await reindexProject(projectId);
    const sourceOnly = await proposeMutation(job, "update_spec", {
      specId: spec.id,
      testSource: VALID_SPEC.replace(
        'page.goto("/")',
        'page.goto("/checkout")'
      ),
    });
    const sourceFiles = await preview(sourceOnly.id);
    assert.equal(sourceFiles[0]?.before, original);
    assert.equal(
      sourceFiles[0]?.after,
      original,
      "unchanged YAML retains comments and formatting"
    );
    assert.notEqual(sourceFiles[1]?.before, sourceFiles[1]?.after);
    const behavior = await proposeMutation(job, "update_spec", {
      specId: spec.id,
      humanSpec: { ...HUMAN_SPEC, expectedResult: "the page is shown" },
    });
    const changed = await preview(behavior.id);
    assert.equal(changed[0]?.before, original);
    assert.notEqual(changed[0]?.before, changed[0]?.after);
    const approved = await router.request(
      `/projects/${projectId}/inbox/${behavior.id}/review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }
    );
    assert.equal(approved.status, 200);
    assert.equal(await fs.readFile(yamlFile, "utf-8"), changed[0]?.after);
    assert.deepEqual(
      await preview(behavior.id),
      changed,
      "review history retains the proposal snapshot"
    );
  });

  test("proposals preserve the contract, reject stale edits, and replay approval once", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { proposeMutation, applyProposal } =
      await import("../../src/core/jobs/proposals");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const projectId = await createProject("Job proposals");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Login",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "Login");
    const yamlFile = path.join(
      repoGit.getRepoDir(projectId),
      spec.path,
      "spec.yml"
    );
    const original = `# Contract owned by the human\n${await fs.readFile(yamlFile, "utf-8")}`;
    await fs.writeFile(yamlFile, original);
    await repoGit.commitAll(projectId, "test: add comment");
    await reindexProject(projectId);
    const job = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "manual",
      goal: "Fix implementation",
      limits: jobLimitsSchema.parse({}),
    });
    const head = await repoGit.getHeadSha(projectId);
    const source = VALID_SPEC.replace('page.goto("/")', 'page.goto("/login")');
    const proposal = await proposeMutation(job, "update_spec", {
      specId: spec.id,
      testSource: source,
    });
    assert.equal(await repoGit.getHeadSha(projectId), head);
    assert.equal(await fs.readFile(yamlFile, "utf-8"), original);
    assert.equal(
      await (async () => {
        const awaitedValue57000 = await proposeMutation(job, "update_spec", {
          specId: spec.id,
          testSource: source,
        });
        return awaitedValue57000.id;
      })(),
      proposal.id
    );
    const commit = await applyProposal(proposal);
    assert.notEqual(commit, head);
    assert.equal(await fs.readFile(yamlFile, "utf-8"), original);
    assert.equal(await applyProposal(proposal), commit);
    assert.equal(await repoGit.getHeadSha(projectId), commit);
    const stale = await proposeMutation(job, "update_spec", {
      specId: spec.id,
      testSource: VALID_SPEC,
    });
    await writer.updateSpecWithLock(spec.id, {
      testSource: source.replace("/login", "/other"),
    });
    await assert.rejects(() => applyProposal(stale), /Spec changed/u);
    const other = await createProject("Other project");
    const otherFeature = await writer.createFeatureInRepo(
      other,
      null,
      "Other",
      ""
    );
    const { spec: otherSpec } = await createSpec(
      other,
      otherFeature.id,
      "Other"
    );
    await assert.rejects(
      () =>
        proposeMutation(job, "update_spec", {
          specId: otherSpec.id,
          testSource: source,
        }),
      /not found/u
    );
  });

  test("job policy accounts before tool execution and pauses for credentials", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { createJobPolicy } = await import("../../src/core/jobs/policy");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const projectId = await createProject("Policy");
    const row = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "manual",
      goal: "Inspect",
      limits: jobLimitsSchema.parse({ maxActions: 1 }),
    });
    const job = requireValue(await jobsRepository.claim(row.id));
    let executed = 0;
    let aborted = false;
    const { Type } = await import("typebox");
    const tools = createJobPolicy(job, () => {
      aborted = true;
    }).tools([
      {
        name: "test_tool",
        label: "test_tool",
        description: "test",
        parameters: Type.Object({}),
        execute() {
          try {
            executed += 1;
            return Promise.resolve({ content: [], details: undefined });
          } catch (error) {
            return Promise.reject(error);
          }
        },
      },
    ]);
    const tool = requireValue(tools[0]);
    await tool.execute("1", {}, undefined, undefined, {} as never);
    assert.equal(executed, 1);
    await assert.rejects(
      () => tool.execute("2", {}, undefined, undefined, {} as never),
      /did not reach a confirmed result/iu
    );
    assert.equal(executed, 1);
    assert.ok(aborted);
    assert.equal(
      await (async () => {
        const awaitedResult65047 = await jobsRepository.get(job.id);
        return awaitedResult65047?.status;
      })(),
      "stalled"
    );
    const row2 = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "manual",
      goal: "Credentials",
      limits: jobLimitsSchema.parse({}),
    });
    const job2 = requireValue(await jobsRepository.claim(row2.id));
    let paused = false;
    const credential = requireValue(
      createJobPolicy(job2, () => {
        paused = true;
      }).tools([
        {
          name: "request_credential",
          label: "request",
          description: "test",
          parameters: Type.Object({}),
          execute() {
            try {
              throw new Error("must be intercepted");
            } catch (error) {
              return Promise.reject(error);
            }
          },
        },
      ])[0]
    );
    await credential.execute("1", {}, undefined, undefined, {} as never);
    assert.ok(
      paused,
      "a question aborts the turn even when other tool calls were batched"
    );
    assert.equal(
      await (async () => {
        const awaitedResult65979 = await jobsRepository.get(job2.id);
        return awaitedResult65979?.status;
      })(),
      "blocked"
    );
    assert.equal(
      await (async () => {
        const awaitedResult66060 = await (async () => {
          const awaitedValue60598 = await jobsRepository.inbox(projectId);
          return awaitedValue60598[0];
        })();
        return awaitedResult66060?.kind;
      })(),
      "question"
    );
    await assert.rejects(
      () => credential.execute("2", {}, undefined, undefined, {} as never),
      /paused/u
    );
    await jobsRepository.update(job2.id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    await jobsRepository.recover();
    assert.equal(
      await (async () => {
        const awaitedResult66554 = await jobsRepository.get(job2.id);
        return awaitedResult66554?.status;
      })(),
      "queued"
    );
  });

  test("session restore confirms browser success and cleans up after runtime failures", async () => {
    const { createSessionTools } =
      await import("../../src/core/chat/session-tools");
    const { createProfile } =
      await import("../../src/core/credentials/profiles");
    const { encryptSecret } = await import("../../src/core/credentials/crypto");
    const { isInfrastructureFailure } =
      await import("../../src/core/jobs/presentation-errors");
    const { chatSessionsRepository } =
      await import("../../src/infra/repositories/chat-sessions");
    const projectId = await createProject("Session restore failures");
    const profile = await createProfile(projectId, {
      name: "standard-user",
      fields: [{ key: "password", value: "temporary-password" }],
    });
    await chatSessionsRepository.upsert({
      id: crypto.randomUUID(),
      projectId,
      profileId: profile.id,
      state: encryptSecret(JSON.stringify({ cookies: [], origins: [] })),
      savedAt: new Date().toISOString(),
    });
    const workDir = tempDir();
    let restoreError = true;
    let navigateError = false;
    let activeUrl: string | null = "https://app.example.com/";
    let navigations = 0;
    const mcp = {
      client: {
        async callTool(input: {
          name: string;
          arguments: { filename?: string };
        }) {
          if (input.name === "browser_set_storage_state") {
            assert.deepEqual(
              JSON.parse(
                await fs.readFile(
                  path.join(workDir, requireValue(input.arguments.filename)),
                  "utf-8"
                )
              ),
              { cookies: [], origins: [] }
            );
            return {
              isError: restoreError,
              content: [
                {
                  type: "text",
                  text: restoreError
                    ? "Error: async initializeServer: EROFS: read-only file system, open '/home/server/.cache/ms-playwright/b/browser@123'"
                    : "Restored",
                },
              ],
            };
          }
          assert.equal(input.name, "browser_tabs");
          return {
            content: [
              {
                type: "text",
                text: activeUrl
                  ? `- 0: (current) [Application](${activeUrl})`
                  : "No open tabs",
              },
            ],
          };
        },
      },
      navigate(url: string) {
        try {
          navigations += 1;
          assert.equal(url, "https://app.example.com");
          if (navigateError) {
            throw new Error(
              "browser tool failed: Browser is already in use for /tmp/profile"
            );
          }

          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
    } as unknown as BrowserMcp;
    const tool = requireValue(
      createSessionTools({
        projectId,
        baseUrl: "https://app.example.com",
        mcp,
        workDir,
      }).find((toolInTest) => toolInTest.name === "resume_session")
    );
    const restore = () =>
      tool.execute(
        "restore",
        { profile: profile.name },
        undefined,
        undefined,
        {} as never
      );
    const rejected = await restore();
    assert.equal((rejected as { isError?: boolean }).isError, true);
    assert.equal(navigations, 0);
    assert.doesNotMatch(JSON.stringify(rejected), /Session restored/u);
    assert.match(JSON.stringify(rejected), /EROFS/u);
    assert.equal(isInfrastructureFailure(JSON.stringify(rejected)), true);
    restoreError = false;
    navigateError = true;
    const navigationFailure = await restore();
    assert.equal((navigationFailure as { isError?: boolean }).isError, true);
    assert.doesNotMatch(JSON.stringify(navigationFailure), /Session restored/u);
    assert.equal(
      isInfrastructureFailure(JSON.stringify(navigationFailure)),
      true
    );
    navigateError = false;
    activeUrl = null;
    const unconfirmed = await restore();
    assert.equal((unconfirmed as { isError?: boolean }).isError, true);
    assert.match(
      JSON.stringify(unconfirmed),
      /could not confirm the current page address/u
    );
    activeUrl = "https://other.example.com/";
    assert.match(
      JSON.stringify(await restore()),
      /restored page origin is not allowed/u
    );
    activeUrl = "https://app.example.com/";
    const restored = await restore();
    assert.notEqual((restored as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(restored), /Session restored/u);
    assert.equal(navigations, 4);
    assert.deepEqual(
      await fs.readdir(workDir),
      [],
      "decrypted saved-session files are removed for every outcome"
    );
  });

  test("browser and session infrastructure errors retry without asking for application access", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { createJobPolicy } = await import("../../src/core/jobs/policy");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { bridgeBrowserTools } = await import("../../src/core/browser/mcp");
    const { Type } = await import("typebox");
    const projectId = await createProject("Browser infrastructure retry");
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const name of ["browser_navigate", "resume_session"]) {
      const row = await jobsRepository.create({
        projectId,
        chatId: crypto.randomUUID(),
        trigger: "manual",
        goal: "Confirm inventory order",
        limits: jobLimitsSchema.parse({}),
      });
      const job = requireValue(await jobsRepository.claim(row.id));
      let aborted = false;
      const mcp = {
        tools: [
          {
            name: "browser_navigate",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        client: {
          callTool() {
            try {
              return Promise.resolve({
                isError: true,
                errorCode: "infrastructure",
                content: [
                  {
                    type: "text",
                    text: "Error: async initializeServer: EROFS: read-only file system, open '/home/server/.cache/ms-playwright/b/browser@123'",
                  },
                ],
              });
            } catch (error) {
              return Promise.reject(error);
            }
          },
        },
      } as unknown as BrowserMcp;
      const browser = requireValue(bridgeBrowserTools(mcp, "/tmp")[0]);
      const session = {
        name,
        label: name,
        description: "Restore",
        parameters: Type.Object({}),
        execute() {
          try {
            return Promise.resolve({
              isError: true,
              errorCode: "infrastructure",
              content: [
                {
                  type: "text" as const,
                  text: "resume_session failed: The browser could not confirm the current page address.",
                },
              ],
              details: undefined,
            });
          } catch (error) {
            return Promise.reject(error);
          }
        },
      };
      const tool = requireValue(
        createJobPolicy(job, () => {
          aborted = true;
        }).tools([name === "browser_navigate" ? browser : session])[0]
      );
      const output = await tool.execute(
        "call",
        {},
        undefined,
        undefined,
        {} as never
      );
      assert.equal((output as { isError?: boolean }).isError, true);
      assert.equal(aborted, true);
      const retry = requireValue(await jobsRepository.get(job.id));
      assert.equal(retry.status, "queued");
      assert.equal(retry.infrastructureRetries, 1);
      assert.ok(retry.retryAt);
      assert.equal(retry.safetyRetries, 0);
      assert.deepEqual(await jobsRepository.inbox(projectId), []);
    }
    /* oxlint-enable no-await-in-loop */
  });

  test("startup retires existing browser-fault questions while preserving genuine access questions and an explicit pause", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { startJobWorker, stopJobWorker } =
      await import("../../src/core/jobs/worker");
    const { AGENT_RULES_VERSION } = await import("../../src/core/jobs/policy");
    const projectId = await createProject("Recover browser questions");
    const makeBlocked = async (goal: string, body: string) => {
      const job = await jobsRepository.create({
        projectId,
        chatId: crypto.randomUUID(),
        trigger: "manual",
        goal,
        limits: jobLimitsSchema.parse({}),
      });
      await jobsRepository.update(job.id, { status: "blocked" });
      const question = await jobsRepository.addItem({
        jobId: job.id,
        projectId,
        kind: "question",
        title: goal,
        body,
        payload: { rulesVersion: AGENT_RULES_VERSION },
      });
      return { job, question };
    };
    const internal = await makeBlocked(
      "Access needed to confirm default inventory order",
      "The saved standard-user session restored, but the browser could not confirm or inspect the application page address, so I cannot observe the inventory’s initial product order. Could you restore or allow browser access to https://www.saucedemo.com/ so I can verify the selected Spec’s expected behavior?"
    );
    const credentials = await makeBlocked(
      "Sign-in details needed",
      "The saved session expired. Can you provide a valid account for the app?"
    );
    const paused = await settingsRepository.getAgentPaused();
    await stopJobWorker();
    await settingsRepository.setAgentPaused(true);
    try {
      await startJobWorker();
      const recovered = requireValue(await jobsRepository.get(internal.job.id));
      assert.equal(
        recovered.status,
        "paused",
        "internal recovery respects the user's existing pause"
      );
      assert.equal(recovered.infrastructureRetries, 1);
      assert.equal(
        await (async () => {
          const awaitedResult76589 = await jobsRepository.item(
            internal.question.id
          );
          return awaitedResult76589?.status;
        })(),
        "dismissed"
      );
      assert.equal(
        await (async () => {
          const awaitedResult76705 = await jobsRepository.item(
            internal.question.id
          );
          return awaitedResult76705?.payload.internalRecovery;
        })(),
        true
      );
      assert.equal(
        await (async () => {
          const awaitedResult76843 = await jobsRepository.get(
            credentials.job.id
          );
          return awaitedResult76843?.status;
        })(),
        "blocked"
      );
      assert.equal(
        await (async () => {
          const awaitedResult76954 = await jobsRepository.item(
            credentials.question.id
          );
          return awaitedResult76954?.status;
        })(),
        "pending"
      );
    } finally {
      await stopJobWorker();
      await settingsRepository.setAgentPaused(paused);
    }
  });

  test("concurrent approvals and recovery of a committed proposal produce one commit", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { proposeMutation } = await import("../../src/core/jobs/proposals");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { createJobsRouter } =
      await import("../../src/infra/web/routes/jobs");
    const projectId = await createProject("Approval recovery");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Login",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "Login");
    const job = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "manual",
      goal: "Fix implementation",
      limits: jobLimitsSchema.parse({}),
    });
    const proposal = await proposeMutation(job, "update_spec", {
      specId: spec.id,
      testSource: VALID_SPEC.replace('page.goto("/")', 'page.goto("/login")'),
    });
    const router = createJobsRouter();
    const approve = () =>
      router.request(`/projects/${projectId}/inbox/${proposal.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
    const beforeInTest = await commitCount(projectId);
    const responses = await Promise.all([approve(), approve()]);
    assert.deepEqual(
      responses.map((response) => response.status).toSorted(),
      [200, 409]
    );
    const approved = await jobsRepository.item(proposal.id);
    assert.equal(approved?.status, "approved");
    assert.ok(approved?.commitSha);
    assert.equal(await commitCount(projectId), beforeInTest + 1);
    await jobsRepository.updateItem(proposal.id, {
      status: "applying",
      commitSha: null,
    });
    await jobsRepository.recover();
    assert.equal(
      await (async () => {
        const awaitedValue73367 = await approve();
        return awaitedValue73367.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedResult79263 = await jobsRepository.item(proposal.id);
        return awaitedResult79263?.commitSha;
      })(),
      approved.commitSha
    );
    assert.equal(await commitCount(projectId), beforeInTest + 1);
  });

  test("answering a question resumes a paused job without reviving a cancelled job", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const projectId = await createProject("Answer race");
    const job = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "manual",
      goal: "Review",
      limits: jobLimitsSchema.parse({}),
    });
    await jobsRepository.update(job.id, { status: "blocked" });
    const question = await jobsRepository.addItem({
      jobId: job.id,
      projectId,
      kind: "question",
      title: "Access",
      body: "Configure access",
    });
    assert.ok(await jobsRepository.claimItem(question.id));
    await jobsRepository.answer(question, "Configured");
    assert.equal(
      await (async () => {
        const awaitedResult80306 = await jobsRepository.get(job.id);
        return awaitedResult80306?.status;
      })(),
      "queued"
    );
    assert.equal(
      await (async () => {
        const awaitedResult80378 = await jobsRepository.item(question.id);
        return awaitedResult80378?.status;
      })(),
      "answered"
    );
    assert.equal(
      await (async () => {
        const awaitedResult80465 = await jobsRepository.item(question.id);
        return awaitedResult80465?.answer;
      })(),
      "Configured"
    );

    await jobsRepository.update(job.id, { status: "blocked" });
    const next = await jobsRepository.addItem({
      jobId: job.id,
      projectId,
      kind: "question",
      title: "Session",
      body: "Restore session",
    });
    assert.ok(await jobsRepository.claimItem(next.id));
    await jobsRepository.update(job.id, { status: "cancelled" });
    await assert.rejects(
      () => jobsRepository.answer(next, "Restored"),
      /no longer paused/u
    );
    assert.equal(
      await (async () => {
        const awaitedResult81030 = await jobsRepository.get(job.id);
        return awaitedResult81030?.status;
      })(),
      "cancelled"
    );
    assert.equal(
      await (async () => {
        const awaitedResult81105 = await jobsRepository.item(next.id);
        return awaitedResult81105?.status;
      })(),
      "applying"
    );
    assert.equal(
      await (async () => {
        const awaitedResult81181 = await jobsRepository.item(next.id);
        return awaitedResult81181?.answer;
      })(),
      null
    );
  });
});

describe("project steward", () => {
  test("stays idle without events and only runs requested work in observation mode", async (t) => {
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { stopJobWorker } = await import("../../src/core/jobs/worker");
    const { enqueueIntent, processProjectSteward } =
      await import("../../src/core/steward/engine");
    const { canRunAgentJob } = await import("../../src/core/jobs/pause");
    const { createJobPolicy } = await import("../../src/core/jobs/policy");
    const { createBackgroundTaskTool } =
      await import("../../src/core/steward/tools");
    const { createJobSchema, jobLimitsSchema } =
      await import("../../src/core/jobs/schemas");
    await stopJobWorker();
    t.mock.method(globalThis, "fetch", () => {
      try {
        return Promise.resolve(
          new Response('<script src="/unchanged.js"></script>')
        );
      } catch (error) {
        return Promise.reject(error);
      }
    });
    const projectId = await createProject("Event decisions");
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let i = 0; i < 3; i += 1) {
      await processProjectSteward(projectId);
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(
      await (async () => {
        const awaitedValue76579 = await stewardRepository.intents(projectId);
        return awaitedValue76579.length;
      })(),
      0,
      "an empty project does not schedule exploration or planning"
    );
    assert.equal(
      await (async () => {
        const awaitedValue76732 = await jobsRepository.list(projectId);
        return awaitedValue76732.length;
      })(),
      0
    );
    assert.equal(
      await (async () => {
        const awaitedValue76800 = await stewardRepository.signals(projectId);
        return awaitedValue76800.length;
      })(),
      0
    );
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const kind of [
      "empty_project",
      "context_changed",
      "stale_spec",
      "app_unavailable",
    ]) {
      await stewardRepository.signal({
        projectId,
        key: kind,
        kind,
        title: "Changed",
        body: "Inspect this change",
      });
    }
    /* oxlint-enable no-await-in-loop */
    await processProjectSteward(projectId, false);
    assert.equal(
      await (async () => {
        const awaitedValue77229 = await stewardRepository.intents(projectId);
        return awaitedValue77229.length;
      })(),
      0,
      "these observations are not automatic work triggers"
    );
    await assert.rejects(
      () =>
        enqueueIntent(
          projectId,
          { kind: "coverage", goal: "Find gaps", reason: "No checks" },
          "automatic:gaps"
        ),
      /explicit human request/u
    );
    await assert.rejects(
      () =>
        enqueueIntent(
          projectId,
          { kind: "explore", goal: "Explore", reason: "No checks" },
          "automatic:explore"
        ),
      /explicit human request/u
    );
    assert.equal(createJobSchema.safeParse({ kind: "planner" }).success, false);
    await stewardRepository.update(projectId, { autonomy: "observe" });
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Access",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "Sign in");
    const event = await enqueueIntent(
      projectId,
      {
        kind: "regenerate",
        goal: "Repair sign in",
        reason: "Invalid check",
        specIds: [spec.id],
      },
      "event:repair"
    );
    const requested = {
      kind: "coverage",
      goal: "Explore sign in",
      reason: "The human requested missing coverage",
      priority: 90,
    };
    const one = await enqueueIntent(projectId, requested, "chat:one", "user");
    const duplicate = await enqueueIntent(
      projectId,
      requested,
      "chat:one",
      "user"
    );
    assert.equal(one.id, duplicate.id);
    await Promise.all([
      processProjectSteward(projectId, false),
      processProjectSteward(projectId, false),
    ]);
    const jobs = await jobsRepository.list(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(
      jobs[0]?.id,
      one.id,
      "dispatch recovery keeps the original identity"
    );
    assert.equal(await canRunAgentJob(requireValue(jobs[0])), true);
    assert.equal(
      await (async () => {
        const awaitedResult85468 = await (async () => {
          const awaitedValue79183 = await stewardRepository.intents(projectId);
          return awaitedValue79183.find((item) => item.id === event.id);
        })();
        return awaitedResult85468?.status;
      })(),
      "pending",
      "observation mode records event work without dispatching it"
    );
    const eventJob = await jobsRepository.create({
      id: event.id,
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "steward",
      goal: "Repair sign in",
      limits: jobLimitsSchema.parse({}),
    });
    assert.equal(
      await canRunAgentJob(eventJob),
      false,
      "worker dispatch respects observation mode too"
    );
    const tools = createJobPolicy(requireValue(jobs[0]), () => {
      /* Intentionally ignore this best-effort operation. */
    }).tools([createBackgroundTaskTool(projectId, "chat:policy-check")]);
    assert.equal(
      tools.some((tool) =>
        ["start_background_task", "propose_intents"].includes(tool.name)
      ),
      false,
      "an autonomous session cannot create more work"
    );
    await jobsRepository.update(one.id, { status: "completed" });
    const again = await enqueueIntent(projectId, requested, "chat:two", "user");
    await processProjectSteward(projectId, false);
    assert.equal(
      await (async () => {
        const awaitedResult86707 = await jobsRepository.get(again.id);
        return awaitedResult86707?.status;
      })(),
      "queued",
      "a fresh explicit request does not wait for a six-hour cooldown"
    );
    await stewardRepository.update(projectId, { paused: true });
    assert.equal(
      await canRunAgentJob(requireValue(jobs[0])),
      false,
      "pause still applies to explicit requests"
    );
    const failedRuns = [];
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let i = 0; i < 2; i += 1) {
      const run = await runsRepository.createRun({
        specId: spec.id,
        sourceHash: spec.sourceHash,
        commitSha: await repoGit.getHeadSha(projectId),
      });
      await runsRepository.finishRun(
        run.id,
        "failed",
        1,
        "Expected sign-in result was missing"
      );
      failedRuns.push(run);
    }
    /* oxlint-enable no-await-in-loop */
    const firstFailure = {
      kind: "triage",
      goal: "Investigate sign in",
      reason: "The latest check failed",
      specIds: [spec.id],
      runId: requireValue(failedRuns[0]).id,
    };
    const firstTriage = await enqueueIntent(
      projectId,
      firstFailure,
      `failure:${requireValue(failedRuns[0]).id}`
    );
    const replay = await enqueueIntent(
      projectId,
      firstFailure,
      `failure:${requireValue(failedRuns[0]).id}`
    );
    const nextTriage = await enqueueIntent(
      projectId,
      { ...firstFailure, runId: requireValue(failedRuns[1]).id },
      `failure:${requireValue(failedRuns[1]).id}`
    );
    assert.equal(
      firstTriage.id,
      replay.id,
      "replaying one failure still deduplicates"
    );
    assert.equal(
      firstTriage.fingerprint,
      nextTriage.fingerprint,
      "equivalent failures share their subject across run and signal IDs"
    );
  });

  test("triage requires the latest failed run and both current source and behavior hashes", async () => {
    const { prepareTriageGoal, cancelStaleTriage } =
      await import("../../src/core/jobs/triage");
    const { enqueueJob, stopJobWorker } =
      await import("../../src/core/jobs/worker");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { runsDir } = await import("../../src/core/paths");
    await stopJobWorker();
    const projectId = await createProject("Current failure");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Store",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "Store");
    const yaml = await fs.readFile(
      path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml"),
      "utf-8"
    );
    const snapshot = async (status: "failed" | "passed") => {
      const run = await runsRepository.createRun({
        specId: spec.id,
        sourceHash: spec.sourceHash,
        commitSha: await repoGit.getHeadSha(projectId),
      });
      await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
      await fs.writeFile(path.join(runsDir, run.id, "spec.yml"), yaml);
      await runsRepository.finishRun(
        run.id,
        status,
        1,
        status === "failed" ? "Expected: Store" : null
      );
      return run;
    };
    const first = await snapshot("failed");
    assert.equal(
      await (async () => {
        const awaitedValue83398 = await prepareTriageGoal(projectId, first.id);
        return awaitedValue83398.runId;
      })(),
      first.id
    );
    const queued = await enqueueJob(projectId, {
      kind: "failure_triage",
      trigger: "spec_failure",
      goal: "Investigate",
      runId: first.id,
    });
    await snapshot("passed");
    await assert.rejects(
      () => prepareTriageGoal(projectId, first.id),
      /no longer the current result/u
    );
    assert.equal(await cancelStaleTriage(queued), true);
    assert.equal(
      await (async () => {
        const awaitedResult90450 = await jobsRepository.get(queued.id);
        return awaitedResult90450?.status;
      })(),
      "cancelled"
    );
    assert.equal(
      await (async () => {
        const awaitedResult90535 = await jobsRepository.get(queued.id);
        return awaitedResult90535?.actionsUsed;
      })(),
      0,
      "superseded queued work never starts an agent turn"
    );
    const latest = await snapshot("failed");
    await specsRepository.updateSpecRecord(spec.id, {
      markdownHash: "changed-behavior",
    });
    await assert.rejects(
      () => prepareTriageGoal(projectId, latest.id),
      /no longer the current result/u
    );
    await specsRepository.updateSpecRecord(spec.id, {
      markdownHash: spec.markdownHash,
      sourceHash: "changed-implementation",
    });
    await assert.rejects(
      () => prepareTriageGoal(projectId, latest.id),
      /no longer the current result/u
    );
  });

  test("leaving Observe discards the backlog and resumes only a current failure", async () => {
    const { createStewardRouter } =
      await import("../../src/infra/web/routes/steward");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { recordFailureSignal, processProjectSteward } =
      await import("../../src/core/steward/engine");
    const { stopJobWorker } = await import("../../src/core/jobs/worker");
    const { runsDir } = await import("../../src/core/paths");
    await stopJobWorker();
    const projectId = await createProject("Observed failures");
    await stewardRepository.update(projectId, { autonomy: "observe" });
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Store",
      ""
    );
    const ids: string[] = [];
    let currentRunId = "";
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const state of ["fixed", "current", "changed", "no-healing"]) {
      const { spec } = await createSpec(projectId, feature.id, state);
      ids.push(spec.id);
      const run = await runsRepository.createRun({
        specId: spec.id,
        sourceHash: spec.sourceHash,
        commitSha: await repoGit.getHeadSha(projectId),
        healOnFailure: state !== "no-healing",
      });
      await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
      await fs.writeFile(
        path.join(runsDir, run.id, "spec.yml"),
        await fs.readFile(
          path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml"),
          "utf-8"
        )
      );
      await runsRepository.finishRun(run.id, "failed", 1, "Expected: Store");
      await recordFailureSignal(projectId, run.id, spec.id, state);
      if (state === "fixed") {
        const passed = await runsRepository.createRun({
          specId: spec.id,
          sourceHash: spec.sourceHash,
          commitSha: run.commitSha,
        });
        await runsRepository.finishRun(passed.id, "passed", 1, null);
      } else if (state === "changed") {
        await specsRepository.updateSpecRecord(spec.id, { sourceHash: "new" });
      } else if (state === "current") {
        currentRunId = run.id;
      }
    }
    /* oxlint-enable no-await-in-loop */
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let i = 0; i < 10; i += 1) {
      await stewardRepository.signal({
        projectId,
        key: `old-change:${i}`,
        kind: "spec_changed",
        title: "Old version",
        body: "Run old version",
        payload: {
          specIds: [ids[0]],
          sourceHash: `old-${i}`,
          markdownHash: "old",
        },
      });
    }
    /* oxlint-enable no-await-in-loop */
    await processProjectSteward(projectId, false);
    assert.equal(
      await (async () => {
        const awaitedValue87311 = await stewardRepository.intents(projectId);
        return awaitedValue87311.length;
      })(),
      0
    );
    const router = createStewardRouter();
    assert.equal(
      await (async () => {
        const awaitedValue87434 = await router.request(
          `/projects/${projectId}/steward`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ autonomy: "propose" }),
          }
        );
        return awaitedValue87434.status;
      })(),
      200
    );
    const pending = await stewardRepository.pendingSignals(projectId);
    assert.deepEqual(
      pending.map((signal) => signal.payload.runId),
      [currentRunId]
    );
    await processProjectSteward(projectId, false);
    const jobs = await jobsRepository.list(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.runId, currentRunId);
    assert.equal(
      await (async () => {
        const awaitedValue88065 = await stewardRepository.intents(projectId);
        return awaitedValue88065.length;
      })(),
      1
    );
  });

  test("automatic investigations remember cooldowns and rejections across repeated runs", async () => {
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { enqueueIntent, processProjectSteward } =
      await import("../../src/core/steward/engine");
    const { stopJobWorker } = await import("../../src/core/jobs/worker");
    const { runsDir } = await import("../../src/core/paths");
    await stopJobWorker();
    const projectId = await createProject("Repeated failure");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Store",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "Store");
    const failed = async (status: "failed" | "error" = "failed") => {
      const run = await runsRepository.createRun({
        specId: spec.id,
        sourceHash: spec.sourceHash,
        commitSha: await repoGit.getHeadSha(projectId),
      });
      await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
      await fs.writeFile(
        path.join(runsDir, run.id, "spec.yml"),
        await fs.readFile(
          path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml"),
          "utf-8"
        )
      );
      await runsRepository.finishRun(
        run.id,
        status,
        1,
        status === "failed" ? "Expected: Store" : "Connection refused"
      );
      return enqueueIntent(
        projectId,
        {
          kind: "triage",
          specIds: [spec.id],
          runId: run.id,
          goal: "Investigate",
          reason: "Latest check failed",
        },
        `test:${run.id}`
      );
    };
    const first = await failed();
    await processProjectSteward(projectId, false);
    const job = requireValue(await jobsRepository.get(first.id));
    await jobsRepository.update(job.id, { status: "completed" });
    const second = await failed();
    await processProjectSteward(projectId, false);
    assert.equal(
      await (async () => {
        const awaitedResult97151 = await (async () => {
          const awaitedValue90204 = await stewardRepository.intents(projectId);
          return awaitedValue90204.find((row) => row.id === second.id);
        })();
        return awaitedResult97151?.status;
      })(),
      "ignored"
    );
    assert.equal(
      await (async () => {
        const awaitedValue90350 = await jobsRepository.list(projectId);
        return awaitedValue90350.length;
      })(),
      1
    );
    const suggestion = await jobsRepository.addItem({
      projectId,
      jobId: job.id,
      kind: "spec_fix",
      title: "Suggested change",
      body: "Review",
    });
    await jobsRepository.updateItem(suggestion.id, { status: "rejected" });
    const third = await failed();
    await processProjectSteward(projectId, false);
    assert.match(
      (await (async () => {
        const awaitedResult97936 = await (async () => {
          const awaitedValue90765 = await stewardRepository.intents(projectId);
          return awaitedValue90765.find((row) => row.id === third.id);
        })();
        return awaitedResult97936?.reason;
      })()) ?? "",
      /rejected/u
    );
    const different = await failed("error");
    assert.notEqual(
      different.fingerprint,
      third.fingerprint,
      "a different failure category remains actionable"
    );
    await processProjectSteward(projectId, false);
    assert.equal(
      await (async () => {
        const awaitedResult98430 = await jobsRepository.get(different.id);
        return awaitedResult98430?.status;
      })(),
      "queued"
    );
  });

  test("trusted automatic fixes preserve assertion targets, action kinds, aliases and input values", async () => {
    const { isLocatorOnlyFix } =
      await import("../../src/core/steward/approval");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const projectId = await createProject("Trusted fixes");
    const job = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "manual",
      goal: "Review",
      limits: jobLimitsSchema.parse({}),
    });
    const source = VALID_SPEC.replace(
      'await page.goto("/");',
      'await page.goto("/");\n        await page.locator("button.new").click();'
    );
    const beforeInTest = source.replace("button.new", "button.old");
    const item = await jobsRepository.addItem({
      projectId,
      jobId: job.id,
      kind: "spec_fix",
      title: "Fix",
      body: "Fix",
      payload: {
        requiresVerification: true,
        before: { testSource: beforeInTest },
        params: { specId: crypto.randomUUID(), testSource: source },
      },
    });
    assert.equal(isLocatorOnlyFix(item), true);
    for (const method of [
      "locator",
      "getByLabel",
      "getByTestId",
      "getByPlaceholder",
    ]) {
      item.payload.before = {
        testSource: beforeInTest.replace(".locator", `.${method}`),
      };
      item.payload.params = {
        specId: crypto.randomUUID(),
        testSource: source.replace(".locator", `.${method}`),
      };
      assert.equal(
        isLocatorOnlyFix(item),
        true,
        `${method} may change on a direct action`
      );
      item.payload.before = {
        testSource: VALID_SPEC.replace(
          'page.getByRole("heading")',
          `page.${method}("specific target")`
        ),
      };
      item.payload.params = {
        specId: crypto.randomUUID(),
        testSource: VALID_SPEC.replace(
          'page.getByRole("heading")',
          `page.${method}("body")`
        ),
      };
      assert.equal(
        isLocatorOnlyFix(item),
        false,
        `${method} cannot weaken an assertion target`
      );
    }
    item.payload.before = { testSource: beforeInTest };
    item.payload.params = {
      specId: crypto.randomUUID(),
      testSource: source.replace(".click()", ".hover()"),
    };
    assert.equal(
      isLocatorOnlyFix(item),
      false,
      "changing the action requires review"
    );
    const alias = VALID_SPEC.replace(
      'await page.goto("/");',
      'await page.goto("/");\n        const target = page.locator("specific");'
    ).replace('page.getByRole("heading")', "target");
    item.payload.before = { testSource: alias };
    item.payload.params = {
      specId: crypto.randomUUID(),
      testSource: alias.replace('"specific"', '"body"'),
    };
    assert.equal(
      isLocatorOnlyFix(item),
      false,
      "shared locator declarations cannot weaken an assertion indirectly"
    );
    for (const expectCall of ["expect", "expect.soft"]) {
      item.payload.before = {
        testSource: `await ${expectCall}(await page.locator("specific").click()).toBeUndefined();`,
      };
      item.payload.params = {
        specId: crypto.randomUUID(),
        testSource: `await ${expectCall}(await page.locator("body").click()).toBeUndefined();`,
      };
      assert.equal(
        isLocatorOnlyFix(item),
        false,
        "actions nested inside assertions cannot change their selectors"
      );
    }
    item.payload.before = { testSource: beforeInTest };
    item.payload.params = {
      specId: crypto.randomUUID(),
      testSource: source.replace("toBeVisible()", "toBeAttached()"),
    };
    assert.equal(
      isLocatorOnlyFix(item),
      false,
      "assertion matchers must stay exact"
    );
    item.payload.params = { specId: crypto.randomUUID(), testSource: source };
    item.payload.params = {
      ...(item.payload.params as object),
      humanSpec: HUMAN_SPEC,
    };
    assert.equal(
      isLocatorOnlyFix(item),
      false,
      "behavior proposals always need a human"
    );
    item.payload.before = { testSource: `page.fill(".locator('old')")` };
    item.payload.params = {
      specId: crypto.randomUUID(),
      testSource: `page.fill(".locator('new')")`,
    };
    assert.equal(
      isLocatorOnlyFix(item),
      false,
      "input data cannot masquerade as a locator change"
    );
  });

  test("screenshot policy changes apply to existing agent sessions", async (t) => {
    const { agentSettings, updateSecuritySettings } =
      await import("../../src/core/chat/safety-settings");
    const manager = await agentSettings();
    assert.equal(manager.getBlockImages(), false);
    await updateSecuritySettings({ sendScreenshotsToModel: false });
    assert.equal(
      manager.getBlockImages(),
      true,
      "existing sessions recheck image policy on every request"
    );
    t.after(() => updateSecuritySettings({}));
    await updateSecuritySettings({ sendScreenshotsToModel: true });
    assert.equal(manager.getBlockImages(), false);
  });

  test("replays changed Spec and deploy signals once after a crash, while retaining real reversions", async (t) => {
    const { collectProjectSignals } =
      await import("../../src/core/steward/signals");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const projectId = await createProject("Observation recovery");
    const project = requireValue(
      await projectsRepository.getProject(projectId)
    );
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Store",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "Store");
    let build = "a";
    t.mock.method(globalThis, "fetch", () => {
      try {
        return Promise.resolve(
          new Response(`<script src="/${build}.js"></script>`)
        );
      } catch (error) {
        return Promise.reject(error);
      }
    });
    let at = Date.now();
    let observation = await collectProjectSignals(project, {}, at);
    await stewardRepository.update(projectId, { observation });
    const originalHash = spec.sourceHash;
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const [index, version] of ["b", "a", "b"].entries()) {
      at += 300_001;
      build = version;
      await specsRepository.updateSpecRecord(spec.id, {
        sourceHash: version === "a" ? originalHash : "changed-source",
      });
      const persisted = await (async () => {
        const awaitedValue97607 = await stewardRepository.get(projectId);
        return awaitedValue97607.observation;
      })();
      observation = await collectProjectSignals(project, persisted, at);
      const replay = await collectProjectSignals(project, persisted, at + 1000);
      assert.deepEqual(replay.specGenerations, observation.specGenerations);
      assert.equal(
        replay.deployment?.generation,
        observation.deployment?.generation
      );
      const signals = await stewardRepository.signals(projectId);
      assert.equal(
        signals.filter((signal) => signal.kind === "spec_changed").length,
        index + 1
      );
      assert.equal(
        signals.filter((signal) => signal.kind === "deployment_changed").length,
        index + 1
      );
      assert.equal(observation.specGenerations?.[spec.id], index + 1);
      await stewardRepository.update(projectId, { observation });
    }
    /* oxlint-enable no-await-in-loop */
    await stewardRepository.signal({
      projectId,
      key: "preview:first",
      kind: "deployment",
      title: "Preview",
      body: "Run preview",
      payload: {
        environment: "preview",
        url: "https://first.preview.test",
        commitSha: "one",
      },
    });
    // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
    await stewardRepository.signal({
      projectId,
      key: "preview:latest",
      kind: "deployment",
      title: "Preview",
      body: "Run preview",
      payload: {
        environment: "preview",
        url: "https://latest.preview.test",
        commitSha: "two",
      },
    });
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const signal of await stewardRepository.signals(projectId)) {
      await stewardRepository.acknowledge(signal.id, "observed");
    }
    /* oxlint-enable no-await-in-loop */
    const { resumeCurrentSignals } =
      await import("../../src/core/steward/engine");
    await resumeCurrentSignals(projectId);
    const current = await stewardRepository.pendingSignals(projectId);
    assert.equal(
      current.length,
      3,
      "only the current Spec, detected build and explicit deployment remain actionable"
    );
    assert.equal(
      current.find((signal) => signal.kind === "spec_changed")?.payload
        .generation,
      3,
      "returning to the same content does not replay an older generation"
    );
    assert.equal(
      current.find((signal) => signal.kind === "deployment_changed")?.payload
        .generation,
      3
    );
    assert.equal(
      current.find((signal) => signal.kind === "deployment")?.payload.url,
      "https://latest.preview.test",
      "older preview URLs for the same environment are not resumed"
    );
  });

  test("run prerequisites ask once and resume the original request without exploratory work", async () => {
    const { createChat } = await import("../../src/core/chat/session-store");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { stopJobWorker } = await import("../../src/core/jobs/worker");
    const { enqueueIntent, processProjectSteward } =
      await import("../../src/core/steward/engine");
    await stopJobWorker();
    const projectId = await createProject("Missing run access");
    const { environmentsRepository } =
      await import("../../src/infra/repositories/environments");
    const production = requireValue(
      await (async () => {
        const awaitedValue100915 = await environmentsRepository.list(projectId);
        return awaitedValue100915[0];
      })()
    );
    await environmentsRepository.update(production, {
      ...production,
      allowedOrigins: ["https://preview.example.com"],
    });
    await stewardRepository.update(projectId, { autonomy: "observe" });
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Sign in",
      ""
    );
    const source = VALID_SPEC.replace(
      "{ page, step }",
      "{ page, step, secret }"
    ).replace(
      'await page.goto("/");',
      'await page.goto("/");\n        await page.getByLabel("Email").fill(secret("shopper", "email"));'
    );
    const { spec } = await createSpec(projectId, feature.id, "Sign in", source);
    const chat = await createChat(projectId);
    const intent = await enqueueIntent(
      projectId,
      {
        kind: "run_specs",
        goal: "Verify the preview",
        reason: "The human requested a preview check",
        specIds: [spec.id],
        baseUrl: "https://preview.example.com",
      },
      `chat:${chat.id}:missing-access`,
      "user",
      { sourceChatId: chat.id }
    );
    await processProjectSteward(projectId, false);
    const waiting = requireValue(
      await (async () => {
        const awaitedValue102103 = await stewardRepository.intents(projectId);
        return awaitedValue102103.find((item) => item.id === intent.id);
      })()
    );
    assert.equal(waiting.status, "running");
    const job = requireValue(await jobsRepository.get(intent.id));
    assert.equal(job.status, "blocked");
    assert.equal(job.kind, "review");
    assert.equal(job.tokensUsed, 0);
    assert.equal(job.sourceChatId, chat.id);
    assert.match(job.stopReason ?? "", /credentials.*not configured/u);
    const question = requireValue(
      await (async () => {
        const awaitedValue102555 = await jobsRepository.inbox(projectId);
        return awaitedValue102555[0];
      })()
    );
    assert.equal(question.kind, "question");
    assert.equal(question.payload.waitingFor, "credentials");
    assert.equal(question.payload.runIntentId, intent.id);
    assert.equal(question.payload.sourceChatId, chat.id);
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let i = 0; i < 3; i += 1) {
      await processProjectSteward(projectId, false);
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(
      await (async () => {
        const awaitedValue102937 = await jobsRepository.inbox(projectId);
        return awaitedValue102937.length;
      })(),
      1
    );
    assert.equal(
      await (async () => {
        const awaitedValue103006 = await stewardRepository.intents(projectId);
        return awaitedValue103006.length;
      })(),
      1
    );
    await stewardRepository.signal({
      projectId,
      kind: "credentials_changed",
      key: "access:changed",
      title: "Access changed",
      body: "Profiles changed",
    });
    await processProjectSteward(projectId, false);
    assert.equal(
      await (async () => {
        const awaitedResult111357 = await jobsRepository.get(job.id);
        return awaitedResult111357?.status;
      })(),
      "completed",
      "answering a run prerequisite never starts an LLM turn"
    );
    assert.equal(
      await (async () => {
        const awaitedResult111506 = await jobsRepository.item(question.id);
        return awaitedResult111506?.status;
      })(),
      "answered"
    );
    const resumed = requireValue(
      await (async () => {
        const awaitedValue103559 = await stewardRepository.intents(projectId);
        return awaitedValue103559.find(
          (item) => item.key === `resume-run:${intent.id}:${question.id}`
        );
      })()
    );
    assert.ok(resumed);
    assert.equal(resumed.source, "user");
    assert.equal(
      resumed.sourceChatId,
      chat.id,
      "access questions and retries stay in the original conversation"
    );
    assert.equal(resumed.intent.baseUrl, "https://preview.example.com");
    assert.deepEqual(resumed.intent.specIds, [spec.id]);
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let i = 0; i < 3; i += 1) {
      await processProjectSteward(projectId, false);
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(
      await (async () => {
        const awaitedResult112300 = await jobsRepository.get(resumed.id);
        return awaitedResult112300?.status;
      })(),
      "blocked"
    );
    assert.equal(
      await (async () => {
        const awaitedValue104213 = await jobsRepository.list(projectId);
        return awaitedValue104213.length;
      })(),
      2
    );
    assert.equal(
      await (async () => {
        const awaitedValue104288 = await jobsRepository.inbox(projectId);
        return awaitedValue104288.filter((item) => item.status === "pending")
          .length;
      })(),
      1
    );
    assert.equal(
      await (async () => {
        const awaitedValue104435 = await stewardRepository.intents(projectId);
        return awaitedValue104435.some((item) =>
          ["explore", "coverage"].includes(item.intent.kind)
        );
      })(),
      false
    );
  });

  test("keeps independent coverage requests and promoted bug reports distinct", async () => {
    const { enqueueIntent } = await import("../../src/core/steward/engine");
    const projectId = await createProject("Independent coverage");
    const base = {
      kind: "coverage",
      reason: "Missing coverage",
      goal: "Cover login",
    };
    const login = await enqueueIntent(projectId, base, "chat:login", "user");
    const duplicate = await enqueueIntent(
      projectId,
      { ...base, goal: " Cover   LOGIN " },
      "chat:repeat",
      "user"
    );
    const checkout = await enqueueIntent(
      projectId,
      { ...base, goal: "Cover checkout" },
      "chat:checkout",
      "user"
    );
    const regression = await enqueueIntent(
      projectId,
      base,
      "regression:bug-one",
      "user"
    );
    assert.equal(login.fingerprint, duplicate.fingerprint);
    assert.notEqual(login.fingerprint, checkout.fingerprint);
    assert.notEqual(login.fingerprint, regression.fingerprint);
  });

  test("promoting a bug report creates one regression intent without changing the repository", async () => {
    const { createChat } = await import("../../src/core/chat/session-store");
    const { chatsRepository } =
      await import("../../src/infra/repositories/chats");
    const { createJobsRouter } =
      await import("../../src/infra/web/routes/jobs");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { stopJobWorker } = await import("../../src/core/jobs/worker");
    await stopJobWorker();
    const projectId = await createProject("Regression proposal");
    const chat = await createChat(projectId);
    const job = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      sourceChatId: chat.id,
      trigger: "manual",
      goal: "Investigate",
      limits: jobLimitsSchema.parse({}),
    });
    const bug = await jobsRepository.addItem({
      projectId,
      jobId: job.id,
      kind: "bug_report",
      title: "Checkout drops the discount",
      body: "Open checkout with a coupon; the total ignores it.",
      payload: { discussionChatId: crypto.randomUUID() },
    });
    const question = await jobsRepository.addItem({
      projectId,
      jobId: job.id,
      kind: "question",
      title: "Access",
      body: "Which account?",
    });
    const head = await repoGit.getHeadSha(projectId);
    const router = new Hono().route("/", createJobsRouter());
    const discussed = await router.request(
      `/projects/${projectId}/inbox/${bug.id}/discuss`,
      { method: "POST" }
    );
    assert.deepEqual(
      await discussed.json(),
      { chatId: chat.id },
      "discussion returns the original conversation when its separate discussion was deleted"
    );
    const promote = (project: string, item: string) =>
      router.request(`/projects/${project}/inbox/${item}/promote`, {
        method: "POST",
      });
    const response = await promote(projectId, bug.id);
    assert.equal(response.status, 202);
    const { intentId } = (await response.json()) as { intentId: string };
    assert.deepEqual(
      await (async () => {
        const awaitedValue107929 = await promote(projectId, bug.id);
        return awaitedValue107929.json();
      })(),
      {
        intentId,
      }
    );
    assert.equal(
      await (async () => {
        const awaitedValue108015 = await promote(crypto.randomUUID(), bug.id);
        return awaitedValue108015.status;
      })(),
      404
    );
    assert.equal(
      await (async () => {
        const awaitedValue108091 = await promote(projectId, question.id);
        return awaitedValue108091.status;
      })(),
      400
    );
    const intents = await stewardRepository.intents(projectId);
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.intent.kind, "coverage");
    assert.equal(intents[0]?.sourceChatId, chat.id);
    assert.match(intents[0]?.intent.goal ?? "", /total ignores it/u);
    assert.equal(
      await (async () => {
        const awaitedResult117293 = await jobsRepository.item(bug.id);
        return awaitedResult117293?.payload.regressionIntentId;
      })(),
      intentId
    );
    assert.equal(await repoGit.getHeadSha(projectId), head);
    assert.ok(
      await (async () => {
        const awaitedValue108610 = await repoGit
          .getProjectGit(projectId)
          .status();
        return awaitedValue108610.isClean();
      })()
    );
    await chatsRepository.deleteChatRow(chat.id);
    assert.equal(
      await (async () => {
        const awaitedResult117726 = await jobsRepository.get(job.id);
        return awaitedResult117726?.sourceChatId;
      })(),
      null,
      "deleting a conversation retains the investigation audit"
    );
    const later = await jobsRepository.addItem({
      projectId,
      jobId: job.id,
      kind: "bug_report",
      title: "Checkout has another issue",
      body: "The checkout cannot continue.",
      payload: { sourceChatId: chat.id },
    });
    assert.equal(
      await (async () => {
        const awaitedValue109154 = await promote(projectId, later.id);
        return awaitedValue109154.status;
      })(),
      202,
      "a deleted source conversation cannot block promoting the report from Overview"
    );
  });

  test("does not recreate an exact proposal the human already rejected", async () => {
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { proposeMutation } = await import("../../src/core/jobs/proposals");
    const projectId = await createProject("Rejected proposal");
    const createJob = () =>
      jobsRepository.create({
        projectId,
        chatId: crypto.randomUUID(),
        trigger: "manual",
        goal: "Propose coverage",
        limits: jobLimitsSchema.parse({}),
      });
    const job = await createJob();
    const params = { title: "Checkout", description: "Coupons and payment" };
    const proposal = await proposeMutation(job, "create_feature", params);
    await jobsRepository.updateItem(proposal.id, { status: "rejected" });
    const next = await createJob();
    await assert.rejects(
      () =>
        proposeMutation(next, "create_feature", {
          description: params.description,
          title: params.title,
        }),
      /human rejected/u
    );
    assert.equal(
      await (async () => {
        const awaitedValue110453 = await jobsRepository.inbox(projectId);
        return awaitedValue110453.length;
      })(),
      1
    );
    const different = await proposeMutation(next, "create_feature", {
      title: "Login",
      description: "Access and account sessions",
    });
    assert.equal(different.status, "pending");
  });
});

describe("plain-language autonomous presentation", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
  const createOverviewRun = async function createOverviewRun(
    input: Parameters<typeof runsRepository.createRun>[0]
  ) {
    const { runsDir } = await import("../../src/core/paths");
    const spec = requireValue(await specsRepository.getSpec(input.specId));
    const run = await runsRepository.createRun(input);
    await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
    await fs.copyFile(
      path.join(repoGit.getRepoDir(spec.projectId), spec.path, "spec.yml"),
      path.join(runsDir, run.id, "spec.yml")
    );
    return run;
  };

  test("unfinished updates stay out of Inbox, stopped attempts offer help, and stale updates disappear", async () => {
    const { projectPresentation } =
      await import("../../src/core/jobs/presentation");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { proposeMutation } = await import("../../src/core/jobs/proposals");
    const projectId = await createProject("Understandable updates");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Store",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "View results");
    const job = await jobsRepository.create({
      projectId,
      specId: spec.id,
      kind: "regenerate",
      chatId: crypto.randomUUID(),
      trigger: "steward",
      goal: "Repair the check",
      limits: jobLimitsSchema.parse({}),
    });
    await jobsRepository.update(job.id, { status: "running" });
    const source = VALID_SPEC.replace(
      'page.goto("/")',
      'page.goto("/results")'
    );
    const item = await proposeMutation(job, "update_spec", {
      specId: spec.id,
      testSource: source,
    });
    const error =
      "TimeoutError: expected result did not appear\n    at Object.click (/home/gus/specbook/src/core/runner/guard.ts:279:36)\n> 279 | await locator.click();\n      | ^\nArtifact: /tmp/specbook/storage/runs/private/error.txt";
    await jobsRepository.updateItem(item.id, {
      payload: {
        ...item.payload,
        verification: { status: "failed", failReason: error, screenshots: [] },
      },
    });
    assert.equal(
      await (async () => {
        const awaitedValue113024 = await projectPresentation(projectId);
        return awaitedValue113024.items.length;
      })(),
      0
    );
    await jobsRepository.update(job.id, { status: "stalled" });
    const paused = await projectPresentation(projectId);
    assert.equal(paused.items.length, 1);
    assert.equal(paused.items[0]?.presentation.type, "help");
    assert.match(
      paused.items[0]?.presentation.title ?? "",
      /Look at it together\?/u
    );
    assert.ok(
      !paused.activity.some((story) => story.status === "paused"),
      "an unfinished attempt is not a user-requested pause"
    );
    assert.equal(paused.summary.paused, false);
    assert.doesNotMatch(
      JSON.stringify(paused),
      /\/home\/gus|\/tmp\/specbook|src\/core\/runner|Object\.click|279 \|/u
    );
    await writer.updateSpecWithLock(spec.id, { testSource: source });
    assert.equal(
      await (async () => {
        const awaitedValue113840 = await projectPresentation(projectId);
        return awaitedValue113840.items.length;
      })(),
      0,
      "an outdated failed suggestion is not a new decision"
    );
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    await stewardRepository.update(projectId, { autonomy: "observe" });
    const observing = await projectPresentation(projectId);
    assert.ok(
      !observing.activity.some(
        (story) => story.status === "paused" || story.status === "working"
      )
    );
    assert.equal(observing.summary.paused, false);
    assert.equal(observing.activity[0]?.status, "stopped");
    assert.match(observing.activity[0]?.nextStep ?? "", /Discuss the Spec/u);
    await jobsRepository.update(job.id, { status: "running" });
    const working = await projectPresentation(projectId);
    assert.equal(working.activity[0]?.status, "working");
  });

  // oxlint-disable-next-line complexity -- Keep the complete protocol scenario and its assertions together in this test.
  test("groups repeated observations and investigations around one check and pairs the same screenshot step", async () => {
    const { projectPresentation } =
      await import("../../src/core/jobs/presentation");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { proposeMutation } = await import("../../src/core/jobs/proposals");
    const { sourceHashOf } = await import("../../src/core/repo/writer");
    const { runsDir } = await import("../../src/core/paths");
    const projectId = await createProject("Grouped story");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Store",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "Open results");
    const run = await runsRepository.createRun({
      specId: spec.id,
      sourceHash: spec.sourceHash,
      commitSha: await repoGit.getHeadSha(projectId),
    });
    await runsRepository.finishRun(run.id, "failed", 1, "Missing results");
    await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
    await fs.writeFile(
      path.join(runsDir, run.id, "evidence.json"),
      JSON.stringify({
        failedStep: "Open the page",
        steps: [{ label: "Open the page", file: "evidence/step-01.png" }],
      })
    );
    const job = await jobsRepository.create({
      projectId,
      runId: run.id,
      specId: spec.id,
      kind: "regenerate",
      chatId: crypto.randomUUID(),
      trigger: "steward",
      goal: "Repair",
      limits: jobLimitsSchema.parse({}),
    });
    const source = VALID_SPEC.replace(
      'page.goto("/")',
      'page.goto("/results")'
    );
    const item = await proposeMutation(job, "update_spec", {
      specId: spec.id,
      testSource: source,
    });
    await jobsRepository.updateItem(item.id, {
      payload: {
        ...item.payload,
        verification: {
          id: crypto.randomUUID(),
          status: "passed",
          sourceHash: sourceHashOf(source),
          screenshots: ["evidence/step-01.png", "evidence/step-02.png"],
        },
      },
    });
    await jobsRepository.update(job.id, { status: "completed" });
    await jobsRepository.log(
      job.id,
      "browser_snapshot:completed",
      "Captured the page"
    );
    await jobsRepository.log(job.id, "proposal:verified", `${item.id}: passed`);
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const key of ["changed:one", "changed:two"]) {
      await stewardRepository.signal({
        projectId,
        key,
        kind: "invalid_spec",
        title: "Internal invalid status",
        body: "Internal detail",
        payload: { specIds: [spec.id] },
      });
    }
    /* oxlint-enable no-await-in-loop */
    const view = await projectPresentation(projectId);
    assert.equal(view.activity.length, 1);
    assert.equal(view.activity[0]?.subject.id, spec.id);
    assert.deepEqual(
      new Set(view.activity[0]?.timeline.map((entry) => entry.label)),
      new Set(["Noticed", "Tested update", "Your decision"])
    );
    const times = requireValue(view.activity[0]).timeline.map(
      (entry) => entry.createdAt
    );
    assert.deepEqual(
      times,
      [...times].toSorted(),
      "decision and evidence dates are chronological even when investigation ends later"
    );
    assert.doesNotMatch(
      JSON.stringify(view.activity),
      /Reviewed the check and the available application evidence/u
    );
    assert.notEqual(
      view.activity[0]?.timeline[0]?.detail,
      view.activity[0]?.summary
    );
    assert.match(
      view.items[0]?.presentation.screenshots.before?.url ?? "",
      /step-01\.png$/u
    );
    assert.match(
      view.items[0]?.presentation.screenshots.after?.url ?? "",
      /step-01\.png$/u
    );
    assert.equal(view.items[0]?.presentation.type, "update");
    assert.equal(
      view.items[0]?.presentation.summary,
      "Missing results. The expected behavior stays the same."
    );
    assert.doesNotMatch(view.items[0]?.presentation.summary ?? "", /passed/u);
    assert.match(view.items[0]?.presentation.workDone ?? "", /passed/u);
    assert.match(
      view.activity[0]?.title ?? "",
      /needs an update before it can run/u
    );
    assert.equal(
      view.items.filter(
        (itemInTest) =>
          itemInTest.status === "pending" && itemInTest.kind !== "bug_report"
      ).length,
      1
    );
    assert.ok(!view.activity.some((story) => story.status === "working"));
  });

  test("keeps internal browser failures out of Inbox and removes source frames from optional diagnostics", async () => {
    const { projectPresentation } =
      await import("../../src/core/jobs/presentation");
    const { isInfrastructureFailure } =
      await import("../../src/core/jobs/presentation-errors");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const projectId = await createProject("Service recovery");
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const display of [118, 119]) {
      const job = await jobsRepository.create({
        projectId,
        chatId: crypto.randomUUID(),
        trigger: "steward",
        goal: "Inspect",
        limits: jobLimitsSchema.parse({}),
      });
      await jobsRepository.update(job.id, { status: "blocked" });
      await jobsRepository.addItem({
        projectId,
        jobId: job.id,
        kind: "question",
        title: "Job needs help",
        body: `O navegador não iniciou devido ao conflito do servidor X (display ${display}).`,
      });
    }
    /* oxlint-enable no-await-in-loop */
    const view = await projectPresentation(projectId);
    assert.deepEqual(view.items, []);
    assert.ok(view.summary.systemHealth);
    assert.match(view.summary.systemHealth.message, /resume automatically/u);
    assert.equal(
      view.activity.length,
      0,
      "infrastructure recovery is represented by one health notice"
    );
    const technical = sanitizeTechnicalDetails(
      "TimeoutError: missing button\n    at Object.click (/home/gus/app/src/core/runner/guard.ts:279)\n> 279 | await locator.click()\n    ^\nC:\\Users\\gus\\specbook\\error.log\nSee /var/log/specbook/errors.txt\nURL: https://app.example.com/results"
    );
    assert.match(technical, /TimeoutError: missing button/u);
    assert.match(technical, /https:\/\/app.example.com\/results/u);
    assert.doesNotMatch(
      technical,
      /\/home|C:\\Users|\/var\/log|guard\.ts|locator\.click|\bat Object/u
    );
    assert.equal(
      isInfrastructureFailure("The application returned HTTP 503"),
      false
    );
    assert.equal(
      isInfrastructureFailure("browserType.launch: Xvfb failed"),
      true
    );
    assert.equal(isInfrastructureFailure("BrowserUnavailableError"), true);
    assert.equal(
      isInfrastructureFailure("Specbook couldn’t start its browser."),
      true
    );
    assert.equal(
      isInfrastructureFailure("Specbook could not start its browser."),
      true
    );
  });

  test("overview separates decisions from failing checks and keeps health independent of pause", async () => {
    const { projectOverview } = await import("../../src/core/jobs/overview");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { db } = await import("../../src/infra/db/client");
    const { inboxItems } = await import("../../src/infra/db/schema");
    const { eq } = await import("drizzle-orm");
    const projectId = await createProject("Organized overview");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    await stewardRepository.update(projectId, { paused: true });
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Survey",
      ""
    );
    const checks = await Promise.all(
      [
        "Passing",
        "Failing",
        "Flaky",
        "Paused one",
        "Paused two",
        "Unchecked",
        "Invalid",
      ].map(
        async (title) =>
          await (async () => {
            const awaitedValue122850 = await createSpec(
              projectId,
              feature.id,
              title
            );
            return awaitedValue122850.spec;
          })()
      )
    );
    const [passing, failing, flaky, pausedOne, pausedTwo, unchecked, invalid] =
      checks;
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const spec of [
      requireValue(passing),
      requireValue(failing),
      requireValue(flaky),
    ]) {
      const status = spec.id === requireValue(failing).id ? "failed" : "passed";
      const run = await createOverviewRun({
        specId: spec.id,
        sourceHash: spec.sourceHash,
        commitSha: await repoGit.getHeadSha(projectId),
      });
      await runsRepository.finishRun(
        run.id,
        status,
        5,
        status === "failed" ? "Result did not appear" : null
      );
      await specsRepository.updateSpecStatus(spec.id, status);
      if (spec.id === requireValue(flaky).id) {
        await runsRepository.markFlaky(run.id, run.id);
      }
    }
    /* oxlint-enable no-await-in-loop */
    await specsRepository.updateSpecStatus(
      requireValue(invalid).id,
      "invalid",
      "spec.ts is missing"
    );
    const previous = await jobsRepository.create({
      projectId,
      specId: requireValue(pausedOne).id,
      kind: "explore",
      chatId: crypto.randomUUID(),
      trigger: "steward",
      goal: "Explore surveys",
      limits: jobLimitsSchema.parse({}),
    });
    await jobsRepository.update(previous.id, { status: "completed" });
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const spec of [requireValue(pausedOne), requireValue(pausedTwo)]) {
      const job = await jobsRepository.create({
        projectId,
        specId: spec.id,
        kind: "regenerate",
        chatId: crypto.randomUUID(),
        trigger: "steward",
        goal: "Update check",
        limits: jobLimitsSchema.parse({}),
      });
      await jobsRepository.update(job.id, { status: "stalled" });
    }
    /* oxlint-enable no-await-in-loop */
    const questionJob = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      trigger: "steward",
      goal: "Clarify survey access",
      limits: jobLimitsSchema.parse({}),
    });
    await jobsRepository.update(questionJob.id, { status: "blocked" });
    const newer = await jobsRepository.addItem({
      projectId,
      jobId: questionJob.id,
      kind: "question",
      title: "Should guests see survey results?",
      body: "Which results should be visible to guests?",
    });
    const older = await jobsRepository.addItem({
      projectId,
      jobId: questionJob.id,
      kind: "question",
      title: "Should drafts appear in the survey list?",
      body: "Should the survey list include drafts?",
    });
    await db
      .update(inboxItems)
      .set({ createdAt: "2024-01-01T00:00:00.000Z" })
      .where(eq(inboxItems.id, older.id));
    const failedRun = requireValue(
      await (async () => {
        const awaitedValue125385 = await runsRepository.listRuns(
          requireValue(failing).id
        );
        return awaitedValue125385[0];
      })()
    );
    const bug = await jobsRepository.addItem({
      projectId,
      jobId: questionJob.id,
      kind: "bug_report",
      title: "Deleting a survey shows an error",
      body: "Deleting the survey leaves it in the list.",
      payload: { specId: requireValue(failing).id, runId: failedRun.id },
    });
    const regeneration = await jobsRepository.create({
      projectId,
      specId: requireValue(invalid).id,
      kind: "regenerate",
      chatId: crypto.randomUUID(),
      trigger: "steward",
      goal: "Restore the invalid check",
      limits: jobLimitsSchema.parse({}),
    });
    await jobsRepository.update(regeneration.id, {
      status: "completed",
      classification: "application_bug",
    });
    const invalidFinding = await jobsRepository.addItem({
      projectId,
      jobId: regeneration.id,
      kind: "bug_report",
      title: "The results page cannot open",
      body: "Opening the results page leaves an empty screen.",
    });
    const view = await projectOverview(projectId);
    assert.deepEqual(
      view.needsYou.map((item) => item.id),
      [older.id, newer.id, invalidFinding.id]
    );
    assert.equal(view.summary.attentionCount, 3);
    assert.equal(view.failing.length, 1);
    assert.equal(
      view.failing.find((item) => item.specId === requireValue(failing).id)
        ?.triageStatus,
      "App bug reported"
    );
    assert.equal(
      view.failing.some((item) => item.specId === requireValue(invalid).id),
      false,
      "an invalid implementation is not a failing application check"
    );
    assert.equal(
      view.needsYou.some((item) => item.id === invalidFinding.id),
      true,
      "a finding without a current failing check remains a reviewable decision"
    );
    assert.equal(view.summary.paused, true);
    assert.deepEqual(view.summary.specHealth, {
      total: 7,
      passing: 1,
      failing: 1,
      flaky: 1,
      awaiting_deploy: 0,
      not_checked: 3,
      queued: 0,
      running: 0,
      repairing: 0,
      invalid: 1,
    });
    assert.equal(
      view.specHealth[requireValue(pausedOne).id]?.status,
      "not_checked"
    );
    assert.equal(
      view.specHealth[requireValue(unchecked).id]?.status,
      "not_checked"
    );
    assert.equal(view.specHealth[requireValue(invalid).id]?.status, "invalid");
    assert.equal(
      view.specHealth[requireValue(invalid).id]?.label,
      "Needs repair"
    );
    assert.equal(view.specHealth[requireValue(flaky).id]?.status, "flaky");
    assert.equal(
      view.recentRuns.length,
      3,
      "recent activity contains actual runs, not completed agent sessions"
    );
    assert.equal(
      view.stories.some((story) => story.inboxIds.includes(older.id)),
      true,
      "pending decisions retain a detail timeline"
    );
    const finding = await jobsRepository.addItem({
      projectId,
      jobId: previous.id,
      kind: "bug_report",
      title: "An export link is broken",
      body: "Opening export returns 404.",
    });
    const withFinding = await projectOverview(projectId);
    const decision = withFinding.needsYou.find(
      (item) => item.id === finding.id
    );
    assert.match(
      decision?.presentation.title ?? "",
      /^Add a regression Spec.*\?$/u
    );
    assert.equal(
      withFinding.items.find((item) => item.id === finding.id)?.presentation
        .title,
      decision?.presentation.title
    );
    assert.equal(withFinding.summary.attentionCount, 4);
    assert.match(view.summary.nextCheck, /Resume Specbook/u);
    await stewardRepository.update(projectId, { paused: false });
    const oldTriage = await jobsRepository.create({
      projectId,
      specId: requireValue(failing).id,
      runId: failedRun.id,
      kind: "failure_triage",
      chatId: crypto.randomUUID(),
      trigger: "spec_failure",
      goal: "Investigate the previous failure",
      limits: jobLimitsSchema.parse({}),
    });
    await jobsRepository.update(oldTriage.id, {
      status: "completed",
      classification: "application_bug",
    });
    const passingRun = await createOverviewRun({
      specId: requireValue(failing).id,
      sourceHash: requireValue(failing).sourceHash,
      commitSha: await repoGit.getHeadSha(projectId),
    });
    await runsRepository.finishRun(passingRun.id, "passed", 1, null);
    const newFailure = await createOverviewRun({
      specId: requireValue(failing).id,
      sourceHash: requireValue(failing).sourceHash,
      commitSha: await repoGit.getHeadSha(projectId),
    });
    await runsRepository.finishRun(
      newFailure.id,
      "failed",
      1,
      "A different element is missing"
    );
    const uncheckedFailure = await projectOverview(projectId);
    const currentFailure = requireValue(
      uncheckedFailure.failing.find(
        (entry) => entry.specId === requireValue(failing).id
      )
    );
    assert.equal(currentFailure.triageStatus, "Latest run failed");
    assert.equal(
      currentFailure.storyId,
      undefined,
      "old triage details do not stand in for the latest failure evidence"
    );
    assert.ok(!currentFailure.inboxIds.includes(bug.id));
    const retry = await createOverviewRun({
      specId: requireValue(failing).id,
      sourceHash: requireValue(failing).sourceHash,
      commitSha: await repoGit.getHeadSha(projectId),
      retryOf: newFailure.id,
    });
    await runsRepository.finishRun(
      retry.id,
      "failed",
      1,
      "The same element is still missing"
    );
    const currentTriage = await jobsRepository.create({
      projectId,
      specId: requireValue(failing).id,
      runId: newFailure.id,
      kind: "failure_triage",
      chatId: crypto.randomUUID(),
      trigger: "spec_failure",
      goal: "Investigate the current failure",
      limits: jobLimitsSchema.parse({}),
    });
    await jobsRepository.update(currentTriage.id, { status: "running" });
    assert.equal(
      await (async () => {
        const awaitedResult141313 = await (async () => {
          const awaitedValue131053 = await projectOverview(projectId);
          return awaitedValue131053.failing.find(
            (entry) => entry.specId === requireValue(failing).id
          );
        })();
        return awaitedResult141313?.triageStatus;
      })(),
      "Investigating…",
      "the original and retry belong to the same investigation"
    );
  });

  test("overview health and last checked use the same current implementation and behavior", async () => {
    const { projectOverview } = await import("../../src/core/jobs/overview");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { db } = await import("../../src/infra/db/client");
    const { runs } = await import("../../src/infra/db/schema");
    const { eq } = await import("drizzle-orm");
    const projectId = await createProject("Current health");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Checkout",
      ""
    );
    const { spec } = await createSpec(
      projectId,
      feature.id,
      "Show the confirmation"
    );
    const run = await createOverviewRun({
      specId: spec.id,
      sourceHash: spec.sourceHash,
      commitSha: await repoGit.getHeadSha(projectId),
    });
    await db
      .update(runs)
      .set({ startedAt: "2026-01-01T12:00:00.000Z" })
      .where(eq(runs.id, run.id));
    await runsRepository.finishRun(
      run.id,
      "failed",
      100,
      "Confirmation not visible"
    );
    const job = await jobsRepository.create({
      projectId,
      specId: spec.id,
      runId: run.id,
      kind: "failure_triage",
      trigger: "spec_failure",
      chatId: crypto.randomUUID(),
      goal: "Investigate confirmation",
      limits: jobLimitsSchema.parse({}),
    });
    await jobsRepository.update(job.id, { status: "running" });
    const current = await projectOverview(projectId);
    assert.equal(current.summary.specHealth.failing, 1);
    assert.equal(current.summary.lastCheckedAt, "2026-01-01T12:00:00.100Z");
    assert.equal(
      current.specHealth[spec.id]?.lastCheckedAt,
      current.summary.lastCheckedAt
    );
    assert.equal(
      current.failing[0]?.updatedAt,
      current.summary.lastCheckedAt,
      "triage activity does not pretend the check ran again"
    );
    await writer.updateSpecWithLock(spec.id, {
      humanSpec: { ...HUMAN_SPEC, expectedResult: "The page is shown." },
    });
    assert.equal(
      await (async () => {
        const awaitedResult143862 = await specsRepository.getSpec(spec.id);
        return awaitedResult143862?.sourceHash;
      })(),
      spec.sourceHash
    );
    const changedBehavior = await projectOverview(projectId);
    assert.equal(changedBehavior.summary.specHealth.not_checked, 1);
    assert.equal(
      changedBehavior.summary.lastCheckedAt,
      null,
      "an old behavior result cannot supply the current check timestamp"
    );
    assert.equal(changedBehavior.specHealth[spec.id]?.runId, undefined);
    assert.equal(changedBehavior.failing.length, 0);
    assert.equal(
      changedBehavior.recentRuns.length,
      1,
      "historical results remain available as history"
    );
    await specsRepository.updateSpecStatus(
      spec.id,
      "invalid",
      "Missing spec.ts file in the spec directory"
    );
    const invalid = await projectOverview(projectId);
    assert.equal(invalid.summary.specHealth.invalid, 1);
    assert.equal(invalid.summary.specHealth.failing, 0);
    assert.equal(invalid.summary.lastCheckedAt, null);
    assert.equal(invalid.failing.length, 0);
  });

  test("overview groups repeated results while retaining each run and distinct failures", async () => {
    const { projectOverview } = await import("../../src/core/jobs/overview");
    const { db } = await import("../../src/infra/db/client");
    const { runs } = await import("../../src/infra/db/schema");
    const { eq } = await import("drizzle-orm");
    const projectId = await createProject("Repeated results");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Surveys",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "View surveys");
    const commitSha = await repoGit.getHeadSha(projectId);
    const runIds: string[] = [];
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let minute = 0; minute < 3; minute += 1) {
      const run = await createOverviewRun({
        specId: spec.id,
        sourceHash: spec.sourceHash,
        commitSha,
      });
      runIds.push(run.id);
      await db
        .update(runs)
        .set({ startedAt: `2026-01-01T12:0${minute}:00.000Z` })
        .where(eq(runs.id, run.id));
      await runsRepository.finishRun(run.id, "passed", 100, null);
    }
    /* oxlint-enable no-await-in-loop */
    const grouped = await projectOverview(projectId);
    assert.equal(grouped.recentRuns.length, 1);
    assert.equal(grouped.recentRuns[0]?.occurrences, 3);
    assert.equal(grouped.recentRuns[0]?.counts.passed, 3);
    assert.match(grouped.recentRuns[0]?.title ?? "", /3 runs/u);
    assert.deepEqual(
      grouped.recentRuns[0]?.timeline.map((event) => event.runId),
      runIds
    );
    assert.equal(grouped.recentRuns[0]?.updatedAt, "2026-01-01T12:02:00.100Z");
    const failed = await createOverviewRun({
      specId: spec.id,
      sourceHash: spec.sourceHash,
      commitSha,
    });
    await db
      .update(runs)
      .set({ startedAt: "2026-01-01T12:03:00.000Z" })
      .where(eq(runs.id, failed.id));
    await runsRepository.finishRun(
      failed.id,
      "failed",
      100,
      "Survey list is empty"
    );
    const distinct = await projectOverview(projectId);
    assert.equal(distinct.recentRuns.length, 2);
    assert.equal(distinct.recentRuns[0]?.runId, failed.id);
    assert.equal(distinct.recentRuns[0]?.occurrences, 1);
    assert.equal(distinct.recentRuns[1]?.occurrences, 3);
    assert.equal(distinct.summary.lastCheckedAt, "2026-01-01T12:03:00.100Z");
  });

  test("overview keeps a batch live through retry and links the final grouped result to run evidence", async () => {
    const { projectOverview } = await import("../../src/core/jobs/overview");
    const { createJobsRouter } =
      await import("../../src/infra/web/routes/jobs");
    const { runBatchesDir } = await import("../../src/core/paths");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { db } = await import("../../src/infra/db/client");
    const { projectSignals } = await import("../../src/infra/db/schema");
    const { eq } = await import("drizzle-orm");
    const projectId = await createProject("Batch overview");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Login",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "Sign in");
    const commitSha = await repoGit.getHeadSha(projectId);
    const original = await createOverviewRun({
      specId: spec.id,
      sourceHash: spec.sourceHash,
      commitSha,
      automate: true,
    });
    await runsRepository.finishRun(
      original.id,
      "failed",
      10,
      "Login button was not visible"
    );
    const batchId = crypto.randomUUID();
    await fs.mkdir(path.join(runBatchesDir, batchId), { recursive: true });
    const batch = {
      id: batchId,
      projectId,
      label: "Login checks",
      status: "failed",
      startedAt: original.startedAt,
      durationMs: 10,
      failReason: null,
      specs: [
        {
          runId: original.id,
          specId: spec.id,
          commitSha,
          sourceHash: spec.sourceHash,
          markdownHash: spec.markdownHash,
          title: spec.title,
          status: "failed",
          durationMs: 10,
          failReason: "Login button was not visible",
        },
      ],
    } satisfies RunBatch;
    await fs.writeFile(
      path.join(runBatchesDir, batchId, "batch.json"),
      JSON.stringify(batch)
    );
    await stewardRepository.signal({
      projectId,
      kind: "deployment",
      key: "deploy:preview",
      title: "Preview deployed",
      body: "Check the preview",
    });
    const signal = requireValue(
      await (async () => {
        const awaitedValue139070 = await stewardRepository.signals(projectId);
        return awaitedValue139070[0];
      })()
    );
    const runIntent = {
      kind: "run_specs" as const,
      goal: "Check login",
      reason: "Login changed",
      specIds: [spec.id],
      priority: 50,
    };
    const deployment = await stewardRepository.addIntent({
      projectId,
      key: `signal:${signal.id}`,
      fingerprint: "deploy:preview",
      intent: runIntent,
      priority: 50,
      reason: runIntent.reason,
    });
    await stewardRepository.updateIntent(deployment.id, {
      status: "completed",
    });
    const resumed = await stewardRepository.addIntent({
      projectId,
      key: `resume-run:${deployment.id}:answer`,
      fingerprint: "resumed:preview",
      intent: runIntent,
      priority: 50,
      reason: runIntent.reason,
    });
    await stewardRepository.updateIntent(resumed.id, {
      status: "running",
      batchId,
    });
    const pending = await projectOverview(projectId);
    assert.equal(pending.recentRuns.length, 1);
    assert.equal(pending.recentRuns[0]?.id, `batch:${batchId}`);
    assert.equal(pending.recentRuns[0]?.status, "working");
    assert.equal(pending.recentRuns[0]?.counts.running, 1);
    assert.equal(
      pending.recentRuns[0]?.trigger,
      "deploy",
      "resumed deployments retain their original trigger"
    );
    await runsRepository.finishRun(original.id, "passed", 10, null);
    assert.deepEqual(
      await (async () => {
        const awaitedResult151015 = await (async () => {
          const awaitedValue140483 = await projectOverview(projectId);
          return awaitedValue140483.recentRuns[0];
        })();
        return awaitedResult151015?.counts;
      })(),
      {
        total: 1,
        passed: 0,
        failed: 0,
        flaky: 0,
        running: 1,
        awaiting_deploy: 0,
      },
      "pending automation is counted once even after a passing result"
    );
    await runsRepository.finishRun(
      original.id,
      "failed",
      10,
      "Login button was not visible"
    );
    const retry = await createOverviewRun({
      specId: spec.id,
      sourceHash: spec.sourceHash,
      commitSha,
      retryOf: original.id,
    });
    await runsRepository.finishRun(retry.id, "passed", 20, null);
    await runsRepository.markFlaky(original.id, retry.id);
    assert.deepEqual(
      await (async () => {
        const awaitedResult151848 = await (async () => {
          const awaitedValue141191 = await projectOverview(projectId);
          return awaitedValue141191.recentRuns[0];
        })();
        return awaitedResult151848?.counts;
      })(),
      {
        total: 1,
        passed: 0,
        failed: 0,
        flaky: 0,
        running: 1,
        awaiting_deploy: 0,
      },
      "marking flaky before acknowledgment never duplicates the result count"
    );
    await runsRepository.acknowledgeAutomation(original.id);
    await specsRepository.updateSpecStatus(spec.id, "passed");
    const router = new Hono().route("/", createJobsRouter());
    const response = await router.request(`/projects/${projectId}/overview`);
    assert.equal(response.status, 200);
    const view = (await response.json()) as Awaited<
      ReturnType<typeof projectOverview>
    >;
    assert.equal(view.recentRuns[0]?.status, "completed");
    assert.equal(
      view.recentRuns.length,
      1,
      "batch runs and retries are not repeated as standalone history rows"
    );
    assert.match(view.recentRuns[0]?.title ?? "", /1 passed on retry/u);
    assert.equal(view.recentRuns[0]?.outcome, "flaky");
    assert.equal(view.recentRuns[0]?.timeline[0]?.specId, spec.id);
    assert.equal(view.recentRuns[0]?.timeline[0]?.runId, retry.id);
    assert.equal(
      view.recentRuns[0]?.updatedAt,
      new Date(Date.parse(retry.startedAt) + 20).toISOString()
    );
    assert.equal(view.specHealth[spec.id]?.status, "flaky");
    assert.equal(
      await (async () => {
        const awaitedValue142551 = await router.request(
          `/projects/${crypto.randomUUID()}/overview`
        );
        return awaitedValue142551.status;
      })(),
      404
    );
    await fs.writeFile(
      path.join(runBatchesDir, batchId, "batch.json"),
      JSON.stringify({ ...batch, trigger: "deploy" })
    );
    await db
      .delete(projectSignals)
      .where(eq(projectSignals.projectId, projectId));
    await stewardRepository.updateIntent(resumed.id, { status: "completed" });
    const finished = await stewardRepository.addIntent({
      projectId,
      key: "login:old",
      fingerprint: "login:old",
      intent: runIntent,
      priority: 50,
      reason: runIntent.reason,
    });
    await stewardRepository.updateIntent(finished.id, {
      status: "completed",
      batchId,
    });
    await stewardRepository.addIntent({
      projectId,
      key: "login:new",
      fingerprint: "login:new",
      intent: runIntent,
      priority: 50,
      reason: runIntent.reason,
    });
    const again = await projectOverview(projectId);
    assert.equal(
      again.recentRuns.length,
      1,
      "a pending intention is not a new run"
    );
    assert.equal(again.recentRuns[0]?.id, `batch:${batchId}`);
    assert.equal(
      again.recentRuns[0]?.trigger,
      "deploy",
      "stored run triggers survive observation retention and missing original signals"
    );
    assert.equal(
      again.stories.some(
        (story) => story.status === "queued" && story.specId === spec.id
      ),
      true
    );
  });
});

test("agent evaluation records outcomes and decisions without prompts or credentials", async () => {
  const { execFileSync } = await import("node:child_process");
  const { jobsRepository } = await import("../../src/infra/repositories/jobs");
  const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
  const { jobMetricsPath, recordAgentMetric } =
    await import("../../src/core/jobs/metrics");
  const projectId = await createProject("Evaluation records");
  const secret = "private-input-never-exported";
  const job = await jobsRepository.create({
    projectId,
    chatId: crypto.randomUUID(),
    kind: "failure_triage",
    trigger: "spec_failure",
    goal: secret,
    limits: jobLimitsSchema.parse({}),
  });
  await jobsRepository.claim(job.id);
  await jobsRepository.update(job.id, {
    classification: "test_drift",
    tokensUsed: 123,
    actionsUsed: 4,
    elapsedMs: 500,
  });
  const item = await jobsRepository.addItem({
    projectId,
    jobId: job.id,
    kind: "spec_fix",
    title: secret,
    body: secret,
  });
  await jobsRepository.log(job.id, "proposal:verified", `${item.id}: passed`);
  await jobsRepository.log(job.id, "inbox:reject", item.id);
  const current = requireValue(await jobsRepository.get(job.id));
  await recordAgentMetric(current, "decision", {
    itemId: item.id,
    decision: "approve",
    actor: "agent",
  });
  const records = await (async () => {
    const awaitedValue145431 = await fs.readFile(jobMetricsPath, "utf-8");
    return awaitedValue145431
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.jobId === job.id);
  })();
  assert.deepEqual(
    records.map((event) => event.event),
    [
      "created",
      "started",
      "classified",
      "item_created",
      "verified",
      "decision",
      "decision",
    ]
  );
  assert.equal(records[2].classification, "test_drift");
  assert.equal(records[4].verificationStatus, "passed");
  assert.equal(records[5].actor, "human");
  assert.equal(records[6].actor, "agent");
  assert.equal(records[6].tokensUsed, 123);
  assert.doesNotMatch(JSON.stringify(records), new RegExp(secret, "u"));
  const csv = execFileSync(
    process.execPath,
    ["scripts/export-metrics.mjs", jobMetricsPath, "--agent"],
    { encoding: "utf-8" }
  );
  assert.match(csv, /classification,tokensUsed,actionsUsed,elapsedMs/u);
  assert.match(csv, new RegExp(`${item.id},,reject,human`, "u"));
  assert.doesNotMatch(csv, new RegExp(secret, "u"));
});

describe("existing checks baseline", () => {
  test("first observation seeds 80 existing Specs without automatic runs, and queues repairs for broken ones", async (t) => {
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { processProjectSteward } =
      await import("../../src/core/steward/engine");
    const { stopJobWorker } = await import("../../src/core/jobs/worker");
    await stopJobWorker();
    t.mock.method(globalThis, "fetch", () => {
      try {
        return Promise.resolve(
          new Response('<script src="/stable-build.js"></script>')
        );
      } catch (error) {
        return Promise.reject(error);
      }
    });
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const invalid of [false, true]) {
      const projectId = await createProject(`Imported checks ${invalid}`);
      const feature = await writer.createFeatureInRepo(
        projectId,
        null,
        "Imported",
        ""
      );
      for (let i = 0; i < 80; i += 1) {
        await specsRepository.createSpecRecord({
          projectId,
          featureId: feature.id,
          title: `Imported check ${i + 1}`,
          description: "",
          path: `specs/imported/check-${i + 1}`,
          sourceHash: invalid ? "" : `source-${i}`,
          markdownHash: `behavior-${i}`,
          status: invalid ? "invalid" : "unverified",
          invalidReason: invalid
            ? "Missing spec.ts file in the spec directory"
            : null,
        });
      }
      await processProjectSteward(projectId);
      await processProjectSteward(projectId);
      assert.equal(
        Object.keys(
          (await (async () => {
            const awaitedValue148052 = await stewardRepository.get(projectId);
            return awaitedValue148052.observation.specs;
          })()) ?? {}
        ).length,
        80
      );
      const signals = await stewardRepository.signals(projectId);
      const intents = await stewardRepository.intents(projectId);
      assert.equal(signals.length, invalid ? 80 : 0);
      assert.ok(signals.every((signal) => signal.kind === "invalid_spec"));
      assert.equal(intents.length, invalid ? 80 : 0);
      assert.ok(intents.every((intent) => intent.intent.kind === "regenerate"));
      const jobs = await jobsRepository.list(projectId);
      assert.ok(
        jobs.every((job) => job.kind === "regenerate"),
        "no automatic runs"
      );
      const inbox = await jobsRepository.inbox(projectId);
      assert.equal(inbox.length, 0);
    }
    /* oxlint-enable no-await-in-loop */
  });
});

describe("repository recovery", () => {
  test("reviews all edits and rejects an obsolete review before committing", async () => {
    const { createRepositoryRecoveryRoutes } =
      await import("../../src/infra/web/routes/repository-recovery");
    const recoveryApp = new Hono();
    recoveryApp.route("/", createRepositoryRecoveryRoutes());
    const projectId = await createProject("Pending edits");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Login",
      ""
    );
    const { spec } = await createSpec(projectId, feature.id, "Sign in");
    const root = repoGit.getRepoDir(projectId);
    const target = path.join(root, spec.path, "spec.yml");
    const beforeInTest = await fs.readFile(target, "utf-8");
    const after = beforeInTest.replace(
      "title: Sign in",
      "title: Reviewed sign in"
    );
    await fs.writeFile(target, after);
    await fs.writeFile(path.join(root, "notes.md"), "Keep these notes.\n");
    const head = await repoGit.getHeadSha(projectId);
    const endpoint = `/projects/${projectId}/repository/recovery`;
    const preview = (await (async () => {
      const awaitedValue149929 = await recoveryApp.request(endpoint);
      return awaitedValue149929.json();
    })()) as {
      dirty: boolean;
      canSave: boolean;
      fingerprint: string;
      files: { path: string; before: string | null; after: string }[];
    };
    assert.equal(preview.canSave, true);
    assert.equal(preview.files.length, 2);
    assert.equal(
      preview.files.find((file) => file.path.endsWith("spec.yml"))?.before,
      beforeInTest
    );
    assert.equal(
      preview.files.find((file) => file.path.endsWith("spec.yml"))?.after,
      after
    );
    assert.equal(
      await repoGit.getHeadSha(projectId),
      head,
      "preview never commits behavior changes"
    );
    await fs.writeFile(
      path.join(root, "notes.md"),
      "Keep these updated notes.\n"
    );
    const save = (fingerprint: string) =>
      recoveryApp.request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fingerprint }),
      });
    assert.equal(
      await (async () => {
        const awaitedValue150905 = await save(preview.fingerprint);
        return awaitedValue150905.status;
      })(),
      409
    );
    assert.equal(await repoGit.getHeadSha(projectId), head);
    const fresh = (await (async () => {
      const awaitedValue151039 = await recoveryApp.request(endpoint);
      return awaitedValue151039.json();
    })()) as typeof preview;
    assert.equal(
      await (async () => {
        const awaitedValue151133 = await save(fresh.fingerprint);
        return awaitedValue151133.status;
      })(),
      200
    );
    assert.notEqual(await repoGit.getHeadSha(projectId), head);
    assert.equal(
      await fs.readFile(target, "utf-8"),
      after,
      "explicit review preserves the exact behavior edit"
    );
    assert.equal(
      await (async () => {
        const awaitedResult162938 = await specsRepository.getSpec(spec.id);
        return awaitedResult162938?.title;
      })(),
      "Reviewed sign in"
    );
    assert.equal(
      await (async () => {
        const awaitedValue151510 = await repoGit
          .getProjectGit(projectId)
          .status();
        return awaitedValue151510.isClean();
      })(),
      true
    );
    assert.equal(
      await (async () => {
        const awaitedValue151613 = await save(fresh.fingerprint);
        return awaitedValue151613.status;
      })(),
      409,
      "a consumed review cannot commit again"
    );
  });

  test("does not expose symlink targets or change files while an update is in progress", async () => {
    const { repositoryRecoveryUnlocked, prepareRunRepositoryUnlocked } =
      await import("../../src/core/repo/recovery");
    const projectId = await createProject("Unsafe pending edit");
    const root = repoGit.getRepoDir(projectId);
    const outside = path.join(tempDir(), "recovery-outside.txt");
    await fs.writeFile(outside, "do not expose this file");
    await fs.symlink(outside, path.join(root, "pending.md"));
    const preview = await repoGit.withRepoLock(projectId, () =>
      repositoryRecoveryUnlocked(projectId)
    );
    assert.equal(preview.canSave, false);
    assert.deepEqual(preview.files, []);
    assert.doesNotMatch(
      JSON.stringify(preview),
      /do not expose|recovery-outside/u
    );
    await fs.unlink(path.join(root, "pending.md"));
    await fs.writeFile(
      path.join(root, ".git", "index.lock"),
      "active operation"
    );
    await assert.rejects(
      () =>
        repoGit.withRepoLock(projectId, () =>
          prepareRunRepositoryUnlocked(projectId)
        ),
      /files are being updated/u
    );
    assert.equal(
      await fs.readFile(path.join(root, ".git", "index.lock"), "utf-8"),
      "active operation"
    );
  });
});

describe("encrypted credentials and operations", () => {
  test("credential fields expose only public values and retain encrypted values while renaming", async () => {
    const { createCredentialsRouter } =
      await import("../../src/infra/web/routes/credentials");
    const { credentialsRepository } =
      await import("../../src/infra/repositories/credentials");
    const { decryptSecret } = await import("../../src/core/credentials/crypto");
    const { projectSecretScrubber, registerTransientSecret } =
      await import("../../src/core/credentials/scrub");
    const projectId = await createProject("Credential field flags");
    const credentials = new Hono();
    credentials.use("*", async (c, next) => {
      c.set("user", {
        id: "credential-admin",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        passwordHash: null,
        disabledAt: null,
        createdAt: "",
        updatedAt: "",
      });
      // oxlint-disable-next-line node/callback-return -- The awaited Hono middleware or HTTP helper is not a Node error-first callback.
      await next();
    });
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- This handler models the callback interface exercised by the test.
    credentials.onError((error, c) =>
      error instanceof HTTPException
        ? c.json({ error: error.message }, error.status)
        : c.json({ error: String(error) }, 500)
    );
    credentials.route("/", createCredentialsRouter());
    const request = (method: string, url: string, body?: unknown) =>
      credentials.request(url, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const created = await request(
      "POST",
      `/projects/${projectId}/credentials`,
      {
        name: "account",
        fields: [
          { key: "username", value: "visible-user" },
          { key: "password", value: "hidden-password" },
          { key: "token", value: "visible-token", sensitive: false },
        ],
      }
    );
    assert.equal(created.status, 200);
    const { profile } = await created.json();
    assert.equal("identifier" in profile, false);
    assert.deepEqual(profile.fields, [
      { key: "username", sensitive: false, value: "visible-user" },
      { key: "password", sensitive: true, hasValue: true },
      { key: "token", sensitive: false, value: "visible-token" },
    ]);
    const stored = requireValue(
      await credentialsRepository.getProfile(profile.id)
    );
    assert.ok(stored.fields.every((field) => field.value.startsWith("v1:")));
    assert.doesNotMatch(
      JSON.stringify(stored),
      /visible-user|hidden-password|visible-token/u
    );
    const changed = await request("PUT", `/credentials/${profile.id}`, {
      fields: [
        {
          key: "email",
          previousKey: "username",
          sensitive: false,
          value: "edited@example.com",
        },
        { key: "api-password", previousKey: "password", sensitive: true },
        { key: "token", sensitive: true },
      ],
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(
      await (async () => {
        const awaitedValue155944 = await changed.json();
        return awaitedValue155944.profile.fields;
      })(),
      [
        { key: "email", sensitive: false, value: "edited@example.com" },
        { key: "api-password", sensitive: true, hasValue: true },
        { key: "token", sensitive: true, hasValue: true },
      ]
    );
    assert.equal(
      decryptSecret(
        requireValue(await credentialsRepository.getProfile(profile.id))
          .fields[1].value
      ),
      "hidden-password"
    );
    assert.equal(
      (await projectSecretScrubber(projectId))(
        "edited@example.com hidden-password visible-token"
      ),
      "edited@example.com •••• ••••"
    );
    registerTransientSecret(projectId, "edited@example.com");
    assert.equal(
      (await projectSecretScrubber(projectId))("edited@example.com"),
      "edited@example.com"
    );
    assert.equal(
      await (async () => {
        const awaitedValue156728 = await request(
          "POST",
          `/projects/${projectId}/credentials`,
          {
            name: "duplicate",
            fields: [
              { key: "password", value: "one" },
              { key: "password", value: "two" },
            ],
          }
        );
        return awaitedValue156728.status;
      })(),
      400
    );
    assert.equal(
      await (async () => {
        const awaitedValue157024 = await request(
          "POST",
          `/projects/${projectId}/credentials`,
          {
            name: "empty",
            fields: [],
          }
        );
        return awaitedValue157024.status;
      })(),
      400
    );
    const visible = await request("PUT", `/credentials/${profile.id}`, {
      fields: [
        { key: "password", previousKey: "api-password", sensitive: false },
      ],
    });
    assert.equal(visible.status, 200);
    assert.deepEqual(
      await (async () => {
        const awaitedValue157429 = await visible.json();
        return awaitedValue157429.profile.fields;
      })(),
      [{ key: "password", sensitive: false, value: "hidden-password" }]
    );
  });

  test(
    "startup encrypts legacy identifiers as public username fields before removing the column",
    { timeout: 30_000 },
    async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { backendRoot } = await import("../../src/core/paths");
      const directory = tempDir("specbook-credential-migration-");
      const migrations = path.join(directory, "drizzle");
      await fs.cp(path.join(backendRoot, "drizzle"), migrations, {
        recursive: true,
      });
      const journalPath = path.join(migrations, "meta", "_journal.json");
      const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
      journal.entries = journal.entries.filter(
        (entry: { idx: number }) => entry.idx < 43
      );
      await fs.writeFile(journalPath, JSON.stringify(journal));
      const environment = {
        ...process.env,
        SPECBOOK_STORAGE_DIR: path.join(directory, "storage"),
        SPECBOOK_ENCRYPTION_KEY: "",
        SPECBOOK_ENCRYPTION_KEY_FILE: "",
      };
      const setup = `
            const {runMigrations}=await import('./src/infra/db/migrate.ts'); await runMigrations();
            const {db}=await import('./src/infra/db/client.ts'); const {sql}=await import('drizzle-orm'); const {encryptSecret}=await import('./src/core/credentials/crypto.ts');
            await db.run(sql\`INSERT INTO projects (id,name,base_url,created_at) VALUES ('legacy-project','Old credentials','https://example.com','2026-10-13')\`);
            const fields=JSON.stringify([{key:'password',value:encryptSecret('legacy-password')}]);
            await db.run(sql\`INSERT INTO credential_profiles (id,project_id,name,allowed_origins,fields,identifier,created_at,updated_at) VALUES ('legacy','legacy-project','legacy','[]',\${fields},'legacy-user','2026-10-13','2026-10-13')\`);
        `;
      const exec = promisify(execFile);
      await exec(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", setup],
        {
          cwd: backendRoot,
          env: { ...environment, SPECBOOK_MIGRATIONS_DIR: migrations },
        }
      );
      const verify = `
            import assert from 'node:assert/strict';
            const {runMigrations}=await import('./src/infra/db/migrate.ts'); await runMigrations();
            const {db}=await import('./src/infra/db/client.ts'); const {sql}=await import('drizzle-orm');
            assert.equal((await db.all(sql\`PRAGMA table_info(credential_profiles)\`)).some(column=>column.name==='identifier'),false);
            const {credentialsRepository}=await import('./src/infra/repositories/credentials.ts'); const row=await credentialsRepository.getProfile('legacy');
            const {publicProfile,resolveSecretEnv}=await import('./src/core/credentials/profiles.ts');
            assert.deepEqual(publicProfile(row).fields,[{key:'username',sensitive:false,value:'legacy-user'},{key:'password',sensitive:true,hasValue:true}]);
            assert.ok(row.fields.every(field=>field.value.startsWith('v1:')));
            assert.deepEqual((await resolveSecretEnv(row.projectId,['SPECBOOK_SECRET_LEGACY_USERNAME','SPECBOOK_SECRET_LEGACY_PASSWORD'])).publicRefs,['SPECBOOK_SECRET_LEGACY_USERNAME']);
            await runMigrations(); assert.deepEqual((await credentialsRepository.getProfile('legacy')).fields,row.fields);
        `;
      await exec(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", verify],
        { cwd: backendRoot, env: environment }
      );
    }
  );

  test(
    "rotates every stored secret and restores an independent backup",
    { timeout: 60_000 },
    async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const root = tempDir("specbook-operations-");
      const original = path.join(root, "original");
      const restored = path.join(root, "restored");
      const archive = path.join(root, "backup.tar.gz");
      const keyFile = path.join(root, "external.key");
      const env = {
        ...process.env,
        SPECBOOK_STORAGE_DIR: original,
        SPECBOOK_ENCRYPTION_KEY: "",
        SPECBOOK_ENCRYPTION_KEY_FILE: "",
      };
      const script = `
            import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import crypto from 'node:crypto';
            const {runMigrations}=await import('./src/infra/db/migrate.ts'); await runMigrations();
            const {createProject}=await import('./src/core/projects.ts'); const p=await createProject('Backup check','https://example.com');
            const {createProfile}=await import('./src/core/credentials/profiles.ts');
            const profile=await createProfile(p.id,{name:'account',fields:[{key:'password',value:'credential-to-preserve'}]});
            const {db}=await import('./src/infra/db/client.ts'); const schema=await import('./src/infra/db/schema.ts');
            const {encryptSecret,decryptSecret}=await import('./src/core/credentials/crypto.ts');
            await db.insert(schema.chatSessions).values({id:'saved',projectId:p.id,profileId:profile.id,state:encryptSecret('saved-browser-state'),savedAt:new Date().toISOString()});
            await db.insert(schema.projectAutomations).values({projectId:p.id,webhookUrl:encryptSecret('https://hooks.example/secret'),updatedAt:new Date().toISOString()});
            await db.insert(schema.appSettings).values({id:1,llm:{provider:'',model:''},sso:{clientSecret:encryptSecret('oidc-secret')},updatedAt:new Date().toISOString()});
            await db.insert(schema.oidcStates).values({stateHash:'state',browserHash:'browser',pkceVerifier:encryptSecret('pkce-verifier'),nonce:'nonce',redirectUri:'https://specbook.example/callback',issuer:'https://issuer.example',clientId:'client',expiresAt:new Date().toISOString()});
            const auth=process.env.SPECBOOK_STORAGE_DIR+'/pi-auth.json'; await fs.writeFile(auth,JSON.stringify({example:{type:'api_key',key:'model-to-preserve'}}));
            const {migrateSecrets,rotateEncryptionKey}=await import('./src/core/credentials/migration.ts');
            process.env.SPECBOOK_ENCRYPTION_KEY=crypto.randomBytes(32).toString('base64'); await migrateSecrets();
            assert.ok(!(await fs.readFile(auth,'utf8')).includes('model-to-preserve'));
            assert.equal((await fs.stat(auth)).mode & 0o777,0o600);
            const next=crypto.randomBytes(32); const result=await rotateEncryptionKey(next); assert.equal(result.requiresConfiguration,true);
            await assert.rejects(migrateSecrets(),/Configure the new/);
            process.env.SPECBOOK_ENCRYPTION_KEY=next.toString('base64'); await migrateSecrets();
            const {FileCredentialStore}=await import('./src/core/llm/credentials.ts'); assert.equal((await new FileCredentialStore(auth).read('example')).key,'model-to-preserve');
            assert.equal(decryptSecret((await db.select().from(schema.credentialProfiles))[0].fields[0].value),'credential-to-preserve');
            assert.equal(decryptSecret((await db.select().from(schema.chatSessions))[0].state),'saved-browser-state');
            assert.equal(decryptSecret((await db.select().from(schema.projectAutomations))[0].webhookUrl),'https://hooks.example/secret');
            assert.equal(decryptSecret((await db.select().from(schema.appSettings))[0].sso.clientSecret),'oidc-secret');
            assert.equal(decryptSecret((await db.select().from(schema.oidcStates))[0].pkceVerifier),'pkce-verifier');
            await fs.writeFile(process.env.OPS_TEST_KEY,next,{mode:0o600});
        `;
      await exec(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { env: { ...env, OPS_TEST_KEY: keyFile } }
      );
      const keyedEnv = { ...env, SPECBOOK_ENCRYPTION_KEY_FILE: keyFile };
      const cli = ["--import", "tsx", "src/operations-cli.ts"];
      await exec(process.execPath, [...cli, "backup", archive], {
        env: keyedEnv,
      });
      assert.equal(
        // oxlint-disable-next-line no-bitwise -- Compare only the Unix permission bits of the generated backup file.
        (await (async () => {
          const awaitedValue165691 = await fs.stat(archive);
          return awaitedValue165691.mode;
        })()) & 0o777,
        0o600
      );
      await exec(
        process.execPath,
        [...cli, "restore", archive, "--storage", restored],
        { env: keyedEnv }
      );
      assert.ok(existsSync(path.join(restored, "specbook.db")));
      assert.equal(
        await fs.readFile(path.join(restored, "pi-auth.json"), "utf-8"),
        await fs.readFile(path.join(original, "pi-auth.json"), "utf-8")
      );
      assert.deepEqual(
        await fs.readdir(path.join(restored, "repos")),
        await fs.readdir(path.join(original, "repos"))
      );
      await assert.rejects(
        exec(
          process.execPath,
          [...cli, "restore", archive, "--storage", restored],
          { env: keyedEnv }
        ),
        /empty storage directory/u
      );
      const wrong = path.join(root, "wrong-key");
      await fs.writeFile(wrong, crypto.randomBytes(32));
      const rejected = path.join(root, "rejected");
      await assert.rejects(
        exec(
          process.execPath,
          [...cli, "restore", archive, "--storage", rejected],
          { env: { ...env, SPECBOOK_ENCRYPTION_KEY_FILE: wrong } }
        ),
        /matching encryption key/u
      );
      assert.deepEqual(
        await (async () => {
          const awaitedValue166923 = await fs.readdir(rejected);
          return awaitedValue166923.filter(
            (name) => name !== ".operations.lock"
          );
        })(),
        []
      );
    }
  );

  test("retention keeps current runs and pending evidence while pruning expired data", async () => {
    const { db } = await import("../../src/infra/db/client");
    const { runs } = await import("../../src/infra/db/schema");
    const { eq } = await import("drizzle-orm");
    const { settingsRepository } =
      await import("../../src/infra/repositories/settings");
    const { cleanupRetention } =
      await import("../../src/core/operations/retention");
    const { storageRoot, runsDir } = await import("../../src/core/paths");
    const projectId = await createProject("Retention");
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Retention",
      ""
    );
    const { spec } = await createSpec(
      projectId,
      feature.id,
      "Retained evidence"
    );
    const old = new Date(Date.now() - 200 * 86_400_000);
    const ids: string[] = [];
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (let index = 0; index < 4; index += 1) {
      const run = await runsRepository.createRun({
        specId: spec.id,
        sourceHash: requireValue(spec.sourceHash),
        commitSha: "sha",
      });
      await runsRepository.finishRun(run.id, "passed", 1, null);
      await db
        .update(runs)
        .set({
          startedAt: new Date(old.getTime() + index * 1000).toISOString(),
        })
        .where(eq(runs.id, run.id));
      await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
      await fs.writeFile(
        path.join(runsDir, run.id, "evidence.txt"),
        "retained only when needed"
      );
      ids.push(run.id);
    }
    /* oxlint-enable no-await-in-loop */
    const batchId = crypto.randomUUID();
    const batchDirectory = path.join(runsDir, "batches", batchId);
    await fs.mkdir(batchDirectory, { recursive: true });
    await fs.writeFile(
      path.join(batchDirectory, "batch.json"),
      JSON.stringify({
        id: batchId,
        projectId,
        label: "Retained batch",
        status: "passed",
        startedAt: old.toISOString(),
        durationMs: 2,
        failReason: null,
        specs: ids.slice(2).map((runId) => ({
          runId,
          specId: spec.id,
          status: "passed",
          title: spec.title,
          sourceHash: spec.sourceHash,
          markdownHash: spec.markdownHash,
          commitSha: "sha",
          durationMs: 1,
          failReason: null,
        })),
      })
    );
    await db
      .update(runs)
      .set({ automationPending: true })
      .where(eq(runs.id, ids[0]));
    const metrics = path.join(storageRoot, "metrics", "chat-turns.jsonl");
    await fs.mkdir(path.dirname(metrics), { recursive: true });
    await fs.writeFile(
      metrics,
      `${JSON.stringify({ startedAt: old.toISOString() })}\n${JSON.stringify({ startedAt: new Date().toISOString() })}\n`
    );
    await settingsRepository.updateRetention({
      runsPerSpec: 1,
      runDays: 30,
      videoDays: 7,
      batchDays: 30,
      metricDays: 90,
      browserProfileDays: 30,
    });
    const result = await cleanupRetention();
    assert.ok(result.removedRuns >= 1);
    assert.ok(
      await runsRepository.getRun(ids[0]),
      "pending failure evidence survives"
    );
    assert.equal(await runsRepository.getRun(ids[1]), null);
    assert.ok(
      await runsRepository.getRun(ids[2]),
      "a retained batch keeps all attempts needed to report its CI status"
    );
    assert.ok(
      await runsRepository.getRun(ids[3]),
      "last run survives regardless of age"
    );
    assert.equal(
      await (async () => {
        const awaitedValue170534 = await fs.readFile(metrics, "utf-8");
        return awaitedValue170534.trim().split("\n").length;
      })(),
      1
    );
    assert.ok(result.removedMetrics >= 1);
    await settingsRepository.updateRetention({
      runsPerSpec: 20,
      runDays: 30,
      videoDays: 7,
      batchDays: 30,
      metricDays: 90,
      browserProfileDays: 30,
    });
  });
});

describe("accounts, roles and session security", () => {
  let secured: Hono;
  let adminCookie = "";
  let admin: { id: string; name: string; email: string; role: string };
  const password = "Specbook-test-password-42";
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
  const cookieOf = (response: Response, name = "specbook_session") =>
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.split(";")[0] ?? "";
  const call = (
    method: string,
    url: string,
    body?: unknown,
    cookie = adminCookie,
    extra: Record<string, string> = {}
  ) =>
    secured.request(`http://localhost:4000${url}`, {
      method,
      headers: {
        host: "localhost:4000",
        "X-Specbook-Request": "1",
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  before(async () => {
    secured = await (async () => {
      const awaitedValue171796 = await import("../../src/infra/web/app");
      return awaitedValue171796.createApp();
    })();
  });

  test("bootstrap is exclusive, credentials are hashed and sessions carry secure cookie attributes", async () => {
    const { accountsRepository } =
      await import("../../src/infra/repositories/accounts");
    assert.deepEqual(
      await (async () => {
        const awaitedValue172103 = await call(
          "GET",
          "/setup/status",
          undefined,
          ""
        );
        return awaitedValue172103.json();
      })(),
      { needsAdmin: true, authenticated: false }
    );
    const responses = await Promise.all(
      ["first", "second"].map((name) =>
        call(
          "POST",
          "/setup/admin",
          { name, email: `${name}@example.com`, password },
          ""
        )
      )
    );
    assert.deepEqual(
      responses.map((response) => response.status).toSorted(),
      [201, 409]
    );
    const response = requireValue(
      responses.find((result) => result.status === 201)
    );
    admin = await (async () => {
      const awaitedValue172646 = await response.json();
      return awaitedValue172646.user;
    })();
    adminCookie = cookieOf(response);
    assert.ok(adminCookie);
    assert.match(requireValue(response.headers.get("set-cookie")), /HttpOnly/u);
    assert.match(
      requireValue(response.headers.get("set-cookie")),
      /SameSite=Lax/iu
    );
    assert.equal(
      await (async () => {
        const awaitedValue172900 = await accountsRepository.listUsers();
        return awaitedValue172900.length;
      })(),
      1
    );
    const stored = requireValue(await accountsRepository.getUser(admin.id));
    assert.match(requireValue(stored.passwordHash), /^scrypt-v1:/u);
    assert.notEqual(stored.passwordHash, password);
    assert.equal(
      await (async () => {
        const awaitedValue173142 = await call("GET", "/auth/me");
        return awaitedValue173142.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedValue173212 = await call(
          "POST",
          "/setup/admin",
          { name: "Third", email: "third@example.com", password },
          ""
        );
        return awaitedValue173212.status;
      })(),
      409
    );
    assert.equal(
      await (async () => {
        const awaitedValue173425 = await call(
          "POST",
          "/auth/login",
          { email: admin.email, password: "wrong" },
          ""
        );
        return awaitedValue173425.status;
      })(),
      401
    );
    const status = await (async () => {
      const awaitedValue173624 = await call(
        "GET",
        "/setup/status",
        undefined,
        ""
      );
      return awaitedValue173624.json();
    })();
    assert.deepEqual(status, { needsAdmin: false, authenticated: false });
  });

  test("invitations are one-use, viewers cannot mutate, editors cannot administer, and bearer clients keep working", async () => {
    const invite = async (role: string) => {
      const response = await call("POST", "/settings/invitations", {
        email: `${role}@example.com`,
        role,
      });
      assert.equal(response.status, 201, await response.clone().text());
      const result = await response.json();
      assert.ok(new URL(result.inviteUrl).hash.startsWith("#token="));
      const token = requireValue(
        new URLSearchParams(new URL(result.inviteUrl).hash.slice(1)).get(
          "token"
        )
      );
      const accepted = await call(
        "POST",
        "/auth/invitations/accept",
        { token, name: role, password },
        ""
      );
      assert.equal(accepted.status, 201, await accepted.clone().text());
      assert.equal(
        await (async () => {
          const awaitedValue174634 = await call(
            "POST",
            "/auth/invitations/inspect",
            { token },
            ""
          );
          return awaitedValue174634.status;
        })(),
        410
      );
      assert.equal(
        await (async () => {
          const awaitedValue174756 = await call(
            "POST",
            "/auth/invitations/accept",
            { token, name: role, password },
            ""
          );
          return awaitedValue174756.status;
        })(),
        410
      );
      return {
        user: await (async () => {
          const awaitedValue174972 = await accepted.json();
          return awaitedValue174972.user;
        })(),
        cookie: cookieOf(accepted),
      };
    };
    const viewer = await invite("viewer");
    const editor = await invite("editor");
    assert.equal(
      await (async () => {
        const awaitedValue175149 = await call(
          "GET",
          "/projects",
          undefined,
          viewer.cookie
        );
        return awaitedValue175149.status;
      })(),
      200
    );
    const missingReplay = "/runs/00000000-0000-4000-8000-000000000000/replay";
    assert.equal(
      await (async () => {
        const awaitedValue175329 = await call(
          "GET",
          missingReplay,
          undefined,
          ""
        );
        return awaitedValue175329.status;
      })(),
      401
    );
    const viewerReplay = await call(
      "GET",
      missingReplay,
      undefined,
      viewer.cookie
    );
    assert.equal(
      viewerReplay.status,
      404,
      "viewers reach the replay artifact handler"
    );
    assert.equal(
      await (async () => {
        const awaitedValue175638 = await viewerReplay.json();
        return awaitedValue175638.error;
      })(),
      "Run not found"
    );
    assert.equal(
      await (async () => {
        const awaitedValue175715 = await call(
          "POST",
          "/projects",
          { name: "Forbidden", baseUrl: "https://example.com" },
          viewer.cookie
        );
        return awaitedValue175715.status;
      })(),
      403
    );
    assert.equal(
      await (async () => {
        const awaitedValue175934 = await call(
          "GET",
          "/settings/members",
          undefined,
          viewer.cookie
        );
        return awaitedValue175934.status;
      })(),
      403
    );
    assert.equal(
      await (async () => {
        const awaitedValue176050 = await call(
          "GET",
          "/settings/llm",
          undefined,
          editor.cookie
        );
        return awaitedValue176050.status;
      })(),
      403
    );
    assert.equal(
      await (async () => {
        const awaitedValue176162 = await call(
          "GET",
          "/settings/llm/status",
          undefined,
          editor.cookie
        );
        return awaitedValue176162.status;
      })(),
      200
    );
    const created = await call(
      "POST",
      "/projects",
      { name: "Attributed edits", baseUrl: "https://example.com" },
      editor.cookie
    );
    assert.equal(created.status, 200, await created.clone().text());
    const { project } = await created.json();
    const featureResponse = await call(
      "POST",
      `/projects/${project.id}/features`,
      { title: "Authored feature", description: "" },
      editor.cookie
    );
    assert.equal(
      featureResponse.status,
      200,
      await featureResponse.clone().text()
    );
    const author = await repoGit
      .getProjectGit(project.id)
      .raw(["log", "-1", "--format=%an <%ae>"]);
    assert.equal(author.trim(), "editor <editor@example.com>");
    const gitToken = await (async () => {
      const awaitedValue177027 = await (async () => {
        const awaitedValue186483 = await call(
          "POST",
          `/projects/${project.id}/git/remote/token`
        );
        return awaitedValue186483.json();
      })();
      return awaitedValue177027.token;
    })();
    const git = await call(
      "GET",
      `/git/${project.id}.git/info/refs?service=git-upload-pack`,
      undefined,
      "",
      {
        authorization: `Basic ${Buffer.from(`git:${gitToken}`).toString("base64")}`,
      }
    );
    assert.equal(git.status, 200, await git.clone().text());
    const ciToken = await (async () => {
      const awaitedValue177465 = await (async () => {
        const awaitedValue187006 = await call(
          "POST",
          `/projects/${project.id}/ci/token`
        );
        return awaitedValue187006.json();
      })();
      return awaitedValue177465.token;
    })();
    assert.equal(
      await (async () => {
        const awaitedValue177580 = await call(
          "POST",
          `/ci/projects/${project.id}/deploy`,
          {},
          "",
          {
            authorization: `Bearer ${ciToken}`,
          }
        );
        return awaitedValue177580.status;
      })(),
      202
    );
    assert.equal(
      await (async () => {
        const awaitedValue177770 = await call(
          "POST",
          `/ci/projects/${project.id}/deploy`,
          {},
          ""
        );
        return awaitedValue177770.status;
      })(),
      401
    );
    const audit = await (async () => {
      const awaitedValue177885 = await call("GET", "/settings/audit?limit=100");
      return awaitedValue177885.json();
    })();
    assert.ok(
      audit.events.some(
        (event: { actorId: string; action: string }) =>
          event.actorId === editor.user.id &&
          event.action === "repository.commit"
      )
    );
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(password, "u"));
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(ciToken, "u"));
    assert.equal(
      await (async () => {
        const awaitedValue178309 = await call(
          "PATCH",
          `/settings/members/${viewer.user.id}`,
          {
            disabled: true,
          }
        );
        return awaitedValue178309.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedValue178474 = await call(
          "GET",
          "/projects",
          undefined,
          viewer.cookie
        );
        return awaitedValue178474.status;
      })(),
      401
    );
  });

  test("personal tokens are one-time secrets and membership changes revoke them", async () => {
    const { accountsRepository } =
      await import("../../src/infra/repositories/accounts");
    const { db } = await import("../../src/infra/db/client");
    const { personalAccessTokens } = await import("../../src/infra/db/schema");
    const { tokenHash } = await import("../../src/core/accounts/tokens");
    const member = await accountsRepository.createSsoUser(
      "token-user@example.com",
      "Token user",
      "editor",
      "https://tokens.example.com",
      "token-user"
    );
    const session = crypto.randomBytes(32).toString("hex");
    await accountsRepository.createSession(
      tokenHash(session),
      member.id,
      new Date(Date.now() + 60_000).toISOString()
    );
    const cookie = `specbook_session=${session}`;
    assert.equal(
      await (async () => {
        const awaitedValue179440 = await call(
          "POST",
          "/auth/access-tokens",
          { name: " " },
          cookie
        );
        return awaitedValue179440.status;
      })(),
      400
    );
    const created = await call(
      "POST",
      "/auth/access-tokens",
      { name: "Work laptop" },
      cookie
    );
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    const { token, accessToken } = await created.json();
    assert.match(token, /^sb_pat_[a-f0-9]{64}$/u);
    assert.equal(accessToken.name, "Work laptop");
    assert.equal(accessToken.lastUsedAt, null);
    assert.equal(accessToken.expiresAt, null);
    const stored = requireValue(
      await (async () => {
        const awaitedValue180038 = await db.select().from(personalAccessTokens);
        return awaitedValue180038.find((row) => row.id === accessToken.id);
      })()
    );
    assert.equal(stored.tokenHash, tokenHash(token));
    assert.ok(!JSON.stringify(stored).includes(token));
    const headers = { authorization: `Bearer ${token}` };
    assert.equal(
      await (async () => {
        const awaitedValue180332 = await (async () => {
          const awaitedValue190553 = await call(
            "GET",
            "/auth/me",
            undefined,
            "",
            headers
          );
          return awaitedValue190553.json();
        })();
        return awaitedValue180332.user.id;
      })(),
      member.id
    );
    const list = await (async () => {
      const awaitedValue180467 = await call(
        "GET",
        "/auth/access-tokens",
        undefined,
        cookie
      );
      return awaitedValue180467.json();
    })();
    assert.ok(list.tokens[0].lastUsedAt);
    assert.ok(!JSON.stringify(list).includes(token));
    assert.equal(
      await (async () => {
        const awaitedValue180669 = await call(
          "DELETE",
          `/auth/access-tokens/${accessToken.id}`
        );
        return awaitedValue180669.status;
      })(),
      404
    );
    assert.equal(
      await (async () => {
        const awaitedValue180782 = await call(
          "POST",
          "/auth/access-tokens",
          { name: "More tokens" },
          "",
          headers
        );
        return awaitedValue180782.status;
      })(),
      403
    );
    assert.equal(
      await (async () => {
        const awaitedValue180989 = await call(
          "GET",
          "/auth/access-tokens",
          undefined,
          "",
          headers
        );
        return awaitedValue180989.status;
      })(),
      403
    );
    const bearerWrite = await secured.request(
      "http://localhost:4000/projects",
      {
        method: "POST",
        headers: {
          host: "localhost:4000",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          name: "Bearer project",
          baseUrl: "https://example.com",
        }),
      }
    );
    assert.equal(bearerWrite.status, 200, await bearerWrite.clone().text());
    assert.equal(
      await (async () => {
        const awaitedValue181567 = await call(
          "PATCH",
          `/settings/members/${member.id}`,
          {
            role: "viewer",
          }
        );
        return awaitedValue181567.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedValue181727 = await call(
          "POST",
          "/projects",
          { name: "Forbidden", baseUrl: "https://example.com" },
          "",
          headers
        );
        return awaitedValue181727.status;
      })(),
      401
    );
    assert.equal(
      await (async () => {
        const awaitedValue181954 = await call(
          "PATCH",
          `/settings/members/${member.id}`,
          {
            disabled: true,
          }
        );
        return awaitedValue181954.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedValue182114 = await call(
          "GET",
          "/auth/me",
          undefined,
          "",
          headers
        );
        return awaitedValue182114.status;
      })(),
      401
    );
    assert.equal(
      await (async () => {
        const awaitedValue182219 = await call(
          "PATCH",
          `/settings/members/${member.id}`,
          {
            disabled: false,
          }
        );
        return awaitedValue182219.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedValue182380 = await call(
          "GET",
          "/auth/me",
          undefined,
          adminCookie,
          {
            authorization: "Bearer invalid",
          }
        );
        return awaitedValue182380.status;
      })(),
      401
    );
    await accountsRepository.createSession(
      tokenHash(session),
      member.id,
      new Date(Date.now() + 60_000).toISOString()
    );
    assert.equal(
      await (async () => {
        const awaitedValue182701 = await call(
          "DELETE",
          `/auth/access-tokens/${accessToken.id}`,
          undefined,
          cookie
        );
        return awaitedValue182701.status;
      })(),
      404
    );
    assert.equal(
      await (async () => {
        const awaitedValue182899 = await call(
          "GET",
          "/auth/me",
          undefined,
          "",
          headers
        );
        return awaitedValue182899.status;
      })(),
      401
    );
    const audit = await (async () => {
      const awaitedValue183004 = await call("GET", "/settings/audit?limit=100");
      return awaitedValue183004.json();
    })();
    assert.ok(!JSON.stringify(audit).includes(token));
    assert.ok(
      audit.events.some(
        (event: { actorId: string; action: string }) =>
          event.actorId === member.id &&
          event.action === "auth.access_token.created"
      )
    );
  });

  test("personal tokens expire and cannot manage accounts or instance settings", async () => {
    const { db } = await import("../../src/infra/db/client");
    const { personalAccessTokens } = await import("../../src/infra/db/schema");
    const { eq } = await import("drizzle-orm");
    const projectId = await createProject("Browser-only management");
    const expiresAt = new Date(Date.now() + 60_000)
      .toISOString()
      .replace(/\.\d+Z$/u, "Z");
    assert.equal(
      await (async () => {
        const awaitedValue183815 = await call("POST", "/auth/access-tokens", {
          name: "Expired",
          expiresAt: "2000-01-01T00:00:00.000Z",
        });
        return awaitedValue183815.status;
      })(),
      400
    );
    const created = await call("POST", "/auth/access-tokens", {
      name: "Short-lived admin CLI",
      expiresAt,
    });
    assert.equal(created.status, 201);
    const { token, accessToken } = await created.json();
    assert.equal(accessToken.expiresAt, new Date(expiresAt).toISOString());
    const headers = { authorization: `Bearer ${token}` };
    assert.equal(
      await (async () => {
        const awaitedValue184369 = await call(
          "GET",
          "/projects",
          undefined,
          "",
          headers
        );
        return awaitedValue184369.status;
      })(),
      200
    );
    const routes: [string, string, unknown?][] = [
      ["GET", "/settings/members"],
      ["GET", "/settings/sso"],
      ["DELETE", "/settings/invitations/00000000-0000-4000-8000-000000000000"],
      [
        "POST",
        "/settings/invitations",
        { email: "refused@example.com", role: "viewer" },
      ],
      ["GET", "/runners"],
      ["POST", "/runners", { name: "Refused" }],
      ["DELETE", "/runners/00000000-0000-4000-8000-000000000000"],
      ["GET", `/projects/${projectId}/ci`],
      ["POST", `/projects/${projectId}/ci/token`],
      ["DELETE", `/projects/${projectId}/ci/token`],
      ["POST", "/auth/logout"],
      ["POST", "/auth/oidc/start", { link: true }],
    ];
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const [method, url, body] of routes) {
      const response = await call(method, url, body, "", headers);
      assert.equal(
        response.status,
        403,
        `${method} ${url}: ${await response.text()}`
      );
    }
    /* oxlint-enable no-await-in-loop */
    await db
      .update(personalAccessTokens)
      .set({ expiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(personalAccessTokens.id, accessToken.id));
    assert.equal(
      await (async () => {
        const awaitedValue185583 = await call(
          "GET",
          "/auth/me",
          undefined,
          "",
          headers
        );
        return awaitedValue185583.status;
      })(),
      401
    );
    assert.equal(
      await (async () => {
        const awaitedValue185688 = await call(
          "DELETE",
          `/auth/access-tokens/${accessToken.id}`
        );
        return awaitedValue185688.status;
      })(),
      200
    );
  });

  test("token issuance rechecks a session revoked after request authentication", async (t) => {
    const { accountsRepository, withAccountsLock } =
      await import("../../src/infra/repositories/accounts");
    const { tokenHash } = await import("../../src/core/accounts/tokens");
    const member = await accountsRepository.createSsoUser(
      "revocation-race@example.com",
      "Revocation race",
      "editor",
      "https://revocation.example.com",
      "editor"
    );
    const token = crypto.randomBytes(32).toString("hex");
    await accountsRepository.createSession(
      tokenHash(token),
      member.id,
      new Date(Date.now() + 60_000).toISOString()
    );
    const original = accountsRepository.session.bind(accountsRepository);
    let checked = false;
    t.mock.method(accountsRepository, "session", async (hash: string) => {
      const result = await original(hash);
      if (hash === tokenHash(token) && !checked) {
        checked = true;
        await withAccountsLock(() =>
          accountsRepository.revokeUserSessions(member.id)
        );
      }
      return result;
    });
    try {
      assert.equal(
        await (async () => {
          const awaitedValue186941 = await call(
            "POST",
            "/auth/access-tokens",
            { name: "Revoked session" },
            `specbook_session=${token}`
          );
          return awaitedValue186941.status;
        })(),
        401
      );
      assert.deepEqual(await accountsRepository.accessTokens(member.id), []);
    } finally {
      t.mock.restoreAll();
    }
  });

  test("only browser administrators can configure runner and tunnel destinations", async () => {
    const { accountsRepository } =
      await import("../../src/infra/repositories/accounts");
    const { tokenHash } = await import("../../src/core/accounts/tokens");
    const member = await accountsRepository.createSsoUser(
      "destination-editor@example.com",
      "Destination editor",
      "editor",
      "https://destinations.example.com",
      "editor"
    );
    const session = crypto.randomBytes(32).toString("hex");
    await accountsRepository.createSession(
      tokenHash(session),
      member.id,
      new Date(Date.now() + 60_000).toISOString()
    );
    const cookie = `specbook_session=${session}`;
    const projectId = await createProject("Protected runner destinations");
    const { environments } = await (async () => {
      const awaitedValue188125 = await call(
        "GET",
        `/projects/${projectId}/environments`
      );
      return awaitedValue188125.json();
    })();
    const environment = environments.find(
      (entry: { name: string }) => entry.name === "Production"
    );
    const url = `/projects/${projectId}/environments/${environment.id}`;
    const input = {
      name: "Production",
      baseUrl: "https://app.example.com",
      allowedOrigins: [],
      credentialOverrides: {},
      executor: "server",
      runnerGroup: null,
    };
    assert.equal(
      await (async () => {
        const awaitedValue188610 = await call("PUT", url, input, cookie);
        return awaitedValue188610.status;
      })(),
      200
    );
    const privateInput = { ...input, executor: "runner", runnerGroup: "lab" };
    assert.equal(
      await (async () => {
        const awaitedValue188760 = await call("PUT", url, privateInput, cookie);
        return awaitedValue188760.status;
      })(),
      403
    );
    assert.equal(
      await (async () => {
        const awaitedValue188845 = await call(
          "POST",
          `/projects/${projectId}/environments`,
          { ...privateInput, name: "Private" },
          cookie
        );
        return awaitedValue188845.status;
      })(),
      403
    );
    assert.equal(
      await (async () => {
        const awaitedValue189059 = await call("PUT", url, privateInput);
        return awaitedValue189059.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedValue189129 = await call("PUT", url, privateInput, cookie);
        return awaitedValue189129.status;
      })(),
      200
    );
    /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
    for (const change of [
      { baseUrl: "https://other.example.com" },
      { allowedOrigins: ["https://other.example.com"] },
      { runnerGroup: "other" },
      { executor: "server", runnerGroup: null },
      { executor: "tunnel" },
    ]) {
      assert.equal(
        await (async () => {
          const awaitedValue189470 = await call(
            "PUT",
            url,
            { ...privateInput, ...change },
            cookie
          );
          return awaitedValue189470.status;
        })(),
        403
      );
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(
      await (async () => {
        const awaitedValue189594 = await call(
          "PATCH",
          `/projects/${projectId}`,
          { baseUrl: "https://other.example.com" },
          cookie
        );
        return awaitedValue189594.status;
      })(),
      403
    );
    const { token, accessToken } = await (async () => {
      const awaitedValue189824 = await call("POST", "/auth/access-tokens", {
        name: "Admin destination test",
      });
      return awaitedValue189824.json();
    })();
    const headers = { authorization: `Bearer ${token}` };
    assert.equal(
      await (async () => {
        const awaitedValue190021 = await call(
          "PUT",
          url,
          { ...privateInput, baseUrl: "https://other.example.com" },
          "",
          headers
        );
        return awaitedValue190021.status;
      })(),
      403
    );
    assert.equal(
      await (async () => {
        const awaitedValue190243 = await call(
          "PATCH",
          `/projects/${projectId}`,
          { baseUrl: "https://other.example.com" },
          "",
          headers
        );
        return awaitedValue190243.status;
      })(),
      403
    );
    assert.equal(
      await (async () => {
        const awaitedValue190471 = await call("PUT", url, {
          ...privateInput,
          executor: "tunnel",
        });
        return awaitedValue190471.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedValue190586 = await call(
          "PUT",
          url,
          {
            ...privateInput,
            executor: "tunnel",
            baseUrl: "https://other.example.com",
          },
          cookie
        );
        return awaitedValue190586.status;
      })(),
      403
    );
    assert.equal(
      await (async () => {
        const awaitedValue190860 = await call(
          "PATCH",
          `/projects/${projectId}`,
          {
            baseUrl: "https://other.example.com",
          }
        );
        return awaitedValue190860.status;
      })(),
      200
    );
    assert.equal(
      await (async () => {
        const awaitedValue191034 = await call(
          "DELETE",
          `/auth/access-tokens/${accessToken.id}`
        );
        return awaitedValue191034.status;
      })(),
      200
    );
  });

  test("publish maps validation failures and hides unexpected internal errors", async () => {
    const { serializeSpecYaml } = await import("@specbook/runtime/yaml");
    const projectId = await createProject("Safe publish failures");
    const input = {
      path: "specs/store/open-application",
      baseRevision: null,
      files: {
        "spec.yml": serializeSpecYaml({
          title: "Open application",
          description: "",
          humanSpec: HUMAN_SPEC,
        }),
        "spec.ts": VALID_SPEC,
      },
      feature: {
        path: "specs/store",
        source: "title: Store\ndescription: Browsing\n",
      },
    };
    const url = `/projects/${projectId}/specs/publish`;
    const invalid = await call("POST", url, {
      specs: [
        {
          ...input,
          files: {
            ...input.files,
            "spec.ts": "import forbidden from 'node:fs';",
          },
        },
      ],
    });
    assert.equal(invalid.status, 400, await invalid.clone().text());
    const original = specsRepository.listSpecs;
    specsRepository.listSpecs = () => {
      try {
        throw new Error("private filesystem marker");
      } catch (error) {
        return Promise.reject(error);
      }
    };
    try {
      const response = await call("POST", url, { specs: [input] });
      assert.equal(response.status, 500, await response.clone().text());
      const body = await response.json();
      assert.ok(body.errorId);
      assert.doesNotMatch(JSON.stringify(body), /private filesystem marker/u);
    } finally {
      specsRepository.listSpecs = original;
    }
  });

  test("last usable administrator is protected and session revocation closes active streams and tokens", async () => {
    const { accountsRepository } =
      await import("../../src/infra/repositories/accounts");
    const { watchSession } = await import("../../src/core/accounts/sessions");
    await accountsRepository.createSsoUser(
      "unlinked-admin@example.com",
      "No active SSO",
      "admin",
      "https://inactive.example",
      "subject"
    );
    assert.equal(
      await (async () => {
        const awaitedValue193164 = await call(
          "PATCH",
          `/settings/members/${admin.id}`,
          { role: "viewer" }
        );
        return awaitedValue193164.status;
      })(),
      409
    );
    assert.equal(
      await (async () => {
        const awaitedValue193297 = await call(
          "PATCH",
          `/settings/members/${admin.id}`,
          { disabled: true }
        );
        return awaitedValue193297.status;
      })(),
      409
    );
    const signedIn = await call(
      "POST",
      "/auth/login",
      { email: admin.email, password },
      ""
    );
    assert.equal(signedIn.status, 200);
    const cookie = cookieOf(signedIn);
    const { token } = await (async () => {
      const awaitedValue193637 = await call(
        "POST",
        "/auth/access-tokens",
        { name: "Logout revocation" },
        cookie
      );
      return awaitedValue193637.json();
    })();
    const projectId = await createProject("Authenticated stream");
    const { createChat } = await import("../../src/core/chat/session-store");
    const chat = await createChat(projectId);
    const stream = await call(
      "GET",
      `/chats/${chat.id}/events`,
      undefined,
      cookie
    );
    const reader = requireValue(stream.body).getReader();
    assert.match(
      new TextDecoder().decode(
        await (async () => {
          const awaitedValue194180 = await reader.read();
          return awaitedValue194180.value;
        })()
      ),
      /event: connected/u
    );
    let closed = false;
    const stop = await watchSession(new Headers({ cookie }), () => {
      closed = true;
    });
    try {
      assert.equal(closed, false);
      assert.equal(
        await (async () => {
          const awaitedValue194438 = await call(
            "POST",
            "/auth/logout",
            undefined,
            cookie
          );
          return awaitedValue194438.status;
        })(),
        200
      );
      assert.equal(closed, true);
      assert.equal(
        await (async () => {
          const awaitedValue194585 = await reader.read();
          return awaitedValue194585.done;
        })(),
        true,
        "logout closes the live SSE response"
      );
      assert.equal(
        await (async () => {
          const awaitedValue194710 = await call(
            "GET",
            "/auth/me",
            undefined,
            cookie
          );
          return awaitedValue194710.status;
        })(),
        401
      );
      assert.equal(
        await (async () => {
          const awaitedValue194818 = await call(
            "GET",
            "/auth/me",
            undefined,
            "",
            {
              authorization: `Bearer ${token}`,
            }
          );
          return awaitedValue194818.status;
        })(),
        401
      );
    } finally {
      stop();
      await reader.cancel();
    }
  });

  test("OIDC validates signatures, PKCE, nonce, browser binding and explicit account linking", async (t) => {
    const { accountsRepository } =
      await import("../../src/infra/repositories/accounts");
    const { verifiedEmail } = await import("../../src/core/accounts/oidc");
    const issuer = "https://identity.example.com";
    const config = {
      enabled: true,
      issuer,
      clientId: "specbook",
      clientSecret: "test-oidc-secret",
      defaultRole: "viewer",
      allowedEmailDomains: ["example.com"],
      passwordLoginEnabled: true,
    };
    const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongKeys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const jwt = (claims: object, invalid = false) => {
      const encoded = [
        JSON.stringify({ alg: "RS256", kid: "test-key" }),
        JSON.stringify(claims),
      ]
        .map((value) => Buffer.from(value).toString("base64url"))
        .join(".");
      return `${encoded}.${crypto.sign("RSA-SHA256", Buffer.from(encoded), invalid ? wrongKeys.privateKey : keys.privateKey).toString("base64url")}`;
    };
    let authorization: URL;
    let overrides: Record<string, unknown> = {};
    let invalidSignature = false;
    let exchanges = 0;
    const originalFetch = globalThis.fetch;
    t.mock.method(
      globalThis,
      "fetch",
      (input: string | URL | Request, options?: RequestInit) => {
        try {
          const url = new URL(
            input instanceof Request ? input.url : input.toString()
          );
          if (url.origin !== issuer) {
            return Promise.resolve(originalFetch(input, options));
          }
          if (url.pathname === "/.well-known/openid-configuration") {
            return Promise.resolve(
              Response.json({
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                jwks_uri: `${issuer}/jwks`,
                response_types_supported: ["code"],
                subject_types_supported: ["public"],
                id_token_signing_alg_values_supported: ["RS256"],
                code_challenge_methods_supported: ["S256"],
              })
            );
          }
          if (url.pathname === "/jwks") {
            return Promise.resolve(
              Response.json({
                keys: [
                  {
                    ...keys.publicKey.export({ format: "jwk" }),
                    alg: "RS256",
                    kid: "test-key",
                    use: "sig",
                  },
                ],
              })
            );
          }
          if (url.pathname === "/token") {
            exchanges += 1;
            const body = new URLSearchParams(options?.body?.toString());
            assert.equal(body.get("client_secret"), config.clientSecret);
            assert.equal(
              crypto
                .createHash("sha256")
                .update(requireValue(body.get("code_verifier")))
                .digest("base64url"),
              authorization.searchParams.get("code_challenge")
            );
            const now = Math.floor(Date.now() / 1000);
            return Promise.resolve(
              Response.json({
                token_type: "Bearer",
                access_token: "fake-access-token",
                expires_in: 300,
                id_token: jwt(
                  {
                    iss: issuer,
                    sub: "local-admin",
                    aud: "specbook",
                    iat: now,
                    exp: now + 300,
                    nonce: authorization.searchParams.get("nonce"),
                    email: admin.email,
                    email_verified: true,
                    ...overrides,
                  },
                  invalidSignature
                ),
              })
            );
          }
          throw new Error(`Unexpected identity request: ${url}`);
        } catch (error) {
          return Promise.reject(error);
        }
      }
    );
    const begin = async (link = false, cookie = adminCookie) => {
      const response = await call("POST", "/auth/oidc/start", { link }, cookie);
      assert.equal(response.status, 200, await response.clone().text());
      authorization = new URL(
        await (async () => {
          const awaitedValue198963 = await response.json();
          return awaitedValue198963.url;
        })()
      );
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256"
      );
      return {
        path: `/auth/oidc/callback?code=authorization-code&state=${authorization.searchParams.get("state")}`,
        cookie: [cookie, cookieOf(response, "specbook_oidc")]
          .filter(Boolean)
          .join("; "),
      };
    };
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper or mutable completion callback scoped to its fixture.
    const callback = (pending: { path: string; cookie: string }) =>
      call("GET", pending.path, undefined, pending.cookie);
    const failed = async (pending: { path: string; cookie: string }) => {
      // oxlint-disable-next-line node/callback-return, promise/prefer-await-to-callbacks -- The awaited Hono middleware or HTTP helper is not a Node error-first callback. This handler models the callback interface exercised by the test.
      const response = await callback(pending);
      assert.match(
        requireValue(response.headers.get("location")),
        /\/login\?error=sso_failed$/u
      );
      assert.equal(cookieOf(response), "");
    };
    assert.equal(
      await (async () => {
        const awaitedValue199783 = await call("PUT", "/settings/sso", config);
        return awaitedValue199783.status;
      })(),
      200
    );
    try {
      const { token: ssoToken, accessToken } = await (async () => {
        const awaitedValue199905 = await call("POST", "/auth/access-tokens", {
          name: "SSO requires a browser",
        });
        return awaitedValue199905.json();
      })();
      const linkedWithToken = await begin(true);
      const rejected = await call(
        "GET",
        linkedWithToken.path,
        undefined,
        linkedWithToken.cookie,
        { authorization: `Bearer ${ssoToken}` }
      );
      assert.match(
        requireValue(rejected.headers.get("location")),
        /\/login\?error=sso_failed$/u
      );
      assert.equal(
        exchanges,
        0,
        "personal tokens cannot complete account linking"
      );
      assert.equal(
        await (async () => {
          const awaitedValue200520 = await call(
            "DELETE",
            `/auth/access-tokens/${accessToken.id}`
          );
          return awaitedValue200520.status;
        })(),
        200
      );
      const bound = await begin();
      await failed({ ...bound, cookie: adminCookie });
      assert.equal(
        exchanges,
        0,
        "a different browser cannot exchange the code"
      );
      await failed(bound);
      assert.equal(
        await accountsRepository.identity(issuer, "local-admin"),
        null,
        "matching emails never link accounts automatically"
      );
      await failed(bound);
      assert.equal(exchanges, 1, "state is consumed once");
      overrides = { nonce: "wrong-nonce" };
      await failed(await begin(true));
      overrides = {};
      invalidSignature = true;
      await failed(await begin(true));
      invalidSignature = false;
      overrides = { email_verified: false };
      await failed(await begin(true));
      overrides = { email: "outside@other.example" };
      await failed(await begin(true));
      overrides = {};
      // oxlint-disable-next-line node/callback-return, promise/prefer-await-to-callbacks -- The awaited Hono middleware or HTTP helper is not a Node error-first callback. This handler models the callback interface exercised by the test.
      const linked = await callback(await begin(true));
      assert.equal(
        linked.headers.get("location"),
        "http://localhost:4000/settings"
      );
      adminCookie = cookieOf(linked);
      assert.ok(adminCookie);
      assert.equal(
        await (async () => {
          const awaitedValue201768 = await (async () => {
            const awaitedValue215899 = await call("GET", "/settings/sso");
            return awaitedValue215899.json();
          })();
          return awaitedValue201768.linked;
        })(),
        true
      );
      const hidden = await (async () => {
        const awaitedValue201877 = await call("GET", "/settings/sso");
        return awaitedValue201877.text();
      })();
      assert.doesNotMatch(hidden, /test-oidc-secret|verifiedUsers/u);
      const invitation = await (async () => {
        const awaitedValue202023 = await call("POST", "/settings/invitations", {
          email: "pending@example.com",
          role: "viewer",
        });
        return awaitedValue202023.json();
      })();
      const token = requireValue(
        new URLSearchParams(new URL(invitation.inviteUrl).hash.slice(1)).get(
          "token"
        )
      );
      const { clientSecret: _secret, ...unchanged } = config;
      assert.equal(
        await (async () => {
          const awaitedValue202378 = await call("PUT", "/settings/sso", {
            ...unchanged,
            passwordLoginEnabled: false,
          });
          return awaitedValue202378.status;
        })(),
        200
      );
      assert.equal(
        await (async () => {
          const awaitedValue202574 = await call(
            "POST",
            "/auth/login",
            { email: admin.email, password },
            ""
          );
          return awaitedValue202574.status;
        })(),
        403
      );
      assert.equal(
        await (async () => {
          const awaitedValue202785 = await call(
            "POST",
            "/auth/invitations/accept",
            { token, name: "Pending", password },
            ""
          );
          return awaitedValue202785.status;
        })(),
        403
      );
      assert.equal(
        await (async () => {
          const awaitedValue203013 = await call("PUT", "/settings/sso", {
            ...config,
            clientSecret: "changed",
            passwordLoginEnabled: false,
          });
          return awaitedValue203013.status;
        })(),
        409,
        "changed provider credentials need a new successful link before disabling local login"
      );
      overrides = {
        sub: "new-member",
        email: "sso-member@example.com",
        name: "New member",
      };
      // oxlint-disable-next-line node/callback-return, promise/prefer-await-to-callbacks -- The awaited Hono middleware or HTTP helper is not a Node error-first callback. This handler models the callback interface exercised by the test.
      const created = await callback(await begin(false, ""));
      assert.equal(created.headers.get("location"), "http://localhost:4000/");
      assert.equal(
        await (async () => {
          const awaitedValue203605 = await (async () => {
            const awaitedValue218331 = await call(
              "GET",
              "/auth/me",
              undefined,
              cookieOf(created)
            );
            return awaitedValue218331.json();
          })();
          return awaitedValue203605.user.role;
        })(),
        "viewer"
      );
      assert.equal(
        await (async () => {
          const awaitedValue203791 = await call(
            "PATCH",
            `/settings/members/${admin.id}`,
            {
              disabled: true,
            }
          );
          return awaitedValue203791.status;
        })(),
        409
      );
      const { db } = await import("../../src/infra/db/client");
      const { users } = await import("../../src/infra/db/schema");
      const { eq } = await import("drizzle-orm");
      const localHash = requireValue(
        await accountsRepository.getUser(admin.id)
      ).passwordHash;
      await db
        .update(users)
        .set({ passwordHash: null })
        .where(eq(users.id, admin.id));
      try {
        assert.equal(
          await (async () => {
            const awaitedValue204371 = await call("PUT", "/settings/sso", {
              ...config,
              clientId: "another-client",
              passwordLoginEnabled: true,
            });
            return awaitedValue204371.status;
          })(),
          409,
          "enabling passwords cannot protect a provider change when no administrator has a local password"
        );
      } finally {
        await db
          .update(users)
          .set({ passwordHash: localHash })
          .where(eq(users.id, admin.id));
      }
      assert.equal(
        verifiedEmail(
          "https://login.microsoftonline.com/12345678-1234-1234-1234-123456789abc/v2.0",
          { email: "verified@example.com", xms_edov: true }
        ),
        "verified@example.com"
      );
      assert.equal(
        verifiedEmail("https://login.microsoftonline.com/common/v2.0", {
          email: "verified@example.com",
          xms_edov: true,
        }),
        null
      );
      assert.equal(
        verifiedEmail(issuer, {
          email: "verified@example.com",
          xms_edov: true,
        }),
        null
      );
    } finally {
      const { clientSecret: _secret, ...unchanged } = config;
      assert.equal(
        await (async () => {
          const awaitedValue205549 = await call("PUT", "/settings/sso", {
            ...unchanged,
            enabled: false,
            passwordLoginEnabled: true,
          });
          return awaitedValue205549.status;
        })(),
        200
      );
    }
  });
});

describe("selected batch suggestions", () => {
  test(
    "unfinished selected Specs retry before asking a resumable question while a failed first run finishes generation",
    { timeout: 30_000 },
    async (t) => {
      const { jobsRepository } =
        await import("../../src/infra/repositories/jobs");
      const { stewardRepository } =
        await import("../../src/infra/repositories/steward");
      const { proposeSpecBatch, selectSpecBatch, presentSpecBatch } =
        await import("../../src/core/jobs/spec-batches");
      const { concludeJobTurn, stopJobWorker } =
        await import("../../src/core/jobs/worker");
      const { retryStalledJob, MAX_SAFETY_RETRIES } =
        await import("../../src/core/jobs/retry");
      const { createChat, openSession, flushSessionFile } =
        await import("../../src/core/chat/session-store");
      const read = jobsRepository.get.bind(jobsRepository);
      let targetId = "";
      t.mock.method(jobsRepository, "queued", async () => {
        const row = await read(targetId);
        return row?.status === "queued" ? [row] : [];
      });
      await stopJobWorker();
      /* oxlint-disable no-await-in-loop -- Run this stateful scenario in order; each step relies on the previous result. */
      for (const outcome of [
        "missing_spec",
        "missing_run",
        "failed",
      ] as const) {
        const projectId = await createProject(`Selected Spec ${outcome}`);
        await stewardRepository.update(projectId, { paused: true });
        const feature = await writer.createFeatureInRepo(
          projectId,
          null,
          "Authentication",
          ""
        );
        const chat = await createChat(projectId);
        const item = await proposeSpecBatch(projectId, chat.id, {
          candidates: [
            {
              title: "Sign-in form",
              goal: "Show the sign-in form.",
              feature: feature.title,
              featureId: feature.id,
              why: "Every user starts here.",
            },
          ],
        });
        const initial = await presentSpecBatch(item);
        const selected = await selectSpecBatch(item, [
          requireValue(initial.candidates[0]).id,
        ]);
        const candidate = requireValue(
          (
            selected.payload.specBatch as {
              candidates: { jobId: string; specId: string }[];
            }
          ).candidates[0]
        );
        targetId = candidate.jobId;
        const job = requireValue(await read(targetId));
        if (outcome !== "missing_spec") {
          const { spec } = await writer.createSpecInRepo({
            projectId,
            id: candidate.specId,
            featureId: feature.id,
            title: "Sign-in form",
            description: "",
            humanSpec: HUMAN_SPEC,
            testSource: VALID_SPEC,
          });
          if (outcome === "failed") {
            const run = await runsRepository.createRun({
              specId: spec.id,
              commitSha: await repoGit.getHeadSha(projectId),
              sourceHash: spec.sourceHash,
              automate: false,
            });
            await runsRepository.finishRun(
              run.id,
              "failed",
              10,
              "The expected sign-in form was not visible."
            );
          }
        }
        const session = requireValue(await openSession(job.chatId));
        session.appendCustomMessageEntry(
          "result",
          "The selected Spec is ready.",
          true
        );
        flushSessionFile(session);
        const executeAttempt = async () => {
          assert.ok(
            await jobsRepository.transition(job.id, "queued", "running")
          );
          await concludeJobTurn(requireValue(await read(job.id)), {
            status: "completed",
          } as Parameters<typeof concludeJobTurn>[1]);
        };
        try {
          await stewardRepository.update(projectId, { paused: false });
          await jobsRepository.transition(job.id, "paused", "queued");
          await executeAttempt();
          assert.equal(
            await (async () => {
              const awaitedValue209695 = await jobsRepository.inbox(projectId);
              return awaitedValue209695.some(
                (entry) => entry.jobId === job.id && entry.kind === "note"
              );
            })(),
            false
          );
          if (outcome === "failed") {
            while (
              (await (async () => {
                const awaitedResult233619 = await read(job.id);
                return awaitedResult233619?.status;
              })()) === "queued"
            ) {
              await executeAttempt();
            }
            assert.equal(
              await (async () => {
                const awaitedResult233741 = await read(job.id);
                return awaitedResult233741?.status;
              })(),
              "completed"
            );
            assert.equal(
              requireValue(
                await (async () => {
                  const awaitedValue210123 = await presentSpecBatch(
                    requireValue(await jobsRepository.item(item.id))
                  );
                  return awaitedValue210123.candidates[0];
                })()
              ).state,
              "failed"
            );
            assert.equal(
              await (async () => {
                const awaitedValue210304 =
                  await jobsRepository.inbox(projectId);
                return awaitedValue210304.filter(
                  (entry) => entry.jobId === job.id && entry.kind === "question"
                ).length;
              })(),
              0
            );
          } else {
            for (let attempt = 0; attempt < MAX_SAFETY_RETRIES; attempt += 1) {
              const stalled = requireValue(await read(job.id));
              assert.equal(stalled.status, "stalled");
              assert.ok(
                stalled.retryAt && Date.parse(stalled.retryAt) > Date.now()
              );
              assert.equal(
                requireValue(
                  await (async () => {
                    const awaitedValue210855 = await presentSpecBatch(
                      requireValue(await jobsRepository.item(item.id))
                    );
                    return awaitedValue210855.candidates[0];
                  })()
                ).state,
                "queued"
              );
              assert.equal(
                await (async () => {
                  const awaitedValue211046 =
                    await jobsRepository.inbox(projectId);
                  return awaitedValue211046.filter(
                    (entry) =>
                      entry.jobId === job.id && entry.kind === "question"
                  ).length;
                })(),
                0,
                "an unfinished model response must retry before asking the human"
              );
              await retryStalledJob(stalled);
              assert.equal(
                await (async () => {
                  const awaitedResult235878 = await read(job.id);
                  return awaitedResult235878?.status;
                })(),
                "stalled",
                "backoff is respected"
              );
              await jobsRepository.update(job.id, {
                retryAt: new Date(Date.now() - 1000).toISOString(),
              });
              await retryStalledJob(requireValue(await read(job.id)));
              assert.equal(
                await (async () => {
                  const awaitedResult236227 = await read(job.id);
                  return awaitedResult236227?.status;
                })(),
                "queued"
              );
              assert.equal(
                await (async () => {
                  const awaitedResult236295 = await read(job.id);
                  return awaitedResult236295?.safetyRetries;
                })(),
                attempt + 1
              );
              await executeAttempt();
            }
            const exhausted = requireValue(await read(job.id));
            assert.equal(exhausted.status, "stalled");
            assert.equal(exhausted.retryAt, null);
            await retryStalledJob(exhausted);
            const progress = await presentSpecBatch(
              requireValue(await jobsRepository.item(item.id))
            );
            const questions = await (async () => {
              const awaitedValue212273 = await jobsRepository.inbox(projectId);
              return awaitedValue212273.filter(
                (entry) => entry.jobId === job.id && entry.kind === "question"
              );
            })();
            assert.equal(
              await (async () => {
                const awaitedResult237063 = await read(job.id);
                return awaitedResult237063?.status;
              })(),
              "blocked"
            );
            assert.equal(
              requireValue(progress.candidates[0]).state,
              "needs_answer"
            );
            assert.equal(questions.length, 1);
            const question = requireValue(questions[0]);
            assert.match(question.title, /Sign-in form/u);
            assert.match(
              question.body,
              outcome === "missing_spec"
                ? /has not been saved/u
                : /first result is missing/u
            );
            assert.doesNotMatch(
              question.body,
              /missing access|credentials/iu,
              "a model ending early does not prove an access problem"
            );
            assert.equal(question.payload.sourceItemId, item.id);
            assert.ok(await jobsRepository.claimItem(question.id));
            await jobsRepository.answer(
              question,
              "Open the homepage and inspect the sign-in form."
            );
            assert.equal(
              await (async () => {
                const awaitedResult238088 = await read(job.id);
                return awaitedResult238088?.status;
              })(),
              "queued"
            );
            assert.match(
              requireValue(await read(job.id)).pendingMessage,
              /Open the homepage/u
            );
            assert.equal(
              await (async () => {
                const awaitedResult238308 = await jobsRepository.item(
                  question.id
                );
                return awaitedResult238308?.status;
              })(),
              "answered"
            );
          }
        } finally {
          await stopJobWorker();
        }
      }
      /* oxlint-enable no-await-in-loop */
    }
  );

  test("requires discovery confirmation, validates selection and resumes only selected checks after restart", async () => {
    const { chatsRepository } =
      await import("../../src/infra/repositories/chats");
    const { createChat, listChats } =
      await import("../../src/core/chat/session-store");
    const { projectContextsRepository } =
      await import("../../src/infra/repositories/project-contexts");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const {
      proposeSpecBatch,
      selectSpecBatch,
      presentSpecBatch,
      recoverSpecBatches,
    } = await import("../../src/core/jobs/spec-batches");
    const projectId = await createProject("Selected checks");
    await stewardRepository.update(projectId, { paused: true });
    const revision = await projectContextsRepository.createProjectContextDraft(
      projectId,
      {
        startUrl: "https://app.example.com",
        goal: "Find useful checks",
        safetyNotes: [],
      }
    );
    const { id: chatId } = await createChat(
      projectId,
      { contextRevisionId: revision.id },
      "Project discovery"
    );
    assert.deepEqual(
      await (async () => {
        const awaitedValue215076 = await listChats(projectId);
        return awaitedValue215076.map((chat) => chat.id);
      })(),
      [chatId]
    );
    const input = {
      candidates: [
        {
          title: "Sign-in form",
          goal: "Show the username and password fields.",
          feature: "Authentication",
          why: "Users need an entry point.",
        },
        {
          title: "Catalog",
          goal: "Display the product catalog.",
          feature: "Catalog",
          why: "Users need to find a product.",
        },
      ],
    };
    const item = await proposeSpecBatch(projectId, chatId, input, {
      contextRevisionId: revision.id,
    });
    assert.deepEqual(
      await (async () => {
        const awaitedValue215718 = await listChats(projectId);
        return awaitedValue215718.map((chat) => chat.id);
      })(),
      [chatId],
      "a discovery conversation stays visible while its internal review stays hidden"
    );
    assert.equal(
      await (async () => {
        const awaitedValue215904 = await proposeSpecBatch(
          projectId,
          chatId,
          input,
          {
            contextRevisionId: revision.id,
          }
        );
        return awaitedValue215904.id;
      })(),
      item.id
    );
    const view = await presentSpecBatch(item);
    assert.equal(view.contextReviewRequired, true);
    await assert.rejects(
      () => selectSpecBatch(item, [requireValue(view.candidates[0]).id]),
      /confirm the discovery context/u
    );
    await projectContextsRepository.confirmProjectContextRevision(revision.id);
    await assert.rejects(
      () => selectSpecBatch(item, [crypto.randomUUID()]),
      /Choose at least one/u
    );
    await assert.rejects(
      () =>
        selectSpecBatch(item, [
          requireValue(view.candidates[0]).id,
          requireValue(view.candidates[0]).id,
        ]),
      /without duplicates/u
    );
    const selected = await selectSpecBatch(item, [
      requireValue(view.candidates[0]).id,
    ]);
    const progress = await presentSpecBatch(selected);
    assert.equal(progress.contextReviewRequired, false);
    assert.equal(requireValue(progress.candidates[0]).selected, true);
    assert.equal(requireValue(progress.candidates[0]).state, "queued");
    assert.equal(requireValue(progress.candidates[1]).selected, undefined);
    assert.equal(requireValue(progress.candidates[1]).jobId, undefined);
    const child = await jobsRepository.get(
      requireValue(requireValue(progress.candidates[0]).jobId)
    );
    assert.equal(child?.kind, "generate_spec");
    assert.equal(
      child?.sourceChatId,
      chatId,
      "selected Specs keep the originating human conversation"
    );
    assert.equal(child?.status, "paused");
    assert.equal(
      await (async () => {
        const awaitedValue217378 = await specsRepository.listSpecs(projectId);
        return awaitedValue217378.length;
      })(),
      0
    );
    const chatCount = await (async () => {
      const awaitedValue217457 = await chatsRepository.listChatRows(projectId);
      return awaitedValue217457.length;
    })();
    await selectSpecBatch(item, [requireValue(view.candidates[0]).id]);
    await recoverSpecBatches();
    assert.deepEqual(
      await (async () => {
        const awaitedValue217632 = await listChats(projectId);
        return awaitedValue217632.map((chat) => chat.id);
      })(),
      [chatId],
      "selected generation and restart recovery do not expose internal chats"
    );
    assert.equal(
      await (async () => {
        const awaitedValue217810 =
          await chatsRepository.listChatRows(projectId);
        return awaitedValue217810.length;
      })(),
      chatCount
    );
    assert.equal(
      await (async () => {
        const awaitedValue217913 = await jobsRepository.list(projectId);
        return awaitedValue217913.filter((job) => job.kind === "generate_spec")
          .length;
      })(),
      1
    );
    await assert.rejects(
      () => selectSpecBatch(item, [requireValue(view.candidates[1]).id]),
      /already been selected/u
    );
  });

  test("rejects cross-project suggestions and generation outside the selected title and feature", async () => {
    const { createChat, listChats } =
      await import("../../src/core/chat/session-store");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const {
      proposeSpecBatch,
      selectSpecBatch,
      presentSpecBatch,
      selectedSpecInstructions,
      createSelectedSpec,
      selectedSpecResult,
    } = await import("../../src/core/jobs/spec-batches");
    const projectId = await createProject("Generated Spec");
    const otherId = await createProject("Other suggestions");
    await stewardRepository.update(projectId, { paused: true });
    const feature = await writer.createFeatureInRepo(
      projectId,
      null,
      "Authentication",
      ""
    );
    const otherFeature = await writer.createFeatureInRepo(
      otherId,
      null,
      "Other",
      ""
    );
    const { id: chatId } = await createChat(projectId, {}, "Sign-in form");
    assert.deepEqual(
      await (async () => {
        const awaitedValue219315 = await listChats(projectId);
        return awaitedValue219315.map((chat) => chat.id);
      })(),
      [chatId]
    );
    const candidate = {
      title: "Sign-in form",
      goal: "Show the sign-in form.",
      feature: feature.title,
      featureId: feature.id,
      why: "Every user starts here.",
    };
    await assert.rejects(
      () => proposeSpecBatch(otherId, chatId, { candidates: [candidate] }),
      /conversation belongs/u
    );
    await assert.rejects(
      () =>
        proposeSpecBatch(projectId, chatId, {
          candidates: [{ ...candidate, featureId: otherFeature.id }],
        }),
      /another project/u
    );
    const item = await proposeSpecBatch(projectId, chatId, {
      candidates: [candidate],
    });
    assert.notEqual(
      requireValue(await jobsRepository.get(item.jobId)).chatId,
      chatId
    );
    assert.deepEqual(
      await (async () => {
        const awaitedValue220127 = await listChats(projectId);
        return awaitedValue220127.map((chat) => chat.id);
      })(),
      [chatId],
      "human conversations remain in chat history after proposing a batch"
    );
    const initial = await presentSpecBatch(item);
    const selected = await selectSpecBatch(item, [
      requireValue(initial.candidates[0]).id,
    ]);
    const choice = requireValue(
      await (async () => {
        const awaitedValue220426 = await presentSpecBatch(selected);
        return awaitedValue220426.candidates[0];
      })()
    );
    const { specId } = requireValue(
      (selected.payload.specBatch as { candidates: { specId: string }[] })
        .candidates[0]
    );
    const job = requireValue(
      await jobsRepository.get(requireValue(choice.jobId))
    );
    await selectedSpecInstructions(job);
    const input = {
      featureId: feature.id,
      title: candidate.title,
      description: candidate.goal,
      humanSpec: HUMAN_SPEC,
      testSource: VALID_SPEC,
    };
    await assert.rejects(
      () => createSelectedSpec(job, { ...input, title: "Unexpected check" }),
      /only the selected Spec/u
    );
    await assert.rejects(
      () => createSelectedSpec(job, { ...input, featureId: otherFeature.id }),
      /only the selected Spec/u
    );
    await assert.rejects(
      () =>
        createSelectedSpec(job, { ...input, testSource: "process.exit(0)" }),
      /Import|test|allowed|top-level/u
    );
    assert.equal(
      await (async () => {
        const awaitedValue221344 = await specsRepository.listSpecs(projectId);
        return awaitedValue221344.length;
      })(),
      0
    );
    const { spec } = await writer.createSpecInRepo({
      ...input,
      projectId,
      id: specId,
    });
    const run = await runsRepository.createRun({
      specId: spec.id,
      commitSha: await repoGit.getHeadSha(projectId),
      sourceHash: spec.sourceHash,
      baseUrl: "https://app.example.com",
      automate: false,
    });
    await runsRepository.finishRun(run.id, "passed", 12, null);
    const count = await commitCount(projectId);
    const result = await createSelectedSpec(job, input);
    assert.equal(result.specId, spec.id);
    assert.equal(result.runId, run.id);
    assert.equal(result.status, "passed");
    assert.equal(
      await (async () => {
        const awaitedValue222058 = await selectedSpecResult(job);
        return awaitedValue222058.runId;
      })(),
      run.id
    );
    await createSelectedSpec(job, input);
    assert.equal(await commitCount(projectId), count);
    assert.equal(
      await (async () => {
        const awaitedValue222220 = await runsRepository.listRuns(spec.id);
        return awaitedValue222220.length;
      })(),
      1
    );
    assert.equal(
      requireValue(
        await (async () => {
          const awaitedValue222297 = await presentSpecBatch(
            requireValue(await jobsRepository.item(item.id))
          );
          return awaitedValue222297.candidates[0];
        })()
      ).state,
      "passed"
    );
  });
});

describe("results requested in chat", () => {
  test("keeps selection, generated questions and background results in their originating conversation", async () => {
    const { createChat, openSession, flushSessionFile, branchSessionForTurn } =
      await import("../../src/core/chat/session-store");
    const { subscribeToChatUpdates } =
      await import("../../src/core/chat/chat-registry");
    const { chatResults } = await import("../../src/core/chat/results");
    const { createChatResultsTool } =
      await import("../../src/core/chat/context-tools");
    const { proposeMutation } = await import("../../src/core/jobs/proposals");
    const { createChatsRouter } =
      await import("../../src/infra/web/routes/chats");
    const { jobsRepository } =
      await import("../../src/infra/repositories/jobs");
    const { projectContextsRepository } =
      await import("../../src/infra/repositories/project-contexts");
    const { stewardRepository } =
      await import("../../src/infra/repositories/steward");
    const {
      proposeSpecBatch,
      selectSpecBatch,
      presentSpecBatch,
      recoverSpecBatches,
    } = await import("../../src/core/jobs/spec-batches");
    const { enqueueIntent } = await import("../../src/core/steward/engine");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const projectId = await createProject("Chat results");
    await stewardRepository.update(projectId, { paused: true });
    const revision = await projectContextsRepository.createProjectContextDraft(
      projectId,
      {
        startUrl: "https://app.example.com",
        goal: "Map sign-in",
        safetyNotes: [],
      }
    );
    await projectContextsRepository.replaceProjectContextDraft(revision.id, {
      ...revision.context,
      summary: "Shoppers sign in before using the catalog.",
      areas: [
        {
          name: "Authentication",
          routes: ["/login"],
          description: "Shopper sign-in",
        },
      ],
    });
    const chat = await createChat(projectId, {
      contextRevisionId: revision.id,
    });
    const other = await createChat(projectId);
    let manager = requireValue(await openSession(chat.id));
    const abandonedUser = manager.appendMessage({
      role: "user",
      content: "Suggest checkout Specs",
      timestamp: 100,
    });
    manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "old-suggestion",
          name: "propose_spec_batch",
          arguments: {},
        },
      ],
      timestamp: 200,
    } as never);
    const abandoned = await proposeSpecBatch(projectId, chat.id, {
      candidates: [
        {
          title: "Checkout",
          goal: "Show checkout",
          feature: "Checkout",
          why: "Orders need a checkout.",
        },
      ],
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "old-suggestion",
      toolName: "propose_spec_batch",
      content: [
        { type: "text", text: JSON.stringify({ inboxId: abandoned.id }) },
      ],
      isError: false,
      timestamp: 300,
    });
    flushSessionFile(manager);
    manager = await (async () => {
      const awaitedValue225619 = await branchSessionForTurn(
        chat.id,
        abandonedUser
      );
      return awaitedValue225619.sessionManager;
    })();
    const user = manager.appendMessage({
      role: "user",
      content: "Suggest sign-in Specs",
      timestamp: 1000,
    });
    const anchor = manager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Here are the suggested Specs." },
        {
          type: "toolCall",
          id: "suggest",
          name: "propose_spec_batch",
          arguments: {},
        },
      ],
      timestamp: 2000,
    } as never);
    const item = await proposeSpecBatch(
      projectId,
      chat.id,
      {
        candidates: [
          {
            title: "Sign-in form",
            goal: "Show the form",
            feature: "Authentication",
            why: "Users need to sign in.",
          },
        ],
      },
      { contextRevisionId: revision.id }
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "suggest",
      toolName: "propose_spec_batch",
      content: [{ type: "text", text: JSON.stringify({ inboxId: item.id }) }],
      isError: false,
      timestamp: 3000,
    });
    const task = await enqueueIntent(
      projectId,
      {
        kind: "explore",
        goal: "Inspect sign-in errors",
        reason: "Sign-in investigation requested",
      },
      `chat:${chat.id}:explore`,
      "user",
      { sourceChatId: chat.id }
    );
    manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "explore",
          name: "start_background_task",
          arguments: {},
        },
      ],
      timestamp: 4000,
    } as never);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "explore",
      toolName: "start_background_task",
      content: [{ type: "text", text: JSON.stringify(task) }],
      isError: false,
      timestamp: 5000,
    });
    flushSessionFile(manager);
    const unrelated = await jobsRepository.create({
      projectId,
      chatId: crypto.randomUUID(),
      sourceChatId: other.id,
      trigger: "chat",
      goal: "Other request",
      limits: jobLimitsSchema.parse({}),
      status: "blocked",
    });
    await jobsRepository.addItem({
      projectId,
      jobId: unrelated.id,
      kind: "question",
      title: "Unrelated question",
      body: "Not part of this conversation.",
    });
    let updates = 0;
    const unsubscribe = subscribeToChatUpdates(chat.id, () => {
      updates += 1;
    });
    try {
      const initial = requireValue(await chatResults(chat.id));
      assert.deepEqual(
        initial.items.map((result) => result.id),
        [item.id]
      );
      assert.equal(
        await (async () => {
          const awaitedResult255198 = await jobsRepository.item(abandoned.id);
          return awaitedResult255198?.status;
        })(),
        "pending",
        "an abandoned suggestion remains in project review history without duplicating the current chat selection"
      );
      assert.equal(requireValue(initial.items[0]).afterMessageId, anchor);
      assert.equal(initial.contextRevision?.id, revision.id);
      assert.equal(initial.tasks[0]?.id, task.id);
      assert.equal(initial.tasks[0]?.afterMessageId, anchor);
      assert.equal(initial.tasks[0]?.title, "Inspect sign-in errors");
      await projectContextsRepository.confirmProjectContextRevision(
        revision.id
      );
      const selected = await selectSpecBatch(item, [
        requireValue(
          await (async () => {
            const awaitedValue228986 = await presentSpecBatch(item);
            return awaitedValue228986.candidates[0];
          })()
        ).id,
      ]);
      const childId = requireValue(
        requireValue(
          await (async () => {
            const awaitedValue229068 = await presentSpecBatch(selected);
            return awaitedValue229068.candidates[0];
          })()
        ).jobId
      );
      assert.equal(
        await (async () => {
          const awaitedResult256352 = await jobsRepository.get(childId);
          return awaitedResult256352?.sourceChatId;
        })(),
        chat.id
      );
      await jobsRepository.transition(childId, "paused", "blocked");
      const question = await jobsRepository.addItem({
        projectId,
        jobId: childId,
        kind: "question",
        title: "Which sign-in role should this Spec use?",
        body: "Choose the role to test.",
      });
      await jobsRepository.addItem({
        projectId,
        jobId: childId,
        kind: "note",
        title: "Sign-in inspected",
        body: "The page contains username and password fields.",
      });
      await jobsRepository.recover();
      await recoverSpecBatches();
      const recovered = requireValue(await chatResults(chat.id));
      assert.equal(
        recovered.items.find((result) => result.id === question.id)
          ?.afterMessageId,
        anchor
      );
      assert.equal(recovered.notes[0]?.afterMessageId, anchor);
      assert.equal(recovered.notes.length, 1);
      assert.equal(
        recovered.tasks.find((taskInTest) => taskInTest.id === childId)?.title,
        "Create “Sign-in form”"
      );
      assert.ok(
        updates > 0,
        "background progress refreshes the source conversation"
      );
      assert.ok(!JSON.stringify(recovered).includes("Unrelated question"));
      const feature = await writer.createFeatureInRepo(
        projectId,
        null,
        "Authentication",
        "Shopper sign-in"
      );
      const { spec } = await createSpec(projectId, feature.id, "Sign-in page");
      const changedSource = VALID_SPEC.replace(
        'page.goto("/")',
        'page.goto("/login")'
      );
      const proposal = await proposeMutation(
        requireValue(await jobsRepository.get(item.jobId)),
        "update_spec",
        { specId: spec.id, testSource: changedSource }
      );
      const read = createChatResultsTool(projectId, chat.id);
      const readText = async (
        tool: ReturnType<typeof createChatResultsTool>,
        input: { itemId?: string }
      ) => {
        const result = await tool.execute(
          "read",
          input,
          undefined as never,
          undefined,
          {} as never
        );
        const content = requireValue(result.content[0]);
        assert.equal(content.type, "text");
        return content.text;
      };
      const headBeforeRead = await repoGit.getHeadSha(projectId);
      const full = JSON.parse(await readText(read, {})) as Awaited<
        ReturnType<typeof chatResults>
      >;
      assert.equal(
        full?.contextRevision?.context.summary,
        "Shoppers sign in before using the catalog."
      );
      assert.equal(full?.contextRevision?.status, "confirmed");
      const chosen = full?.items.find((result) => result.id === item.id);
      assert.equal(
        (
          requireValue(chosen).payload.specBatch as {
            candidates: { selected?: boolean }[];
          }
        ).candidates[0]?.selected,
        true
      );
      const detailed = JSON.parse(
        await readText(read, { itemId: proposal.id })
      ) as {
        id: string;
        payload: {
          files: { path: string; before: string | null; after: string }[];
        };
      };
      assert.equal(detailed.id, proposal.id);
      assert.equal(
        detailed.payload.files.find((file) => file.path === "spec.ts")?.before,
        VALID_SPEC
      );
      assert.equal(
        detailed.payload.files.find((file) => file.path === "spec.ts")?.after,
        changedSource
      );
      const contract = requireValue(
        detailed.payload.files.find((file) => file.path === "spec.yml")
      );
      assert.equal(contract.before, contract.after);
      assert.match(contract.after, /The page is shown/u);
      assert.equal(
        await repoGit.getHeadSha(projectId),
        headBeforeRead,
        "reading the complete proposal cannot apply its files"
      );
      assert.match(
        await readText(createChatResultsTool(projectId, other.id), {
          itemId: proposal.id,
        }),
        /not available in this conversation/u
      );
      const beforeInTest = updates;
      await jobsRepository.update(unrelated.id, {
        stopReason: "Still waiting",
      });
      assert.equal(
        updates,
        beforeInTest,
        "unrelated conversations do not receive task updates"
      );
      const router = new Hono();
      router.route("/", createChatsRouter());
      const view = (await (async () => {
        const awaitedValue233494 = await router.request(`/chats/${chat.id}`);
        return awaitedValue233494.json();
      })()) as { mode: string; contextRevision: { status: string } };
      assert.equal(
        view.mode,
        "standard",
        "confirmed discovery continues as the same ordinary chat"
      );
      assert.equal(view.contextRevision.status, "confirmed");
      assert.equal(
        await (async () => {
          const awaitedValue233844 = await router.request(
            `/chats/${crypto.randomUUID()}/results`
          );
          return awaitedValue233844.status;
        })(),
        404
      );
      const foreign = await createProject("Foreign chat source");
      await assert.rejects(
        () =>
          enqueueIntent(
            foreign,
            { kind: "explore", goal: "Explore", reason: "Requested" },
            "foreign",
            "user",
            { sourceChatId: chat.id }
          ),
        /source conversation must belong/u
      );
      assert.match(
        await readText(createChatResultsTool(foreign, chat.id), {
          itemId: proposal.id,
        }),
        /conversation no longer exists in this project/u
      );
      const discussed = await proposeSpecBatch(projectId, other.id, {
        candidates: [
          {
            title: "Catalog",
            goal: "Show products",
            feature: "Catalog",
            why: "Products need to be visible.",
          },
        ],
      });
      await jobsRepository.updateItem(discussed.id, {
        payload: { ...discussed.payload, discussionChatId: chat.id },
      });
      assert.ok(
        requireValue(await chatResults(chat.id)).items.some(
          (result) => result.id === discussed.id
        ),
        "a discussed batch without a direct tool artifact remains reviewable here"
      );
      const separateReview = await jobsRepository.create({
        projectId,
        chatId: crypto.randomUUID(),
        sourceChatId: other.id,
        trigger: "chat",
        goal: "Review the sign-in implementation",
        limits: jobLimitsSchema.parse({}),
        status: "blocked",
      });
      const discussedPatch = await proposeMutation(
        separateReview,
        "update_spec",
        { specId: spec.id, testSource: changedSource }
      );
      assert.match(
        await readText(read, { itemId: discussedPatch.id }),
        /not available in this conversation/u
      );
      await jobsRepository.updateItem(discussedPatch.id, {
        payload: { ...discussedPatch.payload, discussionChatId: chat.id },
      });
      const discussionDetails = JSON.parse(
        await readText(read, { itemId: discussedPatch.id })
      ) as typeof detailed;
      assert.equal(
        discussionDetails.payload.files.find((file) => file.path === "spec.ts")
          ?.after,
        changedSource,
        "discussion exposes the proposed implementation rather than only its title"
      );
      await branchSessionForTurn(chat.id, user);
      const retried = requireValue(await chatResults(chat.id));
      assert.ok(
        retried.items.some((result) => result.id === item.id),
        "selected Specs remain visible after their originating branch is abandoned"
      );
      assert.ok(
        retried.items.some((result) => result.id === question.id),
        "questions from selected historical generation remain answerable"
      );
      assert.ok(!retried.items.some((result) => result.id === abandoned.id));
    } finally {
      unsubscribe();
    }
  });

  test(
    "retains a failed chat run and returns only that run with its evidence and message anchor",
    { timeout: 60_000 },
    async () => {
      const { createServer } = await import("node:http");
      const { createDomainTools } = await import("../../src/core/chat/tools");
      const {
        createChat,
        openSession,
        flushSessionFile,
        branchSessionForTurn,
      } = await import("../../src/core/chat/session-store");
      const { chatResults } = await import("../../src/core/chat/results");
      const { runsDir } = await import("../../src/core/paths");
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>Sign in</h1>");
      });
      // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address() as { port: number };
        const projectId = await createProject("Failed chat run");
        await projectsRepository.updateProject(projectId, {
          baseUrl: `http://127.0.0.1:${address.port}`,
        });
        const feature = await writer.createFeatureInRepo(
          projectId,
          null,
          "Sign in",
          ""
        );
        const { spec } = await createSpec(
          projectId,
          feature.id,
          "Sign-in heading",
          VALID_SPEC.replace(
            "toBeVisible()",
            'toHaveText("Unexpected heading", { timeout: 1000 })'
          )
        );
        const chat = await createChat(projectId);
        const other = await createChat(projectId);
        const manager = requireValue(await openSession(chat.id));
        const anchor = manager.appendMessage({
          role: "user",
          content: "Run the sign-in Spec",
          timestamp: Date.now(),
        });
        manager.appendMessage({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "run",
              name: "run_spec",
              arguments: { specId: spec.id },
            },
          ],
          timestamp: Date.now(),
        } as never);
        const runTool = requireValue(
          createDomainTools(projectId).find((tool) => tool.name === "run_spec")
        );
        const output = await runTool.execute(
          "run",
          { specId: spec.id },
          undefined as never,
          undefined,
          {} as never
        );
        const content = requireValue(output.content[0]);
        assert.equal(content.type, "text");
        const result = JSON.parse(content.text) as {
          runId: string;
          status: string;
          persisted: boolean;
        };
        assert.equal(result.status, "failed");
        assert.equal(result.persisted, true);
        assert.equal(
          await (async () => {
            const awaitedResult267160 = await runsRepository.getRun(
              result.runId
            );
            return awaitedResult267160?.status;
          })(),
          "failed"
        );
        assert.ok(
          existsSync(path.join(runsDir, result.runId, "evidence.json")),
          "failed chat evidence remains available"
        );
        manager.appendMessage({
          role: "toolResult",
          toolCallId: "run",
          toolName: "run_spec",
          content: output.content as never,
          isError: false,
          timestamp: Date.now(),
        });
        flushSessionFile(manager);
        const results = requireValue(await chatResults(chat.id));
        assert.equal(results.runs.length, 1);
        assert.equal(requireValue(results.runs[0]).id, result.runId);
        assert.equal(requireValue(results.runs[0]).afterMessageId, anchor);
        assert.equal(
          requireValue(results.runs[0]).evidenceUrl,
          `/runs/${result.runId}/evidence`
        );
        assert.doesNotMatch(
          requireValue(results.runs[0]).failReason ?? "",
          /apps\/backend|node_modules|\n\s*at /u
        );
        assert.equal(requireValue(await chatResults(other.id)).runs.length, 0);
        const next = await runsRepository.createRun({
          specId: spec.id,
          commitSha: await repoGit.getHeadSha(projectId),
          sourceHash: spec.sourceHash,
        });
        await runsRepository.finishRun(next.id, "passed", 12, null);
        const secondAnchor = manager.appendMessage({
          role: "user",
          content: "Run it again",
          timestamp: Date.now(),
        });
        manager.appendMessage({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "run",
              name: "run_spec",
              arguments: { specId: spec.id },
            },
          ],
          timestamp: Date.now(),
        } as never);
        manager.appendMessage({
          role: "toolResult",
          toolCallId: "run",
          toolName: "run_spec",
          content: [
            {
              type: "text",
              text: JSON.stringify({ runId: next.id, specId: spec.id }),
            },
          ],
          isError: false,
          timestamp: Date.now(),
        });
        flushSessionFile(manager);
        const repeated = requireValue(await chatResults(chat.id));
        assert.equal(
          repeated.runs.find((run) => run.id === result.runId)?.afterMessageId,
          anchor
        );
        assert.equal(
          repeated.runs.find((run) => run.id === next.id)?.afterMessageId,
          secondAnchor,
          "a reused provider tool call id keeps its own message anchor"
        );
        await branchSessionForTurn(chat.id, secondAnchor);
        assert.deepEqual(
          requireValue(await chatResults(chat.id)).runs.map((run) => run.id),
          [result.runId],
          "abandoned tool results stay out of the active conversation"
        );
      } finally {
        // oxlint-disable-next-line promise/avoid-new -- Adapt the event-driven fixture API while keeping its cancellation and completion behavior.
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  );
});
