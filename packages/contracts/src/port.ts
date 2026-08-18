// The CLI-side deploy seam. Spec: contracts/deploy/deploy.go (normative). Every
// method is idempotent and safe to re-invoke after any interruption: the caller's
// entire retry strategy is "run the same sequence again from Sync".

import type { Readable } from 'node:stream';
import type {
  Digest,
  SyncRequest,
  SyncResult,
  DeployStatus,
  DeleteRequest,
  DeleteResult,
  LogQuery,
  LogsResult,
} from './types.js';

// Streamed content of one blob, consumed as a raw stream never a buffered body
// (100 MiB PUTs). Async-iterable is what the fs blob store and tests hand in; the
// web ReadableStream form lets the R2 adapter forward the request body unchanged.
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

  // appStatus resolves the app's most-useful current deploy and reports its
  // platform state: the active deploy if live, the newest open deploy, or the
  // latest deploy (including failed). No deploy history returns a 404.
  appStatus(appId: string): Promise<DeployStatus>;

  // Delete destroys an app and everything it owns. Empty confirm is a dry run.
  // Confirm must equal the app's slug. The one verb here that cannot be undone.
  delete(req: DeleteRequest): Promise<DeleteResult>;

  logs(appId: string, query: LogQuery): Promise<LogsResult>;
}
