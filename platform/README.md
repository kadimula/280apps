# platform/

The server side of the deploy seam now lives in `packages/backend/` (TS). This
directory holds the app container substrate.

- `appcontainer/` : `App280Container`, the Cloudflare Container each app runs in
  (locked defaults: `enableInternet=false`, `interceptHttps=true`, a
  buildpack-injected CA entrypoint). See `appcontainer/BUILD_HOME.md`.

Container-only serving: `*.280apps.run` is served by each app's own Worker (built
by the roll), which calls the identity gateway (`packages/gateway/`) to mint a
signed identity and forwards to its container. The legacy edge dispatcher
(Workers for Platforms) and its dispatch namespaces were removed in the Phase 3
cutover.

The control plane itself is a Node service deployed on Railway from
`packages/backend/` (`Dockerfile`, env in `.env.example`). One-time resources (R2
buckets, Hyperdrive configs with query caching disabled) are created by
`packages/backend/scripts/bootstrap-resources.sh`.

Server behavior, store, blobstore, runtime, API, and run/deploy docs: see
`packages/backend/`.
