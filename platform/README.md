# platform/

The server side of the deploy seam now lives in `packages/backend/` (TS). This
directory holds only the edge dispatcher.

- `dispatcher/` : the Cloudflare Worker in front of every app. Routes hostname to
  the app's script (Workers for Platforms). `wrangler.jsonc` is prod,
  `wrangler.staging.jsonc` is staging.

Server behavior, store, blobstore, runtime, API, and run/deploy docs: see
`packages/backend/`.
