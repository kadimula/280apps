#!/usr/bin/env bash
# Production harness bundle smoke: prove the per-app Worker (src/worker.js, the roll
# config's `main`) bundles from the ACTUAL vendored layout the backend image builds —
# @280/gateway, @280/contracts, and @280/egress copied flat into node_modules. Root
# typecheck and lint do not cover this isolated JavaScript harness or its cross-package
# import resolution, so a broken vendoring (a missing dist, a renamed export) would
# otherwise only surface at deploy time as "Could not resolve". Mirrors the Dockerfile
# build+vendor stage, then runs a `wrangler deploy --dry-run` esbuild bundle and
# asserts the egress data path actually resolved into the output.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "[smoke] building vendored packages"
pnpm --dir "$repo" --filter @280/contracts --filter @280/gateway --filter @280/egress build >/dev/null

echo "[smoke] staging appcontainer + installing harness deps"
cp -R "$repo/platform/appcontainer/." "$work/"
rm -rf "$work/node_modules"
npm --prefix "$work" install --silent >/dev/null 2>&1

# Vendor the workspace packages flat into node_modules, exactly as packages/backend/Dockerfile does.
for pkg in contracts gateway egress; do
  dest="$work/node_modules/@280/$pkg"
  mkdir -p "$dest"
  cp "$repo/packages/$pkg/package.json" "$dest/package.json"
  cp -R "$repo/packages/$pkg/dist" "$dest/dist"
done

# A deployable-shaped config: the reference wrangler.jsonc carries a placeholder image
# ref the real roll fills in, which fails config validation. This mirrors the roll's
# generated shape (main -> worker.js, App280Container bound as APP) with a valid image
# tag so validation passes and the bundle proceeds.
cat > "$work/smoke.wrangler.json" <<'JSON'
{
  "name": "280-appcontainer-smoke",
  "main": "src/worker.js",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "class_name": "App280Container", "name": "APP" }] },
  "containers": [
    { "class_name": "App280Container", "image": "registry.cloudflare.com/app:latest", "instance_type": "lite", "max_instances": 1 }
  ],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["App280Container"] }]
}
JSON

echo "[smoke] wrangler dry-run bundle"
out="$work/bundle-out"
log="$work/wrangler.log"
if ! npm --prefix "$work" exec -- wrangler deploy --dry-run \
  --config "$work/smoke.wrangler.json" --outdir "$out" >"$log" 2>&1; then
  echo "[smoke] FAIL: wrangler bundle exited non-zero" >&2
  cat "$log" >&2
  exit 1
fi
if grep -qiE 'could not resolve|build failed' "$log"; then
  echo "[smoke] FAIL: bundle reported an unresolved import" >&2
  cat "$log" >&2
  exit 1
fi

# The bundle succeeding is not enough: assert the egress data path (and its typed
# minter) actually resolved into the output, so a tree-shaken-away or stubbed import
# cannot pass silently.
for marker in 280-egress makeEgressHandler oauth2.googleapis.com; do
  if ! grep -rq "$marker" "$out"; then
    echo "[smoke] FAIL: expected marker '$marker' missing from bundle (egress not resolved)" >&2
    exit 1
  fi
done

echo "[smoke] OK: gateway, contracts, and egress resolve from the vendored layout"
