// Go has no static-specific test (covered by the e2e 01-static case), so these pin
// staticDir order, the empty-build rejection, and the placeholder worker's bytes.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_KIND_BUNDLE, digestBytes } from '@280/contracts';
import { buildStatic, staticDir, staticWorker } from './static.js';
import { PreflightError } from './walk.js';

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), '280-static-test-'));
}

describe('buildStatic', () => {
  it('content-addresses a root with index.html and pairs the stub worker', () => {
    const root = tempDir();
    write(join(root, 'index.html'), '<h1>hi</h1>');
    write(join(root, 'style.css'), 'body{}');

    const b = buildStatic(root);
    expect(b.manifest.kind).toBe(MANIFEST_KIND_BUNDLE);
    expect(b.manifest.worker.digest).toBe(digestBytes(staticWorker));
    expect(b.manifest.worker.size).toBe(staticWorker.length);
    expect(b.manifest.assets.map((a) => a.path).sort()).toEqual([
      '/index.html',
      '/style.css',
    ]);
    expect(b.manifest.cache).toHaveLength(0);
    expect(b.content.size).toBe(3);
  });

  it('rejects a directory with no static build', () => {
    const root = tempDir();
    write(join(root, 'package.json'), '{}');
    expect(() => buildStatic(root)).toThrow(PreflightError);
  });
});

describe('staticWorker', () => {
  it('matches the Go serving stub byte for byte', () => {
    expect(Buffer.from(staticWorker).toString()).toBe('// 280 static serving stub v0\n');
  });
});

describe('staticDir', () => {
  it('prefers root when it has index.html', () => {
    const root = tempDir();
    write(join(root, 'index.html'), 'x');
    write(join(root, 'dist', 'index.html'), 'y');
    expect(staticDir(root)).toBe(root);
  });

  it('resolves conventional build dirs in order dist, build, out, public', () => {
    for (const name of ['dist', 'build', 'out', 'public']) {
      const root = tempDir();
      write(join(root, name, 'index.html'), 'x');
      expect(staticDir(root)).toBe(join(root, name));
    }
  });

  it('prefers dist over a later build dir', () => {
    const root = tempDir();
    write(join(root, 'build', 'index.html'), 'b');
    write(join(root, 'dist', 'index.html'), 'd');
    expect(staticDir(root)).toBe(join(root, 'dist'));
  });

  it('rejects when no build dir has an index.html', () => {
    expect(() => staticDir(tempDir())).toThrow(PreflightError);
  });
});
