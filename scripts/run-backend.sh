#!/usr/bin/env bash
#
# run-backend.sh: build the latest control-plane image from the pnpm workspace
# and (re)start a single dedicated container for it.
#
# The image is packages/backend/Dockerfile, whose build context is the repo
# ROOT so the whole workspace (contracts + backend) is compiled in. We keep one
# dedicated container by name: if it already exists we stop and remove it, then
# start a fresh one on the newly built image. That way the container always runs
# whatever the latest code in the tree is.
#
# Usage:
#   scripts/run-backend.sh            build latest, replace the container
#   scripts/run-backend.sh --no-build reuse the existing image, just recreate
#   scripts/run-backend.sh --logs     follow logs after starting
#
# Config (env vars, with defaults):
#   IMAGE      docker image tag            (280-platform)
#   CONTAINER  dedicated container name    (280-backend)
#   PORT       host port -> container 8080 (8080)
#   ENV_FILE   env file passed to the run  (<repo>/.env)
#   BLOB_VOL   named volume for blob store (280-backend-blobs)

set -euo pipefail

# Resolve the repo root from this script's location so it runs from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE="${IMAGE:-280-platform}"
CONTAINER="${CONTAINER:-280-backend}"
PORT="${PORT:-8080}"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env}"
BLOB_VOL="${BLOB_VOL:-280-backend-blobs}"

BUILD=1
FOLLOW_LOGS=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --logs) FOLLOW_LOGS=1 ;;
    -h | --help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

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
ENV_ARGS=()
if [[ -f "$ENV_FILE" ]]; then
  ENV_ARGS=(--env-file "$ENV_FILE")
  echo "using env file: $ENV_FILE"
else
  echo "warning: no env file at $ENV_FILE; the backend needs DATABASE_URL to boot" >&2
fi

if [[ "$BUILD" -eq 1 ]]; then
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
  "${ENV_ARGS[@]}" \
  "$IMAGE" >/dev/null

echo "container '$CONTAINER' is up:  http://localhost:${PORT}"
docker ps --filter "name=^/${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
  echo "--- following logs (ctrl-c to stop) ---"
  docker logs -f "$CONTAINER"
else
  echo "view logs with:  docker logs -f $CONTAINER"
fi
