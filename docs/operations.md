# Storage, backups and retention

Specbook keeps its database, project repositories, chat sessions and run evidence in `SPECBOOK_STORAGE_DIR`. Back up that directory before an upgrade. Do not copy a live SQLite database file: recent writes may still be in its WAL.

The operations CLI requires Node and the Linux `tar` and `flock` commands. The Docker image includes them. For a source checkout, run `pnpm --filter backend build` first, then use `pnpm --filter backend ops`.

## Back up a stopped instance

Stop the backend before backup, restore or key rotation. The CLI takes the same storage lock as the server and refuses to run while that directory is in use. It creates a SQLite snapshot with `VACUUM INTO`, then archives the matching project repositories, run evidence, chat sessions, evaluation metrics and credential files. Browser profiles are disposable and excluded.

```sh
pnpm --filter backend ops backup /secure/backups/specbook.tar.gz \
  --storage /srv/specbook/storage
```

The command refuses to overwrite an existing archive. It records checksums for every file and gives the archive mode `0600`. A backup containing a local encryption key can decrypt its own credentials; keep it private.

With Docker Compose, stop the app and run the CLI in a temporary container attached to its volume:

```sh
mkdir -p backups
chmod 700 backups
docker compose stop app
docker compose run --rm --no-deps --user node \
  --entrypoint node -v "$PWD/backups:/backups" app \
  /app/apps/backend/dist/operations-cli.js backup /backups/specbook.tar.gz
docker compose start app
```

The mounted backup directory must be writable by the image's `node` user (UID 1000). Use a new archive name for each backup.

## Restore and verify

Restore to a new, empty storage directory. The CLI checks archive paths, rejects links and special files, verifies checksums and SQLite integrity, and tests credential decryption before copying files to the destination. It leaves an existing installation alone.

```sh
SPECBOOK_ENCRYPTION_KEY_FILE=/secure/specbook.key \
  pnpm --filter backend ops restore /secure/backups/specbook.tar.gz \
  --storage /srv/specbook/restored

SPECBOOK_STORAGE_DIR=/srv/specbook/restored \
SPECBOOK_ENCRYPTION_KEY_FILE=/secure/specbook.key \
  pnpm --filter backend start
```

Omit `SPECBOOK_ENCRYPTION_KEY_FILE` when the archive includes its local key. An external key stays outside the archive, so supply the same key during restore and boot. Check `/health`, sign in, open a project and run a Spec before switching users to the restored instance.

For a Docker volume, create a fresh volume and mount it at `/app/apps/backend/storage` in a one-off CLI container. Keep the original volume until you have verified the restored installation.

## Encryption keys and upgrades

Specbook encrypts model credentials in `pi-auth.json`, saved browser sessions, project credentials, notification webhook URLs and OIDC secrets with AES-256-GCM. Passwords and access tokens use one-way hashes instead.

Choose one key source:

| Setting | Value |
| --- | --- |
| `SPECBOOK_ENCRYPTION_KEY` | A 32-byte key encoded as 64 hex characters or padded base64 |
| `SPECBOOK_ENCRYPTION_KEY_FILE` | Path to a mounted file containing that encoded key or 32 raw bytes |
| Neither setting | Specbook creates `encryption.key` in its storage directory with mode `0600` |

For a key outside the data volume:

```sh
umask 077
openssl rand -base64 32 > /secure/specbook.key
```

Mount that file read-only and set `SPECBOOK_ENCRYPTION_KEY_FILE` in the backend's environment. Do not set both key variables. Losing the key makes the stored credentials unrecoverable.

On the first upgraded boot, Specbook uses the existing `credentials.key` to migrate encrypted project credentials and encrypts an existing plaintext `pi-auth.json`. It validates all secrets before changing them. When an external key is configured, the migration re-encrypts the data with that key and removes the old local key only after the database and credential file have been saved. Existing projects stay intact.

For a v0.1.0 installation, stop the old backend and run the new operations CLI against its storage before starting the new server. The backup command reads the existing schema without applying migrations, so it can preserve a v0.1.0 volume even though that release did not have this CLI. To roll back across a database or encryption change, restore the pre-upgrade backup into an empty directory and run the matching old image. Do not point an older image at upgraded storage.

## Rotate a key

Stop Specbook and make a backup, then generate a different key file:

```sh
umask 077
openssl rand -base64 32 > /secure/specbook-next.key
SPECBOOK_ENCRYPTION_KEY_FILE=/secure/specbook.key \
  pnpm --filter backend ops rotate-key \
  --new-key-file /secure/specbook-next.key --storage /srv/specbook/storage
```

For an external key, change the deployment to use the new file before restarting. With a local key, the command updates `encryption.key` itself. It prints a fingerprint, never the key.

Rotation covers every encrypted database field and `pi-auth.json`. A recovery journal lets a restart finish an interrupted rotation with either participating key. After a successful boot using the new key, Specbook removes that journal. Store a new backup and keep the old key only as long as you retain backups encrypted with it.

## Retention

Admins can change retention in global Settings or run cleanup there immediately. Automatic cleanup runs hourly, beginning one hour after boot.

| Data | Default |
| --- | --- |
| Runs | Keep the newest 20 per Spec and every run from the last 30 days |
| Failure videos | 7 days; Specs that type credentials never record video |
| Batches | 30 days, after all referenced runs have expired |
| Evaluation metrics | 90 days |
| Inactive chat browser files | 30 days |

Cleanup preserves running checks, unresolved automation, pending Inbox evidence and both attempts of a retained flaky run. It also keeps every run needed by a retained batch so CI history remains accurate. If an expired video belongs to a Playwright HTML report, cleanup expires that report too; the native run history and step screenshots remain. It does not remove Specs, project repositories, chat conversations or the audit log. Set `SPECBOOK_RETENTION_ENABLED=false` to disable the hourly timer; an admin can still request cleanup manually.
