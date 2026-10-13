import { test, expect } from "specbook";

test("Editing a Spec records a version", async ({ page, step, secret, cleanup }) => {
    await cleanup(async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/specs");
        await page.getByRole("button", { name: "Expand Self-test versions" }).hover();
        await page.getByRole("button", { name: "Delete feature Self-test versions" }).click();
        await page.getByRole("button", { name: "Delete feature", exact: true }).click();
    });
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("A Spec \u201cVersioned home check\u201d exists in a new feature", async () => {
        await page.getByRole("link", { name: "Specs" }).click();
        await page.getByRole("button", { name: "New feature" }).click();
        await page.getByRole("dialog", { name: "New feature" }).getByLabel("Title").fill("Self-test versions");
        await page.getByRole("button", { name: "Create feature" }).click();
        await expect(page.getByRole("heading", { name: "Self-test versions" })).toBeVisible();
        await page.getByRole("button", { name: "New Spec" }).click();
        const dialog = page.getByRole("dialog", { name: "New Spec" });
        await dialog.getByLabel("Title").fill("Versioned home check");
        await dialog.getByRole("combobox", { name: "Feature" }).click();
        await page.getByRole("option", { name: "self-test-versions" }).click();
        await page.getByRole("button", { name: "Create Spec" }).click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Versioned home check");
    });
    await step("Rename the step to \u201cOpen the storefront\u201d", async () => {
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await page.getByLabel("Steps").fill("Open the storefront");
        await page.getByText("Advanced: automation source").click();
        await page.getByLabel("spec.ts").fill("import { test, expect } from \"specbook\";\n\ntest(\"Versioned home check\", async ({ page, step }) => {\n    await step(\"Open the storefront\", async () => {\n        await page.goto(\"/\");\n        await expect(page.locator(\"body\")).toBeVisible();\n    });\n});\n");
        await expect(page.getByLabel("Steps")).toHaveValue("Open the storefront");
    });
    await step("Save the Spec", async () => {
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByRole("region", { name: "Specification" }).getByText("Open the storefront")).toBeVisible();
    });
    await step("Open the Spec's versions", async () => {
        await page.getByRole("button", { name: "Versions", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Spec history" })).toBeVisible();
    });
    await step("Select the oldest version", async () => {
        await page.getByRole("list", { name: "Commits" }).getByRole("button").last().click();
        await expect(page.getByRole("list", { name: "Commits" }).getByRole("button").last()).toHaveAttribute("aria-pressed", "true");
    });
    await step("The oldest version still has the step \u201cOpen the application\u201d", async () => {
        await expect(page.getByRole("dialog", { name: "Spec history" }).getByText("Open the application").first()).toBeVisible();
    });
});
