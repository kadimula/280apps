#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

WATCH=0
[ "${1:-}" = "--watch" ] && WATCH=1

[ -x node_modules/.bin/wrangler ] || pnpm install
export PATH="$PWD/node_modules/.bin:$PATH"
[ -f dist/main.js ] || npm run --silent build
[ -f .dev-local-secret-key ] || openssl rand -base64 32 > .dev-local-secret-key

# Reproduce the Dockerfile's appcontainer assembly locally so the roll's wrangler (run in a lone temp dir) resolves an absolute, self-contained harness worker.
REPO_ROOT="$PWD/../.."
APPC="$REPO_ROOT/platform/appcontainer"
[ -f "$REPO_ROOT/packages/gateway/dist/appworker.js" ] || pnpm --filter @280/gateway build
[ -d "$APPC/node_modules/@cloudflare/containers" ] || npm install --omit=dev --prefix "$APPC"
mkdir -p "$APPC/node_modules/@280"
ln -sfn ../../../../packages/gateway "$APPC/node_modules/@280/gateway"
ln -sfn ../../../../packages/contracts "$APPC/node_modules/@280/contracts"
export APP_WORKER_ENTRYPOINT="$APPC/src/worker.js"

BUILD_TOKENS_FILE=.dev-local-build-tokens.env
REQUIRED_TOKENS='DEPOT_API_TOKEN DEPOT_BUILD_PROJECT_ID CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_DEPLOY_API_TOKEN GOOGLE_OIDC_CLIENT_ID GOOGLE_OIDC_CLIENT_SECRET GOOGLE_INTEGRATION_CLIENT_ID GOOGLE_INTEGRATION_CLIENT_SECRET GOOGLE_PICKER_API_KEY GOOGLE_PROJECT_NUMBER MICROSOFT_ENTRA_OIDC_CLIENT_ID MICROSOFT_ENTRA_OIDC_CLIENT_SECRET'
need_fetch=0
for k in $REQUIRED_TOKENS; do grep -q "^$k=" "$BUILD_TOKENS_FILE" 2>/dev/null || need_fetch=1; done
if [ "$need_fetch" = 1 ]; then
  echo "fetching build tokens from Railway (development/platform-development)…" >&2
  railway variables -e development -s platform-development --kv 2>/dev/null \
    | grep -E '^(DEPOT_API_TOKEN|DEPOT_BUILD_PROJECT_ID|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_DEPLOY_API_TOKEN|GOOGLE_OIDC_CLIENT_ID|GOOGLE_OIDC_CLIENT_SECRET|GOOGLE_INTEGRATION_CLIENT_ID|GOOGLE_INTEGRATION_CLIENT_SECRET|GOOGLE_PICKER_API_KEY|GOOGLE_PROJECT_NUMBER|MICROSOFT_ENTRA_OIDC_CLIENT_ID|MICROSOFT_ENTRA_OIDC_CLIENT_SECRET)=' \
    > "$BUILD_TOKENS_FILE" || true
  for k in $REQUIRED_TOKENS; do
    grep -q "^$k=" "$BUILD_TOKENS_FILE" || { echo "missing $k in Railway (development/platform-development): run 'railway login' and link the 280-prod project, then retry" >&2; exit 1; }
  done
fi
set -a; . "./$BUILD_TOKENS_FILE"; set +a

# Default to the shared dev control-plane database
DB_URL_FILE=.dev-local-database-url
if [ -z "${DATABASE_URL:-}" ] && [ ! -s "$DB_URL_FILE" ]; then
  echo "fetching dev DATABASE_URL from Railway (development/platform-development)…" >&2
  railway variables -e development -s platform-development --kv 2>/dev/null \
    | sed -n 's/^DATABASE_URL=//p' > "$DB_URL_FILE" || true
  [ -s "$DB_URL_FILE" ] || { echo "missing DATABASE_URL in Railway (development/platform-development): run 'railway login' and link the project, then retry" >&2; exit 1; }
fi
export DATABASE_URL="${DATABASE_URL:-$(cat "$DB_URL_FILE")}"
export APP_SECRET_LOCAL_MASTER_KEY="$(cat .dev-local-secret-key)"
export APP_SECRET_LOCAL_KEY_ID=dev-local
export PORT="${PORT:-8080}"


export RAILWAY_ENVIRONMENT_NAME="${RAILWAY_ENVIRONMENT_NAME:-development}"
export TWO80_API_ORIGIN="${TWO80_API_ORIGIN:-http://localhost:${PORT}}"
export TWO80_DASHBOARD_ORIGIN="${TWO80_DASHBOARD_ORIGIN:-http://localhost:3000}"
export TWO80_COOKIE_DOMAIN=""
# The SDK origin baked into deployed containers must stay real HTTPS
export TWO80_SDK_API_ORIGIN="${TWO80_SDK_API_ORIGIN:-https://api-development.280apps.com}"

if [ "$WATCH" = 0 ]; then
  exec node dist/main.js
fi

npx tsc -p tsconfig.json --watch --preserveWatchOutput &
TSC_PID=$!
trap 'kill "$TSC_PID" 2>/dev/null || true' EXIT INT TERM
node --watch dist/main.js
