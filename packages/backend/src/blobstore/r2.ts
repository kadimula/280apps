// The per-app content-addressed blob store on Cloudflare R2: the production
// BlobStore, the counterpart to the filesystem store the tests run against.
//
// Key layout is `${appId}/${digest}`, so every method is a prefix operation on
// one app and the cross-tenant dedupe leak is impossible by construction, the
// same guarantee the filesystem store gives by scoping to a directory
// (blobstore.ts). R2 is content-addressed globally, but the app id in the key
// keeps two tenants that uploaded identical bytes on separate objects.
//
// The body is never buffered: put frames the incoming stream in a
// FixedLengthStream and hands R2 the readable end, so the bytes flow straight
// through to storage while R2 verifies the sha256 as it writes.

import { DeployCode, type BlobBody, type BlobInfo, type Digest } from '@280/contracts';
import type { BlobStore } from '../seams.js';
import { DeployErr, ErrNotFound } from './blobstore.js';

// R2 deletes up to 1000 keys per call. deleteApp batches at this bound.
const DELETE_BATCH = 1000;

// R2BlobStore implements the BlobStore seam against one R2 bucket binding.
export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  private key(appId: string, digest: Digest): string {
    return `${appId}/${digest}`;
  }

  async has(appId: string, digest: Digest): Promise<boolean> {
    return (await this.bucket.head(this.key(appId, digest))) !== null;
  }

  // put streams body into R2 under the key, framed to size and verified against
  // digest as R2 writes it.
  //
  // FixedLengthStream(size) errors the stream if the body ends short or long,
  // and R2's sha256 option rejects a body that does not hash to digest without
  // storing anything. Both faults mean the uploaded bytes are not what the
  // manifest declared, so both surface as digest_mismatch, byte-for-byte the
  // same typed error FsBlobStore.put throws. (A genuine R2 outage would also
  // land here; its fix — "run 280 push again" — is the right recovery anyway,
  // since a re-push re-uploads from scratch.)
  async put(appId: string, digest: Digest, size: number, body: BlobBody): Promise<void> {
    const framed = toReadable(body).pipeThrough(new FixedLengthStream(size));
    try {
      await this.bucket.put(this.key(appId, digest), framed, { sha256: digest });
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
    const obj = await this.bucket.get(this.key(appId, digest));
    if (obj === null) throw new Error(`${ErrNotFound}: ${appId}/${digest}`);
    return new Uint8Array(await obj.arrayBuffer());
  }

  // deleteApp removes every object under the app's prefix, in batches, walking
  // the cursor. Idempotent: an app that stored nothing, or whose content is
  // already gone, is a successful no-op, which is what lets an interrupted
  // delete be finished by running it again.
  async deleteApp(appId: string): Promise<void> {
    const prefix = appId + '/';
    let cursor: string | undefined;
    for (;;) {
      const page = await this.bucket.list({ prefix, cursor });
      const keys = page.objects.map((o) => o.key);
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        await this.bucket.delete(keys.slice(i, i + DELETE_BATCH));
      }
      if (!page.truncated) break;
      cursor = page.cursor;
    }
  }

  // missing returns, in stable order, the digests from want the app lacks,
  // deduplicated. It lists the app's prefix once (walking cursor pages into a
  // set) and diffs against it, rather than a head() per digest.
  async missing(appId: string, want: BlobInfo[]): Promise<Digest[]> {
    const prefix = appId + '/';
    const stored = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this.bucket.list({ prefix, cursor });
      for (const o of page.objects) stored.add(o.key.slice(prefix.length));
      if (!page.truncated) break;
      cursor = page.cursor;
    }

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

// toReadable adapts a BlobBody to the web ReadableStream R2 consumes. The web
// stream form (the R2 adapter's own request body) passes straight through; an
// async iterable (the capped request stream, or a test's chunk generator) is
// wrapped without buffering, and a source error — the byte cap tripping — errors
// the stream rather than being swallowed.
function toReadable(body: BlobBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  const iter = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iter.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value instanceof Uint8Array ? value : new Uint8Array(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iter.return?.();
    },
  });
}
