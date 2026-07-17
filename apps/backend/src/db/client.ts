import fs from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { dbPath, storageRoot } from "../core/paths";
import * as schema from "./schema";

fs.mkdirSync(storageRoot, { recursive: true });

const client = createClient({ url: `file:${dbPath}` });

export const db = drizzle(client, { schema });
