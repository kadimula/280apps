# TS platform image (control plane: HTTP API v1 + activation).
#
# Build context is the repo ROOT (the pnpm workspace), so the workspace
# dependency @280/contracts resolves:
#
#   docker build -f packages/backend/Dockerfile -t 280-platform .
#
# This is the Railway cutover target: it runs the Node control plane
# (src/main.ts) directly. Blobs live on R2 over its S3 API (TWO80_S3_*), Postgres
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
RUN pnpm install --frozen-lockfile

# Sources, then build the two packages the platform runs on.
COPY packages/contracts packages/contracts
COPY packages/backend packages/backend
RUN pnpm --filter @280/contracts build && pnpm --filter @280/backend build

# A self-contained deploy tree: prod deps (including the built @280/contracts,
# flattened into node_modules) plus the platform package's dist.
RUN pnpm --filter @280/backend deploy --prod --legacy /app

# Distroless nodejs22. Production blobs are on R2 (no host-mounted volume); the
# filesystem blob store is only the local-dev fallback.
FROM gcr.io/distroless/nodejs22-debian12
WORKDIR /app
COPY --from=build /app /app
EXPOSE 8080
# distroless-nodejs entrypoint is node; this runs /app/dist/main.js.
CMD ["dist/main.js"]
