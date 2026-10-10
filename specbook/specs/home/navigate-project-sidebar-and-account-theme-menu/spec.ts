import { test, expect } from "specbook";
test("Navigate project sidebar and account theme menu", async ({ page, step, secret }) => {
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
  await step("Open Home from the project sidebar", async () => {
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await expect(page.getByRole("heading", { name: "1 of 1 Spec passing" })).toBeVisible();
  });
  await step("Open Specs from the project sidebar", async () => {
    await page.getByRole("link", { name: "Specs", exact: true }).click();
    await expect(page).toHaveURL(/\/specs$/);
    await expect(page.getByRole("heading", { name: "Specs", exact: true })).toBeVisible();
  });
  await step("Open Chats from the project sidebar", async () => {
    await page.getByRole("link", { name: "Chats", exact: true }).click();
    await expect(page).toHaveURL(/\/chats$/);
    await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible();
  });
  await step("Open the account menu and observe the theme options", async () => {
    await page.getByRole("button", { name: "Account: Dogfood Admin" }).click();
    await expect(page.getByRole("menuitemradio", { name: "Light" })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "Dark" })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "System" })).toBeChecked();
  });
});