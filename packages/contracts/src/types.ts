// Deploy & auth wire types, their zod schemas, and the two content derivations
// (DigestBytes, CanonicalDigest). Parsing mirrors Go encoding/json: unknown fields
// preserved, absent/null optionals become the Go zero value (a strict schema would
// break old clients). Spec: contracts/deploy/deploy.go, contracts/auth/auth.go (normative).

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { errorSchema } from './errors.js';

// MaxBuildContextBytes caps the total size of an uploaded container build
// context, the coarse guard preflight applies before any state changes.
export const MAX_BUILD_CONTEXT_BYTES = 512 << 20; // 512 MiB

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
    path: str(), // context-relative path of a build-context file
    digest: str(),
    size: num(),
  })
  .passthrough();
export type BlobInfo = z.infer<typeof blobInfoSchema>;

export const MANIFEST_KIND_CONTAINER = 'container';

// BuildSpec is how the runtime turns the uploaded build context into a runnable
// image: which Dockerfile to build, the port the app listens on, and a builder
// tag for diagnostics ('next' | 'static' | 'dockerfile').
export const buildSpecSchema = z
  .object({
    builder: str(),
    dockerfile: str(), // context-relative path, e.g. "Dockerfile"
    port: num(),
  })
  .passthrough();
export type BuildSpec = z.infer<typeof buildSpecSchema>;

const ZERO_BUILD: BuildSpec = { builder: '', dockerfile: '', port: 0 };

// EgressCredential binds one allowed host to a platform-held secret the outbound
// handler attaches in-flight. Only the secret NAME travels on the wire; its value
// lives in the Worker vault and never enters the app's container. header defaults
// to authorization and scheme to Bearer, so `{host, secret}` covers bearer APIs;
// a raw-value header (e.g. apikey) sets scheme to ''.
export const egressCredentialSchema = z
  .object({
    host: str(),
    secret: str(), // the secret's name; the value is resolved from the vault at call time
    header: str('authorization'),
    scheme: str('Bearer'),
  })
  .passthrough();
export type EgressCredential = z.infer<typeof egressCredentialSchema>;

// EgressPolicy is an app's outbound contract, derived from its 280.json: the hosts
// it may reach and the credentials the handler attaches per host. Anything not in
// allowedHosts fails closed (HTTP 520) at the container boundary. Rides in the
// Manifest so a policy change re-derives the deploy id and redeploys.
export const egressPolicySchema = z
  .object({
    allowedHosts: arr(z.string()),
    credentials: arr(egressCredentialSchema),
  })
  .passthrough();
export type EgressPolicy = z.infer<typeof egressPolicySchema>;

const ZERO_EGRESS: EgressPolicy = { allowedHosts: [], credentials: [] };

// normalizeEgressPolicy is the one place the allowlist is derived, so the CLI that
// builds the policy and the runtime that applies it never disagree: a credential's
// host is implicitly allowed, hosts are lowercased/trimmed, and duplicates drop.
export function normalizeEgressPolicy(p: EgressPolicy): EgressPolicy {
  const credentials = p.credentials
    .map((c) => ({ ...c, host: c.host.trim().toLowerCase() }))
    .filter((c) => c.host !== '');
  const hosts = new Set<string>();
  for (const h of p.allowedHosts) {
    const host = h.trim().toLowerCase();
    if (host !== '') hosts.add(host);
  }
  for (const c of credentials) hosts.add(c.host);
  return { allowedHosts: [...hosts].sort(), credentials };
}

// Manifest is a container build-context descriptor: the build recipe plus every
// file in the context, each content-addressed so the deploy loop transfers only
// what the server lacks. Replaces the retired Workers-for-Platforms bundle shape.
export const manifestSchema = z
  .object({
    kind: str(),
    build: buildSpecSchema.nullish().transform((v) => v ?? ZERO_BUILD),
    files: arr(blobInfoSchema),
    egress: egressPolicySchema.nullish().transform((v) => v ?? ZERO_EGRESS),
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

// canonicalDigest is the manifest's content digest: the build recipe followed by
// every file sorted by path. Order-independent, and no field can change without
// changing it, so the derived deploy id is a pure function of what is deployed.
export function canonicalDigest(m: Manifest): Digest {
  const h = createHash('sha256');
  h.update(`kind:${m.kind}\n`);
  h.update(`build:${m.build.builder}:${m.build.dockerfile}:${m.build.port}\n`);
  for (const f of sortedByPath(m.files)) {
    h.update(`file:${f.path}:${f.digest}:${f.size}\n`);
  }
  const eg = normalizeEgressPolicy(m.egress ?? ZERO_EGRESS);
  for (const host of eg.allowedHosts) h.update(`egress-host:${host}\n`);
  for (const c of [...eg.credentials].sort((a, b) => byteCompare(a.host, b.host))) {
    h.update(`egress-cred:${c.host}:${c.header}:${c.scheme}:${c.secret}\n`);
  }
  return h.digest('hex');
}

// manifestBlobs returns every blob a manifest names. Callers derive Missing from
// it; duplicate digests (identical bytes at different paths) are deduped there.
export function manifestBlobs(m: Manifest): BlobInfo[] {
  return [...m.files];
}
