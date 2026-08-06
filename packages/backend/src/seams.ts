// Platform internal seams as TS interfaces; behavior is normative in the Go
// spec: platform/internal/{store/store.go, blobstore/blobstore.go, runtime/runtime.go}.
// Go's (value, found, error) is modeled as a nullable return (value | null) with
// failures rejecting; conditional transitions that report a winner return boolean.

import type { BlobBody } from '@280/contracts';
import type { Manifest, Digest, BlobInfo, DeployError, AppAccess, AppPolicy, PreviewGrant } from '@280/contracts';

export type { AppPolicy, PreviewGrant, ViewAsTarget } from '@280/contracts';

// id is the OIDC-stable principal every resource keys on, so preserving ids across
// the next-auth migration is what keeps existing users' apps attached to them.
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
  userId: string; // set on approval
  status: string;
  expiresAt: number; // unix seconds
}

// Script and URL are assigned at creation and never change.
export interface App {
  id: string;
  userId: string;
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
  // The owner dialed the app's general-access mode from the dashboard; detail
  // records {from, to, by}. The override outlives redeploys (registerPolicy
  // never touches it).
  PolicyAccessChanged: 'policy.access_changed',
  AppAccessed: 'app.accessed',
  AppAccessDenied: 'app.access_denied',
  // A "view as user" preview mint: an owner/admin rendered the app as another
  // principal. Detail names both the acting owner and the impersonated principal.
  AppPreviewedAs: 'app.previewed_as',
  SecretSet: 'secret.set',
  // A stored value erased because the live manifest no longer declares its name;
  // this event is the tombstone (the row itself is deleted).
  SecretRemoved: 'secret.removed',
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export interface Event {
  id: number;
  userId: string;
  appId: string;
  deployId: string;
  kind: string;
  detail: string; // small JSON object string, or empty
  createdAt: number;
}

export interface AppSecret {
  appId: string;
  name: string;
  envelope: string;
  setBy: string;
  setAt: number;
}

export interface ExpiryCounts {
  sessions: number;
  deviceCodes: number;
  rateLimits: number;
  tokens: number;
  previewGrants: number;
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

  // Resolves the token's user only if it is still valid: minCreatedAt is the
  // caller's now - ttl, and a token created at or before it is expired (null),
  // indistinguishable from an unknown token.
  userByToken(tokenHash: string, minCreatedAt: number): Promise<User | null>;
  addToken(userId: string, tokenHash: string): Promise<void>;

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
  // lapsed rate windows, machine tokens created before now - machineTokenTtlSecs).
  // Idempotent; the counts returned are only for the log line.
  deleteExpired(now: number, machineTokenTtlSecs: number): Promise<ExpiryCounts>;

  createDeviceCode(d: DeviceCode): Promise<void>;
  deviceCodeByHash(hash: string): Promise<DeviceCode | null>;
  approveDeviceCode(userCode: string, userId: string, now: number): Promise<boolean>;
  claimDeviceCode(deviceHash: string): Promise<boolean>;

  // Dashboard preview grants (the device-code discipline: only the hash is
  // stored). The control plane writes them; the gateway reads and honors them over
  // the same shared store, so revocation and expiry apply on the next mint.
  createPreviewGrant(g: PreviewGrant): Promise<void>;
  previewGrantByHash(tokenHash: string): Promise<PreviewGrant | null>;
  revokePreviewGrant(tokenHash: string): Promise<boolean>;

  app(userId: string, appId: string): Promise<App | null>;
  appsByFingerprint(userId: string, fingerprint: string): Promise<App[]>;
  appsByUser(userId: string): Promise<App[]>;
  appByClientRef(userId: string, ref: string): Promise<App | null>;
  createApp(a: App): Promise<void>;
  deleteApp(userId: string, appId: string): Promise<boolean>;
  setStoreId(appId: string, storeId: string): Promise<void>;
  appByScript(script: string): Promise<App | null>;

  deploy(appId: string, deployId: string): Promise<Deploy | null>;
  // The app's newest deploy in any state, for surfaces that must see a pending
  // manifest before it goes live (secret entry precedes the first go-live).
  latestDeploy(appId: string): Promise<Deploy | null>;
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

  // The dashboard's general-access override (design: Share modal "General
  // access"). Writes access_override — never the manifest's access column — and
  // audits policy.access_changed naming the actor. False when the app has no
  // policy row yet (never gone live), which callers reject rather than create.
  setAppAccess(appId: string, access: AppAccess, setBy: string): Promise<boolean>;

  putAppSecret(secret: AppSecret): Promise<void>;
  deleteAppSecret(appId: string, name: string, deletedBy: string): Promise<boolean>;
  appSecrets(appId: string): Promise<AppSecret[]>;
  appSecretNames(appId: string): Promise<string[]>;

  // Records one gateway access decision (allowed/denied) for the permission audit.
  // kind overrides the event kind derived from `allowed` (e.g. app.previewed_as
  // for an impersonating preview mint). Best-effort by contract: the caller
  // swallows its error so an audit-write fault never blocks serving a request.
  recordAppAccess(e: {
    appId: string;
    principal: string;
    allowed: boolean;
    detail?: string;
    kind?: string;
  }): Promise<void>;
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

export interface SecretDelivery {
  rollout(app: RuntimeApp, declared: string[]): Promise<void>;
  set(app: RuntimeApp, name: string): Promise<void>;
  delete(app: RuntimeApp, name: string): Promise<void>;
}
