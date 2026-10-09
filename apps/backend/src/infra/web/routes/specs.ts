import { access } from "../access";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { deleteSpecData, ResourceBusyError } from "../../../core/deletion";
import { UnsafeRepoPathError } from "../../../core/repo/safe-fs";
import { parseSpecYaml, YamlParseError } from "../../../core/repo/yaml";
import type { HumanSpec } from "../../db/schema";
import { editSpecFiles, readSpecRawFiles } from "../../../core/repo/manual";
import { updateSpecWithLock } from "../../../core/repo/writer";
import { featuresRepository } from "../../repositories/features";
import { runsRepository } from "../../repositories/runs";
import { specsRepository, type Spec } from "../../repositories/specs";

const editFilesSchema = z
    .object({
        yaml: z.string().optional(),
        testSource: z.string().optional(),
    })
    .refine((body) => body.yaml !== undefined || body.testSource !== undefined, {
        message: "Provide yaml and/or testSource content",
    });

const humanSpecSchema = z.object({
    preconditions: z.array(z.string()),
    steps: z.array(z.string()),
    expectedResult: z.string(),
    postconditions: z.array(z.string()),
});

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

async function specDetail(spec: Spec, runLimit?: number) {
    const feature = await featuresRepository.getFeature(spec.featureId);
    const runs = await runsRepository.listRuns(spec.id, { limit: runLimit });
    const raw = await readSpecRawFiles(spec).catch((error) => {
        if (error instanceof UnsafeRepoPathError) return { yaml: null, testSource: null };
        throw error;
    });
    let humanSpec: HumanSpec | null = null;
    if (raw.yaml !== null) {
        try {
            humanSpec = parseSpecYaml(raw.yaml).humanSpec;
        } catch {
            humanSpec = null;
        }
    }
    const content =
        raw.yaml !== null || raw.testSource !== null
            ? {
                  humanSpec,
                  testSource: raw.testSource ?? "",
                  yamlSource: raw.yaml ?? "",
              }
            : null;
    return { spec, feature, content, runs };
}

export function createSpecsRouter(): Hono {
    const router = new Hono();

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
