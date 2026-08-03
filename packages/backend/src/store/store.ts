// The control-plane database: users, apps, deploys, events. Blob bytes live in
// blobstore, so no index here drifts from them. Go (store.go) is normative. Deploys
// are a state machine surviving process death with no sole-writer assumption: every
// racy transition is a conditional UPDATE whose row count names the winner, every
// uniqueness rule an index.

import type { AppAccess, AppPolicy, Manifest, DeployError, PreviewGrant, RouteGate } from '@280/contracts';
import {
  APP_ACCESS,
  appPolicyFromManifest,
  isAppAccess,
  manifestSchema,
  errorSchema,
  tenantFromEmail,
  viewAsTargetSchema,
  State,
} from '@280/contracts';
import pg from 'pg';
import type { QueryResult } from 'pg';
import {
  DeviceStatus,
  EventKind,
  type App,
  type Deploy,
  type DeviceCode,
  type Event,
  type ExpiryCounts,
  type Grant,
  type OAuthAccount,
  type Session,
  type Store,
  type User,
} from '../seams.js';
import { migrations, qualify, type Qualifier } from './migrations.js';

const { Pool, Client } = pg;

interface Queryable {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

// How PgStore reaches Postgres: a Pool (boot and tests) or a lazily-connected
// Client (the gateway's per-request path). The store body is identical either way.
interface Backend {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// runTx wraps fn in BEGIN/COMMIT on the given connection, rolling back (swallowing
// a doomed rollback) on failure. It never owns the connection lifecycle: the caller
// acquires and releases its own Queryable.
async function runTx<T>(q: Queryable, fn: (q: Queryable) => Promise<T>): Promise<T> {
  await q.query('BEGIN');
  try {
    const out = await fn(q);
    await q.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await q.query('ROLLBACK');
    } catch {
      // no-op once committed; the original error is what matters
    }
    throw err;
  }
}

class PoolBackend implements Backend {
  constructor(private readonly pool: pg.Pool) {}

  query(text: string, params?: unknown[]): Promise<QueryResult> {
    return this.pool.query(text, params as unknown[] | undefined);
  }

  async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await runTx(client, fn);
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

// One lazily-connected client for the gateway's per-request path: connects on the
// first statement (a request that touches no table opens no connection), ended once
// by close().
class ClientBackend implements Backend {
  private client: pg.Client | null = null;
  private connecting: Promise<pg.Client> | null = null;

  constructor(private readonly connectionString: string) {}

  private conn(): Promise<pg.Client> {
    if (this.client !== null) return Promise.resolve(this.client);
    if (this.connecting === null) {
      const client = new Client({ connectionString: this.connectionString });
      this.connecting = client.connect().then(() => {
        this.client = client;
        return client;
      });
    }
    return this.connecting;
  }

  async query(text: string, params?: unknown[]): Promise<QueryResult> {
    const c = await this.conn();
    return c.query(text, params as unknown[] | undefined);
  }

  async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const c = await this.conn();
    return runTx(c, fn);
  }

  async close(): Promise<void> {
    // Ending a client that never connected throws, so only close one we opened.
    const opened = this.client;
    if (opened !== null) {
      this.client = null;
      this.connecting = null;
      await opened.end();
      return;
    }
    const pending = this.connecting;
    if (pending !== null) {
      this.connecting = null;
      try {
        const c = await pending;
        await c.end();
      } catch {
        // connect never completed; nothing to end
      }
    }
  }
}

// A container host's private network can take a moment to resolve at startup;
// waiting beats restart-looping over a DNS lookup that would soon succeed.
const connectTimeoutMs = 30_000;

// Caps one read: an unbounded query against an append-only table exhausts memory.
const maxEventPage = 200;

// Connects to and migrates Postgres at dsn. A non-empty schema confines every table
// to it (shared database, separate namespace) and is created if missing. Boot
// migrates with idempotent statements, so it need not wait on the CI runner.
export async function open(dsn: string, schema: string): Promise<Store> {
  if (dsn === '') {
    throw new Error('store: empty DATABASE_URL');
  }
  // Validates the schema identifier and throws on a bad one, before opening the pool.
  const stmts = migrations(schema);

  // A bounded pool keeps a restart loop from exhausting the server's connection slots.
  const pool = new Pool({
    connectionString: dsn,
    max: 10,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 3600,
  });

  // Fail at boot rather than on the first push, when it would surface under load.
  try {
    await waitForDB(pool);
    for (const stmt of stmts) {
      await pool.query(stmt);
    }
  } catch (err) {
    await pool.end();
    throw err;
  }
  return new PgStore(new PoolBackend(pool), schema);
}

// A store over one lazily-connected client, for the gateway's request scope. It
// does NOT migrate: DDL runs only through the CI runner (migrate.ts), never at
// runtime; it holds no pool, so no I/O object crosses requests.
export function newPgStore(connectionString: string, schema: string): Store {
  return new PgStore(new ClientBackend(connectionString), schema);
}

async function waitForDB(pool: pg.Pool): Promise<void> {
  const deadline = Date.now() + connectTimeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
    await sleep(1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// bigint columns arrive as strings from `pg`; these hold second-resolution
// timestamps and serial ids that fit in a JS number, so Number() is safe here.
function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

const appCols =
  'id, user_id, slug, framework, url, script, salt, fingerprint, client_ref, store_id, active_deploy';

const grantCols =
  'app_id, principal, app_role, feature_role, data_scope, granted_by, granted_at';

const policyCols = 'app_id, access, access_override, roles, routes, secrets, owner_tenant, updated_at';

// The columns a live deploy (re)registers. access_override is deliberately
// absent: the dashboard's dial survives every redeploy untouched (design D5).
const registerPolicyCols = 'app_id, access, roles, routes, secrets, owner_tenant, updated_at';

// Seconds since the epoch, for columns the store writes rather than defaults (it
// holds no clock of its own). Mirrors migrations' epochDefault.
const epochNow = `EXTRACT(EPOCH FROM now())::bigint`;

// A JSON column that decodes to [] on anything unexpected: a policy row can never
// throw a request that only wants to read its access mode or route gates.
function decodeStringArray(raw: string): string[] {
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function decodeRoutes(raw: string): RouteGate[] {
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      .map((r) => ({
        path: typeof r.path === 'string' ? r.path : '',
        appRole: typeof r.appRole === 'string' ? r.appRole : '',
        role: typeof r.role === 'string' ? r.role : '',
      }))
      .filter((r) => r.path !== '');
  } catch {
    return [];
  }
}

function encodeFailure(e: DeployError | null): string {
  return e === null ? '' : JSON.stringify(e);
}

// data_scope is advisory JSON stored as text: anything that is not an object
// decodes to null rather than throwing, so a bad scope cannot break a row read.
function encodeScope(s: Record<string, unknown> | null): string {
  return s === null ? '' : JSON.stringify(s);
}

function decodeScope(raw: string): Record<string, unknown> | null {
  if (raw === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodeFailure(raw: string): DeployError | null {
  if (raw === '') {
    return null;
  }
  try {
    const parsed = errorSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as DeployError) : null;
  } catch {
    return null;
  }
}

// pg hands columns back untyped; the rowTo* helpers are the one boundary where
// they are read by name into typed shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function rowToApp(r: Row): App {
  return {
    id: r.id,
    userId: r.user_id,
    slug: r.slug,
    framework: r.framework,
    url: r.url,
    script: r.script,
    salt: r.salt,
    fingerprint: r.fingerprint,
    clientRef: r.client_ref,
    storeId: r.store_id,
    activeDeploy: r.active_deploy,
  };
}

function rowToUser(r: Row): User {
  return { id: r.id, email: r.email, name: r.name, image: r.image };
}

function rowToOAuthAccount(r: Row): OAuthAccount {
  return { provider: r.provider, providerAccountId: r.provider_account_id, userId: r.user_id };
}

function rowToSession(r: Row): Session {
  return { tokenHash: r.token_hash, userId: r.user_id, expiresAt: toNum(r.expires_at) };
}

// A grant whose stored view_as no longer parses is treated as unknown (null):
// failing closed beats minting a preview with a guessed target.
function rowToPreviewGrant(r: Row): PreviewGrant | null {
  const viewAs = viewAsTargetSchema.safeParse(r.view_as);
  if (!viewAs.success) return null;
  return {
    tokenHash: r.token_hash,
    appId: r.app_id,
    ownerUserId: r.owner_user_id,
    viewAs: viewAs.data,
    expiresAt: toNum(r.expires_at),
    revoked: r.revoked === true,
  };
}

function rowToDeviceCode(r: Row): DeviceCode {
  return {
    deviceHash: r.device_hash,
    userCode: r.user_code,
    userId: r.user_id,
    status: r.status,
    expiresAt: toNum(r.expires_at),
  };
}

function rowToEvent(r: Row): Event {
  return {
    id: toNum(r.id),
    userId: r.user_id,
    appId: r.app_id,
    deployId: r.deploy_id,
    kind: r.kind,
    detail: r.detail,
    createdAt: toNum(r.created_at),
  };
}

function rowToDeploy(r: Row): Deploy {
  const manifest = manifestSchema.parse(JSON.parse(r.manifest)) as Manifest;
  return {
    appId: r.app_id,
    id: r.id,
    manifest,
    state: r.state,
    failure: decodeFailure(r.failure),
  };
}

function rowToGrant(r: Row): Grant {
  return {
    appId: r.app_id,
    principal: r.principal,
    appRole: r.app_role,
    featureRole: r.feature_role,
    dataScope: decodeScope(r.data_scope),
    grantedBy: r.granted_by,
    grantedAt: toNum(r.granted_at),
  };
}

// The dashboard override wins over the manifest's access; either value coerces
// unknown modes to invited, so a stale or future wire value fails closed.
function rowToAppPolicy(r: Row): AppPolicy {
  const overridden = r.access_override !== '';
  const effective = overridden ? r.access_override : r.access;
  return {
    appId: r.app_id,
    access: isAppAccess(effective) ? effective : APP_ACCESS.Invited,
    accessSource: overridden ? 'dashboard' : 'manifest',
    roles: decodeStringArray(r.roles),
    routes: decodeRoutes(r.routes),
    secrets: decodeStringArray(r.secrets),
    ownerTenant: r.owner_tenant,
    updatedAt: toNum(r.updated_at),
  };
}

function eventDetail(kv: Record<string, string>): string {
  if (Object.keys(kv).length === 0) {
    return '';
  }
  try {
    return JSON.stringify(kv);
  } catch {
    return '';
  }
}

class PgStore implements Store {
  // Addresses a table by its configured schema; routing every statement's table
  // names through it is what lets the store survive transaction-mode pooling.
  private readonly t: Qualifier;

  constructor(
    private readonly db: Backend,
    schema: string,
  ) {
    this.t = qualify(schema);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // Every event is written by the same transaction as the change it describes, so
  // a live deploy without its event, or an event for a rolled-back transition,
  // are states the database will not produce.
  private inTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  async recentEvents(limit: number): Promise<Event[]> {
    if (limit <= 0 || limit > maxEventPage) {
      limit = maxEventPage;
    }
    const res = await this.db.query(
      `SELECT id, user_id, app_id, deploy_id, kind, detail, created_at
       FROM ${this.t('events')} ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map(rowToEvent);
  }

  async userByToken(tokenHash: string, minCreatedAt: number): Promise<User | null> {
    const res = await this.db.query(
      `SELECT u.id, u.email, u.name, u.image FROM ${this.t('users')} u
       JOIN ${this.t('tokens')} t ON t.user_id = u.id
       WHERE t.token_hash = $1 AND t.created_at > $2`,
      [tokenHash, minCreatedAt],
    );
    return res.rows.length ? rowToUser(res.rows[0]) : null;
  }

  async addToken(userId: string, tokenHash: string): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('tokens')} (token_hash, user_id) VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash, userId],
    );
  }

  async userById(id: string): Promise<User | null> {
    const res = await this.db.query(
      `SELECT id, email, name, image FROM ${this.t('users')} WHERE id = $1`,
      [id],
    );
    return res.rows.length ? rowToUser(res.rows[0]) : null;
  }

  async userByEmail(email: string): Promise<User | null> {
    const res = await this.db.query(
      `SELECT id, email, name, image FROM ${this.t('users')} WHERE email = $1`,
      [email],
    );
    return res.rows.length ? rowToUser(res.rows[0]) : null;
  }

  async createUser(u: User): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('users')} (id, email, name, image) VALUES ($1, $2, $3, $4)`,
      [u.id, u.email, u.name, u.image],
    );
  }

  async oauthAccount(provider: string, providerAccountId: string): Promise<OAuthAccount | null> {
    const res = await this.db.query(
      `SELECT provider, provider_account_id, user_id FROM ${this.t('oauth_accounts')}
       WHERE provider = $1 AND provider_account_id = $2`,
      [provider, providerAccountId],
    );
    return res.rows.length ? rowToOAuthAccount(res.rows[0]) : null;
  }

  async linkOAuthAccount(a: OAuthAccount): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('oauth_accounts')} (provider, provider_account_id, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (provider, provider_account_id) DO NOTHING`,
      [a.provider, a.providerAccountId, a.userId],
    );
  }

  async createSession(s: Session): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('sessions')} (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
      [s.tokenHash, s.userId, s.expiresAt],
    );
  }

  async sessionByHash(tokenHash: string): Promise<Session | null> {
    const res = await this.db.query(
      `SELECT token_hash, user_id, expires_at FROM ${this.t('sessions')} WHERE token_hash = $1`,
      [tokenHash],
    );
    return res.rows.length ? rowToSession(res.rows[0]) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query(`DELETE FROM ${this.t('sessions')} WHERE token_hash = $1`, [tokenHash]);
  }

  // A single upsert that resets the window when it has passed and increments it
  // otherwise: one statement, so two replicas cannot both read a stale count.
  async touchLoginRate(key: string, now: number, windowSecs: number, limit: number): Promise<boolean> {
    // Cast the arithmetic params explicitly: an untyped $n inside `+` defaults to
    // text, and text + text is not an operator Postgres has.
    const res = await this.db.query(
      `INSERT INTO ${this.t('login_rate_limits')} AS lrl (key, count, expires_at)
       VALUES ($1, 1, $2::bigint + $3::bigint)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN lrl.expires_at <= $2::bigint THEN 1
                      ELSE lrl.count + 1 END,
         expires_at = CASE WHEN lrl.expires_at <= $2::bigint THEN $2::bigint + $3::bigint
                           ELSE lrl.expires_at END
       RETURNING count`,
      [key, now, windowSecs],
    );
    return toNum(res.rows[0].count) <= limit;
  }

  // Sweeps the time-boxed tables in one transaction; everything else in the schema
  // (users, apps, deploys, events) is retained by design. Machine tokens carry no
  // expires_at: validity is created_at within the ttl, so the cutoff is derived here.
  async deleteExpired(now: number, machineTokenTtlSecs: number): Promise<ExpiryCounts> {
    const tokenCutoff = now - machineTokenTtlSecs;
    return this.inTx(async (tx) => {
      const sessions = await tx.query(
        `DELETE FROM ${this.t('sessions')} WHERE expires_at <= $1`,
        [now],
      );
      const deviceCodes = await tx.query(
        `DELETE FROM ${this.t('device_codes')} WHERE expires_at <= $1`,
        [now],
      );
      const rateLimits = await tx.query(
        `DELETE FROM ${this.t('login_rate_limits')} WHERE expires_at <= $1`,
        [now],
      );
      const tokens = await tx.query(
        `DELETE FROM ${this.t('tokens')} WHERE created_at <= $1`,
        [tokenCutoff],
      );
      const previewGrants = await tx.query(
        `DELETE FROM ${this.t('preview_grants')} WHERE expires_at <= $1`,
        [now],
      );
      return {
        sessions: sessions.rowCount ?? 0,
        deviceCodes: deviceCodes.rowCount ?? 0,
        rateLimits: rateLimits.rowCount ?? 0,
        tokens: tokens.rowCount ?? 0,
        previewGrants: previewGrants.rowCount ?? 0,
      };
    });
  }

  async createDeviceCode(d: DeviceCode): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('device_codes')} (device_hash, user_code, status, expires_at) VALUES ($1,$2,$3,$4)`,
      [d.deviceHash, d.userCode, d.status, d.expiresAt],
    );
  }

  async deviceCodeByHash(hash: string): Promise<DeviceCode | null> {
    const res = await this.db.query(
      `SELECT device_hash, user_code, user_id, status, expires_at FROM ${this.t('device_codes')} WHERE device_hash = $1`,
      [hash],
    );
    return res.rows.length ? rowToDeviceCode(res.rows[0]) : null;
  }

  // Reports false if the code is unknown, expired, or already past pending, so a
  // replayed approval cannot re-open a claimed login.
  async approveDeviceCode(userCode: string, userId: string, now: number): Promise<boolean> {
    return this.inTx(async (tx) => {
      const res = await tx.query(
        `UPDATE ${this.t('device_codes')} SET status = $1, user_id = $2
         WHERE user_code = $3 AND status = $4 AND expires_at > $5`,
        [DeviceStatus.Approved, userId, userCode, DeviceStatus.Pending, now],
      );
      if (res.rowCount !== 1) {
        return false;
      }
      await this.insertEvent(tx, { userId, kind: EventKind.LoginApproved });
      return true;
    });
  }

  // Exactly one poll may mint a token for a given code.
  async claimDeviceCode(deviceHash: string): Promise<boolean> {
    return this.inTx(async (tx) => {
      // RETURNING rather than a row count: the winner needs the user the code
      // was approved for, which the caller does not have.
      const res = await tx.query(
        `UPDATE ${this.t('device_codes')} SET status = $1 WHERE device_hash = $2 AND status = $3
         RETURNING user_id`,
        [DeviceStatus.Claimed, deviceHash, DeviceStatus.Approved],
      );
      if (res.rowCount !== 1) {
        return false;
      }
      await this.insertEvent(tx, {
        userId: res.rows[0].user_id,
        kind: EventKind.LoginClaimed,
      });
      return true;
    });
  }

  async createPreviewGrant(g: PreviewGrant): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('preview_grants')} (token_hash, app_id, owner_user_id, view_as, expires_at, revoked)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [g.tokenHash, g.appId, g.ownerUserId, JSON.stringify(g.viewAs), g.expiresAt, g.revoked],
    );
  }

  async previewGrantByHash(tokenHash: string): Promise<PreviewGrant | null> {
    const res = await this.db.query(
      `SELECT token_hash, app_id, owner_user_id, view_as, expires_at, revoked
       FROM ${this.t('preview_grants')} WHERE token_hash = $1`,
      [tokenHash],
    );
    return res.rows.length ? rowToPreviewGrant(res.rows[0]) : null;
  }

  // Reports whether a live grant was there to revoke; revoking twice is not a failure.
  async revokePreviewGrant(tokenHash: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE ${this.t('preview_grants')} SET revoked = TRUE WHERE token_hash = $1 AND NOT revoked`,
      [tokenHash],
    );
    return res.rowCount === 1;
  }

  async app(userId: string, appId: string): Promise<App | null> {
    const res = await this.db.query(
      `SELECT ${appCols} FROM ${this.t('apps')} WHERE user_id = $1 AND id = $2`,
      [userId, appId],
    );
    return res.rows.length ? rowToApp(res.rows[0]) : null;
  }

  // More than one match is the ambiguous_identity case.
  async appsByFingerprint(userId: string, fingerprint: string): Promise<App[]> {
    const res = await this.db.query(
      `SELECT ${appCols} FROM ${this.t('apps')} WHERE user_id = $1 AND fingerprint = $2 ORDER BY created_at, id`,
      [userId, fingerprint],
    );
    return res.rows.map(rowToApp);
  }

  async appsByUser(userId: string): Promise<App[]> {
    const res = await this.db.query(
      `SELECT ${appCols} FROM ${this.t('apps')} WHERE user_id = $1 ORDER BY created_at DESC, id`,
      [userId],
    );
    return res.rows.map(rowToApp);
  }

  async appByClientRef(userId: string, ref: string): Promise<App | null> {
    const res = await this.db.query(
      `SELECT ${appCols} FROM ${this.t('apps')} WHERE user_id = $1 AND client_ref = $2`,
      [userId, ref],
    );
    return res.rows.length ? rowToApp(res.rows[0]) : null;
  }

  async createApp(a: App): Promise<void> {
    await this.inTx(async (tx) => {
      // No ON CONFLICT: the create-dedup guard is the unique index on (user,
      // clientRef), and losing that race must stay an error the caller resolves.
      await tx.query(
        `INSERT INTO ${this.t('apps')} (${appCols}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          a.id,
          a.userId,
          a.slug,
          a.framework,
          a.url,
          a.script,
          a.salt,
          a.fingerprint,
          a.clientRef,
          a.storeId,
          a.activeDeploy,
        ],
      );
      await this.insertEvent(tx, {
        userId: a.userId,
        appId: a.id,
        kind: EventKind.AppCreated,
        detail: eventDetail({ slug: a.slug, framework: a.framework }),
      });
    });
  }

  // Scoped by user like every other app read, so one tenant cannot delete
  // another's app by guessing an id. The events the app produced stay behind.
  async deleteApp(userId: string, appId: string): Promise<boolean> {
    return this.inTx(async (tx) => {
      const del = await tx.query(
        `DELETE FROM ${this.t('apps')} WHERE user_id = $1 AND id = $2 RETURNING slug`,
        [userId, appId],
      );
      if (del.rowCount !== 1) {
        return false; // already gone; deleting twice is not a failure
      }
      await tx.query(`DELETE FROM ${this.t('deploys')} WHERE app_id = $1`, [appId]);
      // Drop the app's grants and policy so a re-created app id (ids can recur) never
      // inherits another life's access or route gates.
      await tx.query(`DELETE FROM ${this.t('grants')} WHERE app_id = $1`, [appId]);
      await tx.query(`DELETE FROM ${this.t('app_policies')} WHERE app_id = $1`, [appId]);
      // insertEvent, not insertAppEvent: the app row it would read the user
      // from no longer exists.
      await this.insertEvent(tx, {
        userId,
        appId,
        kind: EventKind.AppDeleted,
        detail: eventDetail({ slug: del.rows[0].slug }),
      });
      return true;
    });
  }

  async setStoreId(appId: string, storeId: string): Promise<void> {
    await this.db.query(`UPDATE ${this.t('apps')} SET store_id = $1 WHERE id = $2`, [storeId, appId]);
  }

  async appByScript(script: string): Promise<App | null> {
    const res = await this.db.query(`SELECT ${appCols} FROM ${this.t('apps')} WHERE script = $1`, [script]);
    return res.rows.length ? rowToApp(res.rows[0]) : null;
  }

  async deploy(appId: string, deployId: string): Promise<Deploy | null> {
    const res = await this.db.query(
      `SELECT app_id, id, manifest, state, failure FROM ${this.t('deploys')} WHERE app_id = $1 AND id = $2`,
      [appId, deployId],
    );
    return res.rows.length ? rowToDeploy(res.rows[0]) : null;
  }

  // The app's non-terminal deploys, which define the blob digests it will accept.
  async openDeploys(appId: string): Promise<Deploy[]> {
    const res = await this.db.query(
      `SELECT app_id, id, manifest, state, failure FROM ${this.t('deploys')}
       WHERE app_id = $1 AND state NOT IN ($2, $3)`,
      [appId, State.Live, State.Failed],
    );
    return res.rows.map(rowToDeploy);
  }

  // Creates the deploy, or reopens it if a previous attempt failed: failure is
  // attempt-scoped, so re-running push resumes rather than wedges.
  async openDeploy(d: Deploy): Promise<Deploy> {
    const manifest = JSON.stringify(d.manifest);
    await this.db.query(
      `INSERT INTO ${this.t('deploys')} AS d (app_id, id, manifest, state, failure) VALUES ($1,$2,$3,$4,'')
       ON CONFLICT (app_id, id) DO UPDATE SET
         state   = CASE WHEN d.state = $5 THEN $6 ELSE d.state END,
         failure = CASE WHEN d.state = $7 THEN ''  ELSE d.failure END`,
      [d.appId, d.id, manifest, State.Uploading, State.Failed, State.Uploading, State.Failed],
    );
    const got = await this.deploy(d.appId, d.id);
    if (got === null) {
      throw new Error(`open deploy: ${d.appId}/${d.id} vanished after upsert`);
    }
    return got;
  }

  // Parallel blob uploads can each observe the same last-blob-landed moment;
  // exactly one may act on it, so this reports whether this caller won.
  async claimActivation(appId: string, deployId: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE ${this.t('deploys')} SET state = $1 WHERE app_id = $2 AND id = $3 AND state = $4`,
      [State.Activating, appId, deployId, State.Uploading],
    );
    return res.rowCount === 1;
  }

  // Marks a deploy live and flips the app's serving pointer in one transaction
  // (a live-but-unserved or served-but-not-live deploy are unrecoverable states).
  // It also deletes the row this deploy replaces: ids derive from content, so
  // re-pushing once-live content resolves to its old id, and a surviving stale
  // "live" row would make Sync see a terminal deploy and never re-activate it
  // (the revert-and-push bug). With the row gone, the re-push opens fresh.
  async finishLive(appId: string, deployId: string): Promise<void> {
    await this.inTx(async (tx) => {
      const deployRow = await tx.query(
        `UPDATE ${this.t('deploys')} SET state = $1, failure = '' WHERE app_id = $2 AND id = $3
         RETURNING manifest`,
        [State.Live, appId, deployId],
      );
      await tx.query(
        `DELETE FROM ${this.t('deploys')} WHERE app_id = $1 AND id <> $2 AND state = $3`,
        [appId, deployId, State.Live],
      );
      await tx.query(`UPDATE ${this.t('apps')} SET active_deploy = $1 WHERE id = $2`, [deployId, appId]);
      await this.insertAppEvent(tx, appId, deployId, EventKind.DeployLive, '');

      // Register the live deploy's enforced policy in the same transaction that makes
      // it live, so the gateway never gates against a stale or missing policy. A
      // manifest that fails to parse leaves the app live with no policy, which the
      // gateway reads as fail-closed (owner-only) rather than open.
      if (deployRow.rows.length > 0) {
        await this.registerPolicy(tx, appId, deployId, deployRow.rows[0].manifest as string);
      }
    });
  }

  // registerPolicy persists the live manifest's enforced sections and seeds the
  // owner's grant, both idempotent. The owner is the app's user; if that user row is
  // missing it has no email, so no owner grant is seeded and ownerTenant stays empty
  // (anyone-at-tenant fails closed until the builder shares in the dialog).
  private async registerPolicy(
    tx: Queryable,
    appId: string,
    deployId: string,
    rawManifest: string,
  ): Promise<void> {
    let policy: ReturnType<typeof appPolicyFromManifest>;
    try {
      policy = appPolicyFromManifest(manifestSchema.parse(JSON.parse(rawManifest)) as Manifest);
    } catch {
      return; // unparseable manifest → no policy row → gateway stays owner-only
    }

    const ownerRes = await tx.query(
      `SELECT u.email AS email FROM ${this.t('apps')} ap
       JOIN ${this.t('users')} u ON u.id = ap.user_id
       WHERE ap.id = $1`,
      [appId],
    );
    const ownerEmail: string = ownerRes.rows.length ? (ownerRes.rows[0].email ?? '') : '';
    const ownerTenant = ownerEmail !== '' ? tenantFromEmail(ownerEmail) : '';

    await tx.query(
      `INSERT INTO ${this.t('app_policies')} (${registerPolicyCols})
       VALUES ($1,$2,$3,$4,$5,$6, ${epochNow})
       ON CONFLICT (app_id) DO UPDATE SET
         access       = EXCLUDED.access,
         roles        = EXCLUDED.roles,
         routes       = EXCLUDED.routes,
         secrets      = EXCLUDED.secrets,
         owner_tenant = CASE WHEN EXCLUDED.owner_tenant <> '' THEN EXCLUDED.owner_tenant
                             ELSE ${this.t('app_policies')}.owner_tenant END,
         updated_at   = ${epochNow}`,
      [
        appId,
        policy.access,
        JSON.stringify(policy.roles),
        JSON.stringify(policy.routes),
        JSON.stringify(policy.secrets),
        ownerTenant,
      ],
    );

    // Seed the owner's grant so the builder can open and fully use their own app on
    // the gateway from the first deploy. DO NOTHING preserves a role the owner may
    // have changed later; it never demotes them below owner here.
    if (ownerEmail !== '') {
      await tx.query(
        `INSERT INTO ${this.t('grants')} (app_id, principal, app_role, feature_role, granted_by)
         VALUES ($1,$2,'owner','','platform') ON CONFLICT (app_id, principal) DO NOTHING`,
        [appId, ownerEmail],
      );
    }

    await this.insertAppEvent(
      tx,
      appId,
      deployId,
      EventKind.PolicyRegistered,
      eventDetail({
        access: policy.access,
        roles: String(policy.roles.length),
        routes: String(policy.routes.length),
      }),
    );
  }

  // Marks a deploy failed, leaving the previously live deploy served.
  async finishFailed(appId: string, deployId: string, failure: DeployError | null): Promise<void> {
    await this.inTx(async (tx) => {
      await tx.query(
        `UPDATE ${this.t('deploys')} SET state = $1, failure = $2 WHERE app_id = $3 AND id = $4`,
        [State.Failed, encodeFailure(failure), appId, deployId],
      );
      // The code, not the message: the useful question of this table is which
      // kinds of failure happen, not what one instance's path or upstream said.
      const code = failure !== null ? failure.code : '';
      await this.insertAppEvent(tx, appId, deployId, EventKind.DeployFailed, eventDetail({ code }));
    });
  }

  // Upsert on the (app_id, principal) primary key, so re-sharing to someone
  // already listed changes their role in place. granted_at comes from the caller,
  // so an update also refreshes it to the moment of the change.
  async putGrant(g: Grant): Promise<void> {
    await this.inTx(async (tx) => {
      await tx.query(
        `INSERT INTO ${this.t('grants')} (${grantCols})
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (app_id, principal) DO UPDATE SET
           app_role     = EXCLUDED.app_role,
           feature_role = EXCLUDED.feature_role,
           data_scope   = EXCLUDED.data_scope,
           granted_by   = EXCLUDED.granted_by,
           granted_at   = EXCLUDED.granted_at`,
        [g.appId, g.principal, g.appRole, g.featureRole, encodeScope(g.dataScope), g.grantedBy, g.grantedAt],
      );
      await this.insertAppEvent(
        tx,
        g.appId,
        '',
        EventKind.GrantAdded,
        eventDetail({
          principal: g.principal,
          appRole: g.appRole,
          featureRole: g.featureRole,
          by: g.grantedBy,
        }),
      );
    });
  }

  async grant(appId: string, principal: string): Promise<Grant | null> {
    const res = await this.db.query(
      `SELECT ${grantCols} FROM ${this.t('grants')} WHERE app_id = $1 AND principal = $2`,
      [appId, principal],
    );
    return res.rows.length ? rowToGrant(res.rows[0]) : null;
  }

  // Oldest share first, the order the share dialog presents the access list in.
  // The (app_id, principal) primary key backs the filter, so no separate index.
  async grantsByApp(appId: string): Promise<Grant[]> {
    const res = await this.db.query(
      `SELECT ${grantCols} FROM ${this.t('grants')} WHERE app_id = $1 ORDER BY granted_at, principal`,
      [appId],
    );
    return res.rows.map(rowToGrant);
  }

  // Reports whether a row was there to remove, so revoking twice is not a failure.
  // A real removal writes a GrantRevoked audit event naming who revoked it.
  async revokeGrant(appId: string, principal: string, revokedBy = ''): Promise<boolean> {
    return this.inTx(async (tx) => {
      const res = await tx.query(
        `DELETE FROM ${this.t('grants')} WHERE app_id = $1 AND principal = $2`,
        [appId, principal],
      );
      if (res.rowCount !== 1) return false;
      await this.insertAppEvent(
        tx,
        appId,
        '',
        EventKind.GrantRevoked,
        eventDetail({ principal, by: revokedBy }),
      );
      return true;
    });
  }

  async appPolicy(appId: string): Promise<AppPolicy | null> {
    const res = await this.db.query(
      `SELECT ${policyCols} FROM ${this.t('app_policies')} WHERE app_id = $1`,
      [appId],
    );
    return res.rows.length ? rowToAppPolicy(res.rows[0]) : null;
  }

  // Writes the dashboard override and audits the change in one transaction. The
  // `from` recorded is the previously effective mode, so the audit reads as what
  // viewers actually experienced before and after.
  async setAppAccess(appId: string, access: AppAccess, setBy: string): Promise<boolean> {
    return this.inTx(async (tx) => {
      const res = await tx.query(
        `SELECT ${policyCols} FROM ${this.t('app_policies')} WHERE app_id = $1`,
        [appId],
      );
      if (res.rows.length === 0) return false;
      const from = rowToAppPolicy(res.rows[0]).access;
      await tx.query(
        `UPDATE ${this.t('app_policies')} SET access_override = $1, updated_at = ${epochNow} WHERE app_id = $2`,
        [access, appId],
      );
      await this.insertAppEvent(
        tx,
        appId,
        '',
        EventKind.PolicyAccessChanged,
        eventDetail({ from, to: access, by: setBy }),
      );
      return true;
    });
  }

  // A single append to the events table, denormalizing the user from the app row.
  // Callers treat this as best-effort (they swallow its error), so a slow or failed
  // audit write never turns a served request into an error.
  async recordAppAccess(e: {
    appId: string;
    principal: string;
    allowed: boolean;
    detail?: string;
    kind?: string;
  }): Promise<void> {
    const kind = e.kind ?? (e.allowed ? EventKind.AppAccessed : EventKind.AppAccessDenied);
    const detail = e.detail ?? eventDetail({ principal: e.principal });
    await this.db.query(
      `INSERT INTO ${this.t('events')} (user_id, app_id, deploy_id, kind, detail)
       SELECT user_id, id, '', $1, $2 FROM ${this.t('apps')} WHERE id = $3`,
      [kind, detail, e.appId],
    );
  }

  private async insertEvent(
    x: Queryable,
    e: { userId?: string; appId?: string; deployId?: string; kind: string; detail?: string },
  ): Promise<void> {
    await x.query(
      `INSERT INTO ${this.t('events')} (user_id, app_id, deploy_id, kind, detail) VALUES ($1,$2,$3,$4,$5)`,
      [e.userId ?? '', e.appId ?? '', e.deployId ?? '', e.kind, e.detail ?? ''],
    );
  }

  // Takes the user from the app row, so deploy transitions that know only an
  // app id need not thread a user through only to denormalize it here.
  private async insertAppEvent(
    x: Queryable,
    appId: string,
    deployId: string,
    kind: string,
    detail: string,
  ): Promise<void> {
    await x.query(
      `INSERT INTO ${this.t('events')} (user_id, app_id, deploy_id, kind, detail)
       SELECT user_id, id, $1, $2, $3 FROM ${this.t('apps')} WHERE id = $4`,
      [deployId, kind, detail, appId],
    );
  }
}
