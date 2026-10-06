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

The file may contain only this shape: one import from `specbook`, one `test`, and `step` blocks whose titles are the `steps` of `spec.yml`, in order. Inside a step, only supported awaited browser or API actions and literal assertions are accepted; anything else makes the Spec invalid. `secret(profile, field)` types a credential value at run time, only on the project origin or the profile's allowed origins.

## Clone, edit and push

Open **Settings → Git** in a project and create a repository access token. The token is shown once. Use `specbook` as the username when Git prompts for credentials:

```bash
git clone https://your-specbook-host/api/git/<project-id>.git
# Username: specbook
# Password: the one-time project token
```

The repository accepts the `main` branch only. Generated files and edits made in Specbook are committed before the remote is advertised, and pushes are reindexed into the project after they complete. Rotating or revoking the token immediately prevents new Git requests; existing connections must authenticate again.

A missing or invalid `spec.ts` makes a Spec incomplete. Open its validation reason and use **Repair in chat**. The agent may propose an implementation repair; changing `spec.yml` requires a human decision.

## Drafts and environments

Selected batches generate drafts with their first run result. Drafts run manually; activate a Spec to include it in schedules, CI, deployment events and failure investigation. Activation is an operational setting saved in Specbook, separate from the behavior contract. New Specs imported through Git begin as drafts; existing Specs retain their state when reindexed.

Save destinations in **Project settings → Environments**. Production is the default and uses the project URL. Other environments can override a Spec's credential profile with another profile saved in the same project. An override explicitly authorizes the selected profile at that environment's base origin; otherwise the original profile's allowed origins still apply. One-off preview URLs must be allowlisted separately for navigation and credential use. Run results retain their environment configuration for retries and investigation.

## API Specs

API-only Specs use `request` without a browser page:

```ts
import { test, expect } from "specbook";

test("Health endpoint responds", async ({ request, step }) => {
    await step("Request the health endpoint", async () => {
        const response = await request.get("/health");
        await expect(response).toBeOK();
        await expect(response.status()).toBe(200);
        await expect(await response.json()).toMatchObject({ status: "ok" });
    });
});
```

The named step must also appear in `spec.yml`. Supported methods are `get`, `post`, `put`, `patch` and `delete`, with literal paths and options. Relative paths use the selected environment; absolute destinations and redirects must stay on allowed origins. Use `secret("profile", "field")` in header values or JSON body fields for saved credentials. Console and network failures, or API request/response excerpts, become bounded redacted evidence. API-only steps do not create screenshots.

When suggesting Specs from API documentation, the agent can read a public text, JSON or YAML URL on an allowed origin. Add a separate documentation origin to the environment if needed. The reader does not forward cookies, credentials or redirects.
