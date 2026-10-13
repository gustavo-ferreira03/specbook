import { test, expect } from "specbook";

test("Create a Spec by hand and run it", async ({ page, step, secret, cleanup }) => {
    await cleanup(async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/specs");
        await page.getByRole("button", { name: "Expand Self-test checks" }).hover();
        await page.getByRole("button", { name: "Delete feature Self-test checks" }).click();
        await page.getByRole("button", { name: "Delete feature", exact: true }).click();
    });
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("Open the Specs list", async () => {
        await page.getByRole("link", { name: "Specs" }).click();
        await expect(page.getByRole("button", { name: "New feature" })).toBeVisible();
    });
    await step("Create the feature “Self-test checks”", async () => {
        await page.getByRole("button", { name: "New feature" }).click();
        await page.getByRole("dialog", { name: "New feature" }).getByLabel("Title").fill("Self-test checks");
        await page.getByRole("button", { name: "Create feature" }).click();
        await expect(page.getByRole("heading", { name: "Self-test checks" })).toBeVisible();
    });
    await step("Create the Spec “Manual home check” in that feature", async () => {
        await page.getByRole("button", { name: "New Spec" }).click();
        const dialog = page.getByRole("dialog", { name: "New Spec" });
        await dialog.getByLabel("Title").fill("Manual home check");
        await dialog.getByRole("combobox", { name: "Feature" }).click();
        await page.getByRole("option", { name: "self-test-checks" }).click();
        await page.getByRole("button", { name: "Create Spec" }).click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Manual home check");
        await expect(page.getByRole("region", { name: "Run status" }).getByRole("paragraph").getByText("Not verified yet")).toBeVisible();
    });
    await step("Run the new Spec", async () => {
        await page.getByRole("button", { name: "Run", exact: true }).click();
        await expect(page.getByRole("region", { name: "Run status" }).getByRole("paragraph").getByText("Not verified yet")).toBeHidden();
    });
    await step("The last run of “Manual home check” passed", async () => {
        await expect(page.getByRole("region", { name: "Run status" }).getByRole("paragraph").getByText("Last run passed")).toBeVisible({ timeout: 30000 });
    });
});
