#!/usr/bin/env bash
#
# run-backend.sh: bring up the 280 control-plane backend for local development.
#
# DEFAULT (Worker): deploy the control-plane Worker to the DEVELOPMENT
# Cloudflare environment with `wrangler deploy`, using
# packages/backend/wrangler.development.jsonc. Before deploying it runs the
# schema migration runner against the development database over a DIRECT
# connection, and it refuses to deploy until a set of preconditions is met.
# This targets DEVELOPMENT ONLY and will not touch the prod config or route.
#
# --docker: the legacy path, preserved verbatim. Build the control-plane image
# from the pnpm workspace and (re)start a single dedicated container for it.
#
# Usage:
#   scripts/run-backend.sh                 deploy the Worker to DEVELOPMENT (default)
#   scripts/run-backend.sh --dry-run       bundle + validate the Worker, do not publish
#   scripts/run-backend.sh --docker        legacy: build image, replace the container
#   scripts/run-backend.sh --docker --no-build   legacy: reuse the image, just recreate
#   scripts/run-backend.sh --docker --logs       legacy: follow container logs after start
#   scripts/run-backend.sh --help          show this help
#
# Worker path env vars (with defaults):
#   MIGRATE_DATABASE_URL   DIRECT dev Postgres DSN for the schema runner (required;
#                          NOT the Hyperdrive/pooler endpoint: plain primary URL)
#   WRANGLER_VERSION       wrangler version used via npx      (4.113.0, matches dispatcher)
#   WRANGLER               override the wrangler command      (e.g. "pnpm exec wrangler")
#
# Docker path env vars (with defaults):
#   IMAGE      docker image tag            (280-platform)
#   CONTAINER  dedicated container name    (280-backend)
#   PORT       host port -> container 8080 (8080)
#   ENV_FILE   env file passed to the run  (<repo>/.env)
#   BLOB_VOL   named volume for blob store (280-backend-blobs)

set -euo pipefail

# Resolve the repo root from this script's location so it runs from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BACKEND_DIR="${REPO_ROOT}/packages/backend"
# The Worker path is hard-wired to the DEVELOPMENT config. There is deliberately
# no way to point this script at wrangler.jsonc (prod): see assert_development().
DEV_CONFIG="${BACKEND_DIR}/wrangler.development.jsonc"

# Docker path defaults (legacy).
IMAGE="${IMAGE:-280-platform}"
CONTAINER="${CONTAINER:-280-backend}"
PORT="${PORT:-8080}"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env}"
BLOB_VOL="${BLOB_VOL:-280-backend-blobs}"

# Worker path: how we invoke wrangler. A `wrangler` already on PATH wins;
# otherwise fall back to a pinned npx download so this works on a clean machine.
# WRANGLER overrides the whole command (space-separated).
WRANGLER_VERSION="${WRANGLER_VERSION:-4.113.0}"
if [[ -n "${WRANGLER:-}" ]]; then
  read -r -a WRANGLER_CMD <<<"${WRANGLER}"
elif command -v wrangler >/dev/null 2>&1; then
  WRANGLER_CMD=(wrangler)
else
  WRANGLER_CMD=(npx --yes "wrangler@${WRANGLER_VERSION}")
fi

usage() {
  sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'
}

die() {
  echo "error: $1" >&2
  exit 1
}

# --- argument parsing --------------------------------------------------------

MODE="worker" # worker (default) | dryrun | docker
DOCKER_NO_BUILD=0
DOCKER_LOGS=0

for arg in "$@"; do
  case "$arg" in
    --docker) MODE="docker" ;;
    --dry-run) MODE="dryrun" ;;
    --no-build) DOCKER_NO_BUILD=1 ;;
    --logs) DOCKER_LOGS=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

if [[ "$MODE" != "docker" && ("$DOCKER_NO_BUILD" -eq 1 || "$DOCKER_LOGS" -eq 1) ]]; then
  die "--no-build and --logs only apply to the legacy --docker path (add --docker)"
fi

# ============================================================================
#  Docker path (legacy): preserved verbatim from the previous behavior.
# ============================================================================

run_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is not installed or not on PATH" >&2
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "error: docker daemon is not running (start Docker Desktop and retry)" >&2
    exit 1
  fi

  # The backend reads DATABASE_URL (and friends) at runtime; without them boot
  # will fail. Warn loudly rather than silently starting a broken container.
  local env_args=()
  if [[ -f "$ENV_FILE" ]]; then
    env_args=(--env-file "$ENV_FILE")
    echo "using env file: $ENV_FILE"
  else
    echo "warning: no env file at $ENV_FILE; the backend needs DATABASE_URL to boot" >&2
  fi

  if [[ "$DOCKER_NO_BUILD" -eq 0 ]]; then
    echo "building $IMAGE from workspace root ($REPO_ROOT)..."
    docker build -f "${REPO_ROOT}/packages/backend/Dockerfile" -t "$IMAGE" "$REPO_ROOT"
  else
    echo "skipping build (--no-build); reusing existing $IMAGE image"
  fi

  # Check for the dedicated container by exact name. If it exists in any state
  # (running or stopped), remove it so we can recreate on the latest image.
  if docker ps -a --filter "name=^/${CONTAINER}$" --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "existing container '$CONTAINER' found; stopping and removing it"
    docker rm -f "$CONTAINER" >/dev/null
  else
    echo "no existing '$CONTAINER' container; creating a fresh one"
  fi

  echo "starting '$CONTAINER' on port $PORT..."
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p "${PORT}:8080" \
    -v "${BLOB_VOL}:/app/data/blobs" \
    "${env_args[@]}" \
    "$IMAGE" >/dev/null

  echo "container '$CONTAINER' is up:  http://localhost:${PORT}"
  docker ps --filter "name=^/${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

  if [[ "$DOCKER_LOGS" -eq 1 ]]; then
    echo "--- following logs (ctrl-c to stop) ---"
    docker logs -f "$CONTAINER"
  else
    echo "view logs with:  docker logs -f $CONTAINER"
  fi
}

# ============================================================================
#  Worker path (default): deploy the control-plane Worker to DEVELOPMENT.
# ============================================================================

# Refuse to run against anything but the development config. This is the guard
# that keeps the script from ever deploying the prod worker/route: the config is
# fixed to wrangler.development.jsonc above, and here we prove it really is the
# development target before doing anything with real credentials.
assert_development() {
  [[ -f "$DEV_CONFIG" ]] || die "missing dev config: $DEV_CONFIG"
  grep -q '"name": *"280-backend-development"' "$DEV_CONFIG" ||
    die "$DEV_CONFIG is not the development worker (name must be 280-backend-development); refusing"
  # NOTE: development currently serves over the free *.workers.dev URL, so we no
  # longer require the api-development.280apps.com/* route to be present (it is
  # deferred until 280apps.com is a Cloudflare zone). The prod-route guard below
  # is what actually keeps this script from ever deploying the prod target.
  # Belt and suspenders: never proceed if the prod API route leaks into this file.
  if grep -qE '"pattern": *"api\.280apps\.com/\*"' "$DEV_CONFIG"; then
    die "$DEV_CONFIG contains the PROD route api.280apps.com/*; refusing (prod is out of scope for this script)"
  fi
}

# Bundle + validate the entry and bindings without publishing. Needs no account
# write access, no secrets, and works with the placeholder Hyperdrive id: this
# is the pre-credential validation path.
run_dry_run() {
  assert_development
  echo "==> wrangler deploy --dry-run (bundle + validate only, no publish)"
  echo "    config: $DEV_CONFIG"
  ( cd "$BACKEND_DIR" && "${WRANGLER_CMD[@]}" deploy --dry-run --config "$DEV_CONFIG" )
  echo "dry-run OK: the Worker bundles and the bindings validate."
}

check_wrangler_auth() {
  echo "==> checking wrangler is present and authenticated"
  if ! "${WRANGLER_CMD[@]}" whoami >/dev/null 2>&1; then
    die "wrangler is not authenticated. Run:  ${WRANGLER_CMD[*]} login   (then re-run)"
  fi
}

check_hyperdrive_id() {
  echo "==> checking the development Hyperdrive id is filled in"
  if grep -q 'REPLACE_WITH_.*_HYPERDRIVE_ID' "$DEV_CONFIG"; then
    die "the Hyperdrive id in $DEV_CONFIG is still the REPLACE_WITH_... placeholder.
       Create it once with:  cd packages/backend && ./scripts/bootstrap-resources.sh
       then paste the printed dev config id into the hyperdrive[].id field."
  fi
}

check_migrate_url() {
  echo "==> checking the direct migration DSN is set"
  if [[ -z "${MIGRATE_DATABASE_URL:-}" ]]; then
    die "MIGRATE_DATABASE_URL is not set. Export a DIRECT dev Postgres DSN (the plain
       Neon primary URL, NOT the Hyperdrive/pooler endpoint), e.g.:
         export MIGRATE_DATABASE_URL='postgres://USER:PASS@HOST/DB?sslmode=require'"
  fi
}

check_secrets() {
  echo "==> checking required secrets are set on the development worker"
  local required=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET CF_ACCOUNT_ID CF_API_TOKEN DATABASE_URL)
  local listing
  if ! listing="$(cd "$BACKEND_DIR" && "${WRANGLER_CMD[@]}" secret list --config "$DEV_CONFIG" 2>/dev/null)"; then
    die "could not list secrets for the development worker (it may not exist yet, or you are not
       authenticated). Set each secret against the dev config, which also creates the worker:
         cd packages/backend
         for s in ${required[*]}; do ${WRANGLER_CMD[*]} secret put \"\$s\" --config wrangler.development.jsonc; done"
  fi
  local missing=()
  local s
  for s in "${required[@]}"; do
    if ! printf '%s' "$listing" | grep -q "\"$s\""; then
      missing+=("$s")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "missing secrets on the development worker: ${missing[*]}
       Set each with:
         cd packages/backend
         ${WRANGLER_CMD[*]} secret put <NAME> --config wrangler.development.jsonc"
  fi
}

check_r2_bucket() {
  echo "==> checking the development R2 bucket exists"
  local bucket
  bucket="$(grep -oE '"bucket_name": *"[^"]+"' "$DEV_CONFIG" | head -1 | grep -oE '[^"]+"$' | tr -d '"')"
  [[ -n "$bucket" ]] || die "could not read the dev R2 bucket_name from $DEV_CONFIG"
  local listing
  if ! listing="$(cd "$BACKEND_DIR" && "${WRANGLER_CMD[@]}" r2 bucket list 2>/dev/null)"; then
    die "could not list R2 buckets (are you authenticated?). Create the dev bucket with:
         cd packages/backend && ./scripts/bootstrap-resources.sh
       (or:  ${WRANGLER_CMD[*]} r2 bucket create $bucket )"
  fi
  if ! printf '%s' "$listing" | grep -q "$bucket"; then
    die "the development R2 bucket '$bucket' does not exist. Create it with:
         cd packages/backend && ./scripts/bootstrap-resources.sh
       (or:  ${WRANGLER_CMD[*]} r2 bucket create $bucket )"
  fi
}

run_migrations() {
  echo "==> applying the schema to the development database (direct connection)"
  # The runner is node dist/migrate.js, so build the backend first. It honors
  # MIGRATE_DATABASE_URL over DATABASE_URL, and the schema defaults to platform
  # (matches TWO80_DB_SCHEMA in the wrangler config).
  pnpm --filter @280/backend build
  MIGRATE_DATABASE_URL="${MIGRATE_DATABASE_URL}" TWO80_DB_SCHEMA=platform \
    pnpm --filter @280/backend migrate
}

run_deploy() {
  assert_development
  check_wrangler_auth
  check_hyperdrive_id
  check_migrate_url
  check_secrets
  check_r2_bucket

  run_migrations

  echo "==> deploying the control-plane Worker to DEVELOPMENT"
  echo "    config: $DEV_CONFIG"
  ( cd "$BACKEND_DIR" && "${WRANGLER_CMD[@]}" deploy --config "$DEV_CONFIG" )
  echo "deployed: the development API is served at https://api-development.280apps.com"
  echo "next: push a sample app with  scripts/push-local.sh sample-apps/1-static"
}

# --- dispatch ----------------------------------------------------------------

case "$MODE" in
  docker) run_docker ;;
  dryrun) run_dry_run ;;
  worker) run_deploy ;;
esac
