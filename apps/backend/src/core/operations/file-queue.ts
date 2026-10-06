import { createKeyedLock } from "./keyed-lock";

/** Serializes append and retention rewrites so cleanup cannot lose a concurrent record. */
export const withFileQueue = createKeyedLock().run;
