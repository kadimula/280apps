# Releasing `@two80/sdk`

The SDK publishes to npm from CI. A pushed `sdk-v*` tag is the only trigger;
no one runs `npm publish` by hand.

## Cut a release

1. Bump the version in `packages/sdk/package.json`. Merge to `main`.
2. Tag that commit and push the tag:

   ```sh
   git tag sdk-v0.1.1
   git push origin sdk-v0.1.1
   ```

That's it. The `sdk-v*` push runs `.github/workflows/publish-sdk.yml`, which:

- asserts the tag matches `packages/sdk/package.json` and the version is not
  already on npm,
- builds `@280/contracts` then `@two80/sdk`, runs the SDK tests,
- publishes with provenance, then cuts a GitHub Release with generated notes.

The tag version and `package.json` version must match, or the run fails before
publishing.

## First publish (one-time bootstrap)

Trusted publishing can only be configured on a package that already exists, so
the very first `@two80/sdk` release is manual:

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

Whoever can push an `sdk-v*` tag to `kadimula/280apps`. Publishing is gated by
GitHub write/tag-push access, not by holding an npm credential. External
contributors fork and PR; they cannot push tags upstream, so they cannot
release.
