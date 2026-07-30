// An in-memory BlobStore for tests that run where the filesystem store cannot —
// the AppActivator Durable Object tests, which execute inside workerd. Pure JS, so
// it works in both node and the Workers runtime. Content-addressed and app-scoped
// like the real stores; it does not verify digests (the seam's put contract) since
// the activation tests feed it bytes that already hash to their digest.

import type { BlobBody, BlobInfo, Digest } from '@280/contracts';
import type { BlobStore } from '../../src/seams.js';

export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Uint8Array>(); // `${appId}/${digest}`

  private key(appId: string, digest: Digest): string {
    return `${appId}/${digest}`;
  }

  // set stores bytes directly, the test-side counterpart to put (which frames a
  // stream). The activation tests seed content this way.
  set(appId: string, digest: Digest, bytes: Uint8Array): void {
    this.objects.set(this.key(appId, digest), bytes);
  }

  async has(appId: string, digest: Digest): Promise<boolean> {
    return this.objects.has(this.key(appId, digest));
  }

  async put(appId: string, digest: Digest, _size: number, body: BlobBody): Promise<void> {
    const chunks: Uint8Array[] = [];
    if (body instanceof ReadableStream) {
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } else {
      for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    }
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    this.objects.set(this.key(appId, digest), merged);
  }

  async get(appId: string, digest: Digest): Promise<Uint8Array> {
    const v = this.objects.get(this.key(appId, digest));
    if (v === undefined) throw new Error(`not found: ${appId}/${digest}`);
    return v;
  }

  async deleteApp(appId: string): Promise<void> {
    const prefix = appId + '/';
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(prefix)) this.objects.delete(k);
    }
  }

  async missing(appId: string, want: BlobInfo[]): Promise<Digest[]> {
    const seen = new Set<Digest>();
    const out: Digest[] = [];
    for (const b of want) {
      if (seen.has(b.digest)) continue;
      seen.add(b.digest);
      if (!this.objects.has(this.key(appId, b.digest))) out.push(b.digest);
    }
    return out;
  }
}
