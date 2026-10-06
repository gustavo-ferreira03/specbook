import assert from "node:assert/strict";
import { test } from "node:test";
import { useTempStorage } from "../helpers/storage";

useTempStorage();
const { createApp } = await import("../../src/infra/web/app");
const { routePolicy } = await import("../../src/infra/web/access");

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
