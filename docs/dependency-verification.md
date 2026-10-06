# Dependency verification before v0.2.0

On October 6, 2026, Trivy 0.75.0 reported 34 HIGH or CRITICAL findings across the 849 packages in `pnpm-lock.yaml`: 28 HIGH and 6 CRITICAL. After the updates below, the same scan covered 651 packages and returned zero HIGH or CRITICAL findings. No vulnerability exclusions were added, and findings without a fix remain blocking.

| Dependency | Installed after remediation |
| --- | --- |
| Next.js | 16.3.8 |
| simple-git | 4.0.2 |
| brace-expansion | 5.0.12 |
| fast-uri | 3.1.8 |
| ip-address | 10.7.3 |
| js-yaml | 3.15.2 |
| nanoid | 3.3.20 |
| proxy-addr | 2.0.8 |
| sharp | 0.35.5 |
| source-map-js | 1.2.2 |
| undici | 8.11.2 |

The workspace overrides set patched minimum versions for eight transitive dependencies within their existing major versions. The unused shadcn CLI development dependency was removed; its generated components remain. It was the only dependency path to `braces`, whose [stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) had no fixed release.

The [simple-git 4 changelog](https://github.com/steveukx/git-js/blob/main/simple-git/CHANGELOG.md) removes default imports, blocks abbreviated long options and restricts Git environment variables. Specbook already used named imports and complete options. Its Git factories now explicitly allow only the existing `GIT_TERMINAL_PROMPT=0` setting. The other environment and unsafe-operation guards remain enabled.

The Trivy database was updated at `2026-10-06T07:04:23Z`. The binary archive was verified against the official release asset digest and checksums. To repeat the dependency check:

```sh
trivy fs --scanners vuln --pkg-types library --include-dev-deps \
  --disable-telemetry --severity HIGH,CRITICAL --exit-code 1 pnpm-lock.yaml
```

The scan target was the lockfile itself. It did not scan local storage, credentials, Git history, build output or website assets; the secret scanner was disabled. This result covers the locked JavaScript dependencies at that database revision. It does not verify Debian packages, browser binaries or the complete Docker image. The image pipeline still requires its own Trivy checks and native amd64/arm64 boot verification before publishing install tags.
