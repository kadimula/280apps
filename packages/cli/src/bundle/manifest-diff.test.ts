// Manifest parity vs the Go CLI: TS nextBundle over the committed 02-next
// .open-next tree must reproduce manifest.golden.json (Go's own
// json.Marshal(manifest)) byte for byte, pinning the whole assembly path.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, manifestSchema, type BlobInfo, type Manifest } from '@280/contracts';
import { nextBundle } from './next.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'testdata', '02-next');

// Mirrors Go json.Marshal of deploy.BlobInfo: field order Path, Digest, Size;
// Path omitted when empty (json:"path,omitempty"); Size always present.
function goMarshalBlobInfo(b: BlobInfo): string {
  const parts: string[] = [];
  if (b.path !== '') {
    parts.push(`"path":${JSON.stringify(b.path)}`);
  }
  parts.push(`"digest":${JSON.stringify(b.digest)}`);
  parts.push(`"size":${b.size}`);
  return `{${parts.join(',')}}`;
}

// Mirrors Go json.Marshal of deploy.Manifest: field order Kind, Worker, Assets,
// Cache; Cache omitted when empty; Assets always present, a nil slice as null.
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
