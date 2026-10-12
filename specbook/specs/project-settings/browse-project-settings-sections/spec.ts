import { test, expect } from "specbook";

test("Browse Project settings sections", async ({ page, step, secret }) => {
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("button", { name: "Sauce Demo" })).toBeVisible();
    });
    await step("Open Project settings", async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/settings");
        await expect(page.getByRole("heading", { name: "Project settings" })).toBeVisible();
    });
    await step("Select the General tab", async () => {
        await page.getByRole("tab", { name: "General" }).click();
        await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel", { name: "General" })).toBeVisible();
        await expect(page.getByRole("tabpanel", { name: "General" }).getByRole("button", { name: "Save changes" })).toBeDisabled();
    });
    await step("Select the App context tab", async () => {
        await page.getByRole("tab", { name: "App context" }).click();
        await expect(page.getByRole("tab", { name: "App context" })).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel", { name: "App context" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Teach Specbook this application" })).toBeVisible();
    });
    await step("Select the Automation tab", async () => {
        await page.getByRole("tab", { name: "Automation" }).click();
        await expect(page.getByRole("tab", { name: "Automation" })).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel", { name: "Automation" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Automation" })).toBeVisible();
        await expect(page.getByRole("tabpanel", { name: "Automation" }).getByRole("button", { name: "Save changes" }).first()).toBeDisabled();
    });
    await step("Select the Git tab", async () => {
        await page.getByRole("tab", { name: "Git" }).click();
        await expect(page.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel", { name: "Git" })).toBeVisible();
    });
    await step("The Git tab shows the Specbook repository section", async () => {
        await expect(page.getByRole("heading", { name: "Specbook repository" })).toBeVisible();
    });
});
