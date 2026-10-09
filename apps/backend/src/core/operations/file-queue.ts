import { createKeyedLock } from "./keyed-lock";

export const withFileQueue = createKeyedLock().run;
