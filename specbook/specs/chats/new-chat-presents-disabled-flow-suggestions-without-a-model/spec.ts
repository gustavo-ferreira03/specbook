import { test, expect } from "specbook";

test("New chat presents disabled flow suggestions without a model", async ({ page, step, secret }) => {
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("button", { name: "Sauce Demo" })).toBeVisible();
    });
    await step("No model is configured", async () => {
        await expect(page.getByRole("button", { name: "Sauce Demo" })).toBeVisible();
    });
    await step("Open the New chat page", async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/chats/new");
        await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
        await expect(page.getByText("No model is set up yet.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Describe a flow State what should happen and how success is recognized." })).toBeDisabled();
    });
    await step("The Explore a feature suggestion is disabled", async () => {
        await expect(page.getByRole("button", { name: "Explore a feature Let the agent inspect an area and propose useful coverage." })).toBeDisabled();
    });
});
