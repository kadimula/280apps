// The platform's control-plane database: accounts, apps, deploys, and the
// events they produce. Blob bytes are not here — they live in blobstore, which
// is also the authority on which blobs an app has, so there is no index to
// drift out of sync with the bytes.
//
// Spec: platform/internal/store/store.go. Go is normative. Postgres via the
// `pg` driver. Deploys are a state machine that must survive process death, so
// the database is the only place that state lives. Nothing here relies on being
// the sole writer: every transition two callers could reach at once is a
// conditional UPDATE whose row count names the winner (claimActivation,
// claimDeviceCode, approveDeviceCode), and every uniqueness rule is an index
// rather than a read-then-write.

import type { Manifest, DeployError } from '@280/contracts';
import { manifestSchema, errorSchema, State } from '@280/contracts';
import pg from 'pg';
import type { QueryResult } from 'pg';
import {
  DeviceStatus,
  EventKind,
  type Account,
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

// Queryable is the query surface one statement runs against, satisfied by both
// a pooled client and a single Client.
interface Queryable {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

// Backend is how PgStore reaches Postgres: a plain statement, or a function run
// against one connection inside BEGIN/COMMIT. Two shapes back it — a Pool (boot
// and tests, where a query checks a connection out and returns it) and a single
// lazily-connected Client (the Worker, where one connection serves one request
// and is ended after the response). Everything the store does routes through
// here, so the store body is identical whichever backs it.
interface Backend {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// PoolBackend backs the store with a connection pool: the boot path and the
// tests. A transaction checks one client out of the pool and returns it.
class PoolBackend implements Backend {
  constructor(private readonly pool: pg.Pool) {}

  query(text: string, params?: unknown[]): Promise<QueryResult> {
    return this.pool.query(text, params as unknown[] | undefined);
  }

  async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // no-op once committed; the original error is what matters
      }
      throw err;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

// ClientBackend backs the store with one lazily-connected client: the Worker's
// per-request path. The client connects on the first statement (so a request
// that never touches the database opens no connection) and is ended once, after
// the response, by close(). A single client cannot run statements concurrently,
// which is exactly right: one request drives the store sequentially, and a
// transaction is BEGIN/COMMIT on that same client rather than a checkout.
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
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await c.query('ROLLBACK');
      } catch {
        // no-op once committed; the original error is what matters
      }
      throw err;
    }
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

// connectTimeout bounds the wait for a database to become reachable at boot, in
// milliseconds. A container host's private network can take a moment to resolve
// after the process starts; exiting into a restart loop over a DNS lookup that
// would have succeeded a second later is a slower, noisier version of waiting.
const connectTimeoutMs = 30_000;

// maxEventPage caps one read. An unbounded query against an append-only table
// is a slow way to run out of memory two years from now.
const maxEventPage = 200;

// open connects to (and migrates) the Postgres database at dsn, which is the
// DATABASE_URL the host hands the process.
//
// A non-empty schema confines every table to it, so the platform can share a
// database with another service without sharing a namespace. The schema is
// created if missing: the platform owns its own tables, and needing a DBA to
// run one DDL statement before the first boot is a step that gets forgotten.
//
// Boot still migrates. The statements are idempotent, so a database CI already
// migrated is a no-op here; keeping the boot path means the container and
// rollback paths do not depend on a separate runner having gone first.
export async function open(dsn: string, schema: string): Promise<Store> {
  if (dsn === '') {
    throw new Error('store: empty DATABASE_URL');
  }
  // migrations() validates the schema identifier and throws on a bad one, so
  // build the statement list before opening the pool.
  const stmts = migrations(schema);

  // A deploy control plane's write rate does not need a large pool, and a
  // bounded one keeps a restart loop from exhausting the server's connection
  // slots faster than it exhausts our patience.
  const pool = new Pool({
    connectionString: dsn,
    max: 10,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 3600,
  });

  // Fail here rather than on the first push. A platform that boots without a
  // database and only says so under load is the worst version of this error.
  try {
    await waitForDB(pool);
    // Every statement is schema-qualified, so this no longer depends on a
    // session search_path; the first statement creates the schema.
    for (const stmt of stmts) {
      await pool.query(stmt);
    }
  } catch (err) {
    await pool.end();
    throw err;
  }
  return new PgStore(new PoolBackend(pool), schema);
}

// newPgStore builds a store over one lazily-connected client, for the Worker's
// request scope: the client connects on the first statement, against the
// (Hyperdrive) connection string, and is ended after the response. It does NOT
// migrate — DDL runs only through the standalone CI runner (migrate.ts), never
// at runtime — and holds no pool, so no I/O object is carried across requests.
export function newPgStore(connectionString: string, schema: string): Store {
  return new PgStore(new ClientBackend(connectionString), schema);
}

// waitForDB pings until the database answers or connectTimeout elapses.
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

// bigint columns arrive as strings from `pg` (int8 is out of JS's safe integer
// range in general); these columns hold second-resolution timestamps and serial
// ids that fit, so Number() reproduces the Go int64 read.
function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

const appCols =
  'id, account_id, slug, framework, url, script, salt, fingerprint, client_ref, store_id, active_deploy';

const grantCols =
  'app_id, principal, app_role, feature_role, data_scope, granted_by, granted_at';

function encodeFailure(e: DeployError | null): string {
  return e === null ? '' : JSON.stringify(e);
}

// data_scope is advisory, builder-defined JSON, so it is stored as text and read
// back with only the shape the seam promises checked: a JSON object, or null
// when empty. Anything that is not an object (a bare string, an array, malformed
// text) decodes to null rather than throwing — advisory means a bad scope must
// not break a read of the row's real permission fields.
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

// Row is one pg result row. pg hands columns back untyped; the rowTo* helpers
// below are the single boundary where they are read by name into typed shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function rowToAccount(r: Row): Account {
  return { id: r.id, subject: r.subject };
}

function rowToApp(r: Row): App {
  return {
    id: r.id,
    accountId: r.account_id,
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

function rowToDeviceCode(r: Row): DeviceCode {
  return {
    deviceHash: r.device_hash,
    userCode: r.user_code,
    accountId: r.account_id,
    status: r.status,
    expiresAt: toNum(r.expires_at),
  };
}

function rowToEvent(r: Row): Event {
  return {
    id: toNum(r.id),
    accountId: r.account_id,
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

// eventDetail encodes the handful of strings an event carries.
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

// PgStore is the database handle.
class PgStore implements Store {
  // t addresses a table by its configured schema. Every statement below routes
  // its table names through it, so nothing depends on a session search_path —
  // the one requirement for surviving transaction-mode connection pooling.
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

  // inTx runs fn in a transaction. Every event is written by the same
  // transaction as the change it describes, so a deploy that went live without
  // its event, or an event for a transition that rolled back, are both states
  // the database will not produce.
  private inTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  // ---- events ----

  async recentEvents(limit: number): Promise<Event[]> {
    if (limit <= 0 || limit > maxEventPage) {
      limit = maxEventPage;
    }
    const res = await this.db.query(
      `SELECT id, account_id, app_id, deploy_id, kind, detail, created_at
       FROM ${this.t('events')} ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map(rowToEvent);
  }

  // ---- accounts ----

  async accountByToken(tokenHash: string): Promise<Account | null> {
    const res = await this.db.query(
      `SELECT a.id, a.subject FROM ${this.t('accounts')} a
       JOIN ${this.t('tokens')} t ON t.account_id = a.id
       WHERE t.token_hash = $1`,
      [tokenHash],
    );
    return res.rows.length ? rowToAccount(res.rows[0]) : null;
  }

  async accountBySubject(subject: string): Promise<Account | null> {
    const res = await this.db.query(
      `SELECT id, subject FROM ${this.t('accounts')} WHERE subject = $1`,
      [subject],
    );
    return res.rows.length ? rowToAccount(res.rows[0]) : null;
  }

  async createAccount(a: Account): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('accounts')} (id, subject) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [a.id, a.subject],
    );
  }

  // ensureAccount returns the account for an external identity, creating it on
  // first sight. The insert-then-read shape means two machines approving at
  // once converge on one account rather than racing to create two.
  async ensureAccount(subject: string, newId: string): Promise<Account> {
    if (subject === '') {
      throw new Error('ensure account: empty subject');
    }
    // The conflict target repeats the index's WHERE clause because
    // accounts_by_subject is partial, and the upsert target is matched to a
    // partial index only when the predicate is restated.
    await this.db.query(
      `INSERT INTO ${this.t('accounts')} (id, subject) VALUES ($1, $2)
       ON CONFLICT (subject) WHERE subject <> '' DO NOTHING`,
      [newId, subject],
    );
    const res = await this.db.query(
      `SELECT id, subject FROM ${this.t('accounts')} WHERE subject = $1`,
      [subject],
    );
    if (!res.rows.length) {
      throw new Error('ensure account: row vanished after upsert');
    }
    return rowToAccount(res.rows[0]);
  }

  async addToken(accountId: string, tokenHash: string): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('tokens')} (token_hash, account_id) VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash, accountId],
    );
  }

  // ---- users, oauth logins, sessions ----

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

  // touchLoginRate is a single upsert that resets the window when it has passed
  // and increments it otherwise, then reports whether the new count is within
  // the limit. One statement, so two replicas cannot both read a stale count.
  async touchLoginRate(key: string, now: number, windowSecs: number, limit: number): Promise<boolean> {
    // The arithmetic parameters are cast explicitly: an untyped $n inside `+`
    // defaults to text, and text + text is not an operator Postgres has.
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

  // deleteExpired sweeps the three time-boxed tables in one transaction: expired
  // browser sessions and device codes, and lapsed login-rate windows. Run by the
  // scheduled cleanup; the counts are for its log line. Everything else in the
  // schema (accounts, apps, deploys, events) is retained by design.
  async deleteExpired(now: number): Promise<ExpiryCounts> {
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
      return {
        sessions: sessions.rowCount ?? 0,
        deviceCodes: deviceCodes.rowCount ?? 0,
        rateLimits: rateLimits.rowCount ?? 0,
      };
    });
  }

  // ---- device codes ----

  async createDeviceCode(d: DeviceCode): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('device_codes')} (device_hash, user_code, status, expires_at) VALUES ($1,$2,$3,$4)`,
      [d.deviceHash, d.userCode, d.status, d.expiresAt],
    );
  }

  async deviceCodeByHash(hash: string): Promise<DeviceCode | null> {
    const res = await this.db.query(
      `SELECT device_hash, user_code, account_id, status, expires_at FROM ${this.t('device_codes')} WHERE device_hash = $1`,
      [hash],
    );
    return res.rows.length ? rowToDeviceCode(res.rows[0]) : null;
  }

  // approveDeviceCode binds a pending code to an account. It reports false if
  // the code is unknown, expired, or already past pending, so a replayed
  // approval cannot re-open a claimed login.
  async approveDeviceCode(userCode: string, accountId: string, now: number): Promise<boolean> {
    return this.inTx(async (tx) => {
      const res = await tx.query(
        `UPDATE ${this.t('device_codes')} SET status = $1, account_id = $2
         WHERE user_code = $3 AND status = $4 AND expires_at > $5`,
        [DeviceStatus.Approved, accountId, userCode, DeviceStatus.Pending, now],
      );
      if (res.rowCount !== 1) {
        return false;
      }
      await this.insertEvent(tx, { accountId, kind: EventKind.LoginApproved });
      return true;
    });
  }

  // claimDeviceCode moves an approved code to claimed and reports whether this
  // caller won. Exactly one poll may mint a token for a given code.
  async claimDeviceCode(deviceHash: string): Promise<boolean> {
    return this.inTx(async (tx) => {
      // RETURNING rather than a row count: the winner needs the account the
      // code was approved for, and the caller does not have it.
      const res = await tx.query(
        `UPDATE ${this.t('device_codes')} SET status = $1 WHERE device_hash = $2 AND status = $3
         RETURNING account_id`,
        [DeviceStatus.Claimed, deviceHash, DeviceStatus.Approved],
      );
      if (res.rowCount !== 1) {
        return false;
      }
      await this.insertEvent(tx, {
        accountId: res.rows[0].account_id,
        kind: EventKind.LoginClaimed,
      });
      return true;
    });
  }

  // ---- apps ----

  async app(accountId: string, appId: string): Promise<App | null> {
    const res = await this.db.query(
      `SELECT ${appCols} FROM ${this.t('apps')} WHERE account_id = $1 AND id = $2`,
      [accountId, appId],
    );
    return res.rows.length ? rowToApp(res.rows[0]) : null;
  }

  // appsByFingerprint returns every app matching a project fingerprint, oldest
  // first. More than one is the ambiguous_identity case.
  async appsByFingerprint(accountId: string, fingerprint: string): Promise<App[]> {
    const res = await this.db.query(
      `SELECT ${appCols} FROM ${this.t('apps')} WHERE account_id = $1 AND fingerprint = $2 ORDER BY created_at, id`,
      [accountId, fingerprint],
    );
    return res.rows.map(rowToApp);
  }

  // appsByAccount returns everything an account owns, newest first.
  async appsByAccount(accountId: string): Promise<App[]> {
    const res = await this.db.query(
      `SELECT ${appCols} FROM ${this.t('apps')} WHERE account_id = $1 ORDER BY created_at DESC, id`,
      [accountId],
    );
    return res.rows.map(rowToApp);
  }

  async appByClientRef(accountId: string, ref: string): Promise<App | null> {
    const res = await this.db.query(
      `SELECT ${appCols} FROM ${this.t('apps')} WHERE account_id = $1 AND client_ref = $2`,
      [accountId, ref],
    );
    return res.rows.length ? rowToApp(res.rows[0]) : null;
  }

  async createApp(a: App): Promise<void> {
    await this.inTx(async (tx) => {
      // No ON CONFLICT: the create-dedup guard is the unique index on
      // (account, clientRef), and losing that race must stay an error the
      // caller can recognize and resolve to the existing app.
      await tx.query(
        `INSERT INTO ${this.t('apps')} (${appCols}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          a.id,
          a.accountId,
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
        accountId: a.accountId,
        appId: a.id,
        kind: EventKind.AppCreated,
        detail: eventDetail({ slug: a.slug, framework: a.framework }),
      });
    });
  }

  // deleteApp removes an app and its deploys, and reports whether a row was
  // there to remove. Scoped by account like every other app read, so one tenant
  // cannot delete another's app by guessing an id. The events the app produced
  // stay behind.
  async deleteApp(accountId: string, appId: string): Promise<boolean> {
    return this.inTx(async (tx) => {
      const del = await tx.query(
        `DELETE FROM ${this.t('apps')} WHERE account_id = $1 AND id = $2 RETURNING slug`,
        [accountId, appId],
      );
      if (del.rowCount !== 1) {
        return false; // already gone; deleting twice is not a failure
      }
      await tx.query(`DELETE FROM ${this.t('deploys')} WHERE app_id = $1`, [appId]);
      // Grants are app-scoped rows with no owning app anymore; drop them so a
      // re-created app id (ids can recur) never inherits another life's access.
      await tx.query(`DELETE FROM ${this.t('grants')} WHERE app_id = $1`, [appId]);
      // insertEvent, not insertAppEvent: the app row this statement would read
      // the account from no longer exists.
      await this.insertEvent(tx, {
        accountId,
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

  // appByScript resolves a hostname label to an app, for the serving edge.
  async appByScript(script: string): Promise<App | null> {
    const res = await this.db.query(`SELECT ${appCols} FROM ${this.t('apps')} WHERE script = $1`, [script]);
    return res.rows.length ? rowToApp(res.rows[0]) : null;
  }

  // ---- deploys ----

  async deploy(appId: string, deployId: string): Promise<Deploy | null> {
    const res = await this.db.query(
      `SELECT app_id, id, manifest, state, failure FROM ${this.t('deploys')} WHERE app_id = $1 AND id = $2`,
      [appId, deployId],
    );
    return res.rows.length ? rowToDeploy(res.rows[0]) : null;
  }

  // openDeploys returns the app's non-terminal deploys. These define which blob
  // digests the app will accept.
  async openDeploys(appId: string): Promise<Deploy[]> {
    const res = await this.db.query(
      `SELECT app_id, id, manifest, state, failure FROM ${this.t('deploys')}
       WHERE app_id = $1 AND state NOT IN ($2, $3)`,
      [appId, State.Live, State.Failed],
    );
    return res.rows.map(rowToDeploy);
  }

  // openDeploy creates the deploy, or reopens it if a previous attempt failed —
  // failure is attempt-scoped, so re-running push resumes rather than wedges. It
  // returns the deploy as it now stands.
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

  // claimActivation moves a deploy from uploading to activating and reports
  // whether this caller won. Parallel blob uploads can each observe the same
  // last-blob-landed moment; exactly one may act on it.
  async claimActivation(appId: string, deployId: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE ${this.t('deploys')} SET state = $1 WHERE app_id = $2 AND id = $3 AND state = $4`,
      [State.Activating, appId, deployId, State.Uploading],
    );
    return res.rowCount === 1;
  }

  // finishLive marks a deploy live and flips the app's serving pointer. The two
  // happen in one transaction because a live deploy that is not being served,
  // or a served deploy that is not live, are both states nothing can recover
  // from.
  //
  // It also deletes the row this deploy replaces: a row that says live IS the
  // app's active deploy. Deploy ids are derived from content, so re-pushing
  // content that was live once resolves to its old id; if that row survived as
  // a stale "live", Sync would see a terminal deploy and never re-activate it
  // (the revert-and-push bug). With the row gone, the re-push opens fresh.
  async finishLive(appId: string, deployId: string): Promise<void> {
    await this.inTx(async (tx) => {
      await tx.query(
        `UPDATE ${this.t('deploys')} SET state = $1, failure = '' WHERE app_id = $2 AND id = $3`,
        [State.Live, appId, deployId],
      );
      await tx.query(
        `DELETE FROM ${this.t('deploys')} WHERE app_id = $1 AND id <> $2 AND state = $3`,
        [appId, deployId, State.Live],
      );
      await tx.query(`UPDATE ${this.t('apps')} SET active_deploy = $1 WHERE id = $2`, [deployId, appId]);
      await this.insertAppEvent(tx, appId, deployId, EventKind.DeployLive, '');
    });
  }

  // finishFailed marks a deploy failed, leaving the previously live deploy
  // served.
  async finishFailed(appId: string, deployId: string, failure: DeployError | null): Promise<void> {
    await this.inTx(async (tx) => {
      await tx.query(
        `UPDATE ${this.t('deploys')} SET state = $1, failure = $2 WHERE app_id = $3 AND id = $4`,
        [State.Failed, encodeFailure(failure), appId, deployId],
      );
      // The code, not the message: a message carries a path or an upstream
      // error string, and the useful question of this table is which kinds of
      // failure happen, not what one of them said.
      const code = failure !== null ? failure.code : '';
      await this.insertAppEvent(tx, appId, deployId, EventKind.DeployFailed, eventDetail({ code }));
    });
  }

  // ---- grants ----

  // putGrant creates or updates a principal's grant on an app. The upsert targets
  // the (app_id, principal) primary key: re-sharing to someone already on the
  // list changes their role in place rather than failing, which is what the share
  // dialog does when an owner picks a new role. granted_at is supplied by the
  // caller (like session/device-code expiries) rather than read from the clock
  // here, so an update also refreshes it to the moment of the change.
  async putGrant(g: Grant): Promise<void> {
    await this.db.query(
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
  }

  // grant returns a principal's grant on an app, or null if they hold none.
  async grant(appId: string, principal: string): Promise<Grant | null> {
    const res = await this.db.query(
      `SELECT ${grantCols} FROM ${this.t('grants')} WHERE app_id = $1 AND principal = $2`,
      [appId, principal],
    );
    return res.rows.length ? rowToGrant(res.rows[0]) : null;
  }

  // grantsByApp lists every grant on an app, oldest share first — the order the
  // share dialog presents the access list in. The (app_id, principal) primary key
  // is the scan for the app_id filter, so no separate index backs this read.
  async grantsByApp(appId: string): Promise<Grant[]> {
    const res = await this.db.query(
      `SELECT ${grantCols} FROM ${this.t('grants')} WHERE app_id = $1 ORDER BY granted_at, principal`,
      [appId],
    );
    return res.rows.map(rowToGrant);
  }

  // revokeGrant removes a principal's grant and reports whether a row was there
  // to remove, so revoking access twice is not a failure.
  async revokeGrant(appId: string, principal: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM ${this.t('grants')} WHERE app_id = $1 AND principal = $2`,
      [appId, principal],
    );
    return res.rowCount === 1;
  }

  // insertEvent appends one event through the pool or a transaction.
  private async insertEvent(
    x: Queryable,
    e: { accountId?: string; appId?: string; deployId?: string; kind: string; detail?: string },
  ): Promise<void> {
    await x.query(
      `INSERT INTO ${this.t('events')} (account_id, app_id, deploy_id, kind, detail) VALUES ($1,$2,$3,$4,$5)`,
      [e.accountId ?? '', e.appId ?? '', e.deployId ?? '', e.kind, e.detail ?? ''],
    );
  }

  // insertAppEvent appends an app-scoped event, taking the account from the app
  // row. Deploy transitions know an app id and nothing else, and threading an
  // account through them only to denormalize it here would be a parameter that
  // exists to be forgotten.
  private async insertAppEvent(
    x: Queryable,
    appId: string,
    deployId: string,
    kind: string,
    detail: string,
  ): Promise<void> {
    await x.query(
      `INSERT INTO ${this.t('events')} (account_id, app_id, deploy_id, kind, detail)
       SELECT account_id, id, $1, $2, $3 FROM ${this.t('apps')} WHERE id = $4`,
      [deployId, kind, detail, appId],
    );
  }
}
