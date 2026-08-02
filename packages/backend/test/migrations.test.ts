// The accounts→users merge migration, run against real Postgres with a schema per
// test. This is the riskiest code in the phase: a legacy database must converge on
// the identical end schema a fresh one boots into, re-running must be a no-op, and a
// row that cannot be mapped must fail loudly rather than orphan silently.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { open } from '../src/store/store.js';
import { hasDatabase, testDatabaseURL } from './pg.js';

const { Client } = pg;
const base = testDatabaseURL();

let schemaSeq = 0;

async function columnNames(admin: pg.Client, schema: string, table: string): Promise<string[]> {
  const res = await admin.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
    [schema, table],
  );
  return res.rows.map((r) => r.column_name as string);
}

async function tableExists(admin: pg.Client, schema: string, table: string): Promise<boolean> {
  const res = await admin.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return res.rows.length > 0;
}

// Builds a pre-merge schema: the accounts indirection plus the four tables that held
// account ids, mirroring the DDL the old code shipped.
async function seedLegacy(admin: pg.Client, schema: string): Promise<void> {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const q = (name: string) => `"${schema}"."${name}"`;
  await admin.query(`CREATE TABLE ${q('accounts')} (id TEXT PRIMARY KEY, subject TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL DEFAULT 0)`);
  await admin.query(`CREATE UNIQUE INDEX accounts_by_subject ON ${q('accounts')}(subject) WHERE subject <> ''`);
  await admin.query(`CREATE TABLE ${q('tokens')} (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at BIGINT NOT NULL DEFAULT 0)`);
  await admin.query(`CREATE TABLE ${q('device_codes')} (device_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL DEFAULT 0)`);
  await admin.query(`CREATE TABLE ${q('apps')} (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, slug TEXT NOT NULL, framework TEXT NOT NULL, url TEXT NOT NULL, script TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, fingerprint TEXT NOT NULL DEFAULT '', client_ref TEXT NOT NULL DEFAULT '', store_id TEXT NOT NULL DEFAULT '', active_deploy TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL DEFAULT 0)`);
  await admin.query(`CREATE INDEX apps_by_fingerprint ON ${q('apps')}(account_id, fingerprint)`);
  await admin.query(`CREATE UNIQUE INDEX apps_by_client_ref ON ${q('apps')}(account_id, client_ref) WHERE client_ref <> ''`);
  await admin.query(`CREATE TABLE ${q('events')} (id BIGSERIAL PRIMARY KEY, account_id TEXT NOT NULL DEFAULT '', app_id TEXT NOT NULL DEFAULT '', deploy_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL DEFAULT 0)`);
  await admin.query(`CREATE INDEX events_by_time ON ${q('events')}(created_at DESC, id DESC)`);
  await admin.query(`CREATE INDEX events_by_account ON ${q('events')}(account_id, created_at DESC)`);
  await admin.query(`CREATE INDEX events_by_app ON ${q('events')}(app_id, created_at DESC)`);
}

describe.skipIf(!hasDatabase())('accounts→users migration', () => {
  let admin: pg.Client;
  let schema: string;

  beforeEach(async () => {
    admin = new Client({ connectionString: base });
    await admin.connect();
    schema = `t_mig2_${process.pid}_${++schemaSeq}`;
  });
  afterEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it('a fresh schema boots into the merged shape', async () => {
    const store = await open(base, schema);
    await store.close();

    expect(await tableExists(admin, schema, 'accounts')).toBe(false);
    for (const table of ['apps', 'tokens', 'device_codes', 'events']) {
      const cols = await columnNames(admin, schema, table);
      expect(cols).toContain('user_id');
      expect(cols).not.toContain('account_id');
    }
  });

  it('a legacy schema converges: rows carry the user id, columns rename, accounts is gone', async () => {
    await seedLegacy(admin, schema);
    const q = (name: string) => `"${schema}"."${name}"`;
    await admin.query(`INSERT INTO ${q('accounts')} (id, subject) VALUES ('acct_1', 'usr_1')`);
    await admin.query(
      `INSERT INTO ${q('apps')} (id, account_id, slug, framework, url, script, salt) VALUES ('app_1', 'acct_1', 'demo', 'next', 'https://demo.280apps.run', 'demo-1', 'salt')`,
    );
    await admin.query(`INSERT INTO ${q('tokens')} (token_hash, account_id) VALUES ('hash_1', 'acct_1')`);
    await admin.query(
      `INSERT INTO ${q('device_codes')} (device_hash, user_code, account_id, status, expires_at) VALUES ('dev_1', 'ABCD1234', 'acct_1', 'approved', 9999999999)`,
    );
    await admin.query(`INSERT INTO ${q('events')} (account_id, app_id, kind) VALUES ('acct_1', 'app_1', 'app.created')`);
    // An event with no owner must survive untouched (empty stays empty).
    await admin.query(`INSERT INTO ${q('events')} (account_id, app_id, kind) VALUES ('', '', 'deploy.live')`);

    const store = await open(base, schema);

    expect(await tableExists(admin, schema, 'accounts')).toBe(false);
    for (const table of ['apps', 'tokens', 'device_codes', 'events']) {
      const cols = await columnNames(admin, schema, table);
      expect(cols).toContain('user_id');
      expect(cols).not.toContain('account_id');
    }

    // Every former account id is now the user id it mapped to.
    expect((await admin.query(`SELECT user_id FROM ${q('apps')} WHERE id = 'app_1'`)).rows[0].user_id).toBe('usr_1');
    expect((await admin.query(`SELECT user_id FROM ${q('tokens')} WHERE token_hash = 'hash_1'`)).rows[0].user_id).toBe('usr_1');
    expect((await admin.query(`SELECT user_id FROM ${q('device_codes')} WHERE device_hash = 'dev_1'`)).rows[0].user_id).toBe('usr_1');
    expect((await admin.query(`SELECT user_id FROM ${q('events')} WHERE kind = 'app.created'`)).rows[0].user_id).toBe('usr_1');
    expect((await admin.query(`SELECT user_id FROM ${q('events')} WHERE kind = 'deploy.live'`)).rows[0].user_id).toBe('');

    // The index converged on the fresh name, and the app reads back through the seam.
    expect(await tableExists(admin, schema, 'accounts')).toBe(false);
    const idx = await admin.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'events'`,
      [schema],
    );
    const names = idx.rows.map((r) => r.indexname as string);
    expect(names).toContain('events_by_user');
    expect(names).not.toContain('events_by_account');

    expect((await store.app('usr_1', 'app_1'))?.id).toBe('app_1');
    await store.close();
  });

  it('re-running migrations on a migrated legacy schema is a no-op', async () => {
    await seedLegacy(admin, schema);
    const q = (name: string) => `"${schema}"."${name}"`;
    await admin.query(`INSERT INTO ${q('accounts')} (id, subject) VALUES ('acct_1', 'usr_1')`);
    await admin.query(
      `INSERT INTO ${q('apps')} (id, account_id, slug, framework, url, script, salt) VALUES ('app_1', 'acct_1', 'demo', 'next', 'https://demo.280apps.run', 'demo-1', 'salt')`,
    );

    const first = await open(base, schema);
    await first.close();
    // A second Open runs every statement again; it must succeed and keep the data.
    const second = await open(base, schema);
    expect((await second.app('usr_1', 'app_1'))?.id).toBe('app_1');
    expect(await tableExists(admin, schema, 'accounts')).toBe(false);
    await second.close();
  });

  it('a subject-less account fails the migration loudly', async () => {
    await seedLegacy(admin, schema);
    const q = (name: string) => `"${schema}"."${name}"`;
    await admin.query(`INSERT INTO ${q('accounts')} (id, subject) VALUES ('acct_orphan', '')`);

    await expect(open(base, schema)).rejects.toThrow(/empty subject/);
    // Nothing was silently dropped: the accounts table is still there to fix.
    expect(await tableExists(admin, schema, 'accounts')).toBe(true);
  });
});
