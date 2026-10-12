import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { useTempStorage } from "../helpers/storage";

const storage = useTempStorage();
const { createApp } = await import("../../src/infra/web/app");
const { accessGate, routePolicy } = await import("../../src/infra/web/access");
const { createCliRouter } = await import("../../src/infra/web/routes/cli");

test("CLI downloads are public and read-only, with actionable missing-package errors", async () => {
    const file = path.join(storage, "specbook.tgz");
    const app = new Hono().use("*", accessGate()).route("/", createCliRouter(file));
    const missing = await app.request("/cli/specbook.tgz");
    assert.equal(missing.status, 404);
    const { error } = await missing.json();
    assert.match(error, /CLI package is not built/);
    assert.match(error, /pnpm --dir apps\/cli pack --out \.\.\/backend\/dist\/specbook.tgz/);

    const archive = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
    await fs.writeFile(file, archive);
    const download = await app.request("/cli/specbook.tgz");
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("Content-Type"), "application/gzip");
    assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="specbook.tgz"');
    assert.equal(download.headers.get("Cache-Control"), "no-cache");
    assert.equal(download.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), archive);
    assert.notEqual((await app.request("/cli/specbook.tgz", { method: "POST", body: "replacement" })).status, 200);
    assert.deepEqual(await fs.readFile(file), archive);
});

test("every endpoint declares access and protected routes deny anonymous requests before their handlers", async () => {
    const app = createApp();
    const groups = new Map<string, typeof app.routes>();
    for (const route of app.routes) {
        const key = `${route.method} ${route.path}`;
        groups.set(key, [...(groups.get(key) ?? []), route]);
    }
    const middleware = new Set(["ALL *", "ALL /*", "ALL /projects/:id/jobs/*"]);
    let checked = 0;
    for (const [key, routes] of groups) {
        if (middleware.has(key)) continue;
        const policies = routes.map((route) => routePolicy(route.handler)).filter(Boolean);
        assert.equal(policies.length, 1, `${key} must declare exactly one access policy`);
        checked++;
        if (["public", "git-token", "ci-token"].includes(policies[0]!)) continue;
        const route = routes[0];
        const pathname = route.path.replace(/:\w+(?:\{[^}]+\})?/g, "00000000-0000-4000-8000-000000000000").replace(/\*/g, "file");
        const response = await app.request(`http://localhost:4000${pathname}`, { method: route.method, headers: { host: "localhost:4000", "X-Specbook-Request": "1" } });
        assert.equal(response.status, 401, `${key} leaked through the authorization gate`);
    }
    assert.ok(checked >= 100);
    const incomplete = createApp();
    incomplete.get("/forgotten-policy", (c) => c.json({ leaked: true }));
    assert.equal((await incomplete.request("http://localhost:4000/forgotten-policy", { headers: { host: "localhost:4000" } })).status, 401);
});
