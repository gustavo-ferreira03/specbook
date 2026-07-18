---
name: verify
description: How to run and drive specbook for verification without touching the live servers
---

# Verifying specbook

Live processes (do NOT kill or rebuild under them): backend `tsx watch` on :4000, frontend production `next start` on :4001 (serves `.next` — never `next build`/`next dev` in `apps/frontend` while it runs; frontend changes only show after Gus rebuilds+restarts it).

## Isolated backend stack (safe)

```bash
SCRATCH=<scratchpad dir>; mkdir -p $SCRATCH/verify-storage
# drizzle.config.ts hardcodes storage/specbook.db — use a temp config pointing at the scratch db, then:
npx drizzle-kit migrate --config $SCRATCH/drizzle-verify.config.ts
cd apps/backend
SPECBOOK_STORAGE_DIR=$SCRATCH/verify-storage PORT=4009 FRONTEND_ORIGIN=http://localhost:4002 \
  nohup npx tsx src/index.ts > $SCRATCH/backend.log 2>&1 &
curl localhost:4009/health
```

Plain `tsx` (no watch): restart the process after code edits. Kill by pid from `ss -tlnp | grep 4009` — never `pkill -f "tsx"` (matches the live watcher and your own shell).

## Driving the git-spec flows

- `POST /projects` → repo appears at `$STORAGE/repos/<id>` (init commit, branch main).
- GitHub sim: `git init --bare --initial-branch=main $SCRATCH/fake-github.git`, `PUT /projects/:id/git {"remoteUrl": <path>}` (local paths work, no token).
- External edits: clone the bare repo, commit+push, then `POST /projects/:id/git/sync`; check `GET /projects/:id/tree` and `GET /specs/:id`.
- Conflict: push a remote commit FIRST, then commit directly in `$STORAGE/repos/<id>` (author is already configured), then sync → expect `conflict`; resolve via `POST /projects/:id/git/resolve`. Note: the push queue auto-pushes fast — local-ahead states get pushed within seconds, so order matters.
- Spec writes go through agent chat tools only; HTTP has no create/update spec endpoint. Exercise writer via DELETE /specs/:id (commit) and the runner via `POST /projects/:id/run-batches` (robot + Browser are installed; runs against a dead baseUrl fail in ~15s with a page.goto timeout, which still verifies commitSha pinning on the run row).
