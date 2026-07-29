// walkAssets shaping and ordering. The asset list order is part of the manifest
// bytes, so it must match Go's filepath.WalkDir: lexical by basename within each
// directory, pre-order.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestBytes, type Digest } from '@280/contracts';
import { walkAssets } from './walk.js';

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), '280-walk-test-'));
}

describe('walkAssets', () => {
  it('keys each file by its serving URL path and records its digest and size', () => {
    const dir = tempDir();
    write(join(dir, 'index.html'), 'hi');
    write(join(dir, 'nested', 'app.js'), 'x');

    const content = new Map<Digest, Uint8Array>();
    const assets = walkAssets(dir, content);
    const byPath = new Map(assets.map((a) => [a.path, a]));

    expect(byPath.get('/index.html')?.digest).toBe(digestBytes(Buffer.from('hi')));
    expect(byPath.get('/index.html')?.size).toBe(2);
    expect(byPath.get('/nested/app.js')?.path).toBe('/nested/app.js');
    for (const a of assets) {
      expect(content.has(a.digest)).toBe(true);
    }
  });

  it('walks pre-order, lexically sorted by basename within each directory', () => {
    const dir = tempDir();
    // Names chosen so directory recursion order is observable: "a" (dir) sorts
    // before "b.txt" (file), and "z" (dir) after.
    write(join(dir, 'b.txt'), '1');
    write(join(dir, 'a', 'inner.txt'), '2');
    write(join(dir, 'a', 'aa.txt'), '3');
    write(join(dir, 'z', 'z.txt'), '4');

    const paths = walkAssets(dir, new Map()).map((a) => a.path);
    expect(paths).toEqual(['/a/aa.txt', '/a/inner.txt', '/b.txt', '/z/z.txt']);
  });

  it('deduplicates identical content under one digest', () => {
    const dir = tempDir();
    write(join(dir, 'one.txt'), 'same');
    write(join(dir, 'two.txt'), 'same');
    const content = new Map<Digest, Uint8Array>();
    const assets = walkAssets(dir, content);
    expect(assets).toHaveLength(2);
    expect(content.size).toBe(1);
  });
});
