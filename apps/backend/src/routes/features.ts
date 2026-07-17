import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteFeatureData, ResourceBusyError } from "../core/deletion";

export function createFeaturesRouter(): Hono {
    const router = new Hono();

    router.delete("/features/:id", async (c) => {
        try {
            if (!(await deleteFeatureData(c.req.param("id")))) {
                throw new HTTPException(404, { message: "Feature not found" });
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
