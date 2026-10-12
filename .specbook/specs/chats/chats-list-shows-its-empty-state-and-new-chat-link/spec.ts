import { test, expect } from "specbook";

test("Chats list shows its empty state and New chat link", async ({ page, step, secret }) => {
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("button", { name: "Sauce Demo" })).toBeVisible();
    });
    await step("The project has no conversations", async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe");
        await expect(page.getByRole("link", { name: "Chats" })).toBeVisible();
    });
    await step("Open Chats from the project navigation", async () => {
        await page.getByRole("link", { name: "Chats" }).click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Chats");
        await expect(page.getByRole("main").getByText("No chats yet")).toBeVisible();
        await expect(page.getByText("Describe a behavior while the agent operates a live browser, and save the result as a Spec.")).toBeVisible();
    });
    await step("The empty Chats page offers a New chat link", async () => {
        await expect(page.getByRole("main").getByRole("link", { name: "New chat" })).toBeVisible();
    });
});
