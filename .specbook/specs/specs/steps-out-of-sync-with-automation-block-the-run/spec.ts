import { test, expect } from "specbook";

test("Steps out of sync with automation block the run", async ({ page, step, secret, cleanup }) => {
    await cleanup(async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/specs");
        await page.getByRole("button", { name: "Expand Self-test sync" }).hover();
        await page.getByRole("button", { name: "Delete feature Self-test sync" }).click();
        await page.getByRole("button", { name: "Delete feature", exact: true }).click();
    });
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("A Spec \u201cUnsynced home check\u201d exists in a new feature", async () => {
        await page.getByRole("link", { name: "Specs" }).click();
        await page.getByRole("button", { name: "New feature" }).click();
        await page.getByRole("dialog", { name: "New feature" }).getByLabel("Title").fill("Self-test sync");
        await page.getByRole("button", { name: "Create feature" }).click();
        await expect(page.getByRole("heading", { name: "Self-test sync" })).toBeVisible();
        await page.getByRole("button", { name: "New Spec" }).click();
        const dialog = page.getByRole("dialog", { name: "New Spec" });
        await dialog.getByLabel("Title").fill("Unsynced home check");
        await dialog.getByRole("combobox", { name: "Feature" }).click();
        await page.getByRole("option", { name: "self-test-sync" }).click();
        await page.getByRole("button", { name: "Create Spec" }).click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Unsynced home check");
    });
    await step("Rename the step to \u201cOpen the storefront\u201d", async () => {
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await page.getByLabel("Steps").fill("Open the storefront");
        await expect(page.getByText("The automation must be updated to match")).toBeVisible();
    });
    await step("Save the Spec", async () => {
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByRole("alert").getByText("Your changes were saved, but the Spec is now invalid")).toBeVisible();
    });
    await step("The Spec says it can't run", async () => {
        await expect(page.getByRole("region", { name: "Run status" }).getByRole("paragraph").getByText("This Spec can't run")).toBeVisible();
    });
});
