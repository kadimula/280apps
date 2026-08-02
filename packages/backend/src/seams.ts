// Platform internal seams as TS interfaces; behavior is normative in the Go
// spec: platform/internal/{store/store.go, blobstore/blobstore.go, runtime/runtime.go}.
// Go's (value, found, error) is modeled as a nullable return (value | null) with
// failures rejecting; conditional transitions that report a winner return boolean.

import type { BlobBody } from '@280/contracts';
import type { Manifest, Digest, BlobInfo, DeployError, AppPolicy } from '@280/contracts';

export type { AppPolicy } from '@280/contracts';

// subject is the owning user's id; empty only in legacy or test rows.
export interface Account {
  id: string;
  subject: string;
}

// id is the subject the platform keys accounts on, so preserving ids across the
// next-auth migration is what keeps existing users' apps attached to them.
export interface User {
  id: string;
  email: string;
  name: string;
  image: string;
}

// (provider, providerAccountId) is the provider's stable handle for the user,
// e.g. Google's `sub`.
export interface OAuthAccount {
  provider: string;
  providerAccountId: string;
  userId: string;
}

// Only the token's hash is stored, so a leaked database does not hand over the
// ability to impersonate every logged-in user.
export interface Session {
  tokenHash: string;
  userId: string;
  expiresAt: number; // unix seconds
}

export const DeviceStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Claimed: 'claimed',
} as const;
export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

// deviceHash is the hash of the CLI's secret; the secret itself is never stored.
export interface DeviceCode {
  deviceHash: string;
  userCode: string;
  accountId: string; // set on approval
  status: string;
  expiresAt: number; // unix seconds
}

// Script and URL are assigned at creation and never change.
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

export interface Deploy {
  appId: string;
  id: string;
  manifest: Manifest;
  state: string;
  failure: DeployError | null;
}

export const EventKind = {
  AppCreated: 'app.created',
  AppDeleted: 'app.deleted',
  DeployLive: 'deploy.live',
  DeployFailed: 'deploy.failed',
  LoginApproved: 'login.approved',
  LoginClaimed: 'login.claimed',
  // The permission audit (design §08): who was granted or revoked, whose live
  // deploy re-registered its policy, and who reached (or was denied) an app.
  GrantAdded: 'grant.added',
  GrantRevoked: 'grant.revoked',
  PolicyRegistered: 'policy.registered',
  AppAccessed: 'app.accessed',
  AppAccessDenied: 'app.access_denied',
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export interface Event {
  id: number;
  accountId: string;
  appId: string;
  deployId: string;
  kind: string;
  detail: string; // small JSON object string, or empty
  createdAt: number;
}

export interface ExpiryCounts {
  sessions: number;
  deviceCodes: number;
  rateLimits: number;
}

// Tier 1 of the permission model: roles over the app as an object (open it, change
// its code, manage its grants), identical for every 280 app so one share dialog
// drives them all. Owner and Admin manage grants; Editor changes code; Viewer opens.
export const AppRole = {
  Owner: 'owner',
  Admin: 'admin',
  Editor: 'editor',
  Viewer: 'viewer',
} as const;
export type AppRole = (typeof AppRole)[keyof typeof AppRole];

// One principal's access to one app. The model is flat (one row per (app,
// principal), no relationship graph) until relationships turn graph-shaped. appRole
// is tier 1; featureRole is tier 2, a builder-defined role from the app's 280.json
// into which custom actions fold via can().
export interface Grant {
  appId: string;
  principal: string; // 'alice@firm.com' or 'domain:firm.com'
  appRole: AppRole;
  featureRole: string; // '' when the principal holds no feature role
  dataScope: Record<string, unknown> | null; // advisory JSON, null when unset
  grantedBy: string;
  grantedAt: number; // unix seconds
}

export interface Store {
  close(): Promise<void>;

  recentEvents(limit: number): Promise<Event[]>;

  accountByToken(tokenHash: string): Promise<Account | null>;
  accountBySubject(subject: string): Promise<Account | null>;
  createAccount(a: Account): Promise<void>;
  ensureAccount(subject: string, newId: string): Promise<Account>;
  addToken(accountId: string, tokenHash: string): Promise<void>;

  // The identity the backend owns once login moves off the frontend: users key on
  // a stable id, oauth logins on the provider's handle, sessions on a hashed token.
  userById(id: string): Promise<User | null>;
  userByEmail(email: string): Promise<User | null>;
  createUser(u: User): Promise<void>;
  oauthAccount(provider: string, providerAccountId: string): Promise<OAuthAccount | null>;
  linkOAuthAccount(a: OAuthAccount): Promise<void>;
  createSession(s: Session): Promise<void>;
  sessionByHash(tokenHash: string): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<void>;

  // Records one login attempt from key (a client IP) in a fixed window and reports
  // whether still under limit. The window is stored, so replicas share one counter.
  touchLoginRate(key: string, now: number, windowSecs: number, limit: number): Promise<boolean>;

  // Removes rows no longer valid as of now (expired sessions and device codes,
  // lapsed rate windows). Idempotent; the counts returned are only for the log line.
  deleteExpired(now: number): Promise<ExpiryCounts>;

  createDeviceCode(d: DeviceCode): Promise<void>;
  deviceCodeByHash(hash: string): Promise<DeviceCode | null>;
  approveDeviceCode(userCode: string, accountId: string, now: number): Promise<boolean>;
  claimDeviceCode(deviceHash: string): Promise<boolean>;

  app(accountId: string, appId: string): Promise<App | null>;
  appsByFingerprint(accountId: string, fingerprint: string): Promise<App[]>;
  appsByAccount(accountId: string): Promise<App[]>;
  appByClientRef(accountId: string, ref: string): Promise<App | null>;
  createApp(a: App): Promise<void>;
  deleteApp(accountId: string, appId: string): Promise<boolean>;
  setStoreId(appId: string, storeId: string): Promise<void>;
  appByScript(script: string): Promise<App | null>;

  deploy(appId: string, deployId: string): Promise<Deploy | null>;
  openDeploys(appId: string): Promise<Deploy[]>;
  openDeploy(d: Deploy): Promise<Deploy>;
  claimActivation(appId: string, deployId: string): Promise<boolean>;
  finishLive(appId: string, deployId: string): Promise<void>;
  finishFailed(appId: string, deployId: string, failure: DeployError | null): Promise<void>;

  // The two-tier sharing model, flat (one row per (app, principal)). putGrant
  // upserts and revokeGrant deletes; both write a permission-audit event naming the
  // actor (grantedBy / revokedBy), so every change to who-can-do-what is on record.
  putGrant(g: Grant): Promise<void>;
  grant(appId: string, principal: string): Promise<Grant | null>;
  grantsByApp(appId: string): Promise<Grant[]>;
  revokeGrant(appId: string, principal: string, revokedBy?: string): Promise<boolean>;

  // The enforced policy of the app's live deploy — access mode, feature roles, route
  // gates, secret names, owner tenant. Registered atomically when a deploy goes live
  // (see finishLive), read by the gateway to gate each request. Null until the app
  // has gone live at least once.
  appPolicy(appId: string): Promise<AppPolicy | null>;

  // Records one gateway access decision (allowed/denied) for the permission audit.
  // Best-effort by contract: the caller swallows its error so an audit-write fault
  // never blocks serving a request.
  recordAppAccess(e: { appId: string; principal: string; allowed: boolean; detail?: string }): Promise<void>;
}

// Deploy content, addressed by digest and scoped to one app. get rejects
// not-found for an unstored digest; put rejects digest_mismatch (storing nothing)
// when bytes do not hash to the declared digest.
export interface BlobStore {
  has(appId: string, digest: Digest): Promise<boolean>;
  // size is the manifest's declared length (BlobInfo.size), not Content-Length; the
  // backing hashes the body as it drains and rejects digest_mismatch on any mismatch.
  put(appId: string, digest: Digest, size: number, body: BlobBody): Promise<void>;
  get(appId: string, digest: Digest): Promise<Uint8Array>;
  deleteApp(appId: string): Promise<void>;
  missing(appId: string, want: BlobInfo[]): Promise<Digest[]>;
}

// A projection of store.App, so runtimes cannot reach into the control plane.
export interface RuntimeApp {
  id: string;
  slug: string;
  framework: string;
  script: string;
  salt: string;
  storeId: string; // empty until the runtime creates one
}

export interface Activation {
  app: RuntimeApp;
  deployId: string;
  manifest: Manifest;
  asset(digest: Digest): Promise<Uint8Array>; // reads one blob the manifest names, including the worker
}

// Empty storeId means unchanged.
export interface RuntimeResult {
  storeId: string;
}

// activate is atomic and idempotent and leaves the previously serving version
// intact on error; delete is a hard, idempotent delete.
export interface Runtime {
  activate(act: Activation): Promise<RuntimeResult>;
  delete(app: RuntimeApp): Promise<void>;
}
