# Releasing `two80`

Releasing is automated: **bump the version and merge to `main`**. CI forces the
bump, a workflow cuts the tag, and the tag publishes to npm. No one runs
`npm publish`, `git tag`, or `git push --tags` by hand.

## Cut a release

1. Bump the version in `packages/cli/package.json` (the only file: `VERSION` in
   `src/app.ts` is injected from it at build time). The expected default is the
   **smallest** bump — a patch, e.g. `0.4.7 -> 0.4.8`.
2. Open the PR and merge to `main`.

That's it. Two workflows take it from there:

- `.github/workflows/ci.yml` runs `scripts/check-cli-version-bump.mjs`, which
  **fails the PR** if any file that ships in the published package changed since
  the last `cli-v*` tag without a strict version increase. This is why every CLI
  change must carry a bump — the published CLI can never lag `main` again (root
  cause of the two80@0.4.6 activation-gate skew).
- `.github/workflows/tag-cli-release.yml` runs on push to `main`. When
  `packages/cli/package.json` version increased versus the previous commit and no
  `cli-v<version>` tag exists yet, it creates and pushes `cli-v<version>`, then
  hands off to the publish workflow. It is idempotent: a no-op when the version
  is unchanged or the tag already exists, and it never moves an existing tag.

The pushed `cli-v*` tag triggers `.github/workflows/publish-cli.yml`, which:

- asserts the tag matches `packages/cli/package.json` and the version is not
  already on npm,
- builds `@280/contracts` then `two80`, runs the CLI tests,
- publishes with provenance, then cuts a GitHub Release with generated notes.

### Why the tag hand-off uses `workflow_dispatch`

A tag pushed by the default `GITHUB_TOKEN` does **not** start `on: push: tags`
workflows (GitHub's rule against recursive runs). So `tag-cli-release.yml` pushes
the tag (making the release ref real and immutable) and then dispatches
`publish-cli.yml` at that tag ref, where `GITHUB_REF_NAME` is the tag and every
publish step runs unchanged. No new credential (PAT/deploy key) is involved and
publishing stays wholly inside `publish-cli.yml`.

## Manual fallback

If automation is unavailable, push the tag by hand after merging the bump:

```sh
git tag cli-v0.4.8
git push origin cli-v0.4.8
```

The tag version and `package.json` version must match, or the publish run fails
before publishing. You can also re-run a publish from the Actions tab via the
`publish-cli.yml` **Run workflow** button against an existing `cli-v*` tag.

## How auth works (no token)

Publishing uses npm **trusted publishing** (OIDC): CI presents a short-lived
GitHub identity, and npm publishes because the `two80` package has a Trusted
Publisher configured for repo `kadimula/280apps` and workflow
`publish-cli.yml`. There is no `NPM_TOKEN` secret to hold or rotate.

The npm CLI performs the OIDC exchange, so the workflow packs with `pnpm`
(which rewrites the `workspace:` dependency) and publishes that tarball with
`npm`; `pnpm publish` does not do the exchange and 404s.

## Who can publish

Whoever can merge a CLI version bump to `main` — the tag and publish are
automated from there. Publishing is gated by GitHub write access plus the
Trusted Publisher config, not by holding an npm credential. External
contributors fork and PR; they cannot push to `main` or push tags upstream, so
they cannot release.
