import { specDirectories, readSpec } from "./workspace";
import { scrub } from "./credentials";

export async function checkSpecs(workspace: string, selector?: string) {
    const specs = [];
    for (const path of await specDirectories(workspace, selector)) {
        try {
            const spec = await readSpec(workspace, path);
            const locators: { status: string }[] = [];
            specs.push({ path, ok: !locators.some((locator: { status: string }) => locator.status !== "matched"), locators });
        } catch (error) {
            specs.push({ path, ok: false, error: await scrub(error instanceof Error ? error.message : String(error)), locators: [] });
        }
    }
    return { ok: specs.length > 0 && specs.every((spec) => spec.ok), specs, note: "Live locator checks describe the current exploration page; later steps can target different page states." };
}
