// Manifest parity vs the Go CLI (plan W3 "Done"). The fixture under
// testdata/02-next is the real .open-next assets + cache trees the Go CLI
// produced for tests/280-test-cases/02-next, paired with a small stand-in worker
// (the real worker is 4.2 MB; only its digest+size reach the manifest, which any
// bytes exercise identically). manifest.golden.json is Go's own
// json.Marshal(manifest) over exactly these committed bytes.
//
// TS nextBundle over the same tree must reproduce that JSON byte for byte. This
// pins the whole manifest-assembly path — asset walk order, path shaping, cache
// key derivation, worker digest/size — against the Go implementation.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, manifestSchema, type BlobInfo, type Manifest } from '@280/contracts';
import { nextBundle } from './next.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'testdata', '02-next');

// goMarshalBlobInfo mirrors Go json.Marshal of deploy.BlobInfo: field order
// Path, Digest, Size; Path omitted when empty (json:"path,omitempty"); Size
// always present (no omitempty).
function goMarshalBlobInfo(b: BlobInfo): string {
  const parts: string[] = [];
  if (b.path !== '') {
    parts.push(`"path":${JSON.stringify(b.path)}`);
  }
  parts.push(`"digest":${JSON.stringify(b.digest)}`);
  parts.push(`"size":${b.size}`);
  return `{${parts.join(',')}}`;
}

// goMarshalManifest mirrors Go json.Marshal of deploy.Manifest: field order
// Kind, Worker, Assets, Cache; Cache omitted when empty (json:"cache,omitempty").
// Assets is always present (no omitempty) and marshals a nil slice as null.
function goMarshalManifest(m: Manifest): string {
  const parts: string[] = [
    `"kind":${JSON.stringify(m.kind)}`,
    `"worker":${goMarshalBlobInfo(m.worker)}`,
  ];
  parts.push(`"assets":${m.assets.length === 0 ? 'null' : `[${m.assets.map(goMarshalBlobInfo).join(',')}]`}`);
  if (m.cache.length > 0) {
    parts.push(`"cache":[${m.cache.map(goMarshalBlobInfo).join(',')}]`);
  }
  return `{${parts.join(',')}}`;
}

describe('02-next manifest parity vs the Go CLI', () => {
  const worker = readFileSync(join(fixtureDir, 'worker.js'));
  const golden = readFileSync(join(fixtureDir, 'manifest.golden.json'), 'utf8');
  const bundle = nextBundle(join(fixtureDir, 'open-next'), worker);

  it('reproduces Go json.Marshal(manifest) byte for byte', () => {
    expect(goMarshalManifest(bundle.manifest)).toBe(golden);
  });

  it('agrees on the canonical manifest digest', () => {
    const goManifest = manifestSchema.parse(JSON.parse(golden));
    expect(canonicalDigest(bundle.manifest)).toBe(canonicalDigest(goManifest));
  });

  it('names 10 assets and 3 cache entries with content for every blob', () => {
    expect(bundle.manifest.assets).toHaveLength(10);
    expect(bundle.manifest.cache).toHaveLength(3);
    for (const b of [bundle.manifest.worker, ...bundle.manifest.assets, ...bundle.manifest.cache]) {
      expect(bundle.content.has(b.digest)).toBe(true);
    }
  });
});
