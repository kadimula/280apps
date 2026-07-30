// The per-app content-addressed blob store on an S3-compatible object store
// (Cloudflare R2 via its S3 API in production), the Node counterpart to the
// Workers-only R2BlobStore. Keys are `${appId}/${digest}`, so every method is a
// prefix operation on one app and the cross-tenant dedupe leak is impossible by
// construction. Unlike the Workers backing there is no FixedLengthStream: put
// drains the body once, hashing as it goes, and rejects digest_mismatch (storing
// nothing) before it ever calls PutObject.

import { createHash } from 'node:crypto';
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { DeployCode, type BlobBody, type BlobInfo, type Digest } from '@280/contracts';
import type { BlobStore } from '../seams.js';
import { DeployErr, ErrNotFound, safeAppID, safeDigest } from './blobstore.js';

// S3 DeleteObjects takes up to 1000 keys per call, the same batch R2's native
// delete accepted.
const DELETE_BATCH = 1000;

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // R2 and most S3-compatible stores behind a custom endpoint want path-style
  // addressing (bucket in the path, not the host); real AWS S3 does not.
  forcePathStyle: boolean;
}

// openS3 builds the production store from R2/S3 credentials.
export function openS3(cfg: S3Config): S3BlobStore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: cfg.forcePathStyle,
  });
  return new S3BlobStore(client, cfg.bucket);
}

export class S3BlobStore implements BlobStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  // Validated the same way the filesystem backing validates its path segments: a
  // bad app id or digest is an upstream bug, but it is the sole input to a key an
  // attacker could otherwise shape, so it is checked, not trusted.
  private key(appId: string, digest: Digest): string {
    if (!safeAppID(appId)) throw new Error(`blobstore: "${appId}" is not an app id`);
    if (!safeDigest(digest)) throw new Error(`blobstore: "${digest}" is not a sha-256 digest`);
    return `${appId}/${digest}`;
  }

  private prefix(appId: string): string {
    if (!safeAppID(appId)) throw new Error(`blobstore: "${appId}" is not an app id`);
    return appId + '/';
  }

  async has(appId: string, digest: Digest): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(appId, digest) }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  // Drains the body once, hashing as it goes; a body that does not hash to digest
  // is rejected as digest_mismatch with nothing stored, exactly as the filesystem
  // backing does. size is advisory here (the hash over the streamed bytes is the
  // whole verification), so a short/long body still fails on the hash. The declared
  // digest also rides along as ChecksumSHA256 so the store rejects a corruption in
  // transit rather than persisting bytes that silently differ.
  async put(appId: string, digest: Digest, _size: number, body: BlobBody): Promise<void> {
    const key = this.key(appId, digest);
    const { bytes, got } = await drain(body);
    if (got !== digest) {
      throw new DeployErr({
        code: DeployCode.DigestMismatch,
        message:
          'uploaded bytes do not match the declared digest; the build output changed underneath the push',
        fix: 'run 280 push again',
      });
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ChecksumSHA256: hexToBase64(digest),
        }),
      );
    } catch {
      throw new DeployErr({
        code: DeployCode.DigestMismatch,
        message:
          'uploaded bytes do not match the declared digest; the build output changed underneath the push',
        fix: 'run 280 push again',
      });
    }
  }

  async get(appId: string, digest: Digest): Promise<Uint8Array> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(appId, digest) }),
      );
      if (out.Body === undefined) throw new Error(`${ErrNotFound}: ${appId}/${digest}`);
      return await out.Body.transformToByteArray();
    } catch (err) {
      if (isNotFound(err)) throw new Error(`${ErrNotFound}: ${appId}/${digest}`);
      throw err;
    }
  }

  // Removes every object under the app's prefix, in batches, walking the
  // continuation token. Idempotent, so an interrupted delete finishes on re-run.
  async deleteApp(appId: string): Promise<void> {
    const prefix = this.prefix(appId);
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => k !== undefined);
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.slice(i, i + DELETE_BATCH).map((Key) => ({ Key })) },
          }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  // The digests from want the app lacks, deduplicated in stable order. Lists the
  // app's prefix once into a set and diffs against it, rather than a head() each.
  async missing(appId: string, want: BlobInfo[]): Promise<Digest[]> {
    const prefix = this.prefix(appId);
    const stored = new Set<string>();
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key !== undefined) stored.add(o.Key.slice(prefix.length));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);

    const seen = new Set<Digest>();
    const out: Digest[] = [];
    for (const b of want) {
      if (seen.has(b.digest)) continue;
      seen.add(b.digest);
      if (!stored.has(b.digest)) out.push(b.digest);
    }
    return out;
  }
}

// Reads a BlobBody (a web stream or any async iterable of chunks) fully into one
// buffer while hashing incrementally, so a caller gets both the bytes to store and
// the digest to verify from a single pass.
async function drain(body: BlobBody): Promise<{ bytes: Uint8Array; got: string }> {
  const h = createHash('sha256');
  const chunks: Buffer[] = [];
  for await (const chunk of asAsyncIterable(body)) {
    const buf = chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.from(chunk);
    h.update(buf);
    chunks.push(buf);
  }
  return { bytes: Buffer.concat(chunks), got: h.digest('hex') };
}

function asAsyncIterable(body: BlobBody): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) return body as AsyncIterable<Uint8Array>;
  const stream = body as ReadableStream<Uint8Array>;
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

// A missing key surfaces differently per command (HeadObject → NotFound, GetObject
// → NoSuchKey) and every S3-compatible store also carries the 404 in $metadata.
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}
