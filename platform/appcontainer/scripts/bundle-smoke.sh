#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "[smoke] building vendored packages"
pnpm --dir "$repo" --filter @280/contracts --filter @280/gateway build >/dev/null

echo "[smoke] staging appcontainer + installing harness deps"
cp -R "$repo/platform/appcontainer/." "$work/"
rm -rf "$work/node_modules"
npm --prefix "$work" install --silent >/dev/null 2>&1

for pkg in contracts gateway; do
  dest="$work/node_modules/@280/$pkg"
  mkdir -p "$dest"
  cp "$repo/packages/$pkg/package.json" "$dest/package.json"
  cp -R "$repo/packages/$pkg/dist" "$dest/dist"
done

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

for marker in ContainerProxy TWO80_SDK_API_ORIGIN TWO80_API; do
  if ! grep -rq "$marker" "$out"; then
    echo "[smoke] FAIL: expected marker '$marker' missing from bundle" >&2
    exit 1
  fi
done

if grep -rq '@280/egress\|makeEgressHandler\|oauth2.googleapis.com' "$out"; then
  echo "[smoke] FAIL: retired egress handler remains in bundle" >&2
  exit 1
fi

echo "[smoke] OK: fixed SDK API boundary resolves from the vendored layout"
