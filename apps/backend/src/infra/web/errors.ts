import crypto from "node:crypto";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "../logger";

export const handleRequestError: ErrorHandler = (error, c) => {
    if (error instanceof HTTPException && error.status < 500) return c.json({ error: error.message }, error.status);
    const errorId = crypto.randomUUID();
    logger.error("request failed", { errorId, method: c.req.method, path: c.req.path, error });
    return c.json({ error: "Specbook could not complete this request. Try again. If it keeps failing, share the error ID with your administrator.", errorId }, 500);
};
