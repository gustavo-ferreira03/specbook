import { access } from "../access";
import { Hono } from "hono";
import { createProfile } from "../../../core/credentials/profiles";
import { deleteProjectData } from "../../../core/deletion";
import { configuredModel } from "../../../core/llm/runtime";
import { createProject, publicProject } from "../../../core/projects";
import { systemStatus } from "../../../core/system-status";
import { projectsRepository } from "../../repositories/projects";
import { accountsRepository } from "../../repositories/accounts";

export function createSetupRouter(): Hono {
    const router = new Hono();

    router.get("/ready", access("public"), async (c) => {
        const status = await systemStatus();
        return c.json(status, status.ok ? 200 : 503);
    });

    router.get("/setup/status", access("public"), async (c) => {
        const needsAdmin = !await accountsRepository.hasUsers();
        if (!c.get("user")) return c.json({ needsAdmin, authenticated: false });
        const [model, projects] = await Promise.all([configuredModel(), projectsRepository.listProjects()]);
        const needsProject = projects.length === 0;
        return c.json({ needsAdmin, authenticated: true, modelReady: model.ready, needsProject, completed: !needsAdmin && model.ready && !needsProject });
    });

    router.post("/setup/demo", access("admin"), async (c) => {
        const project = await createProject("Sauce Demo", "https://www.saucedemo.com");
        try {
            await createProfile(project.id, {
                name: "demo", allowedOrigins: ["https://www.saucedemo.com"],
                fields: [{ key: "username", value: "standard_user" }, { key: "password", value: "secret_sauce" }],
            });
        } catch (error) {
            await deleteProjectData(project.id);
            throw error;
        }
        return c.json({ project: publicProject(project) }, 201);
    });

    return router;
}
