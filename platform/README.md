# platform/

## `appcontainer/` — the app container harness

`App280Container` (`src/container.js`): the container class every 280 app runs
in, with the platform security defaults locked on. `src/worker.js` is the per-app
harness Worker that fronts it with verify and forward via `@280/gateway`. The
container network permits only the fixed 280 SDK API host. This is live production
code: the backend image copies it in as
`APP_WORKER_ENTRYPOINT` and the roll (`packages/backend/.../cloudflare-container-deployment.ts`)
deploys `App280Container` as the container class. Both files document their own
defaults and wiring; read them.

`container.js` locks `enableInternet` off and gives Cloudflare's `ContainerProxy`
one exact allowed host from `TWO80_SDK_API_ORIGIN`. It injects the same origin as
`TWO80_API` for `@280/sdk`. The backend image vendors `@280/gateway` and
`@280/contracts`; `scripts/bundle-smoke.sh` proves the production layout and checks
that the retired credential handler is absent.

## Server side

The control plane, store, runtime (build via the depot pipeline), and serving all
live in `packages/backend/`. `*.280apps.run` is served container-only by each
app's own Worker fronting the identity gateway (`packages/gateway/`).
