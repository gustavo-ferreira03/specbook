import { test, expect } from "specbook";
test("Home dashboard shows the passing headline", async ({ page, step, secret }) => {
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
  await step("Open the project Home dashboard", async () => {
    await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
  });
  await step("Observe the passing-Spec headline", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("1 of 1 Spec passing");
  });
});