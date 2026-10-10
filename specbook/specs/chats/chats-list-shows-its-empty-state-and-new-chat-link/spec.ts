import { test, expect } from "specbook";
test("Chats list shows its empty state and New chat link", async ({ page, step, secret }) => {
  await step("Open the Specbook sign-in page", async () => {
    await page.goto("/login?next=%2F");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
  await step("Sign in with the saved administrator account", async () => {
    await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
    await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Sauce Demo" })).toBeVisible();
  });
  await step("Open Chats from the project navigation", async () => {
    await page.getByRole("link", { name: "Chats" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Chats");
  });
  await step("Observe the empty-state guidance and New chat link", async () => {
    await expect(page.getByRole("main").getByText("No chats yet")).toBeVisible();
    await expect(page.getByText("Describe a behavior while the agent operates a live browser, and save the result as a Spec.")).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: "New chat" })).toBeVisible();
  });
});