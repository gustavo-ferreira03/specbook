import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { deleteSpecData, ResourceBusyError } from "../../../core/deletion";
import { editSpecFiles, readSpecRawFiles, RepoConflictError } from "../../../core/repo/manual";
import { readSpecFiles } from "../../../core/repo/writer";
import { featuresRepository } from "../../repositories/features";
import { runsRepository } from "../../repositories/runs";
import { specsRepository, type Spec } from "../../repositories/specs";

const editFilesSchema = z
    .object({
        yaml: z.string().optional(),
        robot: z.string().optional(),
    })
    .refine((body) => body.yaml !== undefined || body.robot !== undefined, {
        message: "Provide yaml and/or robot content",
    });

function mapManualError(error: unknown): never {
    if (error instanceof RepoConflictError) throw new HTTPException(409, { message: error.message });
    if (error instanceof Error && /unfinished rebase|uncommitted changes/.test(error.message)) {
        throw new HTTPException(409, { message: error.message });
    }
    throw error;
}

async function specDetail(spec: Spec) {
    const feature = await featuresRepository.getFeature(spec.featureId);
    const runs = await runsRepository.listRuns(spec.id);
    const parsed = await readSpecFiles(spec).catch(() => null);
    const raw = await readSpecRawFiles(spec);
    const content =
        raw.yaml !== null || raw.robot !== null
            ? {
                  humanSpec: parsed?.humanSpec ?? null,
                  robotSource: raw.robot ?? "",
                  yamlSource: raw.yaml ?? "",
              }
            : null;
    return { spec, feature, content, runs };
}

export function createSpecsRouter(): Hono {
    const router = new Hono();

    router.get("/specs/:id", async (c) => {
        const spec = await specsRepository.getSpec(c.req.param("id"));
        if (!spec) throw new HTTPException(404, { message: "Spec not found" });
        return c.json(await specDetail(spec));
    });

    router.put("/specs/:id/files", zValidator("json", editFilesSchema), async (c) => {
        const spec = await specsRepository.getSpec(c.req.param("id"));
        if (!spec) throw new HTTPException(404, { message: "Spec not found" });
        const body = c.req.valid("json");
        const updated = await editSpecFiles(spec, body).catch(mapManualError);
        return c.json(await specDetail(updated));
    });

    router.delete("/specs/:id", async (c) => {
        try {
            if (!(await deleteSpecData(c.req.param("id")))) {
                throw new HTTPException(404, { message: "Spec not found" });
            }
            return c.body(null, 204);
        } catch (error) {
            if (error instanceof HTTPException) throw error;
            if (error instanceof ResourceBusyError) throw new HTTPException(409, { message: error.message });
            throw error;
        }
    });

    return router;
}
