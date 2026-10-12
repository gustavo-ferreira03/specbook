import { specDetail } from "../../../core/specs/detail";
import { access } from "../access";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { humanSpecSchema } from "@specbook/runtime/human-spec";
import { deleteSpecData, ResourceBusyError } from "../../../core/deletion";
import { UnsafeRepoPathError } from "@specbook/runtime/safe-fs";
import { YamlParseError } from "@specbook/runtime/yaml";
import { editSpecFiles } from "../../../core/repo/manual";
import { publishSpecsInRepo, readProjectSpecFiles, SpecPublishValidationError, SpecRevisionConflict, updateSpecWithLock } from "../../../core/repo/writer";
import { resolveRunEnvironment } from "../../../core/environments";
import { projectsRepository } from "../../repositories/projects";
import { specsRepository } from "../../repositories/specs";
import { NetworkTargetError } from "@specbook/runtime/network/targets";

const editFilesSchema = z
    .object({
        yaml: z.string().optional(),
        testSource: z.string().optional(),
    })
    .refine((body) => body.yaml !== undefined || body.testSource !== undefined, {
        message: "Provide yaml and/or testSource content",
    });

const repoPathSchema = z.string().max(500).regex(/^specs\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/);
const publishSchema = z.object({
    environment: z.string().trim().min(1).max(80).optional(),
    specs: z.array(z.object({
        path: repoPathSchema,
        baseRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
        files: z.object({ "spec.yml": z.string().max(100_000), "spec.ts": z.string().max(100_000) }).strict(),
        feature: z.object({ path: repoPathSchema, source: z.string().max(100_000) }).strict(),
    }).strict()).min(1).max(100),
}).strict();


const updateSpecSchema = z
    .object({
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        humanSpec: humanSpecSchema.optional(),
    })
    .refine((body) => body.title !== undefined || body.description !== undefined || body.humanSpec !== undefined, {
        message: "Provide at least one of title, description, or humanSpec",
    });

function mapManualError(error: unknown): never {
    if (error instanceof HTTPException) throw error;
    if (


        error instanceof ResourceBusyError ||
        error instanceof UnsafeRepoPathError
    ) {
        throw new HTTPException(409, { message: error.message });
    }
    if (error instanceof YamlParseError) throw new HTTPException(400, { message: error.message });
    if (error instanceof Error && /unfinished rebase|uncommitted changes/.test(error.message)) {
        throw new HTTPException(409, { message: error.message });
    }
    throw error;
}


export function createSpecsRouter(): Hono {
    const router = new Hono();

    router.get("/projects/:id/specs/files", access("viewer"), async (c) => {
        const projectId = c.req.param("id");
        if (!await projectsRepository.getProject(projectId)) throw new HTTPException(404, { message: "Project not found" });
        return c.json(await readProjectSpecFiles(projectId));
    });

    router.post("/projects/:id/specs/publish", access("editor"), zValidator("json", publishSchema), async (c) => {
        const projectId = c.req.param("id");
        if (!await projectsRepository.getProject(projectId)) throw new HTTPException(404, { message: "Project not found" });
        const body = c.req.valid("json");
        try {
            const environment = await resolveRunEnvironment(projectId, body.environment);
            return c.json(await publishSpecsInRepo(projectId, environment.id, body.specs));
        } catch (error) {
            if (error instanceof SpecRevisionConflict) return c.json({ error: error.message, code: "revision_conflict", conflicts: error.conflicts, command: "specbook pull" }, 409);
            if (error instanceof ResourceBusyError || error instanceof UnsafeRepoPathError) throw new HTTPException(409, { message: error.message });
            if (error instanceof SpecPublishValidationError || error instanceof YamlParseError || error instanceof NetworkTargetError) throw new HTTPException(400, { message: error.message });
            if (error instanceof z.ZodError) throw new HTTPException(400, { message: "Provide valid Spec and Feature YAML before publishing." });
            throw error;
        }
    });

    router.get("/specs/:id", access("viewer"), async (c) => {
        const spec = await specsRepository.getSpec(c.req.param("id"));
        if (!spec) throw new HTTPException(404, { message: "Spec not found" });
        const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
        return c.json(await specDetail(spec, Number.isFinite(limit) && limit > 0 ? limit : undefined));
    });

    router.patch("/specs/:id", access("editor"), zValidator("json", updateSpecSchema), async (c) => {
        const result = await updateSpecWithLock(c.req.param("id"), c.req.valid("json")).catch(mapManualError);
        if (!result) throw new HTTPException(404, { message: "Spec not found" });
        return c.json(await specDetail(result.spec));
    });

    router.put("/specs/:id/files", access("editor"), zValidator("json", editFilesSchema), async (c) => {
        const spec = await specsRepository.getSpec(c.req.param("id"));
        if (!spec) throw new HTTPException(404, { message: "Spec not found" });
        const body = c.req.valid("json");
        const updated = await editSpecFiles(spec, body).catch(mapManualError);
        return c.json(await specDetail(updated));
    });

    router.delete("/specs/:id", access("editor"), async (c) => {
        try {
            if (!(await deleteSpecData(c.req.param("id")))) {
                throw new HTTPException(404, { message: "Spec not found" });
            }
            return c.body(null, 204);
        } catch (error) {
            mapManualError(error);
        }
    });

    return router;
}
