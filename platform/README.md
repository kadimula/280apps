# platform/

## `appcontainer/` — the app container harness

`App280Container` (`src/container.js`): the container class every 280 app runs
in, with the platform security defaults locked on. `src/worker.js` is the per-app
harness Worker that fronts it (verify-and-forward via `@280/gateway`, then the
egress boundary). This is live production code: the backend image copies it in as
`TWO80_WORKER_ENTRY` and the roll (`packages/backend/.../registry-builder.ts`)
deploys `App280Container` as the container class. Both files document their own
defaults and wiring; read them.

`container.js` mirrors the tested `@280/egress` (`packages/egress`) wiring inline
rather than importing it. Keep the two in step — `packages/egress/test/exfil.test.ts`
is the CI guard.

## Server side

The control plane, store, runtime (build via the depot pipeline), and serving all
live in `packages/backend/`. `*.280apps.run` is served container-only by each
app's own Worker fronting the identity gateway (`packages/gateway/`).
