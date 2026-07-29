// The CLI-side deploy seam. Spec: contracts/deploy/deploy.go (Port). Go is
// normative, including the idempotency invariants documented inline there.
//
// Four verbs; Sync carries all the deploy intelligence, PutBlob and Status are
// deliberately dumb, and Delete is the only one that destroys anything. Every
// method is idempotent and safe to re-invoke after any interruption: the
// caller's entire retry strategy is "run the same sequence again from Sync".

import type { Readable } from 'node:stream';
import type {
  Digest,
  SyncRequest,
  SyncResult,
  DeployStatus,
  DeleteRequest,
  DeleteResult,
} from './types.js';

// BlobBody is the streamed content of one blob. It must be consumed as a raw
// stream, never a buffered body (plan risk register: 100 MiB PUTs). The
// async-iterable form is what the filesystem blob store and tests hand in; the
// web ReadableStream form lets the R2 adapter forward the request body straight
// through without re-wrapping it.
export type BlobBody =
  | Readable
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface Port {
  // Sync is begin, resume, and re-attach in one idempotent call. Idempotent on
  // (resolved app, manifest canonical digest). App.id is authoritative and MUST
  // be persisted before uploading any blob. Rejects the manifest
  // (preflight_rejected) before any state change when it violates the envelope.
  sync(req: SyncRequest): Promise<SyncResult>;

  // PutBlob uploads one content-addressed blob for an open deploy. Idempotent,
  // order-free, parallel-safe. The server hashes on receipt; a mismatch fails
  // digest_mismatch and stores nothing. No activation verb exists: the last
  // missing blob triggers activation on its own.
  putBlob(appId: string, digest: Digest, size: number, body: BlobBody): Promise<void>;

  // Status polls one deploy. Cheap; safe to hammer. Live and the app's serving
  // URL appear together. Unknown deploy ids fail not_found.
  status(appId: string, deployId: string): Promise<DeployStatus>;

  // Delete destroys an app and everything it owns. Empty confirm is a dry run.
  // Confirm must equal the app's slug. The one verb here that cannot be undone.
  delete(req: DeleteRequest): Promise<DeleteResult>;
}
