// Holds deploy content, addressed by the digest the CLI sent and scoped to one
// app.
//
// Scoping is not tidiness. "Which blobs am I missing" is answered per app, so an
// app can never learn that some other account already uploaded a file with a
// given hash — the cross-tenant dedupe leak is impossible by construction rather
// than by a check. The same reason drives the per-app salt used downstream when
// these blobs reach a runtime whose own content addressing is namespace-global.
//
// Spec: platform/internal/blobstore/blobstore.go. Go is normative.

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { DeployCode, type BlobInfo, type BlobBody, type Digest } from '@280/contracts';
import type { BlobStore } from '../seams.js';

// SHA256_HEX_LEN is the length of a hex-encoded SHA-256 digest: 32 bytes.
const SHA256_HEX_LEN = 64;

// ErrNotFound is the error Get rejects with for a digest the app has not stored.
export const ErrNotFound = 'blob not found';

// DeployErr carries the seam's typed error shape as a throwable. Put rejects
// with one (code digest_mismatch) when uploaded bytes do not hash to the
// declared digest. Mirrors deploy.Error / deploy.AsError from the Go contract.
export class DeployErr extends Error {
  override readonly name = 'DeployErr';
  readonly code: string;
  readonly fix: string;
  readonly retryable: boolean;
  readonly candidates: string[];

  constructor(fields: {
    code: string;
    message: string;
    fix?: string;
    retryable?: boolean;
    candidates?: string[];
  }) {
    super(fields.message);
    this.code = fields.code;
    this.fix = fields.fix ?? '';
    this.retryable = fields.retryable ?? false;
    this.candidates = fields.candidates ?? [];
  }
}

// safeDigest reports whether d can be used to build a path. Callers validate
// digests before they get here, so a false is a bug upstream rather than user
// input — but the blast radius of being wrong is a directory escape, which is
// worth one comparison to make structurally impossible.
function safeDigest(d: Digest): boolean {
  if (d.length !== SHA256_HEX_LEN) {
    return false;
  }
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    const isDigit = c >= 0x30 && c <= 0x39; // 0-9
    const isHexLower = c >= 0x61 && c <= 0x66; // a-f
    if (!isDigit && !isHexLower) {
      return false;
    }
  }
  return true;
}

// safeAppID reports whether appID can name a directory. Like safeDigest, a false
// is a bug upstream rather than user input — but this one is the sole argument
// to a recursive delete, so it is checked rather than trusted.
function safeAppID(appID: string): boolean {
  if (appID === '') {
    return false;
  }
  for (let i = 0; i < appID.length; i++) {
    const c = appID.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x61 && c <= 0x7a) || // a-z
      (c >= 0x41 && c <= 0x5a) || // A-Z
      c === 0x5f || // _
      c === 0x2d; // -
    if (!ok) {
      return false;
    }
  }
  return true;
}

// open returns a Store rooted at dir, creating it if needed.
export async function open(dir: string): Promise<FsBlobStore> {
  await mkdir(dir, { recursive: true });
  return new FsBlobStore(dir);
}

// FsBlobStore is a content-addressed blob store on the local filesystem.
//
// Local disk is the V1 answer and the documented seam to object storage: every
// method takes the app and the digest and nothing else, so an S3/R2 backing is
// a swap of these methods.
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  // appDir is everything one app has stored.
  private appDir(appID: string): string {
    if (!safeAppID(appID)) {
      throw new Error(`blobstore: "${appID}" is not an app id`);
    }
    return join(this.root, appID);
  }

  // path fans out on the digest's first byte so no directory grows unbounded. It
  // throws rather than building a path from a digest it cannot vouch for: every
  // value here is joined onto the filesystem root.
  private path(appID: string, d: Digest): string {
    const dir = this.appDir(appID);
    if (!safeDigest(d)) {
      throw new Error(`blobstore: "${d}" is not a sha-256 digest`);
    }
    return join(dir, d.slice(0, 2), d);
  }

  // has reports whether the app has stored this digest.
  async has(appID: string, d: Digest): Promise<boolean> {
    const p = this.path(appID, d);
    try {
      await stat(p);
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        return false;
      }
      throw err;
    }
  }

  // put stores body under digest for the app, verifying the content as it reads.
  //
  // It rejects with digest_mismatch when the bytes do not hash to the declared
  // digest, and stores nothing in that case: a corrupt upload must not be able
  // to satisfy a manifest entry, which is the only thing standing between a
  // truncated file and a silently broken live app. The body is streamed to a
  // temp file with an incremental hash, never buffered.
  async put(appID: string, d: Digest, body: BlobBody): Promise<void> {
    const dst = this.path(appID, d);
    const dir = dirname(dst);
    await mkdir(dir, { recursive: true });

    const tmp = join(dir, `.upload-${randomSuffix()}`);
    const h = createHash('sha256');
    const hashing = async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of body) {
        const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
        h.update(buf);
        yield buf;
      }
    };

    try {
      await pipeline(hashing(), createWriteStream(tmp, { flags: 'wx' }));
    } catch (err) {
      await unlink(tmp).catch(() => {}); // best effort; no-op if never created
      throw err;
    }

    const got = h.digest('hex');
    if (got !== d) {
      await unlink(tmp).catch(() => {}); // store nothing on mismatch
      throw new DeployErr({
        code: DeployCode.DigestMismatch,
        message:
          'uploaded bytes do not match the declared digest; the build output changed underneath the push',
        fix: 'run 280 push again',
      });
    }

    // Rename is the commit. A blob is either absent or complete and verified;
    // there is no third state for a resumed push to trip over.
    try {
      await rename(tmp, dst);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  // get reads a stored blob.
  async get(appID: string, d: Digest): Promise<Uint8Array> {
    const p = this.path(appID, d);
    try {
      return await readFile(p);
    } catch (err) {
      if (isNotFound(err)) {
        throw new Error(`${ErrNotFound}: ${appID}/${d}`);
      }
      throw err;
    }
  }

  // deleteApp removes every blob the app stored. Idempotent: an app that stored
  // nothing, or whose content is already gone, is a successful no-op, which is
  // what lets an interrupted delete be finished by running it again.
  async deleteApp(appID: string): Promise<void> {
    const dir = this.appDir(appID);
    await rm(dir, { recursive: true, force: true });
  }

  // missing returns, in stable order, the digests from want that the app lacks,
  // deduplicated. This is the whole of what Sync reports back to the CLI.
  async missing(appID: string, want: BlobInfo[]): Promise<Digest[]> {
    const seen = new Set<Digest>();
    const out: Digest[] = [];
    for (const b of want) {
      if (seen.has(b.digest)) {
        continue;
      }
      seen.add(b.digest);
      if (!(await this.has(appID, b.digest))) {
        out.push(b.digest);
      }
    }
    return out;
  }
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// randomSuffix names a temp upload file uniquely within its directory. The `wx`
// open flag makes a collision an error rather than a silent overwrite.
function randomSuffix(): string {
  return randomBytes(8).toString('hex');
}
