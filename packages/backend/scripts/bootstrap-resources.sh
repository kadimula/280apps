#!/usr/bin/env bash
#
# One-time bootstrap for the 280 control-plane Worker's stateful resources.
#
# These resources are referenced by packages/backend/wrangler.jsonc (prod) and
# wrangler.development.jsonc (dev). They are created ONCE per Cloudflare account
# and then live for the lifetime of the deployment — this script exists so that
# creation is recorded here in the repo instead of being dashboard folklore.
#
# It creates, for BOTH prod and development:
#   * an R2 bucket for deploy blobs
#   * a Hyperdrive config pointing at the existing PostgreSQL database, with
#     query caching DISABLED
#
# It does NOT create the Durable Object namespace, KV, or secrets: DO namespaces
# come up with the first `wrangler deploy` (migration tag v1), and secrets are set
# with `wrangler secret put` (see the wrangler configs).
#
# ============================================================================
#  READ THIS: HYPERDRIVE QUERY CACHING MUST BE DISABLED IN EVERY ENVIRONMENT.
# ============================================================================
# Hyperdrive's query cache serves stale rows for a TTL after a write. The 280
# device-login flow and the deploy-poll flow both depend on read-your-writes:
# the CLI writes a device code / deploy record and immediately polls for it, and
# the login browser redeems a code the API just created. An enabled cache
# silently returns the pre-write state and those loops hang or fail with no error.
# Every Hyperdrive config below is created with --caching-disabled. If you ever
# find a 280 Hyperdrive config with caching ENABLED, treat it as a provisioning
# BUG and disable it — do not "tune" the TTL.
# ============================================================================
#
# This script is NOT meant to be run blind. Read it, set the variables below,
# and run the commands yourself. It is written to be idempotent-ish (bucket
# creation is safe to re-run; Hyperdrive create will make a NEW config each time,
# so only run those once and record the printed ids in the wrangler files).
#
# Prereqs: `wrangler`, authenticated to the correct Cloudflare account
# (`wrangler whoami`). Run from packages/backend/.

set -euo pipefail

# --- fill these in -----------------------------------------------------------

# R2 bucket names — must match the r2_buckets bucket_name in the wrangler files.
PROD_BUCKET="two80-blobs"
DEV_BUCKET="two80-blobs-development"

# Hyperdrive config names (labels only; the binding is HYPERDRIVE in both files).
PROD_HYPERDRIVE_NAME="two80-backend-prod"
DEV_HYPERDRIVE_NAME="two80-backend-development"

# PostgreSQL connection strings for the existing project (prod + dev roles/
# databases). DO NOT commit real values — export them in your shell first, e.g.
#   export PROD_DATABASE_URL='postgres://...'
#   export DEV_DATABASE_URL='postgres://...'
PROD_DATABASE_URL="${PROD_DATABASE_URL:-}"
DEV_DATABASE_URL="${DEV_DATABASE_URL:-}"

# -----------------------------------------------------------------------------

echo "==> R2 buckets"
# Safe to re-run; wrangler no-ops if the bucket already exists.
wrangler r2 bucket create "$PROD_BUCKET"
wrangler r2 bucket create "$DEV_BUCKET"

echo
echo "==> Hyperdrive (caching DISABLED — do not remove --caching-disabled)"
if [[ -z "$PROD_DATABASE_URL" || -z "$DEV_DATABASE_URL" ]]; then
	echo "PROD_DATABASE_URL / DEV_DATABASE_URL are unset. Export them, then re-run the"
	echo "Hyperdrive commands below by hand. Run each ONCE and copy the printed"
	echo "config id into the matching wrangler file's hyperdrive[].id."
	echo
	echo "  wrangler hyperdrive create $PROD_HYPERDRIVE_NAME --caching-disabled \\"
	echo "    --connection-string \"\$PROD_DATABASE_URL\""
	echo
	echo "  wrangler hyperdrive create $DEV_HYPERDRIVE_NAME --caching-disabled \\"
	echo "    --connection-string \"\$DEV_DATABASE_URL\""
	exit 0
fi

# Each create prints a config id. Paste PROD's id into wrangler.jsonc and DEV's
# id into wrangler.development.jsonc (the REPLACE_WITH_*_HYPERDRIVE_ID slots).
wrangler hyperdrive create "$PROD_HYPERDRIVE_NAME" --caching-disabled \
	--connection-string "$PROD_DATABASE_URL"

wrangler hyperdrive create "$DEV_HYPERDRIVE_NAME" --caching-disabled \
	--connection-string "$DEV_DATABASE_URL"

echo
echo "==> Done. Now:"
echo "  1. Copy each Hyperdrive config id into the matching wrangler file."
echo "  2. Set secrets: wrangler secret put GOOGLE_CLIENT_ID (and GOOGLE_CLIENT_SECRET,"
echo "     CF_ACCOUNT_ID, CF_API_TOKEN, DATABASE_URL)."
echo "  3. Deploy: wrangler deploy  (creates the APP_ACTIVATOR Durable Object, tag v1)."
