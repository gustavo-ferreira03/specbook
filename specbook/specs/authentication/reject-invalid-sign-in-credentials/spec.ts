import { test, expect } from "specbook";

test("Reject invalid sign-in credentials", async ({ page, step }) => {
    await step("Open the sign-in page", async () => {
        await page.goto("/login?next=%2F");
        await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    });
    await step("Submit invalid credentials", async () => {
        await page.getByRole("textbox", { name: "Email" }).fill("invalid@example.test");
        await page.getByRole("textbox", { name: "Password" }).fill("invalid-password");
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page).toHaveURL(/\/login\?next=%2F$/);
    });
    await step("The sign-in page shows \u201cEmail or password is incorrect.\u201d", async () => {
        await expect(page.getByText("Email or password is incorrect.", { exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    });
});
