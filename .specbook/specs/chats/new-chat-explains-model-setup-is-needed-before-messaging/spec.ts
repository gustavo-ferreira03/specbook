import { test, expect } from "specbook";

test("New chat explains model setup is needed before messaging", async ({ page, step, secret }) => {
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
        await expect(page.getByText("Choose a provider to chat with the agent.")).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Message Specbook" })).toBeDisabled();
    });
    await step("The Send message button is disabled", async () => {
        await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    });
});
