import { test, expect } from "specbook";
test("Browse Project settings sections", async ({ page, step, secret }) => {
  await step("Open the Specbook sign-in page", async () => {
    await page.goto("/login?next=%2F");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
  await step("Enter the saved administrator email and password", async () => {
    await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
    await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Sauce Demo" })).toBeVisible();
  });
  await step("Open Project settings", async () => {
    await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/settings");
    await expect(page.getByRole("heading", { name: "Project settings" })).toBeVisible();
  });
  await step("Select General and observe its section", async () => {
    await page.getByRole("tab", { name: "General" }).click();
    await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "General" })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "General" }).getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
  await step("Open App context and observe its section", async () => {
    await page.getByRole("tab", { name: "App context" }).click();
    await expect(page.getByRole("tab", { name: "App context" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "App context" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Teach Specbook this application" })).toBeVisible();
  });
  await step("Open Automation and observe its section", async () => {
    await page.getByRole("tab", { name: "Automation" }).click();
    await expect(page.getByRole("tab", { name: "Automation" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Automation" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Automation" })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "Automation" }).getByRole("button", { name: "Save changes" }).first()).toBeDisabled();
  });
  await step("Open Git and observe its section", async () => {
    await page.getByRole("tab", { name: "Git" }).click();
    await expect(page.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Git" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Specbook repository" })).toBeVisible();
  });
});