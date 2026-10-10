import { test, expect } from "specbook";
test("Browse Specs by feature, status, and title", async ({ page, step, secret }) => {
  await step("Open the Specbook sign-in page", async () => {
    await page.goto("/login?next=%2Fp%2F9edbbcfa-523b-4dbc-b02d-f5b746bd48fe%2Fspecs");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
  await step("Sign in with the saved administrator account", async () => {
    await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
    await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/p\/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe\/specs$/);
  });
  await step("Open the Specs list and observe its feature grouping", async () => {
    await expect(page.getByRole("heading", { name: "Specs", level: 1 })).toBeVisible();
    await expect(page.getByRole("list", { name: "Specs by feature" }).getByRole("heading", { name: "Smoke", level: 2 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Home page opens" })).toBeVisible();
  });
  await step("Filter the list to passing Specs", async () => {
    await page.getByRole("button", { name: "Passing 1" }).click();
    await expect(page.getByRole("button", { name: "Passing 1" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("list", { name: "Specs by feature" }).getByRole("link")).toHaveCount(1);
  });
  await step("Search for a Spec by its title", async () => {
    await page.getByRole("searchbox", { name: "Filter Specs by title" }).fill("Home page opens");
    await expect(page.getByRole("searchbox", { name: "Filter Specs by title" })).toHaveValue("Home page opens");
    await expect(page.getByRole("list", { name: "Specs by feature" }).getByRole("link", { name: "Home page opens" })).toHaveCount(1);
    await expect(page.getByRole("list", { name: "Specs by feature" }).getByRole("link")).toHaveCount(1);
  });
});