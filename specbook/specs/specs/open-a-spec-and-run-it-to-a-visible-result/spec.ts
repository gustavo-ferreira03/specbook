import { test, expect } from "specbook";
test("Open a Spec and run it to a visible result", async ({ page, step, secret }) => {
  await step("Sign in to the Sauce Demo project", async () => {
    await page.goto("/login?next=%2F");
    await page.getByLabel("Email").fill(secret("dogfood-admin", "username"));
    await page.getByLabel("Password").fill(secret("dogfood-admin", "password"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
  });
  await step("Open the existing Spec from the Specs list", async () => {
    await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/specs");
    await page.getByRole("link", { name: "Home page opens" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home page opens");
    await expect(page.getByRole("region", { name: "Specification" }).getByText("Open the application")).toBeVisible();
  });
  await step("Run the Spec again", async () => {
    await page.getByRole("button", { name: "Run again" }).click();
  });
  await step("See the updated pass status, unchanged Spec step, and additional run in history", async () => {
    await expect(page.getByRole("status", { name: "Run status" }).getByText("Last run passed")).toBeVisible();
    const newest = page.getByRole("list", { name: "Runs, newest first" }).getByRole("listitem").first();
    await expect(newest.getByText("just now")).toBeVisible();
    await expect(newest.getByText("Passed")).toBeVisible();
    await expect(page.getByRole("region", { name: "Specification" }).getByText("Open the application")).toBeVisible();
  });
});