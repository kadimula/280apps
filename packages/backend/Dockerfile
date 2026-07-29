# TS platform image (control plane: HTTP API v1 + activation).
#
# Build context is the repo ROOT (the pnpm workspace), so the workspace
# dependency @280/contracts resolves:
#
#   docker build -f packages/backend/Dockerfile -t 280-platform .
#
# This is the cutover target (plan Gate E): the same Railway service swaps the
# Go image for this one, inheriting the blob volume, the env, and DATABASE_URL.

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

# Distroless nodejs22. Root, not :nonroot: the blob volume is host-mounted and
# blobstore.open must mkdir under it; a uid mismatch fails at first push rather
# than at boot, which mirrors the Go image's reasoning.
FROM gcr.io/distroless/nodejs22-debian12
WORKDIR /app
COPY --from=build /app /app
EXPOSE 8080
# distroless-nodejs entrypoint is node; this runs /app/dist/main.js.
CMD ["dist/main.js"]
