# Releasing `@two80/sdk`

Releasing is automated end to end: merge an SDK change to `main` and it ships.
No one runs `npm publish`, `git tag`, `git push --tags`, or hand-edits the
version by hand.

## Cut a release

Just merge your change. Three workflows take it from there:

- `.github/workflows/sdk-auto-bump.yml` runs on push to `main`. When a file
  that ships in the published SDK package (`packages/sdk/**`, minus `test/`,
  `scripts/`, `RELEASING.md`, `vitest.config.ts`) changed since the last
  `sdk-v*` tag and `package.json` wasn't already bumped ahead of it, it
  increments the patch version itself, commits, and pushes straight to `main`.
  This is why an `@two80/sdk` source change can never again land unreleased —
  PR #106 shipped a real fix without bumping the version, and the tag-gated
  publish workflow silently had nothing new to publish (root cause of the
  google-sheets sample app 500ing whenever Sheets is unconnected).
- `.github/workflows/tag-sdk-release.yml` runs on push to `main` whenever
  `packages/sdk/package.json` changes (bot bump or a manual bump in a PR).
  When the version increased versus the previous commit and no
  `sdk-v<version>` tag exists yet, it creates and pushes `sdk-v<version>`,
  then hands off to the publish workflow. It is idempotent: a no-op when the
  version is unchanged or the tag already exists, and it never moves an
  existing tag.
- The pushed `sdk-v*` tag triggers `.github/workflows/publish-sdk.yml`, which:
  - asserts the tag matches `packages/sdk/package.json` and the version is not
    already on npm,
  - builds `@280/contracts` then `@two80/sdk`, runs the SDK tests,
  - publishes with provenance, then cuts a GitHub Release with generated
    notes.

If you *want* to bump the version yourself in the PR (e.g. to pick a minor
bump instead of the auto-bump's default patch), that's fine — the auto-bump
workflow only acts when it sees shipping changes with no bump at all; a
version you already raised is left alone.

### Why the tag hand-off uses `workflow_dispatch`

A tag pushed by the default `GITHUB_TOKEN` does **not** start `on: push: tags`
workflows (GitHub's rule against recursive runs). So `tag-sdk-release.yml`
pushes the tag (making the release ref real and immutable) and then dispatches
`publish-sdk.yml` at that tag ref, where `GITHUB_REF_NAME` is the tag and every
publish step runs unchanged. No new credential (PAT/deploy key) is involved and
publishing stays wholly inside `publish-sdk.yml`.

## Manual fallback

If automation is unavailable, bump `packages/sdk/package.json` and push the
tag by hand after merging:

```sh
git tag sdk-v0.3.2
git push origin sdk-v0.3.2
```

The tag version and `package.json` version must match, or the publish run
fails before publishing. You can also re-run a publish from the Actions tab
via the `publish-sdk.yml` **Run workflow** button against an existing
`sdk-v*` tag.

## First publish (one-time bootstrap)

Trusted publishing can only be configured on a package that already exists, so
the very first `@two80/sdk` release was manual:

1. Build and pack locally: `pnpm --filter @280/contracts build`, then
   `pnpm --filter @two80/sdk build`, then
   `pnpm --filter @two80/sdk pack`.
2. Publish that tarball once with an npm credential you hold (a granular access
   token or `npm publish` with 2FA): `npm publish two80-sdk-0.1.0.tgz --access public`.
3. On npmjs.com, open the `@two80/sdk` package settings and add a Trusted
   Publisher for repo `kadimula/280apps` and workflow `publish-sdk.yml`.

After that, every release is tokenless OIDC through the workflow above.

## How auth works (no token)

Publishing uses npm **trusted publishing** (OIDC): CI presents a short-lived
GitHub identity, and npm publishes because the `@two80/sdk` package has a
Trusted Publisher configured for repo `kadimula/280apps` and workflow
`publish-sdk.yml`. There is no `NPM_TOKEN` secret to hold or rotate.

The npm CLI performs the OIDC exchange, so the workflow packs with `pnpm`
(which rewrites the `workspace:` dependency) and publishes that tarball with
`npm`; `pnpm publish` does not do the exchange and 404s.

## Who can publish

Whoever can merge an SDK change to `main` — the bump (if you didn't already
do it), tag, and publish are all automated from there. Publishing is gated by
GitHub write access plus the Trusted Publisher config, not by holding an npm
credential. External contributors fork and PR; they cannot push to `main` or
push tags upstream, so they cannot release.
