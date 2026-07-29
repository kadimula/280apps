// Platform internal seams as TS interfaces. Method signatures are lifted from
// the Go seam surfaces; behavior is normative there.
// Spec: platform/internal/store/store.go, platform/internal/blobstore/blobstore.go,
// platform/internal/runtime/runtime.go.
//
// Go lookups return (value, found, error); the TS seam models "found" as a
// nullable return (value | null) and surfaces failures by rejecting. Conditional
// transitions that report a winner (ClaimActivation, ClaimDeviceCode,
// ApproveDeviceCode) return boolean.

import type { BlobBody } from '@280/contracts';
import type { Manifest, Digest, BlobInfo, DeployError } from '@280/contracts';

// ============================ store (store.go) ============================

// Account owns apps (store.go:38). Subject is empty for OpenSignup accounts.
export interface Account {
  id: string;
  subject: string;
}

// User is a person the backend has authenticated. Its id is the subject the
// platform keys accounts on, so preserving ids across the next-auth migration is
// what keeps existing users' apps attached to them.
export interface User {
  id: string;
  email: string;
  name: string;
  image: string;
}

// OAuthAccount links a user to one external identity provider login. The pair
// (provider, providerAccountId) is the provider's stable handle for the user,
// e.g. Google's `sub`.
export interface OAuthAccount {
  provider: string;
  providerAccountId: string;
  userId: string;
}

// Session is one signed-in browser. Only the token's hash is stored, so a leaked
// database does not hand over the ability to impersonate every logged-in user.
export interface Session {
  tokenHash: string;
  userId: string;
  expiresAt: number; // unix seconds
}

// Device-flow states (store.go:45-49).
export const DeviceStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Claimed: 'claimed',
} as const;
export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

// DeviceCode is one in-flight login (store.go:53). DeviceHash is the hash of the
// CLI's secret; the secret itself is never stored.
export interface DeviceCode {
  deviceHash: string;
  userCode: string;
  accountId: string; // set on approval
  status: string;
  expiresAt: number; // unix seconds
}

// App is one deployed application (store.go:63). Script and URL are assigned at
// creation and never change.
export interface App {
  id: string;
  accountId: string;
  slug: string;
  framework: string;
  url: string; // https://<slug>-<token>.<domain>
  script: string; // runtime script name; also the URL's host label
  salt: string; // per-app asset-hash salt

  fingerprint: string; // hash of git remote + slug, for autolink
  clientRef: string; // create-dedup nonce when there is no git remote

  storeId: string; // the app's SQL store, assigned on first activation
  activeDeploy: string; // the deploy the app is serving
}

// Deploy is one attempt to make an app serve one manifest (store.go:80).
export interface Deploy {
  appId: string;
  id: string;
  manifest: Manifest;
  state: string;
  failure: DeployError | null;
}

// Event kinds (store.go:95-102).
export const EventKind = {
  AppCreated: 'app.created',
  AppDeleted: 'app.deleted',
  DeployLive: 'deploy.live',
  DeployFailed: 'deploy.failed',
  LoginApproved: 'login.approved',
  LoginClaimed: 'login.claimed',
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

// Event is one thing that happened (store.go:110). Detail is a small JSON object
// string or empty.
export interface Event {
  id: number;
  accountId: string;
  appId: string;
  deployId: string;
  kind: string;
  detail: string;
  createdAt: number;
}

// ExpiryCounts reports how many rows one scheduled cleanup removed, per table,
// for the log line the sweep writes.
export interface ExpiryCounts {
  sessions: number;
  deviceCodes: number;
  rateLimits: number;
}

// Store is the platform's control-plane database (store.go:121).
export interface Store {
  close(): Promise<void>;

  // events
  recentEvents(limit: number): Promise<Event[]>;

  // accounts
  accountByToken(tokenHash: string): Promise<Account | null>;
  accountBySubject(subject: string): Promise<Account | null>;
  createAccount(a: Account): Promise<void>;
  ensureAccount(subject: string, newId: string): Promise<Account>;
  addToken(accountId: string, tokenHash: string): Promise<void>;

  // users, oauth logins, and browser sessions (the identity the backend owns
  // once login moves off the frontend). Users key on a stable id; oauth logins
  // key on the provider's handle; sessions key on their hashed token.
  userById(id: string): Promise<User | null>;
  userByEmail(email: string): Promise<User | null>;
  createUser(u: User): Promise<void>;
  oauthAccount(provider: string, providerAccountId: string): Promise<OAuthAccount | null>;
  linkOAuthAccount(a: OAuthAccount): Promise<void>;
  createSession(s: Session): Promise<void>;
  sessionByHash(tokenHash: string): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<void>;

  // touchLoginRate records one login attempt from key (a client IP) inside a
  // fixed window and reports whether it is still under the limit. The window is
  // stored, not held in a process, so replicas share one counter.
  touchLoginRate(key: string, now: number, windowSecs: number, limit: number): Promise<boolean>;

  // deleteExpired removes rows no longer valid as of now: browser sessions and
  // device codes past their expiry, and login-rate windows that have lapsed. It
  // is the scheduled cleanup's whole job (worker.ts scheduled()); the counts it
  // returns are only for the log line. Idempotent: a second sweep with nothing
  // expired removes nothing.
  deleteExpired(now: number): Promise<ExpiryCounts>;

  // device codes
  createDeviceCode(d: DeviceCode): Promise<void>;
  deviceCodeByHash(hash: string): Promise<DeviceCode | null>;
  approveDeviceCode(userCode: string, accountId: string, now: number): Promise<boolean>;
  claimDeviceCode(deviceHash: string): Promise<boolean>;

  // apps
  app(accountId: string, appId: string): Promise<App | null>;
  appsByFingerprint(accountId: string, fingerprint: string): Promise<App[]>;
  appsByAccount(accountId: string): Promise<App[]>;
  appByClientRef(accountId: string, ref: string): Promise<App | null>;
  createApp(a: App): Promise<void>;
  deleteApp(accountId: string, appId: string): Promise<boolean>;
  setStoreId(appId: string, storeId: string): Promise<void>;
  appByScript(script: string): Promise<App | null>;

  // deploys
  deploy(appId: string, deployId: string): Promise<Deploy | null>;
  openDeploys(appId: string): Promise<Deploy[]>;
  openDeploy(d: Deploy): Promise<Deploy>;
  claimActivation(appId: string, deployId: string): Promise<boolean>;
  finishLive(appId: string, deployId: string): Promise<void>;
  finishFailed(appId: string, deployId: string, failure: DeployError | null): Promise<void>;
}

// ========================= blobstore (blobstore.go) =========================

// BlobStore holds deploy content, addressed by digest and scoped to one app
// (blobstore.go:29). Get rejects with a not-found error for an unstored digest;
// Put rejects with digest_mismatch when bytes do not hash to the declared digest
// and stores nothing in that case.
export interface BlobStore {
  has(appId: string, digest: Digest): Promise<boolean>;
  // put stores body under digest for the app. size is the blob's declared length
  // from the manifest (BlobInfo.size), not the client's Content-Length: the R2
  // backing uses it to frame a FixedLengthStream so a body that ends short or
  // long is rejected as digest_mismatch, and the filesystem backing ignores it
  // (it hashes the bytes regardless). Rejects digest_mismatch when the bytes do
  // not hash to digest, storing nothing.
  put(appId: string, digest: Digest, size: number, body: BlobBody): Promise<void>;
  get(appId: string, digest: Digest): Promise<Uint8Array>;
  deleteApp(appId: string): Promise<void>;
  missing(appId: string, want: BlobInfo[]): Promise<Digest[]>;
}

// =========================== runtime (runtime.go) ===========================

// RuntimeApp is what a runtime needs to know about an application (runtime.go:22).
// A projection of store.App, so runtimes cannot reach into the control plane.
export interface RuntimeApp {
  id: string;
  slug: string;
  framework: string;
  script: string;
  salt: string;
  storeId: string; // empty until the runtime creates one
}

// Activation is one request to make a deploy the app's serving version
// (runtime.go:32).
export interface Activation {
  app: RuntimeApp;
  deployId: string;
  manifest: Manifest;
  // asset reads one blob the manifest names, including the worker.
  asset(digest: Digest): Promise<Uint8Array>;
}

// RuntimeResult reports state the runtime owns and the control plane must
// persist (runtime.go:48). Empty storeId means unchanged.
export interface RuntimeResult {
  storeId: string;
}

// Runtime hosts apps (runtime.go:55). Activate is atomic and idempotent and
// leaves the previously serving version intact on error; Delete is a hard,
// idempotent delete.
export interface Runtime {
  activate(act: Activation): Promise<RuntimeResult>;
  delete(app: RuntimeApp): Promise<void>;
}
