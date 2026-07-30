// Deploy & auth wire types, their zod schemas, and the two content derivations
// (DigestBytes, CanonicalDigest). Parsing mirrors Go encoding/json: unknown fields
// preserved, absent/null optionals become the Go zero value (a strict schema would
// break old clients). Spec: contracts/deploy/deploy.go, contracts/auth/auth.go (normative).

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { errorSchema } from './errors.js';

// The User Worker envelope limit.
export const MAX_WORKER_GZIP_BYTES = 10 << 20; // 10 MiB

// Hex-encoded SHA-256 of blob content.
export type Digest = string;

// zero-value helpers: absent/null => Go zero value
const str = (d = '') =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? d);
const num = (d = 0) =>
  z
    .number()
    .nullish()
    .transform((v) => v ?? d);
const bool = (d = false) =>
  z
    .boolean()
    .nullish()
    .transform((v) => v ?? d);
const arr = <T extends z.ZodTypeAny>(el: T) =>
  z
    .array(el)
    .nullish()
    .transform((v) => v ?? ([] as z.infer<T>[]));

export const identitySchema = z
  .object({
    appId: str(),
    slug: str(),
    framework: str(), // "next" | "static"
    gitRemote: str(),
    clientRef: str(),
    forceNew: bool(),
  })
  .passthrough();
export type Identity = z.infer<typeof identitySchema>;

export const blobInfoSchema = z
  .object({
    path: str(), // URL path for assets; KV key for cache; empty for the worker
    digest: str(),
    size: num(),
  })
  .passthrough();
export type BlobInfo = z.infer<typeof blobInfoSchema>;

const ZERO_BLOB: BlobInfo = { path: '', digest: '', size: 0 };

export const MANIFEST_KIND_BUNDLE = 'bundle';

export const manifestSchema = z
  .object({
    kind: str(),
    worker: blobInfoSchema.nullish().transform((v) => v ?? ZERO_BLOB),
    assets: arr(blobInfoSchema),
    cache: arr(blobInfoSchema),
  })
  .passthrough();
export type Manifest = z.infer<typeof manifestSchema>;

// Callers treat unknown states as "in progress".
export const State = {
  Uploading: 'uploading',
  Activating: 'activating',
  Live: 'live',
  Failed: 'failed',
} as const;
export type State = (typeof State)[keyof typeof State];

export function stateTerminal(s: string): boolean {
  return s === State.Live || s === State.Failed;
}

export const Resolution = {
  Existing: 'existing',
  Created: 'created',
  FingerprintLinked: 'fingerprint_linked',
} as const;
export type Resolution = (typeof Resolution)[keyof typeof Resolution];

export const appSchema = z
  .object({
    id: str(),
    slug: str(),
    url: str(), // https://<slug>-<token>.280apps.run
  })
  .passthrough();
export type App = z.infer<typeof appSchema>;

export const deleteRequestSchema = z
  .object({
    appId: str(),
    confirm: str(),
  })
  .passthrough();
export type DeleteRequest = z.infer<typeof deleteRequestSchema>;

export const deleteResultSchema = z
  .object({
    app: appSchema,
    deleted: bool(),
  })
  .passthrough();
export type DeleteResult = z.infer<typeof deleteResultSchema>;

export const syncRequestSchema = z
  .object({
    identity: identitySchema,
    manifest: manifestSchema,
  })
  .passthrough();
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export const syncResultSchema = z
  .object({
    app: appSchema,
    resolution: str(),
    deployId: str(),
    state: str(),
    missing: arr(z.string()), // digests the server still lacks; empty => just poll
    failure: errorSchema.nullish().transform((v) => v ?? undefined),
  })
  .passthrough();
export type SyncResult = z.infer<typeof syncResultSchema>;

export const deployStatusSchema = z
  .object({
    state: str(),
    url: str(),
    failure: errorSchema.nullish().transform((v) => v ?? undefined),
  })
  .passthrough();
export type DeployStatus = z.infer<typeof deployStatusSchema>;

export const deviceCodeResponseSchema = z
  .object({
    deviceCode: str(),
    userCode: str(),
    verificationUri: str(),
    expiresIn: num(),
    interval: num(),
  })
  .passthrough();
export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>;

export const tokenRequestSchema = z
  .object({ deviceCode: str() })
  .passthrough();
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export const tokenResponseSchema = z
  .object({ token: str() })
  .passthrough();
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

// The approving user comes from the browser session, so the body carries only the code the human typed.
export const approveRequestSchema = z
  .object({ userCode: str() })
  .passthrough();
export type ApproveRequest = z.infer<typeof approveRequestSchema>;

export const appSummarySchema = z
  .object({
    id: str(),
    slug: str(),
    url: str(),
    live: bool(),
  })
  .passthrough();
export type AppSummary = z.infer<typeof appSummarySchema>;

export const appsResponseSchema = z
  .object({ apps: arr(appSummarySchema) })
  .passthrough();
export type AppsResponse = z.infer<typeof appsResponseSchema>;

// Like approve: the owner is the session, so only the typed confirmation rides in the body; the app is in the path.
export const deleteAppRequestSchema = z
  .object({ confirm: str() })
  .passthrough();
export type DeleteAppRequest = z.infer<typeof deleteAppRequestSchema>;

// The signed-in user the backend renders for the web surface. Its id is the subject
// the platform keys accounts on, so a user carries their apps across a re-login.
export const userSchema = z
  .object({
    id: str(),
    email: str(),
    name: str(),
    image: str(),
  })
  .passthrough();
export type User = z.infer<typeof userSchema>;

// What GET /auth/me returns: the current user, or a null user when the request
// carries no valid session (the frontend renders the signed-out state from that).
export const meResponseSchema = z
  .object({ user: userSchema.nullish().transform((v) => v ?? null) })
  .passthrough();
export type MeResponse = z.infer<typeof meResponseSchema>;

// The hex SHA-256 of raw content.
export function digestBytes(data: Uint8Array): Digest {
  return createHash('sha256').update(data).digest('hex');
}

// Orders two strings by their UTF-8 bytes, matching Go's string <.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sortedByPath(items: BlobInfo[]): BlobInfo[] {
  return [...items].sort((x, y) => byteCompare(x.path, y.path));
}

// The manifest's content digest. Each list hashes in its own labeled section,
// sorted by path, so the digest is order-independent and no entry can move between lists unnoticed.
export function canonicalDigest(m: Manifest): Digest {
  const h = createHash('sha256');
  h.update(`kind:${m.kind}\nworker:${m.worker.digest}:${m.worker.size}\n`);
  for (const a of sortedByPath(m.assets)) {
    h.update(`asset:${a.path}:${a.digest}:${a.size}\n`);
  }
  for (const c of sortedByPath(m.cache)) {
    h.update(`cache:${c.path}:${c.digest}:${c.size}\n`);
  }
  return h.digest('hex');
}

// Every blob a manifest names, in stable order (worker, assets, cache); callers derive Missing from it.
export function manifestBlobs(m: Manifest): BlobInfo[] {
  return [m.worker, ...m.assets, ...m.cache];
}
