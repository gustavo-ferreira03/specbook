import { test, expect } from "specbook";

test("Run every Spec from the Specs list", async ({ page, step, secret }) => {
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("Open the Specs list", async () => {
        await page.getByRole("link", { name: "Specs" }).click();
        await expect(page.getByRole("button", { name: "Run all" })).toBeVisible();
    });
    await step("Run all Specs", async () => {
        await page.getByRole("button", { name: "Run all" }).click();
        await expect(page.getByRole("dialog", { name: "Run all Specs" })).toBeVisible();
    });
    await step("The batch completes with every Spec passed", async () => {
        const batch = page.getByRole("dialog", { name: "Run all Specs" });
        await expect(batch.getByText("Run completed", { exact: true })).toBeVisible({ timeout: 60000 });
        await expect(batch.getByText(/^\d+ passed across \d+ Specs?\.$/)).toBeVisible();
    });
});
