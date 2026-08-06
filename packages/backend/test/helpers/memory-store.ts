// In-memory Store for W5 behavior tests, mirroring the semantics of
// platform/internal/store/store.go that deploysvc and api depend on: conditional
// activation claim, device-code state machine, clientRef/script uniqueness,
// open-deploy reopen, and FinishLive superseding the prior live row. The real
// Postgres Store (W4) implements the same seam.

import {
  State,
  stateTerminal,
  appPolicyFromManifest,
  isAppAccess,
  tenantFromEmail,
  APP_ACCESS,
  type AppAccess,
  type AppPolicy,
  type DeployError,
  type PreviewGrant,
} from '@280/contracts';
import {
  DeviceStatus,
  EventKind,
  type App,
  type AppSecret,
  type Deploy,
  type DeviceCode,
  type Event,
  type ExpiryCounts,
  type Grant,
  type OAuthAccount,
  type Session,
  type Store,
  type User,
} from '../../src/seams.js';

export class MemoryStore implements Store {
  private seq = 0;
  private readonly tokens = new Map<string, { userId: string; createdAt: number }>();
  // Settable so a test can seed a token created in the past; real time otherwise.
  tokenClock: () => number = () => Math.floor(Date.now() / 1000);
  private readonly deviceByHash = new Map<string, DeviceCode>();
  private readonly apps = new Map<string, StoredApp>();
  private readonly deploys = new Map<string, StoredDeploy>(); // `${appId}/${id}`
  private readonly users = new Map<string, User>(); // id -> user
  private readonly oauth = new Map<string, OAuthAccount>(); // `${provider}/${providerAccountId}`
  private readonly sessions = new Map<string, Session>(); // tokenHash -> session
  private readonly loginRate = new Map<string, { count: number; expiresAt: number }>();
  private readonly previewGrants = new Map<string, PreviewGrant>(); // tokenHash -> grant
  private readonly grants = new Map<string, Grant>(); // `${appId}/${principal}`
  private readonly policies = new Map<string, AppPolicy>(); // appId -> policy (manifest-declared access)
  private readonly secrets = new Map<string, AppSecret>(); // `${appId}/${name}`
  private readonly accessOverrides = new Map<string, string>(); // appId -> dashboard override
  private readonly events: Event[] = [];

  async close(): Promise<void> {}

  async recentEvents(limit = 200): Promise<Event[]> {
    return [...this.events].reverse().slice(0, limit).map((e) => ({ ...e }));
  }

  private record(e: { userId?: string; appId?: string; kind: string; detail?: string }): void {
    this.events.push({
      id: ++this.seq,
      userId: e.userId ?? '',
      appId: e.appId ?? '',
      deployId: '',
      kind: e.kind,
      detail: e.detail ?? '',
      createdAt: 0,
    });
  }

  private userIdFor(appId: string): string {
    return this.apps.get(appId)?.userId ?? '';
  }

  async userByToken(tokenHash: string, minCreatedAt: number): Promise<User | null> {
    const rec = this.tokens.get(tokenHash);
    if (rec === undefined || rec.createdAt <= minCreatedAt) return null;
    const u = this.users.get(rec.userId);
    return u ? { ...u } : null;
  }

  async addToken(userId: string, tokenHash: string): Promise<void> {
    if (!this.tokens.has(tokenHash)) this.tokens.set(tokenHash, { userId, createdAt: this.tokenClock() });
  }

  async userById(id: string): Promise<User | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async userByEmail(email: string): Promise<User | null> {
    for (const u of this.users.values()) {
      if (u.email === email) return { ...u };
    }
    return null;
  }

  async createUser(u: User): Promise<void> {
    for (const e of this.users.values()) {
      if (e.email === u.email) throw new Error('duplicate email');
    }
    if (this.users.has(u.id)) throw new Error('duplicate user id');
    this.users.set(u.id, { ...u });
  }

  async oauthAccount(provider: string, providerAccountId: string): Promise<OAuthAccount | null> {
    const a = this.oauth.get(`${provider}/${providerAccountId}`);
    return a ? { ...a } : null;
  }

  async linkOAuthAccount(a: OAuthAccount): Promise<void> {
    const k = `${a.provider}/${a.providerAccountId}`;
    if (!this.oauth.has(k)) this.oauth.set(k, { ...a });
  }

  async createSession(s: Session): Promise<void> {
    this.sessions.set(s.tokenHash, { ...s });
  }

  async sessionByHash(tokenHash: string): Promise<Session | null> {
    const s = this.sessions.get(tokenHash);
    return s ? { ...s } : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async touchLoginRate(key: string, now: number, windowSecs: number, limit: number): Promise<boolean> {
    const cur = this.loginRate.get(key);
    if (!cur || cur.expiresAt <= now) {
      this.loginRate.set(key, { count: 1, expiresAt: now + windowSecs });
      return 1 <= limit;
    }
    cur.count += 1;
    return cur.count <= limit;
  }

  async deleteExpired(now: number, machineTokenTtlSecs: number): Promise<ExpiryCounts> {
    let sessions = 0;
    for (const [k, s] of [...this.sessions.entries()]) {
      if (s.expiresAt <= now) {
        this.sessions.delete(k);
        sessions++;
      }
    }
    let deviceCodes = 0;
    for (const [k, d] of [...this.deviceByHash.entries()]) {
      if (d.expiresAt <= now) {
        this.deviceByHash.delete(k);
        deviceCodes++;
      }
    }
    let rateLimits = 0;
    for (const [k, r] of [...this.loginRate.entries()]) {
      if (r.expiresAt <= now) {
        this.loginRate.delete(k);
        rateLimits++;
      }
    }
    let tokens = 0;
    const tokenCutoff = now - machineTokenTtlSecs;
    for (const [k, rec] of [...this.tokens.entries()]) {
      if (rec.createdAt <= tokenCutoff) {
        this.tokens.delete(k);
        tokens++;
      }
    }
    let previewGrants = 0;
    for (const [k, g] of [...this.previewGrants.entries()]) {
      if (g.expiresAt <= now) {
        this.previewGrants.delete(k);
        previewGrants++;
      }
    }
    return { sessions, deviceCodes, rateLimits, tokens, previewGrants };
  }

  async createDeviceCode(d: DeviceCode): Promise<void> {
    // user_code is UNIQUE; a collision is a bug worth surfacing
    for (const e of this.deviceByHash.values()) {
      if (e.userCode === d.userCode) throw new Error('duplicate user code');
    }
    this.deviceByHash.set(d.deviceHash, { ...d });
  }

  async deviceCodeByHash(hash: string): Promise<DeviceCode | null> {
    const d = this.deviceByHash.get(hash);
    return d ? { ...d } : null;
  }

  async approveDeviceCode(userCode: string, userId: string, now: number): Promise<boolean> {
    for (const d of this.deviceByHash.values()) {
      if (d.userCode === userCode && d.status === DeviceStatus.Pending && d.expiresAt > now) {
        d.status = DeviceStatus.Approved;
        d.userId = userId;
        return true;
      }
    }
    return false;
  }

  async claimDeviceCode(deviceHash: string): Promise<boolean> {
    const d = this.deviceByHash.get(deviceHash);
    if (d && d.status === DeviceStatus.Approved) {
      d.status = DeviceStatus.Claimed;
      return true;
    }
    return false;
  }

  async createPreviewGrant(g: PreviewGrant): Promise<void> {
    this.previewGrants.set(g.tokenHash, { ...g, viewAs: { ...g.viewAs } });
  }

  async previewGrantByHash(tokenHash: string): Promise<PreviewGrant | null> {
    const g = this.previewGrants.get(tokenHash);
    return g ? { ...g, viewAs: { ...g.viewAs } } : null;
  }

  async revokePreviewGrant(tokenHash: string): Promise<boolean> {
    const g = this.previewGrants.get(tokenHash);
    if (!g || g.revoked) return false;
    g.revoked = true;
    return true;
  }

  async app(userId: string, appId: string): Promise<App | null> {
    const a = this.apps.get(appId);
    return a && a.userId === userId ? cloneApp(a) : null;
  }

  async appsByFingerprint(userId: string, fingerprint: string): Promise<App[]> {
    return [...this.apps.values()]
      .filter((a) => a.userId === userId && a.fingerprint === fingerprint)
      .sort((x, y) => x.createdAt - y.createdAt || cmp(x.id, y.id))
      .map(cloneApp);
  }

  async appsByUser(userId: string): Promise<App[]> {
    return [...this.apps.values()]
      .filter((a) => a.userId === userId)
      .sort((x, y) => y.createdAt - x.createdAt || cmp(x.id, y.id))
      .map(cloneApp);
  }

  async appByClientRef(userId: string, ref: string): Promise<App | null> {
    for (const a of this.apps.values()) {
      if (a.userId === userId && a.clientRef !== '' && a.clientRef === ref) return cloneApp(a);
    }
    return null;
  }

  async createApp(a: App): Promise<void> {
    // script is globally UNIQUE
    for (const e of this.apps.values()) {
      if (e.script === a.script) throw new Error('duplicate script');
      // (user, clientRef) is UNIQUE where clientRef <> ''
      if (a.clientRef !== '' && e.userId === a.userId && e.clientRef === a.clientRef) {
        throw new Error('duplicate client ref');
      }
    }
    this.apps.set(a.id, { ...a, createdAt: this.seq++ });
  }

  async deleteApp(userId: string, appId: string): Promise<boolean> {
    const a = this.apps.get(appId);
    if (!a || a.userId !== userId) return false;
    this.apps.delete(appId);
    for (const key of [...this.deploys.keys()]) {
      if (this.deploys.get(key)!.appId === appId) this.deploys.delete(key);
    }
    // Grants are dropped with the app, so a re-created app id inherits no access.
    for (const [key, g] of [...this.grants.entries()]) {
      if (g.appId === appId) this.grants.delete(key);
    }
    for (const [key, secret] of [...this.secrets.entries()]) {
      if (secret.appId === appId) this.secrets.delete(key);
    }
    return true;
  }

  async setStoreId(appId: string, storeId: string): Promise<void> {
    const a = this.apps.get(appId);
    if (a) a.storeId = storeId;
  }

  async appByScript(script: string): Promise<App | null> {
    for (const a of this.apps.values()) {
      if (a.script === script) return cloneApp(a);
    }
    return null;
  }

  async deploy(appId: string, deployId: string): Promise<Deploy | null> {
    const d = this.deploys.get(key(appId, deployId));
    return d ? cloneDeploy(d) : null;
  }

  async latestDeploy(appId: string): Promise<Deploy | null> {
    const mine = [...this.deploys.values()]
      .filter((d) => d.appId === appId)
      .sort((a, b) => b.createdAt - a.createdAt || cmp(b.id, a.id));
    return mine.length ? cloneDeploy(mine[0]) : null;
  }

  async openDeploys(appId: string): Promise<Deploy[]> {
    return [...this.deploys.values()]
      .filter((d) => d.appId === appId && !stateTerminal(d.state))
      .map(cloneDeploy);
  }

  async openDeploy(d: Deploy): Promise<Deploy> {
    const k = key(d.appId, d.id);
    const ex = this.deploys.get(k);
    if (!ex) {
      this.deploys.set(k, {
        appId: d.appId,
        id: d.id,
        manifest: d.manifest,
        state: State.Uploading,
        failure: null,
        createdAt: this.seq++,
      });
    } else if (ex.state === State.Failed) {
      // reopen a failed attempt; manifest is unchanged (same id ⇒ same content)
      ex.state = State.Uploading;
      ex.failure = null;
    }
    return cloneDeploy(this.deploys.get(k)!);
  }

  async claimActivation(appId: string, deployId: string): Promise<boolean> {
    const d = this.deploys.get(key(appId, deployId));
    if (d && d.state === State.Uploading) {
      d.state = State.Activating;
      return true;
    }
    return false;
  }

  async finishLive(appId: string, deployId: string): Promise<void> {
    const d = this.deploys.get(key(appId, deployId));
    if (!d) return;
    d.state = State.Live;
    d.failure = null;
    // delete the row this deploy replaces: a live row IS the app's active deploy,
    // so a stale one would make a re-push of once-live content skip activation
    for (const [k, other] of [...this.deploys.entries()]) {
      if (other.appId === appId && other.id !== deployId && other.state === State.Live) {
        this.deploys.delete(k);
      }
    }
    const a = this.apps.get(appId);
    if (a) a.activeDeploy = deployId;
    this.registerPolicy(appId, d);
  }

  // Mirrors PgStore.registerPolicy: persist the live manifest's policy, seed the
  // owner's grant, and record the audit event. Owner is the app's user, like the
  // real store.
  private registerPolicy(appId: string, d: StoredDeploy): void {
    let policy;
    try {
      policy = appPolicyFromManifest(d.manifest);
    } catch {
      return;
    }
    const ownerEmail = this.users.get(this.userIdFor(appId))?.email ?? '';
    const ownerTenant = ownerEmail !== '' ? tenantFromEmail(ownerEmail) : '';
    const existing = this.policies.get(appId);
    this.policies.set(appId, {
      appId,
      access: policy.access,
      accessSource: 'manifest',
      roles: policy.roles,
      routes: policy.routes,
      secrets: policy.secrets,
      ownerTenant: ownerTenant !== '' ? ownerTenant : (existing?.ownerTenant ?? ''),
      updatedAt: 0,
    });
    for (const [k, secret] of [...this.secrets.entries()]) {
      if (secret.appId === appId && !policy.secrets.includes(secret.name)) {
        this.secrets.delete(k);
        this.record({
          userId: this.userIdFor(appId),
          appId,
          kind: EventKind.SecretRemoved,
          detail: JSON.stringify({ name: secret.name }),
        });
      }
    }
    if (ownerEmail !== '' && !this.grants.has(grantKey(appId, ownerEmail))) {
      this.grants.set(grantKey(appId, ownerEmail), {
        appId,
        principal: ownerEmail,
        appRole: 'owner',
        featureRole: '',
        dataScope: null,
        grantedBy: 'platform',
        grantedAt: 0,
      });
    }
    this.record({
      userId: this.userIdFor(appId),
      appId,
      kind: EventKind.PolicyRegistered,
      detail: JSON.stringify({ access: policy.access, roles: String(policy.roles.length), routes: String(policy.routes.length) }),
    });
  }

  // Mirrors rowToAppPolicy: the dashboard override wins, unknown modes coerce
  // to invited (fail closed).
  async appPolicy(appId: string): Promise<AppPolicy | null> {
    const p = this.policies.get(appId);
    if (!p) return null;
    const override = this.accessOverrides.get(appId) ?? '';
    const effective = override !== '' ? override : p.access;
    return {
      ...p,
      access: isAppAccess(effective) ? effective : APP_ACCESS.Invited,
      accessSource: override !== '' ? 'dashboard' : 'manifest',
      roles: [...p.roles],
      routes: [...p.routes],
      secrets: [...p.secrets],
    };
  }

  async setAppAccess(appId: string, access: AppAccess, setBy: string): Promise<boolean> {
    const current = await this.appPolicy(appId);
    if (current === null) return false;
    this.accessOverrides.set(appId, access);
    this.record({
      userId: this.userIdFor(appId),
      appId,
      kind: EventKind.PolicyAccessChanged,
      detail: JSON.stringify({ from: current.access, to: access, by: setBy }),
    });
    return true;
  }

  async putAppSecret(secret: AppSecret): Promise<void> {
    this.secrets.set(secretKey(secret.appId, secret.name), { ...secret });
    this.record({
      userId: this.userIdFor(secret.appId),
      appId: secret.appId,
      kind: EventKind.SecretSet,
      detail: JSON.stringify({ name: secret.name, by: secret.setBy }),
    });
  }

  async deleteAppSecret(appId: string, name: string, deletedBy: string): Promise<boolean> {
    if (!this.secrets.delete(secretKey(appId, name))) return false;
    this.record({
      userId: this.userIdFor(appId),
      appId,
      kind: EventKind.SecretRemoved,
      detail: JSON.stringify({ name, by: deletedBy }),
    });
    return true;
  }

  async appSecrets(appId: string): Promise<AppSecret[]> {
    return [...this.secrets.values()]
      .filter((secret) => secret.appId === appId)
      .sort((a, b) => cmp(a.name, b.name))
      .map((secret) => ({ ...secret }));
  }

  async recordAppAccess(e: { appId: string; principal: string; allowed: boolean; detail?: string; kind?: string }): Promise<void> {
    this.record({
      userId: this.userIdFor(e.appId),
      appId: e.appId,
      kind: e.kind ?? (e.allowed ? EventKind.AppAccessed : EventKind.AppAccessDenied),
      detail: e.detail ?? JSON.stringify({ principal: e.principal }),
    });
  }

  async finishFailed(appId: string, deployId: string, failure: DeployError | null): Promise<void> {
    const d = this.deploys.get(key(appId, deployId));
    if (!d) return;
    d.state = State.Failed;
    d.failure = failure;
  }

  async putGrant(g: Grant): Promise<void> {
    // Upsert on (appId, principal): re-granting replaces the role in place.
    this.grants.set(grantKey(g.appId, g.principal), cloneGrant(g));
    this.record({
      userId: this.userIdFor(g.appId),
      appId: g.appId,
      kind: EventKind.GrantAdded,
      detail: JSON.stringify({ principal: g.principal, appRole: g.appRole, featureRole: g.featureRole, by: g.grantedBy }),
    });
  }

  async grant(appId: string, principal: string): Promise<Grant | null> {
    const g = this.grants.get(grantKey(appId, principal));
    return g ? cloneGrant(g) : null;
  }

  async grantsByApp(appId: string): Promise<Grant[]> {
    return [...this.grants.values()]
      .filter((g) => g.appId === appId)
      .sort((x, y) => x.grantedAt - y.grantedAt || cmp(x.principal, y.principal))
      .map(cloneGrant);
  }

  async revokeGrant(appId: string, principal: string, revokedBy = ''): Promise<boolean> {
    // Reports whether a row was there, so revoking twice is not a failure.
    const removed = this.grants.delete(grantKey(appId, principal));
    if (removed) {
      this.record({
        userId: this.userIdFor(appId),
        appId,
        kind: EventKind.GrantRevoked,
        detail: JSON.stringify({ principal, by: revokedBy }),
      });
    }
    return removed;
  }
}

interface StoredApp extends App {
  createdAt: number;
}

interface StoredDeploy extends Deploy {
  createdAt: number;
}

function key(appId: string, deployId: string): string {
  return `${appId}/${deployId}`;
}

function grantKey(appId: string, principal: string): string {
  return `${appId}/${principal}`;
}

function secretKey(appId: string, name: string): string {
  return `${appId}/${name}`;
}

function cloneGrant(g: Grant): Grant {
  // dataScope is a nested object, so deep-copy it: a stored grant must not share
  // mutable state with the caller's copy, mirroring the Postgres round-trip.
  return { ...g, dataScope: g.dataScope === null ? null : { ...g.dataScope } };
}

function cloneApp(a: StoredApp): App {
  const { createdAt: _c, ...rest } = a;
  void _c;
  return { ...rest };
}

function cloneDeploy(d: StoredDeploy): Deploy {
  return { appId: d.appId, id: d.id, manifest: d.manifest, state: d.state, failure: d.failure };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
