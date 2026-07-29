#!/usr/bin/env bash
#
# push-local.sh: build the local-tree 280 CLI and push a working copy of a
# static or Next.js app at the local backend, sandboxed from your real 280
# login and apps.
#
#   TWO80_API   local backend            (http://localhost:8080)
#   TWO80_HOME  stable local creds dir    (~/.280-local/home)  -- log in once
#   APP_DIR     stable app working copy    (~/.280-local/app)   -- kept between runs
#
# Usage:  scripts/push-local.sh <app-dir>   (static index.html, or a Next.js app)
# Fresh app (new binding):  rm -rf ~/.280-local/app  first.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:?usage: scripts/push-local.sh <static-app-dir>}"

export TWO80_API="${TWO80_API:-http://localhost:8080}"
export TWO80_HOME="${TWO80_HOME:-$HOME/.280-local/home}"
APP_DIR="${APP_DIR:-$HOME/.280-local/app}"

# Latest local CLI, invoked by explicit path so a global `two80` can't shadow it.
pnpm --filter two80 build >/dev/null

# Sync source into the stable app dir. No --delete: the .280/ binding (and thus
# the app's identity) survives, so re-runs push the SAME local app. node_modules
# and build output are excluded from the copy; for a Next.js app they are
# regenerated in the app dir below and then persist between runs.
mkdir -p "$APP_DIR"
rsync -a --exclude node_modules --exclude .next --exclude .git "${SOURCE%/}/" "$APP_DIR/"

cd "$APP_DIR"

# The CLI deploys a build; it does not build your app for you. A Next.js app
# must be compiled to its standalone tree (next.config output: "standalone")
# before the push, or the CLI rejects it with `no Next.js build found at .next`.
# A static app (index.html, no package.json) needs no build step. Detect Next.js
# the same way the CLI does: a `next` dependency in package.json.
if [ -f package.json ] && grep -Eq '"next"[[:space:]]*:' package.json; then
  echo "push-local: Next.js app detected; installing deps and building" >&2
  if [ -f pnpm-lock.yaml ]; then
    pnpm install --frozen-lockfile || pnpm install
  elif [ -f package-lock.json ]; then
    npm ci || npm install
  elif [ -f yarn.lock ]; then
    yarn install --frozen-lockfile || yarn install
  else
    npm install
  fi
  npx next build
fi

# Push from the app dir. First run prints `authorization_pending`: approve the
# printed link once; the stable TWO80_HOME creds persist for later runs.
exec node "$REPO_ROOT/packages/cli/dist/bin.js" push
