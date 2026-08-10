# TS platform image (control plane: HTTP API v1 + activation).
#
# Build context is the repo ROOT (the pnpm workspace), so the workspace
# dependency @280/contracts resolves:
#
#   docker build -f packages/backend/Dockerfile -t 280-platform .
#
# This is the Railway cutover target: it runs the Node control plane
# (src/main.ts) directly. Blobs live on R2 over its S3 API (BLOB_S3_*), Postgres
# is dialed directly via DATABASE_URL, and activation runs in-process. See
# .env.example for the full env set.

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable

# Manifests first: a source-only change then reuses the installed store.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/backend/package.json packages/backend/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/gateway/package.json packages/gateway/package.json
RUN pnpm install --frozen-lockfile

# Sources, then build the packages the platform runs on plus @280/gateway, whose
# verify-and-forward middleware is vendored into the per-app harness Worker below.
COPY packages/contracts packages/contracts
COPY packages/backend packages/backend
COPY packages/gateway packages/gateway
RUN pnpm --filter @280/contracts build \
 && pnpm --filter @280/backend build \
 && pnpm --filter @280/gateway build

# A self-contained deploy tree: prod deps (including the built @280/contracts,
# flattened into node_modules) plus the platform package's dist.
RUN pnpm --filter @280/backend deploy --prod --legacy /app

# Runtime image. node:22-slim (not distroless) so the control plane can shell out
# to the two build/roll CLIs it now orchestrates (report §5, stage 3):
#   - depot   : daemonless remote BuildKit; `depot build --push` compiles the app
#               image and pushes it to registry.cloudflare.com with no Docker here.
#   - wrangler: rolls the app's container application onto the pre-built image
#               (`wrangler deploy --containers-rollout immediate`).
# Depot is the sole build home; it needs DEPOT_TOKEN and CLOUDFLARE_* set (or run
# APP_RUNTIME=memory to record deploys without building).
FROM node:22-slim
WORKDIR /app

# depot is a static binary from its install script (pinned via ARG); wrangler is
# the same version platform/appcontainer pins. curl is used only to fetch depot and
# is removed after; ca-certificates stays for the CLIs' outbound HTTPS.
# DEPOT_INSTALL_DIR forces depot onto /usr/local/bin: the script's default
# $HOME/.depot/bin is off the runtime PATH, so the host would spawn depot ENOENT.
ARG DEPOT_CLI_VERSION=2.101.76
ARG WRANGLER_VERSION=4.116.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -L https://depot.dev/install-cli.sh | DEPOT_INSTALL_DIR=/usr/local/bin sh -s "$DEPOT_CLI_VERSION" \
 && npm install -g "wrangler@$WRANGLER_VERSION" \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app

# Vendor the App280Container harness Worker (the roll config's `main`) so `wrangler
# deploy` can bundle it during the roll. Without this the roll fails "entry-point
# worker.js not found". `npm install` supplies @cloudflare/containers + zod (the
# middleware's transitive runtime dep); the built @280/gateway (its verify-and-forward
# middleware) and @280/contracts are copied flat into the harness node_modules so
# wrangler's esbuild resolves `@280/gateway/appworker` -> `@280/contracts` at bundle
# time. @280/gateway declares @280/backend as a dep, but the middleware never imports
# it, so it is intentionally not vendored (and never enters the tenant bundle).
# APP_WORKER_ENTRYPOINT points the generated roll config at the vendored entry
# using an absolute path so it resolves from any build-context cwd.
COPY platform/appcontainer /app/appcontainer
RUN npm install --omit=dev --prefix /app/appcontainer
COPY --from=build /repo/packages/gateway/package.json /app/appcontainer/node_modules/@280/gateway/package.json
COPY --from=build /repo/packages/gateway/dist /app/appcontainer/node_modules/@280/gateway/dist
COPY --from=build /repo/packages/contracts/package.json /app/appcontainer/node_modules/@280/contracts/package.json
COPY --from=build /repo/packages/contracts/dist /app/appcontainer/node_modules/@280/contracts/dist
ENV APP_WORKER_ENTRYPOINT=/app/appcontainer/src/worker.js

EXPOSE 8080
# node:22-slim has no default entrypoint (unlike distroless-nodejs), so name node.
CMD ["node", "dist/main.js"]
