import { test, expect } from "specbook";

test("A failing run shows where it stopped", async ({ page, step, secret, cleanup }) => {
    await cleanup(async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/specs");
        await page.getByRole("button", { name: "Expand Self-test failures" }).hover();
        await page.getByRole("button", { name: "Delete feature Self-test failures" }).click();
        await page.getByRole("button", { name: "Delete feature", exact: true }).click();
    });
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("A Spec \u201cBroken home check\u201d exists in a new feature", async () => {
        await page.getByRole("link", { name: "Specs" }).click();
        await page.getByRole("button", { name: "New feature" }).click();
        await page.getByRole("dialog", { name: "New feature" }).getByLabel("Title").fill("Self-test failures");
        await page.getByRole("button", { name: "Create feature" }).click();
        await expect(page.getByRole("heading", { name: "Self-test failures" })).toBeVisible();
        await page.getByRole("button", { name: "New Spec" }).click();
        const dialog = page.getByRole("dialog", { name: "New Spec" });
        await dialog.getByLabel("Title").fill("Broken home check");
        await dialog.getByRole("combobox", { name: "Feature" }).click();
        await page.getByRole("option", { name: "self-test-failures" }).click();
        await page.getByRole("button", { name: "Create Spec" }).click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Broken home check");
    });
    await step("Open the automation source", async () => {
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await page.getByText("Advanced: automation source").click();
        await expect(page.getByLabel("spec.ts")).toBeVisible();
    });
    await step("Replace the assertion with text the app never shows", async () => {
        await page.getByLabel("spec.ts").fill("import { test, expect } from \"specbook\";\n\ntest(\"Broken home check\", async ({ page, step }) => {\n    await step(\"Open the application\", async () => {\n        await page.goto(\"/\");\n        await expect(page.getByText(\"Text that never appears\")).toBeVisible({ timeout: 1000 });\n    });\n});\n");
        await expect(page.getByLabel("spec.ts")).toContainText("Text that never appears");
    });
    await step("Save the Spec", async () => {
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    });
    await step("Run the Spec", async () => {
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await expect(page.getByRole("region", { name: "Run status" }).getByRole("paragraph").getByText("Last run failed")).toBeVisible({ timeout: 30000 });
    });
    await step("The automatic retry also failed at \u201cOpen the application\u201d", async () => {
        const newest = page.getByRole("list", { name: "Runs, newest first" }).getByRole("listitem").first();
        await expect(newest.getByText("Automatic retry.")).toBeVisible({ timeout: 60000 });
        await expect(newest.getByText("Failed at step: Open the application")).toBeVisible({ timeout: 60000 });
    });
});
