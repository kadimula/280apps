// The per-app content-addressed blob store on Cloudflare R2: the production
// BlobStore, counterpart to the filesystem store the tests use. Keys are
// `${appId}/${digest}`, so every method is a prefix operation on one app and the
// cross-tenant dedupe leak is impossible by construction even though R2 is
// content-addressed globally. The body is never buffered: put frames the stream
// in a FixedLengthStream so bytes flow straight through while R2 verifies sha256.

import { DeployCode, type BlobBody, type BlobInfo, type Digest } from '@280/contracts';
import type { BlobStore } from '../seams.js';
import { DeployErr, ErrNotFound } from './blobstore.js';

// R2 deletes up to 1000 keys per call.
const DELETE_BATCH = 1000;

export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  private key(appId: string, digest: Digest): string {
    return `${appId}/${digest}`;
  }

  async has(appId: string, digest: Digest): Promise<boolean> {
    return (await this.bucket.head(this.key(appId, digest))) !== null;
  }

  // FixedLengthStream(size) errors a body that ends short or long, and R2's sha256
  // option rejects one that does not hash to digest without storing anything. Both
  // mean the bytes are not what the manifest declared, so both (and a genuine R2
  // outage, whose "run 280 push again" fix is right anyway) surface as digest_mismatch.
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

  // Removes every object under the app's prefix, in batches, walking the cursor.
  // Idempotent, so an interrupted delete can be finished by running it again.
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

  // The digests from want the app lacks, deduplicated in stable order. Lists the
  // app's prefix once into a set and diffs against it, rather than a head() each.
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

// Adapts a BlobBody to the web ReadableStream R2 consumes. A web stream passes
// straight through; an async iterable is wrapped without buffering, and a source
// error (the byte cap tripping) errors the stream rather than being swallowed.
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
