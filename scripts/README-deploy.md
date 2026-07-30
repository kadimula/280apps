# Deploying the control-plane Worker to DEVELOPMENT

This is the runbook for bringing up the 280 backend as a Cloudflare Worker in the
**development** environment and pushing the sample apps against it. It replaces
the old Docker container loop (still available behind `--docker`, see the bottom).

`scripts/run-backend.sh` is the entry point. Its default action deploys the
control-plane Worker to development via `wrangler deploy` against
`packages/backend/wrangler.development.jsonc`, running the schema migration first
and refusing to deploy until every precondition below is met. It targets
**development only** and will not touch the prod config or route.

Everything in the **One-time provisioning** and **Secrets** sections needs the
captain's Cloudflare account credentials. Run them once per account. After that,
day-to-day work is just the **Deploy** and **Validate** sections.

---

## 0. Prerequisites

- Node 20+ and `pnpm` (the repo's package manager).
- `wrangler`, authenticated to the correct Cloudflare account. The script calls
  `wrangler whoami`; if you are not logged in it stops and tells you to run
  `wrangler login`. The script uses a `wrangler` on your `PATH` if present,
  otherwise it downloads a pinned version with `npx` (`WRANGLER_VERSION`,
  default `4.113.0`, matching the dispatcher). Override the whole command with
  the `WRANGLER` env var (e.g. `WRANGLER="pnpm exec wrangler"`).
- A **direct** dev Postgres DSN (the plain Neon primary URL, NOT the
  Hyperdrive/pooler endpoint), exported as `MIGRATE_DATABASE_URL`. Migrations
  run DDL and must not go through a transaction-mode pooler.

---

## 1. One-time provisioning (per Cloudflare account)

### 1a. R2 bucket + dev Hyperdrive config

Run the bootstrap script from `packages/backend/`. It creates the dev R2 bucket
(`two80-blobs-development`) and the dev Hyperdrive config with **query caching
disabled** (an enabled cache silently breaks the device-login and deploy-poll
read-your-writes loops):

```sh
cd packages/backend
export DEV_NEON_URL='postgres://USER:PASS@HOST/DB?sslmode=require'   # direct dev DSN
export PROD_NEON_URL='...'                                           # only if also doing prod
./scripts/bootstrap-resources.sh
```

The bucket create is safe to re-run. The `wrangler hyperdrive create` command
prints a **config id** for the dev Hyperdrive. Run it once.

### 1b. Paste the Hyperdrive id into the dev config

Open `packages/backend/wrangler.development.jsonc` and replace the placeholder in
the `hyperdrive[].id` field:

```jsonc
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "REPLACE_WITH_DEVELOPMENT_HYPERDRIVE_ID" }],
```

with the id printed in step 1a. `run-backend.sh` refuses to deploy while this
placeholder is still present.

---

## 2. Secrets (per environment, against the development worker)

Set each secret against the development config. `wrangler secret put` creates the
worker if it does not exist yet, so this is fine to do before the first deploy:

```sh
cd packages/backend
wrangler secret put GOOGLE_CLIENT_ID     --config wrangler.development.jsonc
wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.development.jsonc
wrangler secret put CF_ACCOUNT_ID        --config wrangler.development.jsonc
wrangler secret put CF_API_TOKEN         --config wrangler.development.jsonc
wrangler secret put DATABASE_URL         --config wrangler.development.jsonc   # dev Neon DSN
```

`run-backend.sh` checks that all five exist on the dev worker before deploying,
and names any that are missing.

---

## 3. Schema

The deploy step runs the migration runner for you (`pnpm --filter @280/backend
migrate`, i.e. `node dist/migrate.js`) against the direct DSN in
`MIGRATE_DATABASE_URL`, applying the shared idempotent statement list from
`src/store/migrations.ts` under the `platform` schema. It is idempotent, so
re-running is safe.

To apply the schema by hand (e.g. from CI), without deploying:

```sh
export MIGRATE_DATABASE_URL='postgres://USER:PASS@HOST/DB?sslmode=require'   # direct dev DSN
pnpm --filter @280/backend build
pnpm --filter @280/backend migrate
```

---

## 4. Deploy

With provisioning, secrets, and the Hyperdrive id in place:

```sh
export MIGRATE_DATABASE_URL='postgres://USER:PASS@HOST/DB?sslmode=require'   # direct dev DSN
scripts/run-backend.sh
```

What it does, in order, stopping with an actionable error if any check fails:

1. Asserts the config is the development target (never prod).
2. Checks `wrangler` is authenticated (`wrangler whoami`).
3. Checks the dev Hyperdrive id is filled in (not the `REPLACE_WITH_...` placeholder).
4. Checks `MIGRATE_DATABASE_URL` is set (the direct migration DSN).
5. Checks the five required secrets exist on the dev worker.
6. Checks the dev R2 bucket (`two80-blobs-development`) exists.
7. Builds the backend and runs the migration against the dev database.
8. `wrangler deploy --config wrangler.development.jsonc`.

On success the development API is served at `https://api-development.280apps.com`.
Note the edge can lag ~1 minute after a deploy.

### Validate the bundle without credentials

To bundle and validate the Worker entry (`src/worker.ts`) and its bindings
without publishing (no account write access needed, works with the placeholder
Hyperdrive id):

```sh
scripts/run-backend.sh --dry-run
```

This runs `wrangler deploy --dry-run` and is the pre-credential validation path.

---

## 5. Validate: push both sample apps

`scripts/push-local.sh` builds the local-tree CLI and pushes a sample app.
Point it at the development API with `TWO80_API` (it defaults to the old local
container at `http://localhost:8080`, which is not what we want here):

```sh
export TWO80_API="https://api-development.280apps.com"

# static app
scripts/push-local.sh sample-apps/1-static

# Next.js app (push-local.sh installs deps and runs `next build` for you)
scripts/push-local.sh sample-apps/2-nextjs
```

The first push prints `authorization_pending` with a device link and code:
approve the link once in the browser (the stable `TWO80_HOME` creds persist for
later runs), then re-run the push to redeem the token.

Each push prints the app URL. Development apps serve at
`<script>-development.280apps.run`, so open, for example:

- `https://<static-script>-development.280apps.run`
- `https://<nextjs-script>-development.280apps.run`

To push a **fresh** app (new binding) instead of re-pushing the same one,
`rm -rf ~/.280-local/app` first (see `push-local.sh` for the details).

---

## Legacy: Docker path

The old Docker build+run loop is preserved behind an explicit flag, kept until
the Worker loop reaches parity so nobody is blocked:

```sh
scripts/run-backend.sh --docker              # build image, replace the container
scripts/run-backend.sh --docker --no-build   # reuse the image, just recreate
scripts/run-backend.sh --docker --logs       # follow container logs after start
```

The Docker path serves the backend at `http://localhost:8080`; with it, push the
sample apps with the default `TWO80_API` (i.e. do not set `TWO80_API`).

Run `scripts/run-backend.sh --help` for the full flag and env-var reference.
