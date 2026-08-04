# Releasing `two80`

The CLI publishes to npm from CI. A pushed `cli-v*` tag is the only trigger;
no one runs `npm publish` by hand.

## Cut a release

1. Bump the version in `packages/cli/package.json` (the only file: `VERSION` in
   `src/app.ts` is injected from it at build time). Merge to `main`.
2. Tag that commit and push the tag:

   ```sh
   git tag cli-v0.4.4
   git push origin cli-v0.4.4
   ```

That's it. The `cli-v*` push runs `.github/workflows/publish-cli.yml`, which:

- asserts the tag matches `packages/cli/package.json` and the version is not
  already on npm,
- builds `@280/contracts` then `two80`, runs the CLI tests,
- publishes with provenance, then cuts a GitHub Release with generated notes.

The tag version and `package.json` version must match, or the run fails before
publishing.

## How auth works (no token)

Publishing uses npm **trusted publishing** (OIDC): CI presents a short-lived
GitHub identity, and npm publishes because the `two80` package has a Trusted
Publisher configured for repo `kadimula/280apps` and workflow
`publish-cli.yml`. There is no `NPM_TOKEN` secret to hold or rotate.

The npm CLI performs the OIDC exchange, so the workflow packs with `pnpm`
(which rewrites the `workspace:` dependency) and publishes that tarball with
`npm`; `pnpm publish` does not do the exchange and 404s.

## Who can publish

Whoever can push a `cli-v*` tag to `kadimula/280apps`. Publishing is gated by
GitHub write/tag-push access, not by holding an npm credential. External
contributors fork and PR; they cannot push tags upstream, so they cannot
release.
