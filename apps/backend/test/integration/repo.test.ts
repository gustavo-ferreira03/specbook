import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { HUMAN_SPEC, tempDir, useTempStorage, VALID_SPEC } from "../helpers/storage";

useTempStorage();
const { runMigrations } = await import("../../src/infra/db/migrate");
const { createProjectsRouter } = await import("../../src/infra/web/routes/projects");
const { createFeaturesRouter } = await import("../../src/infra/web/routes/features");
const { createSpecsRouter } = await import("../../src/infra/web/routes/specs");
const { csrfGuard, REQUEST_HEADER } = await import("../../src/infra/web/security");
const writer = await import("../../src/core/repo/writer");
const { reindexProject } = await import("../../src/core/repo/indexer");
const { repoGit } = await import("../../src/core/repo/git");
const { repoBare } = await import("../../src/core/repo/bare");
const { projectsRepository } = await import("../../src/infra/repositories/projects");
const { specsRepository } = await import("../../src/infra/repositories/specs");
const { featuresRepository } = await import("../../src/infra/repositories/features");
const { runsRepository } = await import("../../src/infra/repositories/runs");

const app = new Hono();
app.use("*", csrfGuard());
app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});
app.route("/", createProjectsRouter());
app.route("/", createFeaturesRouter());
app.route("/", createSpecsRouter());

async function api(method: string, url: string, body?: unknown): Promise<Response> {
    return app.request(url, {
        method,
        headers: { [REQUEST_HEADER]: "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function createProject(name = "Loja"): Promise<string> {
    const response = await api("POST", "/projects", { name, baseUrl: "https://app.example.com" });
    assert.equal(response.status, 200);
    return ((await response.json()) as { project: { id: string } }).project.id;
}

async function createSpec(projectId: string, featureId: string, title: string, testSource = VALID_SPEC) {
    return writer.createSpecInRepo({
        projectId,
        featureId,
        title,
        description: "",
        humanSpec: HUMAN_SPEC,
        testSource,
    });
}

async function commitCount(projectId: string): Promise<number> {
    return Number((await repoGit.getProjectGit(projectId).raw(["rev-list", "--count", "HEAD"])).trim());
}

before(async () => {
    await runMigrations();
});

describe("project, feature and spec through the writer", () => {
    test("creating a project initialises the checkout and the canonical bare repository", async () => {
        const projectId = await createProject();
        assert.ok(existsSync(path.join(repoGit.getRepoDir(projectId), ".git")));
        assert.ok(await repoBare.bareExists(projectId));
        assert.equal(await repoBare.getBareHeadSha(projectId), await repoGit.getHeadSha(projectId));
        const symlinks = await repoGit.getProjectGit(projectId).raw(["config", "--get", "core.symlinks"]);
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
        const feature = await writer.createFeatureInRepo(projectId, null, "Autenticação", "Entrar e sair");
        assert.equal(feature.path, "specs/autenticacao");
        const { spec, commitSha } = await createSpec(projectId, feature.id, "Login válido");
        assert.equal(spec.path, "specs/autenticacao/login-valido");
        assert.equal(spec.status, "unverified");
        const root = repoGit.getRepoDir(projectId);
        assert.equal(await fs.readFile(path.join(root, spec.path, "spec.ts"), "utf8"), VALID_SPEC);
        assert.equal(commitSha, await repoGit.getHeadSha(projectId));
        assert.equal(await repoBare.getBareHeadSha(projectId), commitSha);
        assert.ok((await repoGit.getProjectGit(projectId).status()).isClean());
    });

    test("an invalid spec.ts is stored as an invalid Spec", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const evaluate = VALID_SPEC.replace('await page.goto("/");', 'await page.evaluate("1");');
        const { spec } = await createSpec(projectId, feature.id, "Avalia", evaluate);
        assert.equal(spec.status, "invalid");
        assert.match(spec.invalidReason ?? "", /page\.evaluate\(\) is not allowed/);
    });

    test("step() titles that differ from spec.yml make the Spec invalid", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const { spec } = await createSpec(projectId, feature.id, "Passos", VALID_SPEC.replace('step("Abrir a página"', 'step("Outro passo"'));
        assert.equal(spec.status, "invalid");
        assert.match(spec.invalidReason ?? "", /must match the steps in spec\.yml/);
    });

    test("a manual Spec starts from a valid template", async () => {
        const { createManualSpec } = await import("../../src/core/repo/manual");
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const spec = await createManualSpec(projectId, feature.id, 'Título com "aspas"');
        assert.equal(spec.status, "unverified");
        const source = await fs.readFile(path.join(repoGit.getRepoDir(projectId), spec.path, "spec.ts"), "utf8");
        assert.match(source, /^import \{ test, expect \} from "specbook";/);
    });

    test("a Spec without spec.ts is invalid and can be repaired", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "Checkout", "");
        const { spec } = await createSpec(projectId, feature.id, "Missing implementation");
        await fs.rm(path.join(repoGit.getRepoDir(projectId), spec.path, "spec.ts"));
        await repoGit.commitAll(projectId, "test: remove executable");
        await reindexProject(projectId);
        const invalid = await specsRepository.getSpec(spec.id);
        assert.equal(invalid?.invalidReason, "This check is incomplete: spec.ts is missing. Repair it in chat.");
        const { spec: repaired } = await writer.updateSpecInRepo(invalid!, { testSource: VALID_SPEC });
        assert.equal(repaired.status, "unverified");
    });

    test("renaming a feature moves its specs and keeps ids, runs and status", async () => {
        const projectId = await createProject();
        const parent = await writer.createFeatureInRepo(projectId, null, "Autenticação", "");
        const child = await writer.createFeatureInRepo(projectId, parent.id, "Senha", "");
        const { spec } = await createSpec(projectId, parent.id, "Login válido");
        const { spec: nested } = await createSpec(projectId, child.id, "Recuperar senha");
        const run = await runsRepository.createRun({ specId: spec.id, commitSha: await repoGit.getHeadSha(projectId), sourceHash: spec.sourceHash });
        await runsRepository.finishRun(run.id, "passed", 1000, null);
        await specsRepository.updateSpecStatus(spec.id, "passed");

        const response = await api("PATCH", `/features/${parent.id}`, { title: "Login e sessão" });
        assert.equal(response.status, 200);
        const { feature } = (await response.json()) as { feature: { path: string; title: string } };
        assert.equal(feature.path, "specs/login-e-sessao");

        const moved = await specsRepository.getSpec(spec.id);
        assert.equal(moved?.path, "specs/login-e-sessao/login-valido");
        assert.equal(moved?.status, "passed");
        assert.equal(moved?.featureId, parent.id);
        assert.deepEqual((await runsRepository.listRuns(spec.id)).map((item) => item.id), [run.id]);
        assert.equal((await specsRepository.getSpec(nested.id))?.path, "specs/login-e-sessao/senha/recuperar-senha");
        assert.equal((await featuresRepository.getFeature(child.id))?.path, "specs/login-e-sessao/senha");
        assert.equal((await specsRepository.listSpecs(projectId)).length, 2);

        const root = repoGit.getRepoDir(projectId);
        assert.ok(!existsSync(path.join(root, "specs", "autenticacao")));
        assert.ok(existsSync(path.join(root, "specs", "login-e-sessao", "login-valido", "spec.yml")));
        assert.ok((await repoGit.getProjectGit(projectId).status()).isClean());
    });

    test("a spec directory moved by an external commit keeps its id on reindex", async () => {
        const projectId = await createProject();
        const from = await writer.createFeatureInRepo(projectId, null, "Carrinho", "");
        const { spec } = await createSpec(projectId, from.id, "Adicionar item");
        await specsRepository.updateSpecStatus(spec.id, "failed");

        const git = repoGit.getProjectGit(projectId);
        const root = repoGit.getRepoDir(projectId);
        await fs.mkdir(path.join(root, "specs", "checkout"));
        await git.raw(["mv", "specs/carrinho/adicionar-item", "specs/checkout/adicionar-item"]);
        await git.commit("move spec outside Specbook");

        await reindexProject(projectId);
        const moved = await specsRepository.getSpec(spec.id);
        assert.equal(moved?.path, "specs/checkout/adicionar-item");
        assert.equal(moved?.status, "failed", "content did not change, so the status stays");
        const newFeature = await featuresRepository.getFeatureByPath(projectId, "specs/checkout");
        assert.equal(moved?.featureId, newFeature?.id);
        assert.equal(newFeature?.title, "Checkout");
        assert.equal((await specsRepository.listSpecs(projectId)).length, 1);
    });

    test("a spec.yml that is a symbolic link makes the spec invalid on reindex", async () => {
        const projectId = await createProject();
        const feature = await writer.createFeatureInRepo(projectId, null, "F", "");
        const { spec } = await createSpec(projectId, feature.id, "Spec");
        const outside = tempDir();
        await fs.writeFile(path.join(outside, "stolen.yml"), "title: segredo\n");
        const yamlPath = path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml");
        await fs.rm(yamlPath);
        await fs.symlink(path.join(outside, "stolen.yml"), yamlPath);

        const result = await reindexProject(projectId);
        assert.deepEqual(result.invalidSpecs, [spec.id]);
        const invalid = await specsRepository.getSpec(spec.id);
        assert.equal(invalid?.status, "invalid");
        assert.match(invalid?.invalidReason ?? "", /symbolic link/);
        assert.notEqual(invalid?.title, "segredo", "the link target is never read");
        const detail = await api("GET", `/specs/${spec.id}`);
        assert.ok(!(await detail.text()).includes("segredo"), "the API never serves the link target");
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
        repoGit.commitAll = async (...args) => {
            calls.push("commitAll");
            return originals.commitAll.apply(repoGit, args);
        };
        try {
            const response = await api("DELETE", `/projects/${projectId}`);
            assert.equal(response.status, 204);
            await new Promise((resolve) => setTimeout(resolve, 50));
        } finally {
            Object.assign(repoGit, { commitAll: originals.commitAll });
        }
        assert.deepEqual(calls, []);
        assert.equal(await projectsRepository.getProject(projectId), null);
        assert.deepEqual(await specsRepository.listSpecs(projectId), []);
        assert.deepEqual(await featuresRepository.listFeatures(projectId), []);
        assert.ok(!existsSync(checkoutDir));
        assert.ok(!existsSync(bareDir));
        assert.equal((await api("DELETE", `/projects/${projectId}`)).status, 404);
    });
});

describe("chat browser lifetime", { skip: process.env.SPECBOOK_TEST_VNC !== "1" }, () => {
    test("keeps the same live browser after tools finish and between chat turns", { timeout: 90_000 }, async () => {
        const { createChatsRouter } = await import("../../src/infra/web/routes/chats");
        const { createChat } = await import("../../src/core/chat/session-store");
        const { tryReserveChatTurn, releaseChatTurn } = await import("../../src/core/chat/chat-registry");
        const { getOrCreateChatBrowser, beginChatBrowserTool, endChatBrowserTool, closeChatBrowser } = await import("../../src/core/browser/sessions");
        const { readBrowserSnapshot } = await import("../../src/core/browser/mcp");
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
            assert.equal((await view()).vncSessionId, null);
            assert.equal(tryReserveChatTurn(chat.id), true);
            const browser = await getOrCreateChatBrowser(chat.id, ["https://app.example.com"]);
            await browser.mcp.ensureBrowser();
            beginChatBrowserTool(chat.id, "browser_snapshot");
            assert.equal((await view()).vncSessionId, browser.vnc.id);
            await readBrowserSnapshot(browser.mcp);
            endChatBrowserTool(chat.id, "browser_snapshot");
            assert.equal((await view()).vncSessionId, browser.vnc.id, "ending a tool does not remove the live browser");
            releaseChatTurn(chat.id);
            assert.equal((await view()).busy, false);
            assert.equal((await view()).vncSessionId, browser.vnc.id, "the browser remains visible after the reply");
            assert.equal(tryReserveChatTurn(chat.id), true);
            const nextBrowser = await getOrCreateChatBrowser(chat.id, ["https://app.example.com"]);
            assert.equal(nextBrowser.vnc.id, browser.vnc.id, "the next turn reuses the browser");
            await readBrowserSnapshot(nextBrowser.mcp);
            releaseChatTurn(chat.id);
            await closeChatBrowser(chat.id);
            assert.equal(getVncSession(browser.vnc.id), null);
            assert.equal((await view()).vncSessionId, null, "explicit cleanup releases the session");
        } finally {
            releaseChatTurn(chat.id);
            await closeChatBrowser(chat.id);
            await api("DELETE", `/projects/${projectId}`);
        }
    });
});

describe("first-run setup", () => {
    async function setupApp() {
        const { createSetupRouter } = await import("../../src/infra/web/routes/setup");
        const { createSettingsRouter } = await import("../../src/infra/web/routes/settings");
        const { createProjectContextsRouter } = await import("../../src/infra/web/routes/project-contexts");
        const { handleRequestError } = await import("../../src/infra/web/errors");
        const setup = new Hono();
        setup.use("*", async (c, next) => {
            c.set("user", { id: "setup-admin", email: "admin@example.com", name: "Admin", role: "admin", passwordHash: null, disabledAt: null, createdAt: "", updatedAt: "" });
            await next();
        });
        setup.onError(handleRequestError);
        setup.route("/", createSetupRouter());
        setup.route("/", createSettingsRouter());
        setup.route("/", createProjectContextsRouter());
        return setup;
    }

    test("demo creates an ordinary project with public credentials and discovery requires a connected model", async () => {
        const setup = await setupApp();
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        const { listSecretValues } = await import("../../src/core/credentials/profiles");
        const { projectContextsRepository } = await import("../../src/infra/repositories/project-contexts");
        const { chatsRepository } = await import("../../src/infra/repositories/chats");
        await settingsRepository.updateLlmSettings({ provider: "", model: "" });
        const status = await (await setup.request("/setup/status")).json();
        assert.equal(status.needsAdmin, true);
        assert.equal(status.modelReady, false);
        assert.equal(status.completed, false);
        const response = await setup.request("/setup/demo", { method: "POST" });
        assert.equal(response.status, 201);
        const { project } = await response.json();
        assert.equal(project.baseUrl, "https://www.saucedemo.com");
        assert.equal(await repoBare.bareExists(project.id), true);
        assert.deepEqual((await listSecretValues(project.id)).map(({ field, value }) => ({ field, value })), [
            { field: "username", value: "standard_user" }, { field: "password", value: "secret_sauce" },
        ]);
        assert.deepEqual(await chatsRepository.listChatRows(project.id), []);
        const discovery = await setup.request(`/projects/${project.id}/context-discoveries`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal(discovery.status, 409);
        assert.match((await discovery.json()).error, /Connect a model in global Settings/);
        assert.equal(await projectContextsRepository.getActiveProjectContextDraft(project.id), null);
    });

    test("the LLM installation ID is stable under concurrent creation and persists across processes", async () => {
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        const { db } = await import("../../src/infra/db/client");
        const { appSettings } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const { backendRoot } = await import("../../src/core/paths");
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        await db.update(appSettings).set({ llmDeviceId: null }).where(eq(appSettings.id, 1));
        const ids = await Promise.all(Array.from({ length: 8 }, () => settingsRepository.getLlmDeviceId()));
        assert.equal(new Set(ids).size, 1);
        assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        const [stored] = await db.select({ deviceId: appSettings.llmDeviceId }).from(appSettings).where(eq(appSettings.id, 1));
        assert.equal(stored.deviceId, ids[0]);
        const script = `
            const { settingsRepository } = await import('./src/infra/repositories/settings.ts');
            process.stdout.write(await settingsRepository.getLlmDeviceId());
        `;
        const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: backendRoot, env: process.env, timeout: 10_000 });
        assert.equal(stdout, ids[0]);
        assert.equal(await settingsRepository.getLlmDeviceId(), ids[0]);
    });

    test("LLM settings expose provider authentication methods and support OpenAI subscription login", async (t) => {
        const setup = await setupApp();
        const { modelRuntimePromise } = await import("../../src/core/llm/runtime");
        const runtime = await modelRuntimePromise;
        const response = await setup.request("/settings/llm");
        assert.equal(response.status, 200);
        const { providers } = await response.json() as { providers: { id: string; authMethods: string[] }[] };
        const openai = providers.find((provider) => provider.id === "openai");
        const codex = providers.find((provider) => provider.id === "openai-codex");
        assert.ok(openai);
        assert.ok(codex);
        assert.deepEqual(new Set(openai.authMethods), new Set(["oauth", "api_key"]));
        assert.deepEqual(codex.authMethods, ["oauth"]);

        const login = t.mock.method(runtime, "login", async (provider: string, type: string, interaction: Parameters<typeof runtime.login>[2], options: Parameters<typeof runtime.login>[3]) => {
            assert.equal(provider, "openai");
            assert.equal(type, "oauth");
            assert.ok(interaction.signal instanceof AbortSignal);
            assert.ok(options?.getDeviceId);
            const deviceId = options.getDeviceId();
            assert.match(deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
            assert.equal(options.getDeviceId(), deviceId);
            interaction.notify({ type: "auth_url", url: "https://auth.example.com/sign-in" });
        });
        const started = await setup.request("/settings/llm/providers/openai/oauth/start", { method: "POST" });
        assert.equal(started.status, 200);
        const { sessionId } = await started.json() as { sessionId: string };
        assert.match(sessionId, /^[0-9a-f-]{36}$/);
        let result: { status: string; url?: string } | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
            const polled = await setup.request(`/settings/llm/providers/openai/oauth/poll?sessionId=${sessionId}`);
            assert.equal(polled.status, 200);
            result = await polled.json() as { status: string; url?: string };
            if (result.status !== "pending") break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.deepEqual(result, { status: "done", url: "https://auth.example.com/sign-in" });
        assert.equal(login.mock.callCount(), 1);

        const apiOnly = providers.find((provider) => provider.authMethods.length === 1 && provider.authMethods[0] === "api_key");
        assert.ok(apiOnly);
        const unsupported = await setup.request(`/settings/llm/providers/${apiOnly.id}/oauth/start`, { method: "POST" });
        assert.equal(unsupported.status, 400);
        assert.match((await unsupported.json()).error, /OAuth is not supported/);
        assert.equal(login.mock.callCount(), 1);
    });

    test("OpenAI's real subscription SDK opens sign-in with a persistent installation ID without token requests", { timeout: 15_000 }, async (t) => {
        const setup = await setupApp();
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        const deviceId = await settingsRepository.getLlmDeviceId();
        const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("The sign-in startup test must not make token requests"); });
        type OAuthResult = { status: "pending" | "done" | "error"; url?: string; prompt?: { type: string; placeholder?: string }; error?: string };
        async function pollUntil(sessionId: string, ready: (result: OAuthResult) => boolean): Promise<OAuthResult> {
            const deadline = Date.now() + 3_000;
            while (Date.now() < deadline) {
                const response = await setup.request(`/settings/llm/providers/openai/oauth/poll?sessionId=${sessionId}`);
                assert.equal(response.status, 200);
                const result = await response.json() as OAuthResult;
                if (ready(result)) return result;
                assert.equal(result.status, "pending", result.error ?? "Sign-in ended before the expected event");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.fail("OpenAI sign-in did not produce the expected event in time");
        }
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                const started = await setup.request("/settings/llm/providers/openai/oauth/start", { method: "POST" });
                assert.equal(started.status, 200);
                const { sessionId } = await started.json() as { sessionId: string };
                const pending = await pollUntil(sessionId, (result) => Boolean(result.url && result.prompt));
                assert.equal(pending.status, "pending");
                assert.equal(pending.prompt?.type, "manual_code");
                assert.equal(pending.prompt?.placeholder, "http://127.0.0.1:1455/auth/callback");
                const url = new URL(pending.url!);
                assert.equal(url.origin, "https://auth.openai.com");
                assert.equal(url.searchParams.get("ext_agent_host_id"), `urn:uuid:${deviceId}`);
                assert.equal(url.searchParams.get("resource"), "https://api.openai.com/v1");
                assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
                const input = await setup.request("/settings/llm/providers/openai/oauth/input", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ sessionId, input: "not-a-callback" }),
                });
                assert.equal(input.status, 200);
                const failed = await pollUntil(sessionId, (result) => result.status === "error");
                assert.equal(failed.error, "Paste the complete address from the final sign-in page, then try again.");
                assert.equal(await settingsRepository.getLlmDeviceId(), deviceId);
            }
            assert.equal(fetch.mock.callCount(), 0);
        } finally {
            await setup.request("/settings/llm/providers/openai", { method: "DELETE" });
        }
    });

    test("test connection makes a bounded request and presents provider errors without raw secrets", async (t) => {
        const setup = await setupApp();
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        const { modelRegistryPromise, modelRuntimePromise } = await import("../../src/core/llm/runtime");
        const missing = await setup.request("/settings/llm/test", { method: "POST" });
        assert.equal(missing.status, 400);
        assert.equal((await missing.json()).code, "model_not_configured");
        const registry = await modelRegistryPromise;
        const runtime = await modelRuntimePromise;
        const model = registry.getAll()[0];
        assert.ok(model);
        await settingsRepository.updateLlmSettings({ provider: model.provider, model: model.id });
        t.mock.method(registry, "hasConfiguredAuth", () => true);
        let called = 0;
        t.mock.method(runtime, "completeSimple", async (_model: unknown, context: Parameters<typeof runtime.completeSimple>[1], options: Parameters<typeof runtime.completeSimple>[2]) => {
            called++;
            assert.equal(context.messages[0].content, "Reply with OK.");
            assert.equal(options?.maxTokens, 16);
            assert.ok(options?.signal instanceof AbortSignal);
            if (called === 1) throw new Error("401 invalid API key sk-never-expose");
            return { stopReason: "stop" };
        });
        try {
            const failed = await setup.request("/settings/llm/test", { method: "POST" });
            assert.equal(failed.status, 400);
            const body = await failed.json();
            assert.equal(body.code, "provider_auth");
            assert.match(body.nextStep, /reconnect/);
            assert.doesNotMatch(JSON.stringify(body), /sk-never-expose/);
            const passed = await setup.request("/settings/llm/test", { method: "POST" });
            assert.equal(passed.status, 200);
            assert.equal((await passed.json()).ok, true);
            assert.equal((await (await setup.request("/setup/status")).json()).modelReady, true);
        } finally { await settingsRepository.updateLlmSettings({ provider: "", model: "" }); }
    });

    test("readiness checks both Chromium builds and reports missing programs with installation instructions", async (t) => {
        const setup = await setupApp();
        const access = fs.access.bind(fs);
        t.mock.method(fs, "access", async (file: Parameters<typeof fs.access>[0], mode: Parameters<typeof fs.access>[1]) => {
            if (/chrome|chromium|Xvfb|x11vnc/.test(String(file))) throw new Error("ENOENT /home/server/private");
            return access(file, mode);
        });
        const response = await setup.request("/ready");
        assert.equal(response.status, 503);
        const status = await response.json();
        assert.equal(status.ok, false);
        assert.deepEqual(status.checks.map((check: { id: string }) => check.id), ["database", "storage", "chromium", "mcp_chromium", "xvfb", "x11vnc"]);
        assert.equal(status.checks[0].ok, true);
        assert.equal(status.checks[1].ok, true);
        assert.equal(status.checks[2].ok, false);
        assert.equal(status.checks[3].ok, false);
        assert.ok(status.checks[4].nextStep);
        assert.doesNotMatch(JSON.stringify(status), /private|ENOENT/);
        const { storageRoot } = await import("../../src/core/paths");
        assert.equal((await fs.readdir(storageRoot)).some((name) => name.startsWith(".ready-")), false);
    });
});

describe("autonomous job proposals", () => {
    test("Inbox file previews match the committed bytes for additions and behavior changes", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { proposeMutation, applyProposal } = await import("../../src/core/jobs/proposals");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const projectId = await createProject("Review diffs");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Propose coverage", limits: jobLimitsSchema.parse({}) });
        const router = createJobsRouter();
        const preview = async (id: string) => {
            const response = await router.request(`/projects/${projectId}/overview`);
            assert.equal(response.status, 200);
            const { items } = await response.json() as { items: { id: string; payload: { files: { path: string; before: string | null; after: string }[] } }[] };
            return items.find((item) => item.id === id)!.payload.files;
        };
        const featureProposal = await proposeMutation(job, "create_feature", { title: "Checkout", description: "Coupons: discounts\nPayment" });
        const featureFiles = await preview(featureProposal.id);
        assert.equal(featureFiles[0]?.before, null);
        await applyProposal(featureProposal);
        const feature = (await featuresRepository.listFeatures(projectId))[0]!;
        assert.equal(await fs.readFile(path.join(repoGit.getRepoDir(projectId), feature.path, "feature.yml"), "utf8"), featureFiles[0]?.after);
        const proposal = await proposeMutation(job, "create_spec", { featureId: feature.id, title: "Checkout", description: "", humanSpec: HUMAN_SPEC, testSource: VALID_SPEC });
        const added = await preview(proposal.id);
        assert.equal(added.length, 2);
        assert.ok(added.every((file) => file.before === null));
        await applyProposal(proposal);
        const spec = (await specsRepository.listSpecs(projectId))[0]!;
        for (const file of added) assert.equal(await fs.readFile(path.join(repoGit.getRepoDir(projectId), spec.path, file.path), "utf8"), file.after);
        const yamlFile = path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml");
        const original = `# Human contract\n${await fs.readFile(yamlFile, "utf8")}`;
        await fs.writeFile(yamlFile, original);
        await repoGit.commitAll(projectId, "test: annotate contract");
        await reindexProject(projectId);
        const sourceOnly = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: VALID_SPEC.replace('page.goto("/")', 'page.goto("/checkout")') });
        const sourceFiles = await preview(sourceOnly.id);
        assert.equal(sourceFiles[0]?.before, original);
        assert.equal(sourceFiles[0]?.after, original, "unchanged YAML retains comments and formatting");
        assert.notEqual(sourceFiles[1]?.before, sourceFiles[1]?.after);
        const behavior = await proposeMutation(job, "update_spec", { specId: spec.id, humanSpec: { ...HUMAN_SPEC, expectedResult: "Discount: applied\nTotal updated" } });
        const changed = await preview(behavior.id);
        assert.equal(changed[0]?.before, original);
        assert.notEqual(changed[0]?.before, changed[0]?.after);
        const approved = await router.request(`/projects/${projectId}/inbox/${behavior.id}/review`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
        });
        assert.equal(approved.status, 200);
        assert.equal(await fs.readFile(yamlFile, "utf8"), changed[0]?.after);
        assert.deepEqual(await preview(behavior.id), changed, "review history retains the proposal snapshot");
    });

    test("proposals preserve the contract, reject stale edits, and replay approval once", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { proposeMutation, applyProposal } = await import("../../src/core/jobs/proposals");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Job proposals");
        const feature = await writer.createFeatureInRepo(projectId, null, "Login", "");
        const { spec } = await createSpec(projectId, feature.id, "Login");
        const yamlFile = path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml");
        const original = `# Contract owned by the human\n${await fs.readFile(yamlFile, "utf8")}`;
        await fs.writeFile(yamlFile, original);
        await repoGit.commitAll(projectId, "test: add comment");
        await reindexProject(projectId);
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Fix implementation", limits: jobLimitsSchema.parse({}) });
        const head = await repoGit.getHeadSha(projectId);
        const source = VALID_SPEC.replace('page.goto("/")', 'page.goto("/login")');
        const proposal = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: source });
        assert.equal(await repoGit.getHeadSha(projectId), head);
        assert.equal(await fs.readFile(yamlFile, "utf8"), original);
        assert.equal((await proposeMutation(job, "update_spec", { specId: spec.id, testSource: source })).id, proposal.id);
        const commit = await applyProposal(proposal);
        assert.notEqual(commit, head);
        assert.equal(await fs.readFile(yamlFile, "utf8"), original);
        assert.equal(await applyProposal(proposal), commit);
        assert.equal(await repoGit.getHeadSha(projectId), commit);
        const stale = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: VALID_SPEC });
        await writer.updateSpecWithLock(spec.id, { testSource: source.replace("/login", "/other") });
        await assert.rejects(() => applyProposal(stale), /Spec changed/);
        const other = await createProject("Other project");
        const otherFeature = await writer.createFeatureInRepo(other, null, "Other", "");
        const { spec: otherSpec } = await createSpec(other, otherFeature.id, "Other");
        await assert.rejects(() => proposeMutation(job, "update_spec", { specId: otherSpec.id, testSource: source }), /not found/);
    });

    test("job policy accounts before tool execution and pauses for credentials", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { createJobPolicy } = await import("../../src/core/jobs/policy");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Policy");
        const row = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Inspect", limits: jobLimitsSchema.parse({ maxActions: 1 }) });
        const job = (await jobsRepository.claim(row.id))!;
        let executed = 0;
        let aborted = false;
        const { Type } = await import("@earendil-works/pi-ai");
        const tools = createJobPolicy(job, () => { aborted = true; }).tools([{ name: "test_tool", label: "test_tool", description: "test", parameters: Type.Object({}), async execute() { executed++; return { content: [], details: undefined }; } }]);
        const tool = tools[0]!;
        await tool.execute("1", {}, undefined, undefined, {} as never);
        assert.equal(executed, 1);
        await assert.rejects(() => tool.execute("2", {}, undefined, undefined, {} as never), /did not reach a confirmed result/i);
        assert.equal(executed, 1);
        assert.ok(aborted);
        assert.equal((await jobsRepository.get(job.id))?.status, "stalled");
        const row2 = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Credentials", limits: jobLimitsSchema.parse({}) });
        const job2 = (await jobsRepository.claim(row2.id))!;
        let paused = false;
        const credential = createJobPolicy(job2, () => { paused = true; }).tools([{ name: "request_credential", label: "request", description: "test", parameters: Type.Object({}), async execute() { throw new Error("must be intercepted"); } }])[0]!;
        await credential.execute("1", {}, undefined, undefined, {} as never);
        assert.ok(paused, "a question aborts the turn even when other tool calls were batched");
        assert.equal((await jobsRepository.get(job2.id))?.status, "blocked");
        assert.equal((await jobsRepository.inbox(projectId))[0]?.kind, "question");
        await assert.rejects(() => credential.execute("2", {}, undefined, undefined, {} as never), /paused/);
        await jobsRepository.update(job2.id, { status: "running", startedAt: new Date().toISOString() });
        await jobsRepository.recover();
        assert.equal((await jobsRepository.get(job2.id))?.status, "queued");
    });

    test("concurrent approvals and recovery of a committed proposal produce one commit", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const projectId = await createProject("Approval recovery");
        const feature = await writer.createFeatureInRepo(projectId, null, "Login", "");
        const { spec } = await createSpec(projectId, feature.id, "Login");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Fix implementation", limits: jobLimitsSchema.parse({}) });
        const proposal = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: VALID_SPEC.replace('page.goto("/")', 'page.goto("/login")') });
        const router = createJobsRouter();
        const approve = () => router.request(`/projects/${projectId}/inbox/${proposal.id}/review`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
        });
        const before = await commitCount(projectId);
        const responses = await Promise.all([approve(), approve()]);
        assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
        const approved = await jobsRepository.item(proposal.id);
        assert.equal(approved?.status, "approved");
        assert.ok(approved?.commitSha);
        assert.equal(await commitCount(projectId), before + 1);
        await jobsRepository.updateItem(proposal.id, { status: "applying", commitSha: null });
        await jobsRepository.recover();
        assert.equal((await approve()).status, 200);
        assert.equal((await jobsRepository.item(proposal.id))?.commitSha, approved.commitSha);
        assert.equal(await commitCount(projectId), before + 1);
    });

    test("answering a question resumes a paused job without reviving a cancelled job", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Answer race");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Review", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(job.id, { status: "blocked" });
        const question = await jobsRepository.addItem({ jobId: job.id, projectId, kind: "question", title: "Access", body: "Configure access" });
        assert.ok(await jobsRepository.claimItem(question.id));
        await jobsRepository.answer(question, "Configured");
        assert.equal((await jobsRepository.get(job.id))?.status, "queued");
        assert.equal((await jobsRepository.item(question.id))?.status, "answered");
        assert.equal((await jobsRepository.item(question.id))?.answer, "Configured");

        await jobsRepository.update(job.id, { status: "blocked" });
        const next = await jobsRepository.addItem({ jobId: job.id, projectId, kind: "question", title: "Session", body: "Restore session" });
        assert.ok(await jobsRepository.claimItem(next.id));
        await jobsRepository.update(job.id, { status: "cancelled" });
        await assert.rejects(() => jobsRepository.answer(next, "Restored"), /no longer paused/);
        assert.equal((await jobsRepository.get(job.id))?.status, "cancelled");
        assert.equal((await jobsRepository.item(next.id))?.status, "applying");
        assert.equal((await jobsRepository.item(next.id))?.answer, null);
    });
});

describe("project steward", () => {
    test("stays idle without events and only runs requested work in observation mode", async (t) => {
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        const { enqueueIntent, processProjectSteward } = await import("../../src/core/steward/engine");
        const { canRunAgentJob } = await import("../../src/core/jobs/pause");
        const { createJobPolicy } = await import("../../src/core/jobs/policy");
        const { createBackgroundTaskTool } = await import("../../src/core/steward/tools");
        const { createJobSchema, jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        await stopJobWorker();
        t.mock.method(globalThis, "fetch", async () => new Response('<script src="/unchanged.js"></script>'));
        const projectId = await createProject("Event decisions");
        for (let i = 0; i < 3; i++) await processProjectSteward(projectId);
        assert.equal((await stewardRepository.intents(projectId)).length, 0, "an empty project does not schedule exploration or planning");
        assert.equal((await jobsRepository.list(projectId)).length, 0);
        assert.equal((await stewardRepository.signals(projectId)).length, 0);
        for (const kind of ["empty_project", "context_changed", "stale_spec", "app_unavailable"]) {
            await stewardRepository.signal({ projectId, key: kind, kind, title: "Changed", body: "Inspect this change" });
        }
        await processProjectSteward(projectId, false);
        assert.equal((await stewardRepository.intents(projectId)).length, 0, "these observations are not automatic work triggers");
        await assert.rejects(() => enqueueIntent(projectId, { kind: "coverage", goal: "Find gaps", reason: "No checks" }, "automatic:gaps"), /explicit human request/);
        await assert.rejects(() => enqueueIntent(projectId, { kind: "explore", goal: "Explore", reason: "No checks" }, "automatic:explore"), /explicit human request/);
        assert.equal(createJobSchema.safeParse({ kind: "planner" }).success, false);
        await stewardRepository.update(projectId, { autonomy: "observe" });
        const feature = await writer.createFeatureInRepo(projectId, null, "Access", "");
        const { spec } = await createSpec(projectId, feature.id, "Sign in");
        const event = await enqueueIntent(projectId, { kind: "regenerate", goal: "Repair sign in", reason: "Invalid check", specIds: [spec.id] }, "event:repair");
        const requested = { kind: "coverage", goal: "Explore sign in", reason: "The human requested missing coverage", priority: 90 };
        const one = await enqueueIntent(projectId, requested, "chat:one", "user");
        const duplicate = await enqueueIntent(projectId, requested, "chat:one", "user");
        assert.equal(one.id, duplicate.id);
        await Promise.all([processProjectSteward(projectId, false), processProjectSteward(projectId, false)]);
        const jobs = await jobsRepository.list(projectId);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.id, one.id, "dispatch recovery keeps the original identity");
        assert.equal(await canRunAgentJob(jobs[0]!), true);
        assert.equal((await stewardRepository.intents(projectId)).find((item) => item.id === event.id)?.status, "pending", "observation mode records event work without dispatching it");
        const eventJob = await jobsRepository.create({ id: event.id, projectId, chatId: crypto.randomUUID(), trigger: "steward", goal: "Repair sign in", limits: jobLimitsSchema.parse({}) });
        assert.equal(await canRunAgentJob(eventJob), false, "worker dispatch respects observation mode too");
        const tools = createJobPolicy(jobs[0]!, () => undefined).tools([createBackgroundTaskTool(projectId, "chat:policy-check")]);
        assert.equal(tools.some((tool) => ["start_background_task", "propose_intents"].includes(tool.name)), false, "an autonomous session cannot create more work");
        await jobsRepository.update(one.id, { status: "completed" });
        const again = await enqueueIntent(projectId, requested, "chat:two", "user");
        await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.get(again.id))?.status, "queued", "a fresh explicit request does not wait for a six-hour cooldown");
        await stewardRepository.update(projectId, { paused: true });
        assert.equal(await canRunAgentJob(jobs[0]!), false, "pause still applies to explicit requests");
        const failedRuns = [];
        for (let i = 0; i < 2; i++) {
            const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
            await runsRepository.finishRun(run.id, "failed", 1, "Expected sign-in result was missing");
            failedRuns.push(run);
        }
        const firstFailure = { kind: "triage", goal: "Investigate sign in", reason: "The latest check failed", specIds: [spec.id], runId: failedRuns[0]!.id };
        const firstTriage = await enqueueIntent(projectId, firstFailure, `failure:${failedRuns[0]!.id}`);
        const replay = await enqueueIntent(projectId, firstFailure, `failure:${failedRuns[0]!.id}`);
        const nextTriage = await enqueueIntent(projectId, { ...firstFailure, runId: failedRuns[1]!.id }, `failure:${failedRuns[1]!.id}`);
        assert.equal(firstTriage.id, replay.id, "replaying one failure still deduplicates");
        assert.equal(firstTriage.fingerprint, nextTriage.fingerprint, "equivalent failures share their subject across run and signal IDs");
    });

    test("triage requires the latest failed run and both current source and behavior hashes", async () => {
        const { prepareTriageGoal, cancelStaleTriage } = await import("../../src/core/jobs/triage");
        const { enqueueJob, stopJobWorker } = await import("../../src/core/jobs/worker");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { runsDir } = await import("../../src/core/paths");
        await stopJobWorker();
        const projectId = await createProject("Current failure");
        const feature = await writer.createFeatureInRepo(projectId, null, "Store", "");
        const { spec } = await createSpec(projectId, feature.id, "Store");
        const yaml = await fs.readFile(path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml"), "utf8");
        const snapshot = async (status: "failed" | "passed") => {
            const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
            await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
            await fs.writeFile(path.join(runsDir, run.id, "spec.yml"), yaml);
            await runsRepository.finishRun(run.id, status, 1, status === "failed" ? "Expected: Store" : null);
            return run;
        };
        const first = await snapshot("failed");
        assert.equal((await prepareTriageGoal(projectId, first.id)).runId, first.id);
        const queued = await enqueueJob(projectId, { kind: "failure_triage", trigger: "spec_failure", goal: "Investigate", runId: first.id });
        await snapshot("passed");
        await assert.rejects(() => prepareTriageGoal(projectId, first.id), /no longer the current result/);
        assert.equal(await cancelStaleTriage(queued), true);
        assert.equal((await jobsRepository.get(queued.id))?.status, "cancelled");
        assert.equal((await jobsRepository.get(queued.id))?.actionsUsed, 0, "superseded queued work never starts an agent turn");
        const latest = await snapshot("failed");
        await specsRepository.updateSpecRecord(spec.id, { markdownHash: "changed-behavior" });
        await assert.rejects(() => prepareTriageGoal(projectId, latest.id), /no longer the current result/);
        await specsRepository.updateSpecRecord(spec.id, { markdownHash: spec.markdownHash, sourceHash: "changed-implementation" });
        await assert.rejects(() => prepareTriageGoal(projectId, latest.id), /no longer the current result/);
    });

    test("leaving Observe discards the backlog and resumes only a current failure", async () => {
        const { createStewardRouter } = await import("../../src/infra/web/routes/steward");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { recordFailureSignal, processProjectSteward } = await import("../../src/core/steward/engine");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        const { runsDir } = await import("../../src/core/paths");
        await stopJobWorker();
        const projectId = await createProject("Observed failures");
        await stewardRepository.update(projectId, { autonomy: "observe" });
        const feature = await writer.createFeatureInRepo(projectId, null, "Store", "");
        const ids: string[] = [];
        let currentRunId = "";
        for (const state of ["fixed", "current", "changed", "no-healing"]) {
            const { spec } = await createSpec(projectId, feature.id, state);
            ids.push(spec.id);
            const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId), healOnFailure: state !== "no-healing" });
            await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
            await fs.writeFile(path.join(runsDir, run.id, "spec.yml"), await fs.readFile(path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml"), "utf8"));
            await runsRepository.finishRun(run.id, "failed", 1, "Expected: Store");
            await recordFailureSignal(projectId, run.id, spec.id, state);
            if (state === "fixed") {
                const passed = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: run.commitSha });
                await runsRepository.finishRun(passed.id, "passed", 1, null);
            } else if (state === "changed") await specsRepository.updateSpecRecord(spec.id, { sourceHash: "new" });
            else if (state === "current") currentRunId = run.id;
        }
        for (let i = 0; i < 10; i++) await stewardRepository.signal({ projectId, key: `old-change:${i}`, kind: "spec_changed", title: "Old version", body: "Run old version", payload: { specIds: [ids[0]], sourceHash: `old-${i}`, markdownHash: "old" } });
        await processProjectSteward(projectId, false);
        assert.equal((await stewardRepository.intents(projectId)).length, 0);
        const router = createStewardRouter();
        assert.equal((await router.request(`/projects/${projectId}/steward`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autonomy: "propose" }) })).status, 200);
        const pending = await stewardRepository.pendingSignals(projectId);
        assert.deepEqual(pending.map((signal) => signal.payload.runId), [currentRunId]);
        await processProjectSteward(projectId, false);
        const jobs = await jobsRepository.list(projectId);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.runId, currentRunId);
        assert.equal((await stewardRepository.intents(projectId)).length, 1);
    });

    test("automatic investigations remember cooldowns and rejections across repeated runs", async () => {
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { enqueueIntent, processProjectSteward } = await import("../../src/core/steward/engine");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        const { runsDir } = await import("../../src/core/paths");
        await stopJobWorker();
        const projectId = await createProject("Repeated failure");
        const feature = await writer.createFeatureInRepo(projectId, null, "Store", "");
        const { spec } = await createSpec(projectId, feature.id, "Store");
        const failed = async (status: "failed" | "error" = "failed") => {
            const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
            await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
            await fs.writeFile(path.join(runsDir, run.id, "spec.yml"), await fs.readFile(path.join(repoGit.getRepoDir(projectId), spec.path, "spec.yml"), "utf8"));
            await runsRepository.finishRun(run.id, status, 1, status === "failed" ? "Expected: Store" : "Connection refused");
            return enqueueIntent(projectId, { kind: "triage", specIds: [spec.id], runId: run.id, goal: "Investigate", reason: "Latest check failed" }, `test:${run.id}`);
        };
        const first = await failed();
        await processProjectSteward(projectId, false);
        const job = (await jobsRepository.get(first.id))!;
        await jobsRepository.update(job.id, { status: "completed" });
        const second = await failed();
        await processProjectSteward(projectId, false);
        assert.equal((await stewardRepository.intents(projectId)).find((row) => row.id === second.id)?.status, "ignored");
        assert.equal((await jobsRepository.list(projectId)).length, 1);
        const suggestion = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "spec_fix", title: "Suggested change", body: "Review" });
        await jobsRepository.updateItem(suggestion.id, { status: "rejected" });
        const third = await failed();
        await processProjectSteward(projectId, false);
        assert.match((await stewardRepository.intents(projectId)).find((row) => row.id === third.id)?.reason ?? "", /rejected/);
        const different = await failed("error");
        assert.notEqual(different.fingerprint, third.fingerprint, "a different failure category remains actionable");
        await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.get(different.id))?.status, "queued");
    });

    test("trusted automatic fixes preserve assertion targets, action kinds, aliases and input values", async () => {
        const { isLocatorOnlyFix } = await import("../../src/core/steward/approval");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Trusted fixes");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Review", limits: jobLimitsSchema.parse({}) });
        const source = VALID_SPEC.replace('await page.goto("/");', 'await page.goto("/");\n        await page.locator("button.new").click();');
        const before = source.replace('button.new', 'button.old');
        const item = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "spec_fix", title: "Fix", body: "Fix", payload: {
            requiresVerification: true, before: { testSource: before }, params: { specId: crypto.randomUUID(), testSource: source },
        } });
        assert.equal(isLocatorOnlyFix(item), true);
        for (const method of ["locator", "getByLabel", "getByTestId", "getByPlaceholder"]) {
            item.payload.before = { testSource: before.replace(".locator", `.${method}`) };
            item.payload.params = { specId: crypto.randomUUID(), testSource: source.replace(".locator", `.${method}`) };
            assert.equal(isLocatorOnlyFix(item), true, `${method} may change on a direct action`);
            item.payload.before = { testSource: VALID_SPEC.replace('page.getByRole("heading")', `page.${method}("specific target")`) };
            item.payload.params = { specId: crypto.randomUUID(), testSource: VALID_SPEC.replace('page.getByRole("heading")', `page.${method}("body")`) };
            assert.equal(isLocatorOnlyFix(item), false, `${method} cannot weaken an assertion target`);
        }
        item.payload.before = { testSource: before };
        item.payload.params = { specId: crypto.randomUUID(), testSource: source.replace('.click()', '.hover()') };
        assert.equal(isLocatorOnlyFix(item), false, "changing the action requires review");
        const alias = VALID_SPEC.replace('await page.goto("/");', 'await page.goto("/");\n        const target = page.locator("specific");').replace('page.getByRole("heading")', 'target');
        item.payload.before = { testSource: alias };
        item.payload.params = { specId: crypto.randomUUID(), testSource: alias.replace('"specific"', '"body"') };
        assert.equal(isLocatorOnlyFix(item), false, "shared locator declarations cannot weaken an assertion indirectly");
        for (const expectCall of ["expect", "expect.soft"]) {
            item.payload.before = { testSource: `await ${expectCall}(await page.locator("specific").click()).toBeUndefined();` };
            item.payload.params = { specId: crypto.randomUUID(), testSource: `await ${expectCall}(await page.locator("body").click()).toBeUndefined();` };
            assert.equal(isLocatorOnlyFix(item), false, "actions nested inside assertions cannot change their selectors");
        }
        item.payload.before = { testSource: before };
        item.payload.params = { specId: crypto.randomUUID(), testSource: source.replace('toBeVisible()', 'toBeAttached()') };
        assert.equal(isLocatorOnlyFix(item), false, "assertion matchers must stay exact");
        item.payload.params = { specId: crypto.randomUUID(), testSource: source };
        item.payload.params = { ...(item.payload.params as object), humanSpec: HUMAN_SPEC };
        assert.equal(isLocatorOnlyFix(item), false, "behavior proposals always need a human");
        item.payload.before = { testSource: `page.fill(".locator('old')")` };
        item.payload.params = { specId: crypto.randomUUID(), testSource: `page.fill(".locator('new')")` };
        assert.equal(isLocatorOnlyFix(item), false, "input data cannot masquerade as a locator change");
    });

    test("screenshot policy changes apply to existing agent sessions", async (t) => {
        const { agentSettings, updateSecuritySettings } = await import("../../src/core/chat/safety-settings");
        const manager = await agentSettings();
        assert.equal(manager.getBlockImages(), false);
        await updateSecuritySettings({ sendScreenshotsToModel: false });
        assert.equal(manager.getBlockImages(), true, "existing sessions recheck image policy on every request");
        t.after(() => updateSecuritySettings({}));
        await updateSecuritySettings({ sendScreenshotsToModel: true });
        assert.equal(manager.getBlockImages(), false);
    });

    test("replays changed Spec and deploy signals once after a crash, while retaining real reversions", async (t) => {
        const { collectProjectSignals } = await import("../../src/core/steward/signals");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const projectId = await createProject("Observation recovery");
        const project = (await projectsRepository.getProject(projectId))!;
        const feature = await writer.createFeatureInRepo(projectId, null, "Store", "");
        const { spec } = await createSpec(projectId, feature.id, "Store");
        let build = "a";
        t.mock.method(globalThis, "fetch", async () => new Response(`<script src="/${build}.js"></script>`));
        let at = Date.now();
        let observation = await collectProjectSignals(project, {}, at);
        await stewardRepository.update(projectId, { observation });
        const originalHash = spec.sourceHash;
        for (const [index, version] of ["b", "a", "b"].entries()) {
            at += 300_001;
            build = version;
            await specsRepository.updateSpecRecord(spec.id, { sourceHash: version === "a" ? originalHash : "changed-source" });
            const persisted = (await stewardRepository.get(projectId)).observation;
            observation = await collectProjectSignals(project, persisted, at);
            // Simulate the process stopping after signal INSERT, before saving its observation.
            const replay = await collectProjectSignals(project, persisted, at + 1000);
            assert.deepEqual(replay.specGenerations, observation.specGenerations);
            assert.equal(replay.deployment?.generation, observation.deployment?.generation);
            const signals = await stewardRepository.signals(projectId);
            assert.equal(signals.filter((signal) => signal.kind === "spec_changed").length, index + 1);
            assert.equal(signals.filter((signal) => signal.kind === "deployment_changed").length, index + 1);
            assert.equal(observation.specGenerations?.[spec.id], index + 1);
            await stewardRepository.update(projectId, { observation });
        }
        await stewardRepository.signal({ projectId, key: "preview:first", kind: "deployment", title: "Preview", body: "Run preview", payload: { environment: "preview", url: "https://first.preview.test", commitSha: "one" } });
        await new Promise((resolve) => setTimeout(resolve, 2));
        await stewardRepository.signal({ projectId, key: "preview:latest", kind: "deployment", title: "Preview", body: "Run preview", payload: { environment: "preview", url: "https://latest.preview.test", commitSha: "two" } });
        for (const signal of await stewardRepository.signals(projectId)) await stewardRepository.acknowledge(signal.id, "observed");
        const { resumeCurrentSignals } = await import("../../src/core/steward/engine");
        await resumeCurrentSignals(projectId);
        const current = await stewardRepository.pendingSignals(projectId);
        assert.equal(current.length, 3, "only the current Spec, detected build and explicit deployment remain actionable");
        assert.equal(current.find((signal) => signal.kind === "spec_changed")?.payload.generation, 3, "returning to the same content does not replay an older generation");
        assert.equal(current.find((signal) => signal.kind === "deployment_changed")?.payload.generation, 3);
        assert.equal(current.find((signal) => signal.kind === "deployment")?.payload.url, "https://latest.preview.test", "older preview URLs for the same environment are not resumed");
    });

    test("run prerequisites ask once and resume the original request without exploratory work", async () => {
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        const { enqueueIntent, processProjectSteward } = await import("../../src/core/steward/engine");
        await stopJobWorker();
        const projectId = await createProject("Missing run access");
        const { environmentsRepository } = await import("../../src/infra/repositories/environments");
        const production = (await environmentsRepository.list(projectId))[0]!;
        await environmentsRepository.update(production, { ...production, allowedOrigins: ["https://preview.example.com"] });
        await stewardRepository.update(projectId, { autonomy: "observe" });
        const feature = await writer.createFeatureInRepo(projectId, null, "Sign in", "");
        const source = VALID_SPEC.replace("{ page, step }", "{ page, step, secret }")
            .replace('await page.goto("/");', 'await page.goto("/");\n        await page.getByLabel("Email").fill(secret("shopper", "email"));');
        const { spec } = await createSpec(projectId, feature.id, "Sign in", source);
        const intent = await enqueueIntent(projectId, { kind: "run_specs", goal: "Verify the preview", reason: "The human requested a preview check", specIds: [spec.id], baseUrl: "https://preview.example.com" }, "chat:missing-access", "user");
        await processProjectSteward(projectId, false);
        const waiting = (await stewardRepository.intents(projectId)).find((item) => item.id === intent.id)!;
        assert.equal(waiting.status, "running");
        const job = (await jobsRepository.get(intent.id))!;
        assert.equal(job.status, "blocked");
        assert.equal(job.kind, "review");
        assert.equal(job.tokensUsed, 0);
        assert.match(job.stopReason ?? "", /credentials.*not configured/);
        const question = (await jobsRepository.inbox(projectId))[0]!;
        assert.equal(question.kind, "question");
        assert.equal(question.payload.waitingFor, "credentials");
        assert.equal(question.payload.runIntentId, intent.id);
        for (let i = 0; i < 3; i++) await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.inbox(projectId)).length, 1);
        assert.equal((await stewardRepository.intents(projectId)).length, 1);
        await stewardRepository.signal({ projectId, kind: "credentials_changed", key: "access:changed", title: "Access changed", body: "Profiles changed" });
        await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.get(job.id))?.status, "completed", "answering a run prerequisite never starts an LLM turn");
        assert.equal((await jobsRepository.item(question.id))?.status, "answered");
        const resumed = (await stewardRepository.intents(projectId)).find((item) => item.key === `resume-run:${intent.id}:${question.id}`)!;
        assert.ok(resumed);
        assert.equal(resumed.source, "user");
        assert.equal(resumed.intent.baseUrl, "https://preview.example.com");
        assert.deepEqual(resumed.intent.specIds, [spec.id]);
        // The access signal did not actually add the profile: retry asks the exact prerequisite again, then waits.
        for (let i = 0; i < 3; i++) await processProjectSteward(projectId, false);
        assert.equal((await jobsRepository.get(resumed.id))?.status, "blocked");
        assert.equal((await jobsRepository.list(projectId)).length, 2);
        assert.equal((await jobsRepository.inbox(projectId)).filter((item) => item.status === "pending").length, 1);
        assert.equal((await stewardRepository.intents(projectId)).some((item) => ["explore", "coverage"].includes(item.intent.kind)), false);
    });

    test("keeps independent coverage requests and promoted bug reports distinct", async () => {
        const { enqueueIntent } = await import("../../src/core/steward/engine");
        const projectId = await createProject("Independent coverage");
        const base = { kind: "coverage", reason: "Missing coverage", goal: "Cover login" };
        const login = await enqueueIntent(projectId, base, "chat:login", "user");
        const duplicate = await enqueueIntent(projectId, { ...base, goal: " Cover   LOGIN " }, "chat:repeat", "user");
        const checkout = await enqueueIntent(projectId, { ...base, goal: "Cover checkout" }, "chat:checkout", "user");
        const regression = await enqueueIntent(projectId, base, "regression:bug-one", "user");
        assert.equal(login.fingerprint, duplicate.fingerprint);
        assert.notEqual(login.fingerprint, checkout.fingerprint);
        assert.notEqual(login.fingerprint, regression.fingerprint);
    });

    test("promoting a bug report creates one regression intent without changing the repository", async () => {
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        await stopJobWorker();
        const projectId = await createProject("Regression proposal");
        const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Investigate", limits: jobLimitsSchema.parse({}) });
        const bug = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "bug_report", title: "Checkout drops the discount", body: "Open checkout with a coupon; the total ignores it." });
        const question = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "question", title: "Access", body: "Which account?" });
        const head = await repoGit.getHeadSha(projectId);
        const router = new Hono().route("/", createJobsRouter());
        const promote = (project: string, item: string) => router.request(`/projects/${project}/inbox/${item}/promote`, { method: "POST" });
        const response = await promote(projectId, bug.id);
        assert.equal(response.status, 202);
        const { intentId } = await response.json() as { intentId: string };
        assert.deepEqual(await (await promote(projectId, bug.id)).json(), { intentId });
        assert.equal((await promote(crypto.randomUUID(), bug.id)).status, 404);
        assert.equal((await promote(projectId, question.id)).status, 400);
        const intents = await stewardRepository.intents(projectId);
        assert.equal(intents.length, 1);
        assert.equal(intents[0]?.intent.kind, "coverage");
        assert.match(intents[0]?.intent.goal ?? "", /total ignores it/);
        assert.equal((await jobsRepository.item(bug.id))?.payload.regressionIntentId, intentId);
        assert.equal(await repoGit.getHeadSha(projectId), head);
        assert.ok((await repoGit.getProjectGit(projectId).status()).isClean());
    });

    test("does not recreate an exact proposal the human already rejected", async () => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const projectId = await createProject("Rejected proposal");
        const createJob = () => jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "manual", goal: "Propose coverage", limits: jobLimitsSchema.parse({}) });
        const job = await createJob();
        const params = { title: "Checkout", description: "Coupons and payment" };
        const proposal = await proposeMutation(job, "create_feature", params);
        await jobsRepository.updateItem(proposal.id, { status: "rejected" });
        const next = await createJob();
        await assert.rejects(() => proposeMutation(next, "create_feature", { description: params.description, title: params.title }), /human rejected/);
        assert.equal((await jobsRepository.inbox(projectId)).length, 1);
        const different = await proposeMutation(next, "create_feature", { title: "Login", description: "Access and account sessions" });
        assert.equal(different.status, "pending");
    });

});

describe("plain-language autonomous presentation", () => {
    async function createOverviewRun(input: Parameters<typeof runsRepository.createRun>[0]) {
        const { runsDir } = await import("../../src/core/paths");
        const spec = (await specsRepository.getSpec(input.specId))!;
        const run = await runsRepository.createRun(input);
        await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
        await fs.copyFile(path.join(repoGit.getRepoDir(spec.projectId), spec.path, "spec.yml"), path.join(runsDir, run.id, "spec.yml"));
        return run;
    }

    test("unfinished updates stay out of Inbox, stopped attempts offer help, and stale updates disappear", async () => {
        const { projectPresentation } = await import("../../src/core/jobs/presentation");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const projectId = await createProject("Understandable updates");
        const feature = await writer.createFeatureInRepo(projectId, null, "Store", "");
        const { spec } = await createSpec(projectId, feature.id, "View results");
        const job = await jobsRepository.create({ projectId, specId: spec.id, kind: "regenerate", chatId: crypto.randomUUID(), trigger: "steward", goal: "Repair the check", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(job.id, { status: "running" });
        const source = VALID_SPEC.replace('page.goto("/")', 'page.goto("/results")');
        const item = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: source });
        const error = 'TimeoutError: expected result did not appear\n    at Object.click (/home/gus/specbook/src/core/runner/guard.ts:279:36)\n> 279 | await locator.click();\n      | ^\nArtifact: /tmp/specbook/storage/runs/private/error.txt';
        await jobsRepository.updateItem(item.id, { payload: { ...item.payload, verification: { status: "failed", failReason: error, screenshots: [] } } });
        assert.equal((await projectPresentation(projectId)).items.length, 0);
        await jobsRepository.update(job.id, { status: "stalled" });
        const paused = await projectPresentation(projectId);
        assert.equal(paused.items.length, 1);
        assert.equal(paused.items[0]?.presentation.type, "help");
        assert.match(paused.items[0]?.presentation.title ?? "", /Look at it together\?/);
        assert.ok(!paused.activity.some((story) => story.status === "paused"), "an unfinished attempt is not a user-requested pause");
        assert.equal(paused.summary.paused, false);
        assert.doesNotMatch(JSON.stringify(paused), /\/home\/gus|\/tmp\/specbook|src\/core\/runner|Object\.click|279 \|/);
        await writer.updateSpecWithLock(spec.id, { testSource: source });
        assert.equal((await projectPresentation(projectId)).items.length, 0, "an outdated failed suggestion is not a new decision");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        await stewardRepository.update(projectId, { autonomy: "observe" });
        const observing = await projectPresentation(projectId);
        assert.ok(!observing.activity.some((story) => story.status === "paused" || story.status === "working"));
        assert.equal(observing.summary.paused, false);
        assert.equal(observing.activity[0]?.status, "stopped");
        assert.match(observing.activity[0]?.nextStep ?? "", /Discuss the Spec/);
        await jobsRepository.update(job.id, { status: "running" });
        const working = await projectPresentation(projectId);
        assert.equal(working.activity[0]?.status, "working");
    });

    test("groups repeated observations and investigations around one check and pairs the same screenshot step", async () => {
        const { projectPresentation } = await import("../../src/core/jobs/presentation");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { proposeMutation } = await import("../../src/core/jobs/proposals");
        const { sourceHashOf } = await import("../../src/core/repo/writer");
        const { runsDir } = await import("../../src/core/paths");
        const projectId = await createProject("Grouped story");
        const feature = await writer.createFeatureInRepo(projectId, null, "Store", "");
        const { spec } = await createSpec(projectId, feature.id, "Open results");
        const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
        await runsRepository.finishRun(run.id, "failed", 1, "Missing results");
        await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
        await fs.writeFile(path.join(runsDir, run.id, "evidence.json"), JSON.stringify({ failedStep: "Abrir a página", steps: [{ label: "Abrir a página", file: "evidence/step-01.png" }] }));
        const job = await jobsRepository.create({ projectId, runId: run.id, specId: spec.id, kind: "regenerate", chatId: crypto.randomUUID(), trigger: "steward", goal: "Repair", limits: jobLimitsSchema.parse({}) });
        const source = VALID_SPEC.replace('page.goto("/")', 'page.goto("/results")');
        const item = await proposeMutation(job, "update_spec", { specId: spec.id, testSource: source });
        await jobsRepository.updateItem(item.id, { payload: { ...item.payload, verification: { id: crypto.randomUUID(), status: "passed", sourceHash: sourceHashOf(source), screenshots: ["evidence/step-01.png", "evidence/step-02.png"] } } });
        await jobsRepository.update(job.id, { status: "completed" });
        await jobsRepository.log(job.id, "browser_snapshot:completed", "Captured the page");
        await jobsRepository.log(job.id, "proposal:verified", `${item.id}: passed`);
        for (const key of ["changed:one", "changed:two"]) await stewardRepository.signal({ projectId, key, kind: "invalid_spec", title: "Internal invalid status", body: "Internal detail", payload: { specIds: [spec.id] } });
        const view = await projectPresentation(projectId);
        assert.equal(view.activity.length, 1);
        assert.equal(view.activity[0]?.subject.id, spec.id);
        assert.deepEqual(new Set(view.activity[0]?.timeline.map((entry) => entry.label)), new Set(["Noticed", "Tested update", "Your decision"]));
        const times = view.activity[0]!.timeline.map((entry) => entry.createdAt);
        assert.deepEqual(times, [...times].sort(), "decision and evidence dates are chronological even when investigation ends later");
        assert.doesNotMatch(JSON.stringify(view.activity), /Reviewed the check and the available application evidence/);
        assert.notEqual(view.activity[0]?.timeline[0]?.detail, view.activity[0]?.summary);
        assert.match(view.items[0]?.presentation.screenshots.before?.url ?? "", /step-01\.png$/);
        assert.match(view.items[0]?.presentation.screenshots.after?.url ?? "", /step-01\.png$/);
        assert.equal(view.items[0]?.presentation.type, "update");
        assert.equal(view.items[0]?.presentation.summary, "Missing results. The expected behavior stays the same.");
        assert.doesNotMatch(view.items[0]?.presentation.summary ?? "", /passed/);
        assert.match(view.items[0]?.presentation.workDone ?? "", /passed/);
        assert.match(view.activity[0]?.title ?? "", /needs an update before it can run/);
        assert.equal(view.items.filter((item) => item.status === "pending" && item.kind !== "bug_report").length, 1);
        assert.ok(!view.activity.some((story) => story.status === "working"));
    });

    test("keeps internal browser failures out of Inbox and removes source frames from optional diagnostics", async () => {
        const { projectPresentation } = await import("../../src/core/jobs/presentation");
        const { sanitizeTechnicalDetails, isInfrastructureFailure } = await import("../../src/core/jobs/presentation-errors");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const projectId = await createProject("Service recovery");
        for (const display of [118, 119]) {
            const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "steward", goal: "Inspect", limits: jobLimitsSchema.parse({}) });
            await jobsRepository.update(job.id, { status: "blocked" });
            await jobsRepository.addItem({ projectId, jobId: job.id, kind: "question", title: "Job needs help", body: `O navegador não iniciou devido ao conflito do servidor X (display ${display}).` });
        }
        const view = await projectPresentation(projectId);
        assert.deepEqual(view.items, []);
        assert.ok(view.summary.systemHealth);
        assert.match(view.summary.systemHealth.message, /resume automatically/);
        assert.equal(view.activity.length, 0, "infrastructure recovery is represented by one health notice");
        const technical = sanitizeTechnicalDetails('TimeoutError: missing button\n    at Object.click (/home/gus/app/src/core/runner/guard.ts:279)\n> 279 | await locator.click()\n    ^\nC:\\Users\\gus\\specbook\\error.log\nSee /var/log/specbook/errors.txt\nURL: https://app.example.com/results');
        assert.match(technical, /TimeoutError: missing button/);
        assert.match(technical, /https:\/\/app.example.com\/results/);
        assert.doesNotMatch(technical, /\/home|C:\\Users|\/var\/log|guard\.ts|locator\.click|\bat Object/);
        assert.equal(isInfrastructureFailure("The application returned HTTP 503"), false);
        assert.equal(isInfrastructureFailure("browserType.launch: Xvfb failed"), true);
        assert.equal(isInfrastructureFailure("BrowserUnavailableError"), true);
        assert.equal(isInfrastructureFailure("Specbook couldn’t start its browser."), true);
        assert.equal(isInfrastructureFailure("Specbook could not start its browser."), true);
    });

    test("overview separates decisions from failing checks and keeps health independent of pause", async () => {
        const { projectOverview } = await import("../../src/core/jobs/overview");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { db } = await import("../../src/infra/db/client");
        const { inboxItems } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const projectId = await createProject("Organized overview");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        await stewardRepository.update(projectId, { paused: true });
        const feature = await writer.createFeatureInRepo(projectId, null, "Survey", "");
        const checks = await Promise.all(["Passing", "Failing", "Flaky", "Paused one", "Paused two", "Unchecked", "Invalid"].map(async (title) => (await createSpec(projectId, feature.id, title)).spec));
        const [passing, failing, flaky, pausedOne, pausedTwo, unchecked, invalid] = checks;
        for (const spec of [passing!, failing!, flaky!]) {
            const status = spec.id === failing!.id ? "failed" : "passed";
            const run = await createOverviewRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
            await runsRepository.finishRun(run.id, status, 5, status === "failed" ? "Result did not appear" : null);
            await specsRepository.updateSpecStatus(spec.id, status);
            if (spec.id === flaky!.id) await runsRepository.markFlaky(run.id, run.id);
        }
        await specsRepository.updateSpecStatus(invalid!.id, "invalid", "spec.ts is missing");
        const previous = await jobsRepository.create({ projectId, specId: pausedOne!.id, kind: "explore", chatId: crypto.randomUUID(), trigger: "steward", goal: "Explore surveys", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(previous.id, { status: "completed" });
        for (const spec of [pausedOne!, pausedTwo!]) {
            const job = await jobsRepository.create({ projectId, specId: spec.id, kind: "regenerate", chatId: crypto.randomUUID(), trigger: "steward", goal: "Update check", limits: jobLimitsSchema.parse({}) });
            await jobsRepository.update(job.id, { status: "stalled" });
        }
        const questionJob = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), trigger: "steward", goal: "Clarify survey access", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(questionJob.id, { status: "blocked" });
        const newer = await jobsRepository.addItem({ projectId, jobId: questionJob.id, kind: "question", title: "Should guests see survey results?", body: "Which results should be visible to guests?" });
        const older = await jobsRepository.addItem({ projectId, jobId: questionJob.id, kind: "question", title: "Should drafts appear in the survey list?", body: "Should the survey list include drafts?" });
        await db.update(inboxItems).set({ createdAt: "2024-01-01T00:00:00.000Z" }).where(eq(inboxItems.id, older.id));
        const failedRun = (await runsRepository.listRuns(failing!.id))[0]!;
        const bug = await jobsRepository.addItem({ projectId, jobId: questionJob.id, kind: "bug_report", title: "Deleting a survey shows an error", body: "Deleting the survey leaves it in the list.", payload: { specId: failing!.id, runId: failedRun.id } });
        const regeneration = await jobsRepository.create({ projectId, specId: invalid!.id, kind: "regenerate", chatId: crypto.randomUUID(), trigger: "steward", goal: "Restore the invalid check", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(regeneration.id, { status: "completed", classification: "application_bug" });
        const invalidFinding = await jobsRepository.addItem({ projectId, jobId: regeneration.id, kind: "bug_report", title: "The results page cannot open", body: "Opening the results page leaves an empty screen." });
        const view = await projectOverview(projectId);
        assert.deepEqual(view.needsYou.map((item) => item.id), [older.id, newer.id, invalidFinding.id]);
        assert.equal(view.summary.attentionCount, 3);
        assert.equal(view.failing.length, 1);
        assert.equal(view.failing.find((item) => item.specId === failing!.id)?.triageStatus, "App bug reported");
        assert.equal(view.failing.some((item) => item.specId === invalid!.id), false, "an invalid implementation is not a failing application check");
        assert.equal(view.needsYou.some((item) => item.id === invalidFinding.id), true, "a finding without a current failing check remains a reviewable decision");
        assert.equal(view.summary.paused, true);
        assert.deepEqual(view.summary.specHealth, { total: 7, passing: 1, failing: 1, flaky: 1, not_checked: 3, running: 0, repairing: 0, invalid: 1 });
        assert.equal(view.specHealth[pausedOne!.id]?.status, "not_checked");
        assert.equal(view.specHealth[unchecked!.id]?.status, "not_checked");
        assert.equal(view.specHealth[invalid!.id]?.status, "invalid");
        assert.equal(view.specHealth[invalid!.id]?.label, "Needs repair");
        assert.equal(view.specHealth[flaky!.id]?.status, "flaky");
        assert.equal(view.recentRuns.length, 3, "recent activity contains actual runs, not completed agent sessions");
        assert.equal(view.stories.some((story) => story.inboxIds.includes(older.id)), true, "pending decisions retain a detail timeline");
        const finding = await jobsRepository.addItem({ projectId, jobId: previous.id, kind: "bug_report", title: "An export link is broken", body: "Opening export returns 404." });
        const withFinding = await projectOverview(projectId);
        const decision = withFinding.needsYou.find((item) => item.id === finding.id);
        assert.match(decision?.presentation.title ?? "", /^Add a regression Spec.*\?$/);
        assert.equal(withFinding.items.find((item) => item.id === finding.id)?.presentation.title, decision?.presentation.title);
        assert.equal(withFinding.summary.attentionCount, 4);
        assert.match(view.summary.nextCheck, /Resume Specbook/);
        await stewardRepository.update(projectId, { paused: false });
        const oldTriage = await jobsRepository.create({ projectId, specId: failing!.id, runId: failedRun.id, kind: "failure_triage", chatId: crypto.randomUUID(), trigger: "spec_failure", goal: "Investigate the previous failure", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(oldTriage.id, { status: "completed", classification: "application_bug" });
        const passingRun = await createOverviewRun({ specId: failing!.id, sourceHash: failing!.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
        await runsRepository.finishRun(passingRun.id, "passed", 1, null);
        const newFailure = await createOverviewRun({ specId: failing!.id, sourceHash: failing!.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
        await runsRepository.finishRun(newFailure.id, "failed", 1, "A different element is missing");
        const uncheckedFailure = await projectOverview(projectId);
        const currentFailure = uncheckedFailure.failing.find((entry) => entry.specId === failing!.id)!;
        assert.equal(currentFailure.triageStatus, "Latest run failed");
        assert.equal(currentFailure.storyId, undefined, "old triage details do not stand in for the latest failure evidence");
        assert.ok(!currentFailure.inboxIds.includes(bug.id));
        const retry = await createOverviewRun({ specId: failing!.id, sourceHash: failing!.sourceHash, commitSha: await repoGit.getHeadSha(projectId), retryOf: newFailure.id });
        await runsRepository.finishRun(retry.id, "failed", 1, "The same element is still missing");
        const currentTriage = await jobsRepository.create({ projectId, specId: failing!.id, runId: newFailure.id, kind: "failure_triage", chatId: crypto.randomUUID(), trigger: "spec_failure", goal: "Investigate the current failure", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(currentTriage.id, { status: "running" });
        assert.equal((await projectOverview(projectId)).failing.find((entry) => entry.specId === failing!.id)?.triageStatus, "Investigating…", "the original and retry belong to the same investigation");
    });

    test("overview health and last checked use the same current implementation and behavior", async () => {
        const { projectOverview } = await import("../../src/core/jobs/overview");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
        const { db } = await import("../../src/infra/db/client");
        const { runs } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const projectId = await createProject("Current health");
        const feature = await writer.createFeatureInRepo(projectId, null, "Checkout", "");
        const { spec } = await createSpec(projectId, feature.id, "Show the confirmation");
        const run = await createOverviewRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha: await repoGit.getHeadSha(projectId) });
        await db.update(runs).set({ startedAt: "2026-01-01T12:00:00.000Z" }).where(eq(runs.id, run.id));
        await runsRepository.finishRun(run.id, "failed", 100, "Confirmation not visible");
        const job = await jobsRepository.create({ projectId, specId: spec.id, runId: run.id, kind: "failure_triage", trigger: "spec_failure", chatId: crypto.randomUUID(), goal: "Investigate confirmation", limits: jobLimitsSchema.parse({}) });
        await jobsRepository.update(job.id, { status: "running" });
        const current = await projectOverview(projectId);
        assert.equal(current.summary.specHealth.failing, 1);
        assert.equal(current.summary.lastCheckedAt, "2026-01-01T12:00:00.100Z");
        assert.equal(current.specHealth[spec.id]?.lastCheckedAt, current.summary.lastCheckedAt);
        assert.equal(current.failing[0]?.updatedAt, current.summary.lastCheckedAt, "triage activity does not pretend the check ran again");
        await writer.updateSpecWithLock(spec.id, { humanSpec: { ...HUMAN_SPEC, expectedResult: "The checkout confirmation appears" } });
        assert.equal((await specsRepository.getSpec(spec.id))?.sourceHash, spec.sourceHash);
        const changedBehavior = await projectOverview(projectId);
        assert.equal(changedBehavior.summary.specHealth.not_checked, 1);
        assert.equal(changedBehavior.summary.lastCheckedAt, null, "an old behavior result cannot supply the current check timestamp");
        assert.equal(changedBehavior.specHealth[spec.id]?.runId, undefined);
        assert.equal(changedBehavior.failing.length, 0);
        assert.equal(changedBehavior.recentRuns.length, 1, "historical results remain available as history");
        await specsRepository.updateSpecStatus(spec.id, "invalid", "Missing spec.ts file in the spec directory");
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
        const feature = await writer.createFeatureInRepo(projectId, null, "Surveys", "");
        const { spec } = await createSpec(projectId, feature.id, "View surveys");
        const commitSha = await repoGit.getHeadSha(projectId);
        const runIds: string[] = [];
        for (let minute = 0; minute < 3; minute++) {
            const run = await createOverviewRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha });
            runIds.push(run.id);
            await db.update(runs).set({ startedAt: `2026-01-01T12:0${minute}:00.000Z` }).where(eq(runs.id, run.id));
            await runsRepository.finishRun(run.id, "passed", 100, null);
        }
        const grouped = await projectOverview(projectId);
        assert.equal(grouped.recentRuns.length, 1);
        assert.equal(grouped.recentRuns[0]?.occurrences, 3);
        assert.equal(grouped.recentRuns[0]?.counts.passed, 3);
        assert.match(grouped.recentRuns[0]?.title ?? "", /3 runs/);
        assert.deepEqual(grouped.recentRuns[0]?.timeline.map((event) => event.runId), runIds);
        assert.equal(grouped.recentRuns[0]?.updatedAt, "2026-01-01T12:02:00.100Z");
        const failed = await createOverviewRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha });
        await db.update(runs).set({ startedAt: "2026-01-01T12:03:00.000Z" }).where(eq(runs.id, failed.id));
        await runsRepository.finishRun(failed.id, "failed", 100, "Survey list is empty");
        const distinct = await projectOverview(projectId);
        assert.equal(distinct.recentRuns.length, 2);
        assert.equal(distinct.recentRuns[0]?.runId, failed.id);
        assert.equal(distinct.recentRuns[0]?.occurrences, 1);
        assert.equal(distinct.recentRuns[1]?.occurrences, 3);
        assert.equal(distinct.summary.lastCheckedAt, "2026-01-01T12:03:00.100Z");
    });

    test("overview keeps a batch live through retry and links the final grouped result to run evidence", async () => {
        const { projectOverview } = await import("../../src/core/jobs/overview");
        const { createJobsRouter } = await import("../../src/infra/web/routes/jobs");
        const { runBatchesDir } = await import("../../src/core/paths");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { db } = await import("../../src/infra/db/client");
        const { projectSignals } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const projectId = await createProject("Batch overview");
        const feature = await writer.createFeatureInRepo(projectId, null, "Login", "");
        const { spec } = await createSpec(projectId, feature.id, "Sign in");
        const commitSha = await repoGit.getHeadSha(projectId);
        const original = await createOverviewRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha, automate: true });
        await runsRepository.finishRun(original.id, "failed", 10, "Login button was not visible");
        const batchId = crypto.randomUUID();
        await fs.mkdir(path.join(runBatchesDir, batchId), { recursive: true });
        const batch = {
            id: batchId, projectId, label: "Login checks", status: "failed", startedAt: original.startedAt, durationMs: 10, failReason: null,
            specs: [{ runId: original.id, specId: spec.id, commitSha, sourceHash: spec.sourceHash, markdownHash: spec.markdownHash, title: spec.title, status: "failed", durationMs: 10, failReason: "Login button was not visible" }],
        } satisfies import("../../src/core/runner/batch").RunBatch;
        await fs.writeFile(path.join(runBatchesDir, batchId, "batch.json"), JSON.stringify(batch));
        await stewardRepository.signal({ projectId, kind: "deployment", key: "deploy:preview", title: "Preview deployed", body: "Check the preview" });
        const signal = (await stewardRepository.signals(projectId))[0]!;
        const runIntent = { kind: "run_specs" as const, goal: "Check login", reason: "Login changed", specIds: [spec.id], priority: 50 };
        const deployment = await stewardRepository.addIntent({ projectId, key: `signal:${signal.id}`, fingerprint: "deploy:preview", intent: runIntent, priority: 50, reason: runIntent.reason });
        await stewardRepository.updateIntent(deployment.id, { status: "completed" });
        const resumed = await stewardRepository.addIntent({ projectId, key: `resume-run:${deployment.id}:answer`, fingerprint: "resumed:preview", intent: runIntent, priority: 50, reason: runIntent.reason });
        await stewardRepository.updateIntent(resumed.id, { status: "running", batchId });
        const pending = await projectOverview(projectId);
        assert.equal(pending.recentRuns.length, 1);
        assert.equal(pending.recentRuns[0]?.id, `batch:${batchId}`);
        assert.equal(pending.recentRuns[0]?.status, "working");
        assert.equal(pending.recentRuns[0]?.counts.running, 1);
        assert.equal(pending.recentRuns[0]?.trigger, "deploy", "resumed deployments retain their original trigger");
        await runsRepository.finishRun(original.id, "passed", 10, null);
        assert.deepEqual((await projectOverview(projectId)).recentRuns[0]?.counts, { total: 1, passed: 0, failed: 0, flaky: 0, running: 1 }, "pending automation is counted once even after a passing result");
        await runsRepository.finishRun(original.id, "failed", 10, "Login button was not visible");
        const retry = await createOverviewRun({ specId: spec.id, sourceHash: spec.sourceHash, commitSha, retryOf: original.id });
        await runsRepository.finishRun(retry.id, "passed", 20, null);
        await runsRepository.markFlaky(original.id, retry.id);
        assert.deepEqual((await projectOverview(projectId)).recentRuns[0]?.counts, { total: 1, passed: 0, failed: 0, flaky: 0, running: 1 }, "marking flaky before acknowledgment never duplicates the result count");
        await runsRepository.acknowledgeAutomation(original.id);
        await specsRepository.updateSpecStatus(spec.id, "passed");
        const router = new Hono().route("/", createJobsRouter());
        const response = await router.request(`/projects/${projectId}/overview`);
        assert.equal(response.status, 200);
        const view = await response.json() as Awaited<ReturnType<typeof projectOverview>>;
        assert.equal(view.recentRuns[0]?.status, "completed");
        assert.equal(view.recentRuns.length, 1, "batch runs and retries are not repeated as standalone history rows");
        assert.match(view.recentRuns[0]?.title ?? "", /1 passed on retry/);
        assert.equal(view.recentRuns[0]?.outcome, "flaky");
        assert.equal(view.recentRuns[0]?.timeline[0]?.specId, spec.id);
        assert.equal(view.recentRuns[0]?.timeline[0]?.runId, retry.id);
        assert.equal(view.recentRuns[0]?.updatedAt, new Date(Date.parse(retry.startedAt) + 20).toISOString());
        assert.equal(view.specHealth[spec.id]?.status, "flaky");
        assert.equal((await router.request(`/projects/${crypto.randomUUID()}/overview`)).status, 404);
        await fs.writeFile(path.join(runBatchesDir, batchId, "batch.json"), JSON.stringify({ ...batch, trigger: "deploy" }));
        await db.delete(projectSignals).where(eq(projectSignals.projectId, projectId));
        await stewardRepository.updateIntent(resumed.id, { status: "completed" });
        const finished = await stewardRepository.addIntent({ projectId, key: "login:old", fingerprint: "login:old", intent: runIntent, priority: 50, reason: runIntent.reason });
        await stewardRepository.updateIntent(finished.id, { status: "completed", batchId });
        await stewardRepository.addIntent({ projectId, key: "login:new", fingerprint: "login:new", intent: runIntent, priority: 50, reason: runIntent.reason });
        const again = await projectOverview(projectId);
        assert.equal(again.recentRuns.length, 1, "a pending intention is not a new run");
        assert.equal(again.recentRuns[0]?.id, `batch:${batchId}`);
        assert.equal(again.recentRuns[0]?.trigger, "deploy", "stored run triggers survive observation retention and missing original signals");
        assert.equal(again.stories.some((story) => story.status === "queued" && story.specId === spec.id), true);
    });
});

test("agent evaluation records outcomes and decisions without prompts or credentials", async () => {
    const { execFileSync } = await import("node:child_process");
    const { jobsRepository } = await import("../../src/infra/repositories/jobs");
    const { jobLimitsSchema } = await import("../../src/core/jobs/schemas");
    const { jobMetricsPath, recordAgentMetric } = await import("../../src/core/jobs/metrics");
    const projectId = await createProject("Evaluation records");
    const secret = "private-input-never-exported";
    const job = await jobsRepository.create({ projectId, chatId: crypto.randomUUID(), kind: "failure_triage", trigger: "spec_failure", goal: secret, limits: jobLimitsSchema.parse({}) });
    await jobsRepository.claim(job.id);
    await jobsRepository.update(job.id, { classification: "test_drift", tokensUsed: 123, actionsUsed: 4, elapsedMs: 500 });
    const item = await jobsRepository.addItem({ projectId, jobId: job.id, kind: "spec_fix", title: secret, body: secret });
    await jobsRepository.log(job.id, "proposal:verified", `${item.id}: passed`);
    await jobsRepository.log(job.id, "inbox:reject", item.id);
    const current = (await jobsRepository.get(job.id))!;
    await recordAgentMetric(current, "decision", { itemId: item.id, decision: "approve", actor: "agent" });
    const records = (await fs.readFile(jobMetricsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.jobId === job.id);
    assert.deepEqual(records.map((event) => event.event), ["created", "started", "classified", "item_created", "verified", "decision", "decision"]);
    assert.equal(records[2].classification, "test_drift");
    assert.equal(records[4].verificationStatus, "passed");
    assert.equal(records[5].actor, "human");
    assert.equal(records[6].actor, "agent");
    assert.equal(records[6].tokensUsed, 123);
    assert.doesNotMatch(JSON.stringify(records), new RegExp(secret));
    const csv = execFileSync(process.execPath, ["scripts/export-metrics.mjs", jobMetricsPath, "--agent"], { encoding: "utf8" });
    assert.match(csv, /classification,tokensUsed,actionsUsed,elapsedMs/);
    assert.match(csv, new RegExp(`${item.id},,reject,human`));
    assert.doesNotMatch(csv, new RegExp(secret));
});

describe("existing checks baseline", () => {
    test("first observation seeds 80 existing Specs without automatic runs, and queues repairs for broken ones", async (t) => {
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { processProjectSteward } = await import("../../src/core/steward/engine");
        const { stopJobWorker } = await import("../../src/core/jobs/worker");
        await stopJobWorker();
        t.mock.method(globalThis, "fetch", async () => new Response('<script src="/stable-build.js"></script>'));
        for (const invalid of [false, true]) {
            const projectId = await createProject(`Imported checks ${invalid}`);
            const feature = await writer.createFeatureInRepo(projectId, null, "Imported", "");
            for (let i = 0; i < 80; i++) await specsRepository.createSpecRecord({ projectId, featureId: feature.id, title: `Imported check ${i + 1}`, description: "",
                path: `specs/imported/check-${i + 1}`, sourceHash: invalid ? "" : `source-${i}`, markdownHash: `behavior-${i}`,
                status: invalid ? "invalid" : "unverified", invalidReason: invalid ? "Missing spec.ts file in the spec directory" : null });
            await processProjectSteward(projectId);
            await processProjectSteward(projectId);
            assert.equal(Object.keys((await stewardRepository.get(projectId)).observation.specs ?? {}).length, 80);
            const signals = await stewardRepository.signals(projectId);
            const intents = await stewardRepository.intents(projectId);
            // Existing Specs are a baseline, never re-run; broken ones are things to repair, one repair per Spec version.
            assert.equal(signals.length, invalid ? 80 : 0);
            assert.ok(signals.every((signal) => signal.kind === "invalid_spec"));
            assert.equal(intents.length, invalid ? 80 : 0);
            assert.ok(intents.every((intent) => intent.intent.kind === "regenerate"));
            const jobs = await jobsRepository.list(projectId);
            assert.ok(jobs.every((job) => job.kind === "regenerate"), "no automatic runs");
            const inbox = await jobsRepository.inbox(projectId);
            assert.equal(inbox.length, 0);
        }
    });

});

describe("repository recovery", () => {
    test("reviews all edits and rejects an obsolete review before committing", async () => {
        const { createRepositoryRecoveryRoutes } = await import("../../src/infra/web/routes/repository-recovery");
        const recoveryApp = new Hono();
        recoveryApp.route("/", createRepositoryRecoveryRoutes());
        const projectId = await createProject("Pending edits");
        const feature = await writer.createFeatureInRepo(projectId, null, "Login", "");
        const { spec } = await createSpec(projectId, feature.id, "Sign in");
        const root = repoGit.getRepoDir(projectId);
        const target = path.join(root, spec.path, "spec.yml");
        const before = await fs.readFile(target, "utf8");
        const after = before.replace("title: Sign in", "title: Reviewed sign in");
        await fs.writeFile(target, after);
        await fs.writeFile(path.join(root, "notes.md"), "Keep these notes.\n");
        const head = await repoGit.getHeadSha(projectId);
        const endpoint = `/projects/${projectId}/repository/recovery`;
        const preview = await (await recoveryApp.request(endpoint)).json() as { dirty: boolean; canSave: boolean; fingerprint: string; files: { path: string; before: string | null; after: string }[] };
        assert.equal(preview.canSave, true);
        assert.equal(preview.files.length, 2);
        assert.equal(preview.files.find((file) => file.path.endsWith("spec.yml"))?.before, before);
        assert.equal(preview.files.find((file) => file.path.endsWith("spec.yml"))?.after, after);
        assert.equal(await repoGit.getHeadSha(projectId), head, "preview never commits behavior changes");
        await fs.writeFile(path.join(root, "notes.md"), "Keep these updated notes.\n");
        const save = (fingerprint: string) => recoveryApp.request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fingerprint }) });
        assert.equal((await save(preview.fingerprint)).status, 409);
        assert.equal(await repoGit.getHeadSha(projectId), head);
        const fresh = await (await recoveryApp.request(endpoint)).json() as typeof preview;
        assert.equal((await save(fresh.fingerprint)).status, 200);
        assert.notEqual(await repoGit.getHeadSha(projectId), head);
        assert.equal(await fs.readFile(target, "utf8"), after, "explicit review preserves the exact behavior edit");
        assert.equal((await specsRepository.getSpec(spec.id))?.title, "Reviewed sign in");
        assert.equal((await repoGit.getProjectGit(projectId).status()).isClean(), true);
        assert.equal((await save(fresh.fingerprint)).status, 409, "a consumed review cannot commit again");
    });

    test("does not expose symlink targets or change files while an update is in progress", async () => {
        const { repositoryRecoveryUnlocked, prepareRunRepositoryUnlocked } = await import("../../src/core/repo/recovery");
        const projectId = await createProject("Unsafe pending edit");
        const root = repoGit.getRepoDir(projectId);
        const outside = path.join(tempDir(), "recovery-outside.txt");
        await fs.writeFile(outside, "do not expose this file");
        await fs.symlink(outside, path.join(root, "pending.md"));
        const preview = await repoGit.withRepoLock(projectId, () => repositoryRecoveryUnlocked(projectId));
        assert.equal(preview.canSave, false);
        assert.deepEqual(preview.files, []);
        assert.doesNotMatch(JSON.stringify(preview), /do not expose|recovery-outside/);
        await fs.unlink(path.join(root, "pending.md"));
        await fs.writeFile(path.join(root, ".git", "index.lock"), "active operation");
        await assert.rejects(() => repoGit.withRepoLock(projectId, () => prepareRunRepositoryUnlocked(projectId)), /files are being updated/);
        assert.equal(await fs.readFile(path.join(root, ".git", "index.lock"), "utf8"), "active operation");
    });
});

describe("encrypted credentials and operations", () => {
    test("migrates old credentials, rotates every stored secret and restores an independent backup", { timeout: 60_000 }, async () => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        const root = tempDir("specbook-operations-");
        const original = path.join(root, "original");
        const restored = path.join(root, "restored");
        const archive = path.join(root, "backup.tar.gz");
        const keyFile = path.join(root, "external.key");
        const env = { ...process.env, SPECBOOK_STORAGE_DIR: original, SPECBOOK_ENCRYPTION_KEY: "", SPECBOOK_ENCRYPTION_KEY_FILE: "" };
        const script = `
            import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import crypto from 'node:crypto';
            const {runMigrations}=await import('./src/infra/db/migrate.ts'); await runMigrations();
            const {createProject}=await import('./src/core/projects.ts'); const p=await createProject('Backup check','https://example.com');
            const old=crypto.randomBytes(32); await fs.writeFile(process.env.SPECBOOK_STORAGE_DIR+'/credentials.key',old);
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
            await assert.rejects(fs.access(process.env.SPECBOOK_STORAGE_DIR+'/credentials.key'));
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
        await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...env, OPS_TEST_KEY: keyFile } });
        const keyedEnv = { ...env, SPECBOOK_ENCRYPTION_KEY_FILE: keyFile };
        const cli = ["--import", "tsx", "src/operations-cli.ts"];
        await exec(process.execPath, [...cli, "backup", archive], { env: keyedEnv });
        assert.equal((await fs.stat(archive)).mode & 0o777, 0o600);
        await exec(process.execPath, [...cli, "restore", archive, "--storage", restored], { env: keyedEnv });
        assert.ok(existsSync(path.join(restored, "specbook.db")));
        assert.equal(await fs.readFile(path.join(restored, "pi-auth.json"), "utf8"), await fs.readFile(path.join(original, "pi-auth.json"), "utf8"));
        assert.deepEqual(await fs.readdir(path.join(restored, "repos")), await fs.readdir(path.join(original, "repos")));
        await assert.rejects(exec(process.execPath, [...cli, "restore", archive, "--storage", restored], { env: keyedEnv }), /empty storage directory/);
        const wrong = path.join(root, "wrong-key");
        await fs.writeFile(wrong, crypto.randomBytes(32));
        const rejected = path.join(root, "rejected");
        await assert.rejects(exec(process.execPath, [...cli, "restore", archive, "--storage", rejected], { env: { ...env, SPECBOOK_ENCRYPTION_KEY_FILE: wrong } }), /matching encryption key/);
        assert.deepEqual((await fs.readdir(rejected)).filter((name) => name !== ".operations.lock"), []);
    });

    test("retention keeps current runs and pending evidence while pruning expired data", async () => {
        const { db } = await import("../../src/infra/db/client");
        const { runs } = await import("../../src/infra/db/schema");
        const { eq } = await import("drizzle-orm");
        const { settingsRepository } = await import("../../src/infra/repositories/settings");
        const { cleanupRetention } = await import("../../src/core/operations/retention");
        const { storageRoot, runsDir } = await import("../../src/core/paths");
        const projectId = await createProject("Retention");
        const feature = await writer.createFeatureInRepo(projectId, null, "Retention", "");
        const { spec } = await createSpec(projectId, feature.id, "Retained evidence");
        const old = new Date(Date.now() - 200 * 86_400_000);
        const ids: string[] = [];
        for (let index = 0; index < 4; index++) {
            const run = await runsRepository.createRun({ specId: spec.id, sourceHash: spec.sourceHash!, commitSha: "sha" });
            await runsRepository.finishRun(run.id, "passed", 1, null);
            await db.update(runs).set({ startedAt: new Date(old.getTime() + index * 1000).toISOString() }).where(eq(runs.id, run.id));
            await fs.mkdir(path.join(runsDir, run.id), { recursive: true });
            await fs.writeFile(path.join(runsDir, run.id, "evidence.txt"), "retained only when needed");
            ids.push(run.id);
        }
        const batchId = crypto.randomUUID();
        const batchDirectory = path.join(runsDir, "batches", batchId);
        await fs.mkdir(batchDirectory, { recursive: true });
        await fs.writeFile(path.join(batchDirectory, "batch.json"), JSON.stringify({ id: batchId, projectId, label: "Retained batch", status: "passed", startedAt: old.toISOString(), durationMs: 2, failReason: null,
            specs: ids.slice(2).map((runId) => ({ runId, specId: spec.id, status: "passed", title: spec.title, sourceHash: spec.sourceHash, markdownHash: spec.markdownHash, commitSha: "sha", durationMs: 1, failReason: null })) }));
        await db.update(runs).set({ automationPending: true }).where(eq(runs.id, ids[0]));
        const metrics = path.join(storageRoot, "metrics", "chat-turns.jsonl");
        await fs.mkdir(path.dirname(metrics), { recursive: true });
        await fs.writeFile(metrics, `${JSON.stringify({ startedAt: old.toISOString() })}\n${JSON.stringify({ startedAt: new Date().toISOString() })}\n`);
        await settingsRepository.updateRetention({ runsPerSpec: 1, runDays: 30, videoDays: 7, batchDays: 30, metricDays: 90, browserProfileDays: 30 });
        const result = await cleanupRetention();
        assert.ok(result.removedRuns >= 1);
        assert.ok(await runsRepository.getRun(ids[0]), "pending failure evidence survives");
        assert.equal(await runsRepository.getRun(ids[1]), null);
        assert.ok(await runsRepository.getRun(ids[2]), "a retained batch keeps all attempts needed to report its CI status");
        assert.ok(await runsRepository.getRun(ids[3]), "last run survives regardless of age");
        assert.equal((await fs.readFile(metrics, "utf8")).trim().split("\n").length, 1);
        assert.ok(result.removedMetrics >= 1);
        await settingsRepository.updateRetention({ runsPerSpec: 20, runDays: 30, videoDays: 7, batchDays: 30, metricDays: 90, browserProfileDays: 30 });
    });
});

describe("accounts, roles and session security", () => {
    let secured: Hono;
    let adminCookie = "";
    let admin: { id: string; name: string; email: string; role: string };
    const password = "Specbook-test-password-42";
    const cookieOf = (response: Response, name = "specbook_session") => response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0] ?? "";
    const call = (method: string, url: string, body?: unknown, cookie = adminCookie, extra: Record<string, string> = {}) => secured.request(`http://localhost:4000${url}`, {
        method, headers: { host: "localhost:4000", "X-Specbook-Request": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    before(async () => { secured = (await import("../../src/infra/web/app")).createApp(); });

    test("bootstrap is exclusive, credentials are hashed and sessions carry secure cookie attributes", async () => {
        const { accountsRepository } = await import("../../src/infra/repositories/accounts");
        assert.deepEqual(await (await call("GET", "/setup/status", undefined, "")).json(), { needsAdmin: true, authenticated: false });
        const responses = await Promise.all(["first", "second"].map((name) => call("POST", "/setup/admin", { name, email: `${name}@example.com`, password }, "")));
        assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
        const response = responses.find((result) => result.status === 201)!;
        admin = (await response.json()).user;
        adminCookie = cookieOf(response);
        assert.ok(adminCookie);
        assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
        assert.match(response.headers.get("set-cookie")!, /SameSite=Lax/i);
        assert.equal((await accountsRepository.listUsers()).length, 1);
        const stored = (await accountsRepository.getUser(admin.id))!;
        assert.match(stored.passwordHash!, /^scrypt-v1:/);
        assert.notEqual(stored.passwordHash, password);
        assert.equal((await call("GET", "/auth/me")).status, 200);
        assert.equal((await call("POST", "/setup/admin", { name: "Third", email: "third@example.com", password }, "")).status, 409);
        assert.equal((await call("POST", "/auth/login", { email: admin.email, password: "wrong" }, "")).status, 401);
        const status = await (await call("GET", "/setup/status", undefined, "")).json();
        assert.deepEqual(status, { needsAdmin: false, authenticated: false });
    });

    test("invitations are one-use, viewers cannot mutate, editors cannot administer, and bearer clients keep working", async () => {
        const invite = async (role: string) => {
            const response = await call("POST", "/settings/invitations", { email: `${role}@example.com`, role });
            assert.equal(response.status, 201, await response.clone().text());
            const result = await response.json();
            assert.ok(new URL(result.inviteUrl).hash.startsWith("#token="));
            const token = new URLSearchParams(new URL(result.inviteUrl).hash.slice(1)).get("token")!;
            const accepted = await call("POST", "/auth/invitations/accept", { token, name: role, password }, "");
            assert.equal(accepted.status, 201, await accepted.clone().text());
            assert.equal((await call("POST", "/auth/invitations/inspect", { token }, "")).status, 410);
            assert.equal((await call("POST", "/auth/invitations/accept", { token, name: role, password }, "")).status, 410);
            return { user: (await accepted.json()).user, cookie: cookieOf(accepted) };
        };
        const viewer = await invite("viewer");
        const editor = await invite("editor");
        assert.equal((await call("GET", "/projects", undefined, viewer.cookie)).status, 200);
        assert.equal((await call("POST", "/projects", { name: "Forbidden", baseUrl: "https://example.com" }, viewer.cookie)).status, 403);
        assert.equal((await call("GET", "/settings/members", undefined, viewer.cookie)).status, 403);
        assert.equal((await call("GET", "/settings/llm", undefined, editor.cookie)).status, 403);
        assert.equal((await call("GET", "/settings/llm/status", undefined, editor.cookie)).status, 200);
        const created = await call("POST", "/projects", { name: "Attributed edits", baseUrl: "https://example.com" }, editor.cookie);
        assert.equal(created.status, 200, await created.clone().text());
        const project = (await created.json()).project;
        const featureResponse = await call("POST", `/projects/${project.id}/features`, { title: "Authored feature", description: "" }, editor.cookie);
        assert.equal(featureResponse.status, 200, await featureResponse.clone().text());
        const author = await repoGit.getProjectGit(project.id).raw(["log", "-1", "--format=%an <%ae>"]);
        assert.equal(author.trim(), "editor <editor@example.com>");
        const gitToken = (await (await call("POST", `/projects/${project.id}/git/remote/token`)).json()).token;
        const git = await call("GET", `/git/${project.id}.git/info/refs?service=git-upload-pack`, undefined, "", { authorization: `Basic ${Buffer.from(`git:${gitToken}`).toString("base64")}` });
        assert.equal(git.status, 200, await git.clone().text());
        const ciToken = (await (await call("POST", `/projects/${project.id}/ci/token`)).json()).token;
        assert.equal((await call("GET", `/ci/projects/${project.id}/client.mjs`, undefined, "", { authorization: `Bearer ${ciToken}` })).status, 200);
        assert.equal((await call("GET", `/ci/projects/${project.id}/client.mjs`, undefined, "")).status, 401);
        const audit = await (await call("GET", "/settings/audit?limit=100")).json();
        assert.ok(audit.events.some((event: { actorId: string; action: string }) => event.actorId === editor.user.id && event.action === "repository.commit"));
        assert.doesNotMatch(JSON.stringify(audit), new RegExp(password));
        assert.doesNotMatch(JSON.stringify(audit), new RegExp(ciToken));
        assert.equal((await call("PATCH", `/settings/members/${viewer.user.id}`, { disabled: true })).status, 200);
        assert.equal((await call("GET", "/projects", undefined, viewer.cookie)).status, 401);
    });

    test("last usable administrator is protected and session revocation closes active streams", async () => {
        const { accountsRepository } = await import("../../src/infra/repositories/accounts");
        const { watchSession } = await import("../../src/core/accounts/sessions");
        await accountsRepository.createSsoUser("unlinked-admin@example.com", "No active SSO", "admin", "https://inactive.example", "subject");
        assert.equal((await call("PATCH", `/settings/members/${admin.id}`, { role: "viewer" })).status, 409);
        assert.equal((await call("PATCH", `/settings/members/${admin.id}`, { disabled: true })).status, 409);
        const signedIn = await call("POST", "/auth/login", { email: admin.email, password }, "");
        assert.equal(signedIn.status, 200);
        const cookie = cookieOf(signedIn);
        const projectId = await createProject("Authenticated stream");
        const chat = (await (await call("POST", `/projects/${projectId}/chats`, undefined, cookie)).json()).chat;
        const stream = await call("GET", `/chats/${chat.id}/events`, undefined, cookie);
        const reader = stream.body!.getReader();
        assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/);
        let closed = false;
        const stop = await watchSession(new Headers({ cookie }), () => { closed = true; });
        try {
            assert.equal(closed, false);
            assert.equal((await call("POST", "/auth/logout", undefined, cookie)).status, 200);
            assert.equal(closed, true);
            assert.equal((await reader.read()).done, true, "logout closes the live SSE response");
            assert.equal((await call("GET", "/auth/me", undefined, cookie)).status, 401);
        } finally { stop(); await reader.cancel(); }
    });

    test("OIDC validates signatures, PKCE, nonce, browser binding and explicit account linking", async (t) => {
        const { accountsRepository } = await import("../../src/infra/repositories/accounts");
        const { verifiedEmail } = await import("../../src/core/accounts/oidc");
        const issuer = "https://identity.example.com";
        const config = { enabled: true, issuer, clientId: "specbook", clientSecret: "test-oidc-secret", defaultRole: "viewer", allowedEmailDomains: ["example.com"], passwordLoginEnabled: true };
        const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
        const wrongKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
        const jwt = (claims: object, invalid = false) => {
            const encoded = [JSON.stringify({ alg: "RS256", kid: "test-key" }), JSON.stringify(claims)].map((value) => Buffer.from(value).toString("base64url")).join(".");
            return `${encoded}.${crypto.sign("RSA-SHA256", Buffer.from(encoded), invalid ? wrongKeys.privateKey : keys.privateKey).toString("base64url")}`;
        };
        let authorization: URL;
        let overrides: Record<string, unknown> = {};
        let invalidSignature = false;
        let exchanges = 0;
        const originalFetch = globalThis.fetch;
        t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : input.toString());
            if (url.origin !== issuer) return originalFetch(input, options);
            if (url.pathname === "/.well-known/openid-configuration") return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"] });
            if (url.pathname === "/jwks") return Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), alg: "RS256", kid: "test-key", use: "sig" }] });
            if (url.pathname === "/token") {
                exchanges++;
                const body = new URLSearchParams(options?.body?.toString());
                assert.equal(body.get("client_secret"), config.clientSecret);
                assert.equal(crypto.createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), authorization.searchParams.get("code_challenge"));
                const now = Math.floor(Date.now() / 1000);
                return Response.json({ token_type: "Bearer", access_token: "fake-access-token", expires_in: 300, id_token: jwt({ iss: issuer, sub: "local-admin", aud: "specbook", iat: now, exp: now + 300, nonce: authorization.searchParams.get("nonce"), email: admin.email, email_verified: true, ...overrides }, invalidSignature) });
            }
            throw new Error(`Unexpected identity request: ${url}`);
        });
        const begin = async (link = false, cookie = adminCookie) => {
            const response = await call("POST", "/auth/oidc/start", { link }, cookie);
            assert.equal(response.status, 200, await response.clone().text());
            authorization = new URL((await response.json()).url);
            assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
            return { path: `/auth/oidc/callback?code=authorization-code&state=${authorization.searchParams.get("state")}`, cookie: [cookie, cookieOf(response, "specbook_oidc")].filter(Boolean).join("; ") };
        };
        const callback = (pending: { path: string; cookie: string }) => call("GET", pending.path, undefined, pending.cookie);
        const failed = async (pending: { path: string; cookie: string }) => {
            const response = await callback(pending);
            assert.match(response.headers.get("location")!, /\/login\?error=sso_failed$/);
            assert.equal(cookieOf(response), "");
        };
        assert.equal((await call("PUT", "/settings/sso", config)).status, 200);
        try {
            const bound = await begin();
            await failed({ ...bound, cookie: adminCookie });
            assert.equal(exchanges, 0, "a different browser cannot exchange the code");
            await failed(bound);
            assert.equal(await accountsRepository.identity(issuer, "local-admin"), null, "matching emails never link accounts automatically");
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
            const linked = await callback(await begin(true));
            assert.equal(linked.headers.get("location"), "http://localhost:4000/settings");
            adminCookie = cookieOf(linked);
            assert.ok(adminCookie);
            assert.equal((await (await call("GET", "/settings/sso")).json()).linked, true);
            const hidden = await (await call("GET", "/settings/sso")).text();
            assert.doesNotMatch(hidden, /test-oidc-secret|verifiedUsers/);
            const invitation = await (await call("POST", "/settings/invitations", { email: "pending@example.com", role: "viewer" })).json();
            const token = new URLSearchParams(new URL(invitation.inviteUrl).hash.slice(1)).get("token")!;
            const { clientSecret: _secret, ...unchanged } = config;
            assert.equal((await call("PUT", "/settings/sso", { ...unchanged, passwordLoginEnabled: false })).status, 200);
            assert.equal((await call("POST", "/auth/login", { email: admin.email, password }, "")).status, 403);
            assert.equal((await call("POST", "/auth/invitations/accept", { token, name: "Pending", password }, "")).status, 403);
            assert.equal((await call("PUT", "/settings/sso", { ...config, clientSecret: "changed", passwordLoginEnabled: false })).status, 409, "changed provider credentials need a new successful link before disabling local login");
            overrides = { sub: "new-member", email: "sso-member@example.com", name: "New member" };
            const created = await callback(await begin(false, ""));
            assert.equal(created.headers.get("location"), "http://localhost:4000/");
            assert.equal((await (await call("GET", "/auth/me", undefined, cookieOf(created))).json()).user.role, "viewer");
            assert.equal((await call("PATCH", `/settings/members/${admin.id}`, { disabled: true })).status, 409);
            const { db } = await import("../../src/infra/db/client");
            const { users } = await import("../../src/infra/db/schema");
            const { eq } = await import("drizzle-orm");
            const localHash = (await accountsRepository.getUser(admin.id))!.passwordHash;
            await db.update(users).set({ passwordHash: null }).where(eq(users.id, admin.id));
            try {
                assert.equal((await call("PUT", "/settings/sso", { ...config, clientId: "another-client", passwordLoginEnabled: true })).status, 409, "enabling passwords cannot protect a provider change when no administrator has a local password");
            } finally { await db.update(users).set({ passwordHash: localHash }).where(eq(users.id, admin.id)); }
            assert.equal(verifiedEmail("https://login.microsoftonline.com/12345678-1234-1234-1234-123456789abc/v2.0", { email: "verified@example.com", xms_edov: true }), "verified@example.com");
            assert.equal(verifiedEmail("https://login.microsoftonline.com/common/v2.0", { email: "verified@example.com", xms_edov: true }), null);
            assert.equal(verifiedEmail(issuer, { email: "verified@example.com", xms_edov: true }), null);
        } finally {
            const { clientSecret: _secret, ...unchanged } = config;
            assert.equal((await call("PUT", "/settings/sso", { ...unchanged, enabled: false, passwordLoginEnabled: true })).status, 200);
        }
    });
});

describe("selected batch suggestions", () => {
    test("unfinished selected Specs retry before asking a resumable question while a failed first run finishes generation", { timeout: 30_000 }, async (t) => {
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { proposeSpecBatch, selectSpecBatch, presentSpecBatch } = await import("../../src/core/jobs/spec-batches");
        const { startJobWorker, stopJobWorker } = await import("../../src/core/jobs/worker");
        const { retryStalledJob, MAX_SAFETY_RETRIES } = await import("../../src/core/jobs/retry");
        const { createChat, openSession, flushSessionFile } = await import("../../src/core/chat/session-store");
        const { tryReserveChatTurn, releaseChatTurn } = await import("../../src/core/chat/chat-registry");
        const read = jobsRepository.get.bind(jobsRepository);
        const log = jobsRepository.log.bind(jobsRepository);
        let targetId = "";
        let notifyStopped: () => void = () => undefined;
        t.mock.method(jobsRepository, "queued", async () => {
            const row = await read(targetId);
            return row?.status === "queued" ? [row] : [];
        });
        t.mock.method(jobsRepository, "log", async (id: string, action: string, detail = "") => {
            await log(id, action, detail);
            if (id === targetId && action === "stopped") notifyStopped();
        });
        await stopJobWorker();
        for (const outcome of ["missing_spec", "missing_run", "failed"] as const) {
            const projectId = await createProject(`Selected Spec ${outcome}`);
            await stewardRepository.update(projectId, { paused: true });
            const feature = await writer.createFeatureInRepo(projectId, null, "Authentication", "");
            const chat = await createChat(projectId);
            const item = await proposeSpecBatch(projectId, chat.id, { candidates: [{ title: "Sign-in form", goal: "Show the sign-in form.", feature: feature.title, featureId: feature.id, why: "Every user starts here." }] });
            const initial = await presentSpecBatch(item);
            const selected = await selectSpecBatch(item, [initial.candidates[0]!.id]);
            const candidate = (selected.payload.specBatch as { candidates: { jobId: string; specId: string }[] }).candidates[0]!;
            targetId = candidate.jobId;
            const job = (await read(targetId))!;
            if (outcome !== "missing_spec") {
                const { spec } = await writer.createSpecInRepo({ projectId, id: candidate.specId, featureId: feature.id,
                    title: "Sign-in form", description: "", humanSpec: HUMAN_SPEC, testSource: VALID_SPEC });
                if (outcome === "failed") {
                    const run = await runsRepository.createRun({ specId: spec.id, commitSha: await repoGit.getHeadSha(projectId), sourceHash: spec.sourceHash, automate: false });
                    await runsRepository.finishRun(run.id, "failed", 10, "The expected sign-in form was not visible.");
                }
            }
            const session = (await openSession(job.chatId))!;
            session.appendCustomMessageEntry("result", "The selected Spec is ready.", true);
            flushSessionFile(session);
            // Hold the saved response's chat reservation to exercise completion without a provider call.
            assert.equal(tryReserveChatTurn(job.chatId), true);
            const executeAttempt = async () => {
                const stopped = new Promise<void>((resolve) => { notifyStopped = resolve; });
                await startJobWorker();
                await stopped;
                await stopJobWorker();
            };
            try {
                await stewardRepository.update(projectId, { paused: false });
                await jobsRepository.transition(job.id, "paused", "queued");
                await executeAttempt();
                assert.equal((await jobsRepository.inbox(projectId)).some((entry) => entry.jobId === job.id && entry.kind === "note"), false);
                if (outcome === "failed") {
                    assert.equal((await read(job.id))?.status, "completed");
                    assert.equal((await presentSpecBatch((await jobsRepository.item(item.id))!)).candidates[0]!.state, "failed");
                    assert.equal((await jobsRepository.inbox(projectId)).filter((entry) => entry.jobId === job.id && entry.kind === "question").length, 0);
                } else {
                    for (let attempt = 0; attempt < MAX_SAFETY_RETRIES; attempt++) {
                        const stalled = (await read(job.id))!;
                        assert.equal(stalled.status, "stalled");
                        assert.ok(stalled.retryAt && Date.parse(stalled.retryAt) > Date.now());
                        assert.equal((await presentSpecBatch((await jobsRepository.item(item.id))!)).candidates[0]!.state, "queued");
                        assert.equal((await jobsRepository.inbox(projectId)).filter((entry) => entry.jobId === job.id && entry.kind === "question").length, 0, "an unfinished model response must retry before asking the human");
                        await retryStalledJob(stalled);
                        assert.equal((await read(job.id))?.status, "stalled", "backoff is respected");
                        await jobsRepository.update(job.id, { retryAt: new Date(Date.now() - 1000).toISOString() });
                        await retryStalledJob((await read(job.id))!);
                        assert.equal((await read(job.id))?.status, "queued");
                        assert.equal((await read(job.id))?.safetyRetries, attempt + 1);
                        await executeAttempt();
                    }
                    const exhausted = (await read(job.id))!;
                    assert.equal(exhausted.status, "stalled");
                    assert.equal(exhausted.retryAt, null);
                    await retryStalledJob(exhausted);
                    const progress = await presentSpecBatch((await jobsRepository.item(item.id))!);
                    const questions = (await jobsRepository.inbox(projectId)).filter((entry) => entry.jobId === job.id && entry.kind === "question");
                    assert.equal((await read(job.id))?.status, "blocked");
                    assert.equal(progress.candidates[0]!.state, "needs_answer");
                    assert.equal(questions.length, 1);
                    const question = questions[0]!;
                    assert.match(question.title, /Sign-in form/);
                    assert.match(question.body, outcome === "missing_spec" ? /has not been saved/ : /first result is missing/);
                    assert.doesNotMatch(question.body, /missing access|credentials/i, "a model ending early does not prove an access problem");
                    assert.equal(question.payload.sourceItemId, item.id);
                    assert.ok(await jobsRepository.claimItem(question.id));
                    await jobsRepository.answer(question, "Open the homepage and inspect the sign-in form.");
                    assert.equal((await read(job.id))?.status, "queued");
                    assert.match((await read(job.id))!.pendingMessage, /Open the homepage/);
                    assert.equal((await jobsRepository.item(question.id))?.status, "answered");
                }
            } finally {
                await stopJobWorker();
                releaseChatTurn(job.chatId);
            }
        }
    });

    test("requires discovery confirmation, validates selection and resumes only selected checks after restart", async () => {
        const { chatsRepository } = await import("../../src/infra/repositories/chats");
        const { listChats } = await import("../../src/core/chat/session-store");
        const { projectContextsRepository } = await import("../../src/infra/repositories/project-contexts");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { proposeSpecBatch, selectSpecBatch, presentSpecBatch, recoverSpecBatches } = await import("../../src/core/jobs/spec-batches");
        const projectId = await createProject("Selected checks");
        await stewardRepository.update(projectId, { paused: true });
        const revision = await projectContextsRepository.createProjectContextDraft(projectId, { startUrl: "https://app.example.com", goal: "Find useful checks", safetyNotes: [] });
        const chatId = crypto.randomUUID();
        await chatsRepository.insertChat(chatId, projectId, { contextRevisionId: revision.id });
        assert.deepEqual((await listChats(projectId)).map((chat) => chat.id), [chatId]);
        const input = { candidates: [
            { title: "Sign-in form", goal: "Show the username and password fields.", feature: "Authentication", why: "Users need an entry point." },
            { title: "Catalog", goal: "Display the product catalog.", feature: "Catalog", why: "Users need to find a product." },
        ] };
        const item = await proposeSpecBatch(projectId, chatId, input, { contextRevisionId: revision.id });
        assert.deepEqual((await listChats(projectId)).map((chat) => chat.id), [chatId], "a discovery conversation stays visible while its internal review stays hidden");
        assert.equal((await proposeSpecBatch(projectId, chatId, input, { contextRevisionId: revision.id })).id, item.id);
        const view = await presentSpecBatch(item);
        assert.equal(view.contextReviewRequired, true);
        await assert.rejects(() => selectSpecBatch(item, [view.candidates[0]!.id]), /confirm the discovery context/);
        await projectContextsRepository.confirmProjectContextRevision(revision.id);
        await assert.rejects(() => selectSpecBatch(item, [crypto.randomUUID()]), /Choose at least one/);
        await assert.rejects(() => selectSpecBatch(item, [view.candidates[0]!.id, view.candidates[0]!.id]), /without duplicates/);
        const selected = await selectSpecBatch(item, [view.candidates[0]!.id]);
        const progress = await presentSpecBatch(selected);
        assert.equal(progress.contextReviewRequired, false);
        assert.equal(progress.candidates[0]!.selected, true);
        assert.equal(progress.candidates[0]!.state, "queued");
        assert.equal(progress.candidates[1]!.selected, undefined);
        assert.equal(progress.candidates[1]!.jobId, undefined);
        const child = await jobsRepository.get(progress.candidates[0]!.jobId!);
        assert.equal(child?.kind, "generate_spec");
        assert.equal(child?.status, "paused");
        assert.equal((await specsRepository.listSpecs(projectId)).length, 0);
        const chatCount = (await chatsRepository.listChatRows(projectId)).length;
        await selectSpecBatch(item, [view.candidates[0]!.id]);
        await recoverSpecBatches();
        assert.deepEqual((await listChats(projectId)).map((chat) => chat.id), [chatId], "selected generation and restart recovery do not expose internal chats");
        assert.equal((await chatsRepository.listChatRows(projectId)).length, chatCount);
        assert.equal((await jobsRepository.list(projectId)).filter((job) => job.kind === "generate_spec").length, 1);
        await assert.rejects(() => selectSpecBatch(item, [view.candidates[1]!.id]), /already been selected/);
    });

    test("rejects cross-project suggestions and generation outside the selected title and feature", async () => {
        const { chatsRepository } = await import("../../src/infra/repositories/chats");
        const { listChats } = await import("../../src/core/chat/session-store");
        const { stewardRepository } = await import("../../src/infra/repositories/steward");
        const { jobsRepository } = await import("../../src/infra/repositories/jobs");
        const { proposeSpecBatch, selectSpecBatch, presentSpecBatch, selectedSpecInstructions, createSelectedSpec, selectedSpecResult } = await import("../../src/core/jobs/spec-batches");
        const projectId = await createProject("Generated Spec");
        const otherId = await createProject("Other suggestions");
        await stewardRepository.update(projectId, { paused: true });
        const feature = await writer.createFeatureInRepo(projectId, null, "Authentication", "");
        const otherFeature = await writer.createFeatureInRepo(otherId, null, "Other", "");
        const chatId = crypto.randomUUID();
        await chatsRepository.insertChat(chatId, projectId);
        assert.deepEqual((await listChats(projectId)).map((chat) => chat.id), [chatId]);
        const candidate = { title: "Sign-in form", goal: "Show the sign-in form.", feature: feature.title, featureId: feature.id, why: "Every user starts here." };
        await assert.rejects(() => proposeSpecBatch(otherId, chatId, { candidates: [candidate] }), /conversation belongs/);
        await assert.rejects(() => proposeSpecBatch(projectId, chatId, { candidates: [{ ...candidate, featureId: otherFeature.id }] }), /another project/);
        const item = await proposeSpecBatch(projectId, chatId, { candidates: [candidate] });
        assert.notEqual((await jobsRepository.get(item.jobId))!.chatId, chatId);
        assert.deepEqual((await listChats(projectId)).map((chat) => chat.id), [chatId], "human conversations remain in chat history after proposing a batch");
        const initial = await presentSpecBatch(item);
        const selected = await selectSpecBatch(item, [initial.candidates[0]!.id]);
        const choice = (await presentSpecBatch(selected)).candidates[0]!;
        const specId = (selected.payload.specBatch as { candidates: { specId: string }[] }).candidates[0]!.specId;
        const job = (await jobsRepository.get(choice.jobId!))!;
        await selectedSpecInstructions(job);
        const input = { featureId: feature.id, title: candidate.title, description: candidate.goal, humanSpec: HUMAN_SPEC, testSource: VALID_SPEC };
        await assert.rejects(() => createSelectedSpec(job, { ...input, title: "Unexpected check" }), /only the selected Spec/);
        await assert.rejects(() => createSelectedSpec(job, { ...input, featureId: otherFeature.id }), /only the selected Spec/);
        await assert.rejects(() => createSelectedSpec(job, { ...input, testSource: "process.exit(0)" }), /Import|test|allowed|top-level/);
        assert.equal((await specsRepository.listSpecs(projectId)).length, 0);
        const { spec } = await writer.createSpecInRepo({ ...input, projectId, id: specId });
        const run = await runsRepository.createRun({ specId: spec.id, commitSha: await repoGit.getHeadSha(projectId), sourceHash: spec.sourceHash, baseUrl: "https://app.example.com", automate: false });
        await runsRepository.finishRun(run.id, "passed", 12, null);
        const count = await commitCount(projectId);
        const result = await createSelectedSpec(job, input);
        assert.equal(result.specId, spec.id);
        assert.equal(result.runId, run.id);
        assert.equal(result.status, "passed");
        assert.equal((await selectedSpecResult(job)).runId, run.id);
        await createSelectedSpec(job, input);
        assert.equal(await commitCount(projectId), count);
        assert.equal((await runsRepository.listRuns(spec.id)).length, 1);
        assert.equal((await presentSpecBatch((await jobsRepository.item(item.id))!)).candidates[0]!.state, "passed");
    });
});
