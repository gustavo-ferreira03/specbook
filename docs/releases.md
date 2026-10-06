# Releasing Specbook

The repository prepares releases with release-please. Do not create the v0.2.0 tag manually. The manifest starts at the published 0.1.0 version; feature and breaking-change commits propose a minor release while Specbook is below 1.0.

## Repository settings

Enable GitHub Actions and give its token permission to create pull requests under **Settings → Actions → General**. A `RELEASE_PLEASE_TOKEN` secret with repository contents and pull-request write access lets CI run automatically on the release PR. With `GITHUB_TOKEN`, GitHub creates runs for PR creation and updates in an approval-required state; a maintainer selects **Approve workflows to run** on the PR. See [GitHub's workflow-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

The image workflows use GHCR and the repository's `GITHUB_TOKEN`. They need package write access. Signing uses GitHub OIDC through Sigstore, with no stored signing key. Make the GHCR package public when distributing the public image. Set **Settings → Pages → Source** to **GitHub Actions** for the website.

## Publish the prepared release

After reviewing the local commits and verification results:

```sh
git switch main
git push origin main
gh run list --workflow ci.yml --branch main --limit 5
gh run watch
gh pr list --base main --label 'autorelease: pending'
```

Select the CI run for the commit you pushed when `gh run watch` prompts. After it succeeds, release-please prepares the v0.2.0 PR. Review `version.txt`, the manifest and changelog, including the upgrade instructions and breaking changes. Replace `123` with the release PR number below:

```sh
release_pr=123
release_head="$(gh pr view "$release_pr" --json headRefOid --jq .headRefOid)"
gh pr view "$release_pr" --web
gh pr diff "$release_pr"
gh pr checks "$release_pr" --watch &&
  gh pr merge "$release_pr" --merge --match-head-commit "$release_head"
gh run list --workflow release-please.yml --branch main --limit 5
```

Approve pending workflows in the PR before waiting for checks. The merge command refuses if its head changed after review. If it did change, review the new diff and repeat the check. Release-please creates the Git tag and GitHub Release after the merged commit passes CI; the image job then builds and verifies that commit. Build, scan or signing failures leave the previous install tags intact.

The website workflow builds `site/dist` with `node site/build.mjs` and deploys it to GitHub Pages on changes to `site/`. Pull requests build the site without deploying it.

## What the image pipeline verifies

The shared `container.yml` workflow checks that its exact source commit passed CI as a main-branch push, then builds Linux amd64 and arm64 on native runners. For each architecture it:

1. Builds from an exact commit and uploads the result by digest, without install tags.
2. Generates SPDX SBOMs and maximum-level build provenance, including the build stage.
3. Runs Trivy against OS and application dependencies. Any HIGH or CRITICAL finding blocks publication, including findings without an available fix. The scan report remains a workflow artifact for 30 days.
4. Boots an empty installation, checks the frontend's same-origin API and `/ready`, then opens the setup screen with each of the two installed Chromium builds.

After both architectures pass, the workflow assembles an image index, confirms both SBOMs and provenance are present, and signs its digest with cosign. Only then does it update install tags. These steps use Docker's [attestation support](https://docs.docker.com/build/ci/github-actions/attestations/) and [multi-platform build support](https://docs.docker.com/build/ci/github-actions/multi-platform/).

| Tag | Updated by |
| --- | --- |
| `main` | The current main commit after CI and image verification |
| `sha-<7-character-commit>` | A verified main commit |
| `v0.2.0`, `0.2.0` | The verified v0.2.0 release commit |
| `latest` | The most recent GitHub Release after image verification |

Build uploads and `candidate-<run>-<attempt>` tags are intermediate artifacts, not installation channels. Failed scans may leave untagged build data in GHCR. Signing failures can leave a candidate tag but do not update install tags. Promotion updates several tags; a network failure during that step can leave a partial update, though every promoted digest has already passed scanning, installation checks and signing.

## Recover an image publication

Verified digest artifacts remain available for 30 days. Within GitHub's rerun window, retry only the failed jobs so the successful release-please result is preserved:

```sh
gh run list --workflow release-please.yml --branch main --limit 5
gh run rerun RUN_ID --failed
gh run watch RUN_ID --exit-status
```

Replace `RUN_ID` with the failed run's number. Re-running all jobs calls release-please again; it does not report an existing release as newly created, so that path skips the image job. GitHub documents the [30-day rerun window](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

To rebuild an already published release without creating another tag or release, use the manual recovery path:

```sh
gh workflow run publish-image.yml --ref main -f release_tag=v0.2.0
gh run list --workflow publish-image.yml --event workflow_dispatch --limit 5
gh run watch
```

Select the newly dispatched run. Recovery requires a published, non-prerelease GitHub Release, resolves its tag to a commit and checks for a successful main-branch push CI run on that exact commit. If that CI record is unavailable, recovery stops. Both architectures are rebuilt, scanned and checked before signing and promotion. Recovering an older release updates its version tags but leaves `latest` on the newest release. Omit `release_tag` to verify and publish a preview of the current main commit instead.

Changing application source requires a new commit and a new release. Recovery uses the existing tag's source and can produce a different image digest when upstream packages change; retain the previous digest if deployments pin it.

## Verify a published image

Use a trusted digest from the successful workflow summary. The example below verifies the signing workflow's exact identity before running the image. Change the repository path when using a fork. Fulcio records the [reusable workflow identity](https://github.com/sigstore/fulcio/blob/main/docs/oidc.md) in the certificate.

```sh
image=ghcr.io/gustavo-ferreira03/specbook@sha256:REPLACE_WITH_VERIFIED_DIGEST
cosign verify "$image" \
  --certificate-identity=https://github.com/gustavo-ferreira03/specbook/.github/workflows/container.yml@refs/heads/main \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com

bash scripts/verify-image.sh "$image"
```

The verification script needs Docker, Bash, curl and Python 3. It creates a temporary container with a new anonymous data volume, binds the web port only on loopback, and removes the container and its volumes on exit. Run it on each supported architecture when validating images outside CI.

Inspect the signed index's attestations with Buildx:

```sh
docker buildx imagetools inspect "$image" \
  --format '{{ json (index .SBOM "linux/amd64").SPDX }}' > sbom-amd64.json
docker buildx imagetools inspect "$image" \
  --format '{{ json (index .SBOM "linux/arm64").SPDX }}' > sbom-arm64.json
docker buildx imagetools inspect "$image" \
  --format '{{ json .Provenance }}' > provenance.json
```

Compare the provenance source revision with the released commit. The signature verifies who signed the image digest; it does not replace reviewing the source, scan results or upgrade behavior. See [Docker's SBOM inspection format](https://docs.docker.com/build/metadata/attestations/sbom/) and [Sigstore's verification documentation](https://docs.sigstore.dev/cosign/verifying/verify/) for the underlying commands.

Before upgrading a real installation, follow [backup and restore](operations.md). Keep a copy of the previous image digest and a pre-upgrade backup: reverting the image alone cannot undo a database migration or key change.
