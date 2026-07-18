import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteSpecData, ResourceBusyError } from "../core/deletion";
import { readSpecExecutable } from "../core/specs/files";
import { featuresRepository } from "../repositories/features";
import { runsRepository } from "../repositories/runs";
import { specsRepository } from "../repositories/specs";

export function createSpecsRouter(): Hono {
    const router = new Hono();

    router.get("/specs/:id", async (c) => {
        const spec = await specsRepository.getSpec(c.req.param("id"));
        if (!spec) throw new HTTPException(404, { message: "Spec not found" });
        const feature = await featuresRepository.getFeature(spec.featureId);
        const runs = await runsRepository.listRuns(spec.id);
        if (!spec.currentVersionId) return c.json({ spec, feature, version: null, runs });
        const versionRow = await specsRepository.getSpecVersion(spec.currentVersionId);
        if (!versionRow) return c.json({ spec, feature, version: null, runs });
        const robotSource = await readSpecExecutable(versionRow.executablePath).catch(() => "");
        return c.json({
            spec,
            feature,
            version: {
                id: versionRow.id,
                version: versionRow.version,
                humanSpec: versionRow.humanSpec,
                robotSource,
            },
            runs,
        });
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
