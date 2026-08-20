# Dev setup

Each service runs its own watcher from its package directory. Start them in separate panes.

## backend (`packages/backend`)
```
pnpm dev
```
Runs the Node control-plane entry (`src/main.ts`). Defaults to no watch so a long container roll is never interrupted by a restart. Add `pnpm dev --watch` for auto-rebuild/restart while iterating on backend code (do not use it while pushing an app: the restart races the deploy).

## sdk (`packages/sdk`)
```
pnpm dev
```
Watches and rebuilds `@two80/sdk` so dependents pick up changes.

## cli (`packages/cli`)
```
pnpm exec tsup --watch
```
Rebuilds the `two80` bundle on change; use the local build to `push`/`dev` against a running backend.

## dashboard (`packages/dashboard`)
```
npm run dev
```
Next.js dev server. This package is outside the pnpm workspace, so use npm (`npm ci` first) and set `TWO80_API`.

## sample app (`sample-apps/2-google-sheets-with-sdk`)
```
npm run dev
```
Next.js app used to exercise the SDK against the local backend.
