import type {
  AppAccess,
  AppPolicy,
  BlobBody,
  BlobInfo,
  ConfigEntry,
  DeployError,
  Digest,
  Manifest,
  PreviewGrant,
  State,
} from '@280/contracts';

export type { AppPolicy, PreviewGrant, ViewAsTarget } from '@280/contracts';

export interface User {
  id: string;
  email: string;
  name: string;
  image: string;
}

export interface OAuthAccount {
  provider: string;
  providerAccountId: string;
  userId: string;
}

// Persists the token hash for the `SESSION_COOKIE_NAME` cookie, which defaults to `280_session`.
export interface Session {
  tokenHash: string;
  userId: string;
  expiresAt: number;
}

export const DeviceStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Claimed: 'claimed',
} as const;
export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

// Only the device secret hash is persisted.
export interface DeviceCode {
  deviceHash: string;
  userCode: string;
  userId: string;
  status: DeviceStatus;
  expiresAt: number;
}

export interface App {
  id: string;
  userId: string;
  slug: string;
  framework: string;
  url: string;
  script: string;
  salt: string;

  fingerprint: string;
  clientRef: string;

  activeDeploy: string;

  createdAt: number;
  lastDeployAt: number | null;
}

export interface Deploy {
  appId: string;
  id: string;
  manifest: Manifest;
  state: State;
  failure: DeployError | null;
}

export const EventKind = {
  AppCreated: 'app.created',
  AppDeleted: 'app.deleted',
  DeployLive: 'deploy.live',
  DeployFailed: 'deploy.failed',
  LoginApproved: 'login.approved',
  LoginClaimed: 'login.claimed',
  GrantAdded: 'grant.added',
  GrantRevoked: 'grant.revoked',
  PolicyRegistered: 'policy.registered',
  PolicyAccessChanged: 'policy.access_changed',
  AppAccessed: 'app.accessed',
  AppAccessDenied: 'app.access_denied',
  AppPreviewedAs: 'app.previewed_as',
  SecretSet: 'secret.set',
  SecretRemoved: 'secret.removed',
  IntegrationConnected: 'integration.connected',
  IntegrationReauthorized: 'integration.reauthorized',
  IntegrationDisconnected: 'integration.disconnected',
  IntegrationResourceAdded: 'integration.resource_added',
  IntegrationResourceRemoved: 'integration.resource_removed',
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export interface Event {
  id: number;
  userId: string;
  appId: string;
  deployId: string;
  kind: EventKind;
  detail: string;
  createdAt: number;
}

// Secret values stay control-plane side for future SDK capabilities. Config values are readable by the app.
export interface AppSecret {
  appId: string;
  name: string;
  envelope: string;
  setBy: string;
  setAt: number;
  kind: 'secret' | 'config';
}

export interface ExpiryCounts {
  sessions: number;
  deviceCodes: number;
  rateLimits: number;
  tokens: number;
  previewGrants: number;
  integrationAttempts: number;
}

export const AppRole = {
  Owner: 'owner',
  Admin: 'admin',
  Editor: 'editor',
  Viewer: 'viewer',
} as const;
export type AppRole = (typeof AppRole)[keyof typeof AppRole];

export interface Grant {
  appId: string;
  principal: string;
  appRole: AppRole;
  featureRole: string;
  dataScope: Record<string, unknown> | null;
  grantedBy: string;
  grantedAt: number;
}

export const IntegrationStatus = {
  Active: 'active',
  ReauthorizationRequired: 'reauthorization_required',
  Revoked: 'revoked',
} as const;
export type IntegrationStatus = (typeof IntegrationStatus)[keyof typeof IntegrationStatus];

// One external account authorization belonging to one 280 app. The credential
// envelope is provider-opaque JSON encrypted by SecretCipher; only the provider
// adapter interprets its plaintext. credentialVersion backs the refresh compare-and-swap.
export interface IntegrationConnection {
  id: string;
  appId: string;
  provider: string;
  accountId: string;
  accountLabel: string;
  credentialEnvelope: string;
  credentialVersion: number;
  scopes: string[];
  status: IntegrationStatus;
  createdAt: number;
  updatedAt: number;
}

// Binds an app-friendly alias (e.g. "orders") to one provider resource (e.g. a
// spreadsheet id). externalId is server-resolved: app code never sends it.
export interface IntegrationResource {
  id: string;
  connectionId: string;
  appId: string;
  capability: string;
  alias: string;
  externalId: string;
  displayName: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// One-time OAuth callback state. Only the state hash is stored; the payload
// envelope holds the encrypted PKCE verifier, browser binding, and return path.
export interface IntegrationOAuthAttempt {
  stateHash: string;
  appId: string;
  userId: string;
  provider: string;
  payloadEnvelope: string;
  expiresAt: number;
  consumedAt: number;
}

export interface Store {
  close(): Promise<void>;

  recentEvents(limit: number): Promise<Event[]>;

  // Returns null when the token is unknown or not newer than minCreatedAt.
  userByToken(tokenHash: string, minCreatedAt: number): Promise<User | null>;
  addToken(userId: string, tokenHash: string): Promise<void>;

  userById(id: string): Promise<User | null>;
  userByEmail(email: string): Promise<User | null>;
  createUser(u: User): Promise<void>;
  oauthAccount(provider: string, providerAccountId: string): Promise<OAuthAccount | null>;
  linkOAuthAccount(a: OAuthAccount): Promise<void>;
  createSession(s: Session): Promise<void>;
  sessionByHash(tokenHash: string): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<void>;

  // Records the attempt in a shared fixed window and returns whether it is allowed.
  touchLoginRate(key: string, now: number, windowSecs: number, limit: number): Promise<boolean>;

  // Removes expired authentication records and returns the number removed by kind.
  deleteExpired(now: number, machineTokenTtlSecs: number): Promise<ExpiryCounts>;

  createDeviceCode(d: DeviceCode): Promise<void>;
  deviceCodeByHash(hash: string): Promise<DeviceCode | null>;
  approveDeviceCode(userCode: string, userId: string, now: number): Promise<boolean>;
  claimDeviceCode(deviceHash: string): Promise<boolean>;

  // Preview tokens are persisted only by hash.
  createPreviewGrant(g: PreviewGrant): Promise<void>;
  previewGrantByHash(tokenHash: string): Promise<PreviewGrant | null>;
  revokePreviewGrant(tokenHash: string): Promise<boolean>;

  app(userId: string, appId: string): Promise<App | null>;
  appsByFingerprint(userId: string, fingerprint: string): Promise<App[]>;
  appsByUser(userId: string): Promise<App[]>;
  appByClientRef(userId: string, ref: string): Promise<App | null>;
  createApp(a: App): Promise<void>;
  deleteApp(userId: string, appId: string): Promise<boolean>;
  appByScript(script: string): Promise<App | null>;

  deploy(appId: string, deployId: string): Promise<Deploy | null>;
  // Returns the newest deploy regardless of state.
  latestDeploy(appId: string): Promise<Deploy | null>;
  openDeploys(appId: string): Promise<Deploy[]>;
  openDeploy(d: Deploy): Promise<Deploy>;
  claimActivation(appId: string, deployId: string): Promise<boolean>;
  parkActivation(appId: string, deployId: string, waitingAt: number): Promise<boolean>;
  resumeActivation(appId: string, deployId: string): Promise<boolean>;
  waitingDeploysBefore(cutoff: number): Promise<Deploy[]>;
  failWaitingSecrets(appId: string, deployId: string, failure: DeployError): Promise<boolean>;
  finishLive(appId: string, deployId: string): Promise<void>;
  finishFailed(appId: string, deployId: string, failure: DeployError | null): Promise<void>;

  // Grant mutations also append an audit event naming the actor.
  putGrant(g: Grant): Promise<void>;
  grant(appId: string, principal: string): Promise<Grant | null>;
  grantsByApp(appId: string): Promise<Grant[]>;
  revokeGrant(appId: string, principal: string, revokedBy?: string): Promise<boolean>;

  // Returns null until the app has a live policy.
  appPolicy(appId: string): Promise<AppPolicy | null>;

  // Updates the durable access override. Returns false when no live policy exists.
  setAppAccess(appId: string, access: AppAccess, setBy: string): Promise<boolean>;

  putAppSecret(secret: AppSecret): Promise<void>;
  deleteAppSecret(appId: string, name: string, deletedBy: string): Promise<boolean>;
  appSecrets(appId: string): Promise<AppSecret[]>;
  appSecretNames(appId: string): Promise<string[]>;

  // One-time OAuth state. consumeOAuthAttempt atomically marks the state consumed
  // and returns it only if it was fresh (unconsumed and unexpired), so a replayed
  // callback cannot exchange a code twice.
  createOAuthAttempt(a: IntegrationOAuthAttempt): Promise<void>;
  consumeOAuthAttempt(stateHash: string, now: number): Promise<IntegrationOAuthAttempt | null>;

  // Upsert keyed on (app_id, provider): reconnecting an app replaces its credential
  // in place. Emits a connect/reauthorize audit event naming metadata only.
  putConnection(c: IntegrationConnection, reconnect: boolean): Promise<void>;
  connectionById(appId: string, id: string): Promise<IntegrationConnection | null>;
  connectionByProvider(appId: string, provider: string): Promise<IntegrationConnection | null>;
  connectionsByApp(appId: string): Promise<IntegrationConnection[]>;
  // Compare-and-swap on credentialVersion so a replica cannot overwrite newer token
  // material. Returns false when the expected version no longer matches.
  swapConnectionCredential(
    id: string,
    expectedVersion: number,
    next: { envelope: string; accountId: string; accountLabel: string; scopes: string[]; status: IntegrationStatus },
  ): Promise<boolean>;
  setConnectionStatus(id: string, status: IntegrationStatus): Promise<void>;
  // Removes the connection and its resources, returning the removed row so the
  // caller can best-effort revoke the provider token before it is gone.
  deleteConnection(appId: string, id: string): Promise<IntegrationConnection | null>;

  putResource(r: IntegrationResource): Promise<void>;
  resourceByAlias(appId: string, capability: string, alias: string): Promise<IntegrationResource | null>;
  resourcesByConnection(connectionId: string): Promise<IntegrationResource[]>;
  deleteResource(appId: string, id: string): Promise<boolean>;

  // Audit failures must not block requests.
  recordAppAccess(e: {
    appId: string;
    principal: string;
    allowed: boolean;
    detail?: string;
    kind?: EventKind;
  }): Promise<void>;
}

// Blob reads reject missing content. Blob writes reject size or digest mismatches.
export interface BlobStore {
  has(appId: string, digest: Digest): Promise<boolean>;
  // Size is the manifest declaration, not the transport content length.
  put(appId: string, digest: Digest, size: number, body: BlobBody): Promise<void>;
  get(appId: string, digest: Digest): Promise<Uint8Array>;
  deleteApp(appId: string): Promise<void>;
  missing(appId: string, want: BlobInfo[]): Promise<Digest[]>;
}

export interface ContainerApp {
  id: string;
  script: string;
}

export interface ConfigDelivery {
  resolve(app: ContainerApp, config: ConfigEntry[]): Promise<Record<string, string>>;
}
