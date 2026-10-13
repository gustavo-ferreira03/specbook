import { test, expect } from "specbook";

test("Pause the agent for the project", async ({ page, step, secret, cleanup }) => {
    await cleanup(async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe");
        await page.getByRole("button", { name: "Resume" }).click();
        await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    });
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("Open the project Home", async () => {
        await page.getByRole("link", { name: "Home" }).click();
        await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    });
    await step("Pause the project", async () => {
        await page.getByRole("button", { name: "Pause" }).click();
        await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    });
    await step("Home says nothing runs until the project is resumed", async () => {
        await expect(page.getByText("Paused by you. Nothing runs until you resume.")).toBeVisible();
    });
});
