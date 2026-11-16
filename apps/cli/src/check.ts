import { checkLiveLocators } from "./browser";
import { scrub } from "./credentials";
import { specDirectories, readSpec } from "./workspace";

export const checkSpecs = async function checkSpecs(
  workspace: string,
  selector?: string,
  browserWorkspace = workspace
) {
  const specs = [];
  for (const path of await specDirectories(workspace, selector)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
      const spec = await readSpec(workspace, path);
      // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
      const locators = await checkLiveLocators(browserWorkspace, spec.source);
      specs.push({
        path,
        ok: !locators.some(
          (locator: { status: string }) => locator.status !== "matched"
        ),
        locators,
      });
    } catch (error) {
      specs.push({
        path,
        ok: false,
        // oxlint-disable-next-line no-await-in-loop -- Keep dependent retries, browser actions, and state changes in their original order and bound concurrent resource use.
        error: await scrub(
          error instanceof Error ? error.message : String(error)
        ),
        locators: [],
      });
    }
  }
  return {
    ok: specs.length > 0 && specs.every((spec) => spec.ok),
    specs,
    note: "Live locator checks describe the current exploration page; later steps can target different page states.",
  };
};
