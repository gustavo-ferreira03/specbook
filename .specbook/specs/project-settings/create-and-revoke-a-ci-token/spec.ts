import { test, expect } from "specbook";

test("Create and revoke a CI token", async ({ page, step, secret, cleanup }) => {
    await cleanup(async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/settings?tab=automation");
        await page.getByRole("button", { name: "Revoke", exact: true }).click();
        await page.getByRole("button", { name: "Revoke token" }).click();
    });
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("Open the Automation settings", async () => {
        await page.getByRole("link", { name: "Settings" }).click();
        await page.getByRole("tab", { name: "Automation" }).click();
        await expect(page.getByText("No CI token yet")).toBeVisible();
    });
    await step("Create a CI token", async () => {
        await page.getByRole("button", { name: "Create token" }).click();
        await expect(page.getByText("Copy this token now")).toBeVisible();
    });
    await step("Confirm the token was saved", async () => {
        await page.getByRole("button", { name: "I have saved it" }).click();
        await expect(page.getByText("Never used")).toBeVisible();
    });
    await step("Revoke the CI token", async () => {
        await page.getByRole("button", { name: "Revoke", exact: true }).click();
        await page.getByRole("button", { name: "Revoke token" }).click();
        await expect(page.getByText("CI token revoked.")).toBeVisible();
    });
    await step("The project has no CI token", async () => {
        await expect(page.getByText("No CI token yet")).toBeVisible();
    });
});
