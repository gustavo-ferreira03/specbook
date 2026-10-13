import { test, expect } from "specbook";

test("Create and revoke a personal access token", async ({ page, step, secret, cleanup }) => {
    await cleanup(async () => {
        await page.goto("/settings?tab=access-tokens");
        await page.getByRole("button", { name: "Revoke token Self-test laptop" }).click();
        await page.getByRole("button", { name: "Revoke token", exact: true }).click();
    });
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("Open the access tokens settings", async () => {
        await page.getByRole("button", { name: "Account: Dogfood Admin" }).click();
        await page.getByRole("menuitem", { name: "Access tokens" }).click();
        await expect(page.getByLabel("Token name")).toBeVisible();
    });
    await step("Create the token \u201cSelf-test laptop\u201d", async () => {
        await page.getByLabel("Token name").fill("Self-test laptop");
        await page.getByRole("button", { name: "Create token" }).click();
        await expect(page.getByText("Copy this token now")).toBeVisible();
    });
    await step("Confirm the token was saved", async () => {
        await page.getByRole("button", { name: "I have saved it" }).click();
        await expect(page.getByRole("list", { name: "Your access tokens" }).getByText("Self-test laptop")).toBeVisible();
    });
    await step("Revoke \u201cSelf-test laptop\u201d", async () => {
        await page.getByRole("button", { name: "Revoke token Self-test laptop" }).click();
        await page.getByRole("button", { name: "Revoke token", exact: true }).click();
        await expect(page.getByText("Access token revoked.")).toBeVisible();
    });
    await step("The user has no access tokens", async () => {
        await expect(page.getByText("No access tokens yet.")).toBeVisible();
    });
});
