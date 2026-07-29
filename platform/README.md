# platform/

The server side of the deploy seam now lives in `packages/backend/` (TS). This
directory holds only the edge dispatcher.

- `dispatcher/` : the Cloudflare Worker in front of every app. Routes hostname to
  the app's script (Workers for Platforms). `wrangler.jsonc` is prod,
  `wrangler.development.jsonc` is development.

The control plane itself now also deploys as a Cloudflare Worker, alongside the
dispatcher, from `packages/backend/` — its `wrangler.jsonc` (prod) and
`wrangler.development.jsonc` (development) declare the `api.280apps.com` route,
the R2 / Hyperdrive / Durable Object bindings, and the cleanup cron. One-time
resources (R2 buckets, Hyperdrive configs with query caching disabled) are
created by `packages/backend/scripts/bootstrap-resources.sh`. This is part of
the control-plane Workers migration (plan Workstream B / §5).

Server behavior, store, blobstore, runtime, API, and run/deploy docs: see
`packages/backend/`.
