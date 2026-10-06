import fs from "node:fs/promises";
import path from "node:path";
import type { Run } from "../../infra/repositories/runs";
import type { Spec } from "../../infra/repositories/specs";
import { runsDir } from "../paths";
import { markdownHashOf } from "../repo/writer";

export async function matchesCurrentSpec(run: Run, spec: Spec): Promise<boolean> {
    if (spec.status === "invalid" || run.specId !== spec.id || run.sourceHash !== spec.sourceHash) return false;
    const yaml = await fs.readFile(path.join(runsDir, run.id, "spec.yml"), "utf8").catch(() => null);
    return yaml !== null && markdownHashOf(yaml) === spec.markdownHash;
}
