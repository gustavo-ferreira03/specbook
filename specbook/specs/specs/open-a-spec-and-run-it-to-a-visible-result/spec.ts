import { test, expect } from "specbook";

test("Open a Spec and run it to a visible result", async ({ page, step, secret }) => {
    await step("Signed in as the Specbook administrator", async () => {
        await page.goto("/login?next=%2F");
        await page.getByRole("textbox", { name: "Email" }).fill(secret("dogfood-admin", "username"));
        await page.getByRole("textbox", { name: "Password" }).fill(secret("dogfood-admin", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByRole("link", { name: "Specs" })).toBeVisible();
    });
    await step("Open \u201cHome page opens\u201d from the Specs list", async () => {
        await page.goto("/p/9edbbcfa-523b-4dbc-b02d-f5b746bd48fe/specs");
        await page.getByRole("link", { name: "Home page opens" }).click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home page opens");
        await expect(page.getByRole("region", { name: "Specification" }).getByText("Open the application")).toBeVisible();
    });
    await step("Run the Spec again", async () => {
        await page.getByRole("button", { name: "Run again" }).click();
        await expect(page.getByRole("region", { name: "Run status" }).getByText("Last run passed")).toBeVisible({ timeout: 30000 });
    });
    await step("The newest run in the history passed just now", async () => {
        const newest = page.getByRole("list", { name: "Runs, newest first" }).getByRole("listitem").first();
        await expect(newest.getByText("just now")).toBeVisible();
        await expect(newest.getByText("Passed")).toBeVisible();
    });
    await step("The Spec still shows its step \u201cOpen the application\u201d", async () => {
        await expect(page.getByRole("region", { name: "Specification" }).getByText("Open the application")).toBeVisible();
    });
});
