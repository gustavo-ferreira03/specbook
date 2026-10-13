import { test, expect } from "specbook";

test("Store a credential profile with hidden values", async ({ page, step, secret, cleanup }) => {
    await cleanup(async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/settings");
        await page.getByRole("button", { name: "Delete self-test-shopper" }).click();
        await page.getByRole("button", { name: "Delete profile" }).click();
    });
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("Open Project settings", async () => {
        await page.getByRole("link", { name: "Settings" }).click();
        await expect(page.getByRole("button", { name: "New profile" })).toBeVisible();
    });
    await step("Start a new credential profile", async () => {
        await page.getByRole("button", { name: "New profile" }).click();
        await expect(page.getByRole("dialog", { name: "New credential profile" })).toBeVisible();
    });
    await step("Name it \u201cself-test-shopper\u201d", async () => {
        await page.getByLabel("Profile name").fill("self-test-shopper");
        await expect(page.getByLabel("Profile name")).toHaveValue("self-test-shopper");
    });
    await step("Enter the username \u201cshopper@example.com\u201d", async () => {
        await page.getByLabel("username value").fill("shopper@example.com");
        await expect(page.getByLabel("username sensitive")).not.toBeChecked();
    });
    await step("Enter a password", async () => {
        await page.getByLabel("password value").fill("self-test-password-value");
        await expect(page.getByLabel("password sensitive")).toBeChecked();
    });
    await step("Create the profile", async () => {
        await page.getByRole("button", { name: "Create profile" }).click();
        await expect(page.getByRole("listitem").filter({ hasText: "self-test-shopper" }).getByText("shopper@example.com")).toBeVisible();
    });
    await step("The saved profile hides its password", async () => {
        await expect(page.getByRole("listitem").filter({ hasText: "self-test-shopper" }).getByLabel("saved")).toHaveText("\u2022\u2022\u2022\u2022");
    });
});
