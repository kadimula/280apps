// Blobstore tests. Behavior spec: platform/internal/blobstore/blobstore.go.
// The claims that matter: content is verified on the way in, a mismatch stores
// nothing, blobs are app-scoped, the layout fans out, and every path-building
// input is guarded.

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeployCode } from '@280/contracts';
import { DeployErr, ErrNotFound, open, type FsBlobStore } from '../src/blobstore/blobstore.js';

function digestOf(b: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof b === 'string' ? Buffer.from(b) : b)
    .digest('hex');
}

// bodyFrom yields the bytes in small chunks, so the streaming/hash path is
// exercised rather than a single-write shortcut.
function bodyFrom(data: Uint8Array): Readable {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 3) {
    chunks.push(data.subarray(i, i + 3));
  }
  return Readable.from(chunks.length ? chunks : [Buffer.alloc(0)]);
}

describe('blobstore', () => {
  let root: string;
  let store: FsBlobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'blobstore-'));
    store = await open(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('put then has then get round-trips', async () => {
    const data = Buffer.from('worker bytes');
    const d = digestOf(data);
    expect(await store.has('app_1', d)).toBe(false);
    await store.put('app_1', d, data.length, bodyFrom(data));
    expect(await store.has('app_1', d)).toBe(true);
    const got = await store.get('app_1', d);
    expect(Buffer.from(got).equals(data)).toBe(true);
  });

  it('put is idempotent for identical content', async () => {
    const data = Buffer.from('same');
    const d = digestOf(data);
    await store.put('app_1', d, data.length, bodyFrom(data));
    await store.put('app_1', d, data.length, bodyFrom(data)); // rename over an existing blob
    expect(Buffer.from(await store.get('app_1', d)).toString()).toBe('same');
  });

  it('put stores an empty blob', async () => {
    const data = Buffer.alloc(0);
    const d = digestOf(data);
    await store.put('app_1', d, data.length, bodyFrom(data));
    expect(await store.has('app_1', d)).toBe(true);
    expect((await store.get('app_1', d)).length).toBe(0);
  });

  it('put rejects digest_mismatch and stores nothing', async () => {
    const data = Buffer.from('the real bytes');
    const wrong = digestOf('different bytes'); // valid hex, wrong content
    let caught: unknown;
    try {
      await store.put('app_1', wrong, data.length, bodyFrom(data));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DeployErr);
    expect((caught as DeployErr).code).toBe(DeployCode.DigestMismatch);
    expect((caught as DeployErr).fix).toBe('run 280 push again');
    // Nothing stored: the corrupt upload must not satisfy a manifest entry.
    expect(await store.has('app_1', wrong)).toBe(false);
    // And no temp files left behind in the fan-out directory.
    const fan = join(root, 'app_1', wrong.slice(0, 2));
    const entries = await readdir(fan).catch(() => []);
    expect(entries).toEqual([]);
  });

  it('get rejects not-found for an unstored digest', async () => {
    const d = digestOf('never stored');
    await expect(store.get('app_1', d)).rejects.toThrow(ErrNotFound);
  });

  it('fans out on the digest first byte', async () => {
    const data = Buffer.from('layout');
    const d = digestOf(data);
    await store.put('app_1', d, data.length, bodyFrom(data));
    const p = join(root, 'app_1', d.slice(0, 2), d);
    expect((await stat(p)).isFile()).toBe(true);
  });

  it('blobs are app-scoped: one app storing a digest does not satisfy another', async () => {
    const data = Buffer.from('identical bytes in both apps');
    const d = digestOf(data);
    await store.put('app_one', d, data.length, bodyFrom(data));
    expect(await store.has('app_one', d)).toBe(true);
    expect(await store.has('app_two', d)).toBe(false);
  });

  it('missing returns lacking digests in stable order, deduplicated', async () => {
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    const c = Buffer.from('c');
    const [da, db, dc] = [digestOf(a), digestOf(b), digestOf(c)];
    await store.put('app_1', db, b.length, bodyFrom(b)); // b is present
    const want = [
      { path: '', digest: da, size: a.length },
      { path: '', digest: db, size: b.length },
      { path: '', digest: dc, size: c.length },
      { path: '', digest: da, size: a.length }, // duplicate of da
    ];
    expect(await store.missing('app_1', want)).toEqual([da, dc]);
  });

  it('deleteApp removes everything and is an idempotent no-op when empty', async () => {
    const data = Buffer.from('gone soon');
    const d = digestOf(data);
    await store.put('app_del', d, data.length, bodyFrom(data));
    await store.deleteApp('app_del');
    expect(await store.has('app_del', d)).toBe(false);
    // Deleting an app that stored nothing succeeds.
    await store.deleteApp('app_never');
    // Re-deleting is a no-op, which lets an interrupted delete finish on re-run.
    await store.deleteApp('app_del');
  });

  it('rejects an unsafe app id before touching the filesystem', async () => {
    const d = digestOf('x');
    await expect(store.has('../escape', d)).rejects.toThrow(/is not an app id/);
    await expect(store.deleteApp('bad/slash')).rejects.toThrow(/is not an app id/);
    await expect(store.has('', d)).rejects.toThrow(/is not an app id/);
  });

  it('rejects a non-sha256 digest', async () => {
    await expect(store.has('app_1', 'short')).rejects.toThrow(/is not a sha-256 digest/);
    // Uppercase hex is not the canonical lowercase form Go accepts.
    await expect(store.has('app_1', 'A'.repeat(64))).rejects.toThrow(/is not a sha-256 digest/);
    // Right length, non-hex character.
    await expect(store.has('app_1', 'g'.repeat(64))).rejects.toThrow(/is not a sha-256 digest/);
  });
});
