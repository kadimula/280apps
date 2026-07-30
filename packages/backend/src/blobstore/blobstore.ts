// Holds deploy content, addressed by the digest the CLI sent and scoped to one
// app. Scoping is security, not tidiness: "which blobs am I missing" is answered
// per app, so the cross-tenant dedupe leak (an app learning another account
// already uploaded a given hash) is impossible by construction. The same reason
// drives the per-app salt used when these blobs reach a runtime.

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { DeployCode, type BlobInfo, type BlobBody, type Digest } from '@280/contracts';
import type { BlobStore } from '../seams.js';

const SHA256_HEX_LEN = 64;

export const ErrNotFound = 'blob not found';

// The seam's typed error as a throwable. put rejects with one (code
// digest_mismatch) when uploaded bytes do not hash to the declared digest.
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

// Callers validate digests before here, so a false is an upstream bug; but the
// blast radius of being wrong is a directory escape (or an attacker-shaped S3
// key), worth one comparison. Shared with the S3 backing.
export function safeDigest(d: Digest): boolean {
  if (d.length !== SHA256_HEX_LEN) {
    return false;
  }
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    const isDigit = c >= 0x30 && c <= 0x39;
    const isHexLower = c >= 0x61 && c <= 0x66;
    if (!isDigit && !isHexLower) {
      return false;
    }
  }
  return true;
}

// Like safeDigest, a false is an upstream bug; but this is the sole argument to a
// recursive delete, so it is checked rather than trusted. Shared with the S3 backing.
export function safeAppID(appID: string): boolean {
  if (appID === '') {
    return false;
  }
  for (let i = 0; i < appID.length; i++) {
    const c = appID.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x41 && c <= 0x5a) ||
      c === 0x5f ||
      c === 0x2d;
    if (!ok) {
      return false;
    }
  }
  return true;
}

export async function open(dir: string): Promise<FsBlobStore> {
  await mkdir(dir, { recursive: true });
  return new FsBlobStore(dir);
}

// A content-addressed blob store on the local filesystem. Every method takes only
// the app and the digest, so an S3/R2 backing is a swap of these methods.
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private appDir(appID: string): string {
    if (!safeAppID(appID)) {
      throw new Error(`blobstore: "${appID}" is not an app id`);
    }
    return join(this.root, appID);
  }

  // Fans out on the digest's first byte so no directory grows unbounded, and
  // throws rather than build a path from a digest it cannot vouch for.
  private path(appID: string, d: Digest): string {
    const dir = this.appDir(appID);
    if (!safeDigest(d)) {
      throw new Error(`blobstore: "${d}" is not a sha-256 digest`);
    }
    return join(dir, d.slice(0, 2), d);
  }

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

  // Streams body to a temp file with an incremental hash and rejects with
  // digest_mismatch (storing nothing) if it does not hash to d, so a corrupt
  // upload cannot satisfy a manifest entry. size is on the seam for the R2
  // backing; here the hash over the streamed bytes is the whole verification.
  async put(appID: string, d: Digest, _size: number, body: BlobBody): Promise<void> {
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
      await unlink(tmp).catch(() => {});
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

    // Rename is the commit: a blob is either absent or complete and verified,
    // with no third state for a resumed push to trip over.
    try {
      await rename(tmp, dst);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

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

  // Idempotent: an app that stored nothing, or whose content is already gone, is a
  // successful no-op, which lets an interrupted delete be finished by re-running.
  async deleteApp(appID: string): Promise<void> {
    const dir = this.appDir(appID);
    await rm(dir, { recursive: true, force: true });
  }

  // The digests from want the app lacks, deduplicated in stable order. This is the
  // whole of what Sync reports back to the CLI.
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

// The `wx` open flag makes a temp-name collision an error rather than a silent
// overwrite.
function randomSuffix(): string {
  return randomBytes(8).toString('hex');
}
