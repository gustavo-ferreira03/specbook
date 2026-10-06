# Deploy with HTTPS

Publish one HTTPS origin for the interface and its `/api` routes. The same origin carries chat events, evidence, CI requests, Git and authenticated browser streaming. Caddy supports WebSocket upgrades and immediate response flushing in its [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Keep the direct backend port private.

## Caddy example

Point a DNS name at your Linux host and allow inbound ports 80 and 443. Install Docker Compose, then run from this repository:

```sh
export SPECBOOK_HOST=checks.example.com
docker compose -f deploy/docker-compose.caddy.yml up -d
```

Replace `checks.example.com` with your actual hostname. Caddy obtains and renews its TLS certificate. Open `https://checks.example.com` to create the administrator before inviting users.

The [Compose file](../deploy/docker-compose.caddy.yml) mounts persistent volumes for Specbook and Caddy. It exposes model-provider OAuth callback ports on host loopback only. For a remote machine, use the [SSH forwarding instructions](troubleshooting.md#model-provider-oauth-on-a-remote-host).

Back up the Specbook volume and any external encryption key. Set `SPECBOOK_IMAGE` to a version tag or image digest when you need a pinned deployment. Follow the [upgrade procedure](operations.md) before replacing an existing image.

## Existing reverse proxy

Forward requests and WebSocket upgrades to the frontend on port 4001. Preserve the public Host and set the correct forwarding protocol. Set `FRONTEND_ORIGIN=https://checks.example.com` in Specbook; additional public names belong in `SPECBOOK_ALLOWED_HOSTS`.

Allow streaming responses without buffering and choose a timeout long enough for chat. The application sends SSE heartbeats, `Cache-Control: no-cache, no-transform`, and `X-Accel-Buffering: no`. Set the proxy's upload limit above the intended Git push size.

Local HTTP uses httpOnly SameSite=Lax cookies. HTTPS adds Secure cookies with the `__Host-` prefix. CI and Git use their own project-scoped tokens and do not rely on browser sessions. Browser streaming requires a signed-in editor or admin and a matching Origin.

For a trusted LAN trial, publish port 4001 on the chosen interface and open its IP address. Use HTTPS before sharing credentials on an untrusted network.
