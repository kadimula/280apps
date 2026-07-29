# 02-next manifest-diff fixture

Real `.open-next` output for `tests/280-test-cases/02-next`, used by
`manifest-diff.test.ts` to prove TS `nextBundle` builds a byte-identical manifest
to the Go CLI.

- `open-next/assets/`, `open-next/cache/`: verbatim adapter output (OpenNext
  `@opennextjs/cloudflare@1.20.2`, `wrangler@4.113.0`).
- `worker.js`: a small stand-in. The real bundled worker is ~4.2 MB; only its
  digest + size reach the manifest, which any bytes exercise identically.
- `manifest.golden.json`: Go `json.Marshal(bundle.Manifest)` over exactly these
  bytes (compact, no trailing newline).

## Regenerate

Only if the pinned adapter/wrangler versions change. Rebuild `02-next`, run the
Go adapter + wrangler to produce `open-next/`, drop in the stand-in `worker.js`,
then emit the golden with a throwaway Go test in `cli/internal/bundle` calling
`nextBundle(fixtureDir/open-next, worker)` and writing `json.Marshal(manifest)`.
Go stays authoritative for the golden.
