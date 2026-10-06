# Specs and project repositories

A project repository looks like this:

```text
context.yml
features/<feature>/feature.yml
specs/<feature>/<spec>/spec.yml
specs/<feature>/<spec>/spec.ts
```

`spec.yml` holds the human-facing behavior and `spec.ts` executes it:

```ts
import { test, expect } from "specbook";

test("Sign in with valid credentials", async ({ page, step, secret }) => {
    await step("Open the sign-in page", async () => {
        await page.goto("/login");
    });
    await step("Enter the account email and password", async () => {
        await page.getByLabel("Email").fill("ana@acme.test");
        await page.getByLabel("Password").fill(secret("shopper", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
    });
    await step("See the dashboard", async () => {
        await expect(page.getByRole("heading")).toHaveText(/Welcome back/);
    });
});
```

The file may contain only this shape: one import from `specbook`, one `test`, and `step` blocks whose titles are the `steps` of `spec.yml`, in order. Inside a step, only awaited `page`/locator actions (`goto` with a path, `click`, `fill`, `getByRole`, ...) and `expect` assertions with literal arguments are accepted; anything else makes the Spec invalid. `secret(profile, field)` types a credential value at run time, only on the project origin or the profile's allowed origins.

## Clone, edit and push

Open **Settings → Git** in a project and create a repository access token. The token is shown once. Use `specbook` as the username when Git prompts for credentials:

```bash
git clone https://your-specbook-host/api/git/<project-id>.git
# Username: specbook
# Password: the one-time project token
```

The repository accepts the `main` branch only. Generated files and edits made in Specbook are committed before the remote is advertised, and pushes are reindexed into the project after they complete. Rotating or revoking the token immediately prevents new Git requests; existing connections must authenticate again.

A missing or invalid `spec.ts` makes a check incomplete. Open its validation reason and use **Repair in chat**. The agent may propose an implementation repair; changing `spec.yml` requires a human decision.
