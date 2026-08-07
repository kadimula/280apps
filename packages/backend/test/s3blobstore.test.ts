// S3BlobStore conformance: the same behavioral contract test/blobstore.test.ts
// pins for the filesystem backing, run against the S3 backing over an in-memory
// double of the S3 client. The double implements the five commands the store uses
// (Head/Put/Get/ListObjectsV2/DeleteObjects) with real semantics — prefix listing,
// continuation-token pagination, and batch delete — so the store's key scoping,
// cursor walking, and digest verification are all exercised, not mocked away.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { DeployCode } from '@280/contracts';
import { DeployErr, ErrNotFound } from '../src/blobstore/blobstore.js';
import { S3BlobStore } from '../src/blobstore/s3.js';

function digestOf(b: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof b === 'string' ? Buffer.from(b) : b)
    .digest('hex');
}

// yields bytes in small chunks so the streaming/hash path is exercised, not a
// single-write shortcut.
function bodyFrom(data: Uint8Array): Readable {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 3) {
    chunks.push(data.subarray(i, i + 3));
  }
  return Readable.from(chunks.length ? chunks : [Buffer.alloc(0)]);
}

type AnyCommand =
  | HeadObjectCommand
  | PutObjectCommand
  | GetObjectCommand
  | ListObjectsV2Command
  | DeleteObjectsCommand;

// A minimal in-memory S3, faithful to the wire behaviors S3BlobStore depends on. A
// deliberately tiny page size forces the continuation-token loop in deleteApp and
// missing to actually iterate.
class FakeS3 {
  private readonly objects = new Map<string, Buffer>();
  constructor(private readonly pageSize = 2) {}

  async send(command: AnyCommand): Promise<unknown> {
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key ?? '';
      if (!this.objects.has(key)) throw notFound('NotFound');
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? '';
      this.objects.set(key, Buffer.from(command.input.Body as Uint8Array));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key ?? '';
      const buf = this.objects.get(key);
      if (buf === undefined) throw notFound('NoSuchKey');
      return { Body: { transformToByteArray: async () => new Uint8Array(buf) } };
    }
    if (command instanceof ListObjectsV2Command) {
      return this.list(command.input.Prefix ?? '', command.input.ContinuationToken);
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const o of command.input.Delete?.Objects ?? []) {
        if (o.Key !== undefined) this.objects.delete(o.Key);
      }
      return {};
    }
    throw new Error('unexpected command');
  }

  // Key-based pagination, like real S3: the continuation token is the last key of
  // the previous page and the next page resumes after it. This is what makes it
  // safe to delete already-listed keys mid-iteration (an offset cursor would skip
  // survivors as the list shrinks).
  private list(prefix: string, token: string | undefined): unknown {
    const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const remaining = token !== undefined ? all.filter((k) => k > token) : all;
    const slice = remaining.slice(0, this.pageSize);
    const truncated = remaining.length > this.pageSize;
    return {
      Contents: slice.map((Key) => ({ Key })),
      IsTruncated: truncated,
      NextContinuationToken: truncated ? slice[slice.length - 1] : undefined,
    };
  }
}

function notFound(name: string): Error {
  const err = new Error(name) as Error & { name: string; $metadata: { httpStatusCode: number } };
  err.name = name;
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

describe('s3blobstore', () => {
  let store: S3BlobStore;

  beforeEach(() => {
    store = new S3BlobStore(new FakeS3() as unknown as S3Client, 'blobs');
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
    await store.put('app_1', d, data.length, bodyFrom(data));
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
    expect((caught as DeployErr).fix).toBe('run two80 push again');
    // corrupt upload must not satisfy a manifest entry
    expect(await store.has('app_1', wrong)).toBe(false);
  });

  it('get rejects not-found for an unstored digest', async () => {
    const d = digestOf('never stored');
    await expect(store.get('app_1', d)).rejects.toThrow(ErrNotFound);
  });

  it('blobs are app-scoped: one app storing a digest does not satisfy another', async () => {
    const data = Buffer.from('identical bytes in both apps');
    const d = digestOf(data);
    await store.put('app_one', d, data.length, bodyFrom(data));
    expect(await store.has('app_one', d)).toBe(true);
    expect(await store.has('app_two', d)).toBe(false);
  });

  it('missing returns lacking digests in stable order, deduplicated, across pages', async () => {
    // More stored blobs than the fake's page size, so missing() must walk the
    // continuation token to see them all.
    const bufs = ['a', 'b', 'c', 'd', 'e'].map((s) => Buffer.from(s));
    const digs = bufs.map((b) => digestOf(b));
    // store b, d, e; leave a and c missing
    for (const i of [1, 3, 4]) await store.put('app_1', digs[i]!, bufs[i]!.length, bodyFrom(bufs[i]!));
    const want = [
      { path: '', digest: digs[0]!, size: 1 }, // a: missing
      { path: '', digest: digs[1]!, size: 1 }, // b: present
      { path: '', digest: digs[2]!, size: 1 }, // c: missing
      { path: '', digest: digs[0]!, size: 1 }, // duplicate of a
    ];
    expect(await store.missing('app_1', want)).toEqual([digs[0], digs[2]]);
  });

  it('deleteApp removes everything across pages and is an idempotent no-op when empty', async () => {
    const bufs = ['one', 'two', 'three', 'four', 'five'].map((s) => Buffer.from(s));
    for (const b of bufs) await store.put('app_del', digestOf(b), b.length, bodyFrom(b));
    await store.deleteApp('app_del');
    for (const b of bufs) expect(await store.has('app_del', digestOf(b))).toBe(false);
    // deleting an app that stored nothing succeeds, and re-deleting is a no-op
    await store.deleteApp('app_never');
    await store.deleteApp('app_del');
  });

  it('deleteApp is prefix-exact: it does not touch another app sharing a name prefix', async () => {
    const data = Buffer.from('keep me');
    const d = digestOf(data);
    await store.put('app', d, data.length, bodyFrom(data));
    await store.put('app_1', d, data.length, bodyFrom(data));
    await store.deleteApp('app');
    expect(await store.has('app', d)).toBe(false);
    expect(await store.has('app_1', d)).toBe(true);
  });

  it('rejects an unsafe app id before touching the store', async () => {
    const d = digestOf('x');
    await expect(store.has('../escape', d)).rejects.toThrow(/is not an app id/);
    await expect(store.deleteApp('bad/slash')).rejects.toThrow(/is not an app id/);
    await expect(store.has('', d)).rejects.toThrow(/is not an app id/);
  });

  it('rejects a non-sha256 digest', async () => {
    await expect(store.has('app_1', 'short')).rejects.toThrow(/is not a sha-256 digest/);
    await expect(store.has('app_1', 'A'.repeat(64))).rejects.toThrow(/is not a sha-256 digest/);
    await expect(store.has('app_1', 'g'.repeat(64))).rejects.toThrow(/is not a sha-256 digest/);
  });
});
