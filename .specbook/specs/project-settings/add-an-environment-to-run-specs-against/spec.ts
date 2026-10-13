import { test, expect } from "specbook";

test("Add an environment to run Specs against", async ({ page, step, secret, cleanup }) => {
    await cleanup(async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/settings");
        await page.getByRole("button", { name: "Delete Self-test staging" }).click();
        await page.getByRole("button", { name: "Delete environment" }).click();
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
        await expect(page.getByRole("button", { name: "Add environment" })).toBeVisible();
    });
    await step("Add the environment \u201cSelf-test staging\u201d", async () => {
        await page.getByRole("button", { name: "Add environment" }).click();
        await page.getByLabel("Name", { exact: true }).fill("Self-test staging");
        await page.getByLabel("Base URL").fill("https://www.saucedemo.com");
        await page.getByRole("button", { name: "Save environment" }).click();
        await expect(page.getByText("Environment saved.")).toBeVisible();
    });
    await step("Open the Specs list", async () => {
        await page.getByRole("link", { name: "Specs" }).click();
        await expect(page.getByRole("combobox", { name: "Run environment" })).toBeVisible();
    });
    await step("\u201cSelf-test staging\u201d is offered as a run environment", async () => {
        await page.getByRole("combobox", { name: "Run environment" }).click();
        await expect(page.getByRole("option", { name: "Self-test staging" })).toBeVisible();
    });
});
