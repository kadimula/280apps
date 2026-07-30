// walkContext shaping and ordering. The context file list order is part of the
// manifest bytes, so it must be deterministic: lexical by basename within each
// directory, pre-order.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestBytes, type Digest } from '@280/contracts';
import { walkContext } from './walk.js';

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), '280-walk-test-'));
}

describe('walkContext', () => {
  it('keys each file by its context-relative path (no leading slash) with digest and size', () => {
    const dir = tempDir();
    write(join(dir, 'index.html'), 'hi');
    write(join(dir, 'nested', 'app.js'), 'x');

    const content = new Map<Digest, Uint8Array>();
    const files = walkContext(dir, content);
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.get('index.html')?.digest).toBe(digestBytes(Buffer.from('hi')));
    expect(byPath.get('index.html')?.size).toBe(2);
    expect(byPath.get('nested/app.js')?.path).toBe('nested/app.js');
    for (const f of files) {
      expect(content.has(f.digest)).toBe(true);
    }
  });

  it('walks pre-order, lexically sorted by basename within each directory', () => {
    const dir = tempDir();
    write(join(dir, 'b.txt'), '1');
    write(join(dir, 'a', 'inner.txt'), '2');
    write(join(dir, 'a', 'aa.txt'), '3');
    write(join(dir, 'z', 'z.txt'), '4');

    const paths = walkContext(dir, new Map()).map((f) => f.path);
    expect(paths).toEqual(['a/aa.txt', 'a/inner.txt', 'b.txt', 'z/z.txt']);
  });

  it('deduplicates identical content under one digest', () => {
    const dir = tempDir();
    write(join(dir, 'one.txt'), 'same');
    write(join(dir, 'two.txt'), 'same');
    const content = new Map<Digest, Uint8Array>();
    const files = walkContext(dir, content);
    expect(files).toHaveLength(2);
    expect(content.size).toBe(1);
  });

  it('applies a prefix and skips pruned subtrees and files', () => {
    const dir = tempDir();
    write(join(dir, 'keep.js'), 'k');
    write(join(dir, 'node_modules', 'dep.js'), 'd');
    write(join(dir, '.env'), 'SECRET=1');

    const files = walkContext(dir, new Map(), {
      prefix: 'app',
      skip: (rel, isDir) => (isDir && rel === 'node_modules') || rel === '.env',
    });
    expect(files.map((f) => f.path)).toEqual(['app/keep.js']);
  });
});
