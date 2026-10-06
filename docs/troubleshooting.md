# Troubleshooting

Start with **Settings → System status**. `/health` checks that the backend answers; `/ready` checks the database, storage access, both Chromium installations, Xvfb and x11vnc. A failed readiness check includes its cause.

```sh
docker logs --tail 150 specbook
curl -f http://localhost:4001/api/ready
```

Keep the error identifier when reporting a failure. Don't attach raw credential files, cookies or unreviewed screenshots to public issues.

## Browser cannot start

The image contains two Chromium builds: Playwright MCP uses one for the visible agent browser, and Playwright Test uses one for verification. A source checkout needs both:

```sh
pnpm --filter backend browser:install
```

Linux also needs Xvfb and x11vnc. Missing packages, unavailable displays and exited processes appear in System status or the browser-start message. Restart the backend after fixing the cause.

Each browser owns its X server, VNC process and display allocation. Don't kill every Xvfb process or delete arbitrary `/tmp/.X*-lock` files: another active session may own them. Stop the affected Specbook backend cleanly and inspect its logs before retrying.

## Chromium crashes or runs run out of memory

Use `--shm-size=1g` with Docker, or `shm_size: "1gb"` with Compose. Reduce `SPECBOOK_MAX_CONCURRENT_RUNS` and `SPECBOOK_MAX_CONCURRENT_JOBS` on a small host. Agent browsers and run browsers consume memory separately; see [hardware guidance](architecture.md#capacity-planning).

## Model connection fails

Use **Settings → Model → Test connection** after saving a provider and model. An invalid key needs a new key; a rate limit needs a wait or an available model; a removed model needs a new selection. Having a saved credential alone does not prove that a provider accepts it.

GitHub Copilot is an LLM provider connection. Specbook's project Git remote is separate and uses a project token.

## Model-provider OAuth on a remote host

Some model providers redirect to loopback callback ports on the machine running your browser. If Specbook runs on a remote Linux host, forward those ports before starting the connection:

```sh
ssh -N -L 1455:127.0.0.1:1455 -L 53692:127.0.0.1:53692 user@specbook-host
```

The container must publish these ports to host loopback and set `PI_OAUTH_CALLBACK_HOST=0.0.0.0`. OpenAI Codex uses port 1455; Anthropic uses 53692. GitHub Copilot uses a device-code flow. These model-provider connections are separate from [account SSO](sso.md), whose callback uses the main HTTPS origin.

## Sign-in or SSO fails

Check the public origin, TLS configuration and exact callback URI. Browser cookies must reach the same origin as `/api`. A viewer cannot open Settings or change projects; ask an admin to change the role if editing is intended.

An OIDC provider must return a verified email from an allowed domain. A matching email does not automatically link an existing local account: sign in locally first, then choose **Connect single sign-on**. Keep password sign-in enabled until the admin has completed SSO with the current provider configuration.

## Requests return 421 or the browser stream disconnects

Set `FRONTEND_ORIGIN` to the public HTTPS origin and add any other hostname to `SPECBOOK_ALLOWED_HOSTS`. The reverse proxy must preserve the public Host, forwarding protocol and WebSocket upgrade. Browser streaming needs an editor/admin session and an Origin header matching the interface.

Opening the same image through a LAN IP needs no frontend rebuild. Use the frontend port and its `/api` path; don't configure a browser to call a server's `localhost:4000` from another machine.

## A check is incomplete or local files block a run

Read the check's validation reason and choose **Repair in chat**. A check without `spec.ts` is incomplete. The YAML behavior remains available for review.

When external Git edits haven't been committed, the recovery control shows their file diffs. Save those edits explicitly, then retry. Specbook rejects a stale recovery preview and preserves the files so you can review the current change.

## Stored credentials cannot be decrypted

Restore the matching key rather than replacing or deleting the credential files. If rotation was interrupted, follow the recovery instructions in [Operations](operations.md#rotate-a-key). Losing every copy of the correct key means those credentials must be supplied again.

## Development pages fail after a production build

Never build into a `.next` directory that a running `next dev` uses. Stop that development process before rebuilding, or use `NEXT_DIST_DIR=.next-production-check pnpm --filter frontend build`. Remove only the affected generated output and restart development if it was already corrupted.
