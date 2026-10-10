import { test, expect } from "specbook";
test("Sign in with valid credentials", async ({ page, step, secret }) => {
  await step("Open the Specbook sign-in page", async () => {
    await page.goto("/login?next=%2F");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
  await step("Enter the saved administrator email and password", async () => {
    await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
    await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
    await page.getByRole("button", { name: "Sign in" }).click();
  });
  await step("See the Sauce Demo project workspace", async () => {
    await expect(page).toHaveURL(/\/p\/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe$/);
    await expect(page.getByRole("button", { name: "Sauce Demo" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "1 of 1 Spec passing" })).toBeVisible();
  });
});