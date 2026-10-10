import { test, expect } from "specbook";
test("New chat presents disabled flow suggestions without a model", async ({ page, step, secret }) => {
  await step("Sign in to the Sauce Demo project", async () => {
    await page.goto("/login?next=%2Fp%2F9edbbcfa-523b-4dbc-b02d-f5b746bd48fe%2Fchats%2Fnew");
    await page.getByLabel("Email").fill(secret("dogfood-admin", "username"));
    await page.getByLabel("Password").fill(secret("dogfood-admin", "password"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/p\/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe\/chats\/new$/);
  });
  await step("Open the New chat page", async () => {
    await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/chats/new");
    await expect(page.getByRole("heading", { name: "New chat" })).toBeVisible();
  });
  await step("Observe the flow and feature suggestions are unavailable", async () => {
    await expect(page.getByRole("button", { name: "Describe a flow State what should happen and how success is recognized." })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Explore a feature Let the agent inspect an area and propose useful coverage." })).toBeDisabled();
    await expect(page.getByText("No model is set up yet.")).toBeVisible();
  });
});