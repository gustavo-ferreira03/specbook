Self-hosting Specbook
=====================

The server runs from one container that holds the web app, the agent, both browsers and the test runner:

```sh
docker run -d --name specbook --restart unless-stopped \
  -p 127.0.0.1:4001:4001 -v specbook:/data \
  ghcr.io/gustavo-ferreira03/specbook
```

Updating is a `docker pull` and a new `docker run` with the same volume.

Domain and model logins
-----------------------

To serve Specbook on a domain, point your reverse proxy at port 4001 and add `-e FRONTEND_ORIGIN=https://specbook.example.com`. Extra hostnames go in `-e SPECBOOK_ALLOWED_HOSTS=host1,host2`.

OpenAI device-code login and Anthropic's copy-the-code login work out of the box. The browser login that redirects back to localhost also needs `-p 127.0.0.1:1455:1455` (OpenAI) or `-p 127.0.0.1:53692:53692` (Anthropic).

Configuration and data
----------------------

The `/data` volume holds the SQLite database, project repositories, conversations, run artifacts and the encryption key. Pass settings with `-e`:

| Variable | Purpose |
| --- | --- |
| `FRONTEND_ORIGIN` | Public URL used for links and allowed origins. Defaults to `http://localhost:4001`. |
| `SPECBOOK_ALLOWED_HOSTS` | Extra hostnames accepted besides localhost and IP addresses. |
| `SPECBOOK_ENCRYPTION_KEY` or `SPECBOOK_ENCRYPTION_KEY_FILE` | External encryption key instead of the generated `encryption.key`. Use one. |
| `LOG_LEVEL` | Server log level. |

> [!IMPORTANT]
> Back up the volume together with its encryption key. Without the matching key, stored credentials cannot be recovered.

Backups, restores and key rotation need exclusive access to the data, so stop the container first:

```sh
docker stop specbook
docker run --rm -v specbook:/data -v "$PWD":/backup --entrypoint node \
  ghcr.io/gustavo-ferreira03/specbook \
  apps/backend/dist/operations-cli.js backup /backup/specbook.tar.gz
docker start specbook
```

`restore <archive>` and `rotate-key --new-key-file <file>` work the same way. Retention of runs, videos, metrics and browser profiles is set in the instance settings.
