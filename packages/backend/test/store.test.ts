// Store tests, run against real Postgres with a schema per test. Behavior spec:
// platform/internal/store/store.go. The claims that matter here are the ones a
// pure-logic port can silently break: conditional-UPDATE winner counts, the
// partial unique indexes, ON CONFLICT reopen, and the FinishLive superseded-row
// delete.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from '@280/contracts';
import { State } from '@280/contracts';
import type { App, Deploy, DeviceCode, Store } from '../src/seams.js';
import { DeviceStatus, EventKind } from '../src/seams.js';
import { hasDatabase, newStore } from './pg.js';

const emptyManifest: Manifest = {
  kind: 'bundle',
  worker: { path: '', digest: '', size: 0 },
  assets: [],
  cache: [],
};

function manifestFor(workerDigest: string, size = 6): Manifest {
  return {
    kind: 'bundle',
    worker: { path: '', digest: workerDigest, size },
    assets: [],
    cache: [],
  };
}

let seq = 0;
function appFixture(over: Partial<App> = {}): App {
  seq++;
  return {
    id: over.id ?? `app_${seq.toString(16).padStart(12, '0')}`,
    accountId: over.accountId ?? 'acct_test',
    slug: over.slug ?? 'demo',
    framework: over.framework ?? 'static',
    url: over.url ?? `https://demo-${seq}.280apps.run`,
    script: over.script ?? `demo-${seq}`,
    salt: over.salt ?? 'salt',
    fingerprint: over.fingerprint ?? '',
    clientRef: over.clientRef ?? '',
    storeId: over.storeId ?? '',
    activeDeploy: over.activeDeploy ?? '',
  };
}

const now = () => Math.floor(Date.now() / 1000);

describe.skipIf(!hasDatabase())('store', () => {
  let store: Store;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ store, cleanup } = await newStore());
  });
  afterEach(async () => {
    await cleanup();
  });

  // ---- migrations ----

  it('re-running migrations on an already-migrated schema is a no-op', async () => {
    // No schema version table; every migration statement is idempotent, so a
    // second Open on the same schema must succeed rather than a version check.
    const base = process.env.TEST_DATABASE_URL as string;
    const { open } = await import('../src/store/store.js');
    const schema = `t_mig_${process.pid}_${Date.now()}`;
    const admin = new (await import('pg')).default.Client({ connectionString: base });
    await admin.connect();
    try {
      const first = await open(base, schema);
      await first.createAccount({ id: 'acct_mig', subject: 'sub-mig' });
      await first.close();
      // Re-open: migrations run again against a populated schema without error,
      // and the data is still there.
      const second = await open(base, schema);
      expect(await second.accountBySubject('sub-mig')).toEqual({
        id: 'acct_mig',
        subject: 'sub-mig',
      });
      await second.close();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  // ---- accounts ----

  it('createAccount is idempotent on id (DO NOTHING keeps the first row)', async () => {
    await store.createAccount({ id: 'acct_1', subject: 'sub-a' });
    // ON CONFLICT (id) DO NOTHING: the second insert is a no-op, so the original
    // subject survives rather than being overwritten.
    await store.createAccount({ id: 'acct_1', subject: 'sub-b' });
    expect(await store.accountBySubject('sub-a')).toEqual({ id: 'acct_1', subject: 'sub-a' });
    expect(await store.accountBySubject('sub-b')).toBeNull();
  });

  it('accountByToken joins tokens to accounts', async () => {
    await store.createAccount({ id: 'acct_1', subject: 'sub-1' });
    await store.addToken('acct_1', 'hash-1');
    const a = await store.accountByToken('hash-1');
    expect(a).toEqual({ id: 'acct_1', subject: 'sub-1' });
    expect(await store.accountByToken('nope')).toBeNull();
  });

  it('addToken is idempotent on token hash', async () => {
    await store.createAccount({ id: 'acct_1', subject: '' });
    await store.addToken('acct_1', 'hash-1');
    await store.addToken('acct_1', 'hash-1'); // ON CONFLICT DO NOTHING
    expect(await store.accountByToken('hash-1')).toEqual({ id: 'acct_1', subject: '' });
  });

  it('ensureAccount creates on first sight and converges on the second', async () => {
    const first = await store.ensureAccount('sub-1', 'acct_new_1');
    expect(first).toEqual({ id: 'acct_new_1', subject: 'sub-1' });
    // Second call with a different candidate id must return the existing row,
    // proving the partial unique index deduped rather than inserting a twin.
    const second = await store.ensureAccount('sub-1', 'acct_new_2');
    expect(second).toEqual({ id: 'acct_new_1', subject: 'sub-1' });
  });

  it('ensureAccount rejects an empty subject', async () => {
    await expect(store.ensureAccount('', 'acct_x')).rejects.toThrow(/empty subject/);
  });

  it('accountBySubject is read-only and returns null for the unknown', async () => {
    expect(await store.accountBySubject('ghost')).toBeNull();
  });

  // ---- device codes ----

  function deviceFixture(over: Partial<DeviceCode> = {}): DeviceCode {
    return {
      deviceHash: over.deviceHash ?? 'dev-hash',
      userCode: over.userCode ?? 'ABCD-1234',
      accountId: over.accountId ?? '',
      status: over.status ?? DeviceStatus.Pending,
      expiresAt: over.expiresAt ?? now() + 600,
    };
  }

  it('createDeviceCode then read back by hash', async () => {
    await store.createDeviceCode(deviceFixture());
    const d = await store.deviceCodeByHash('dev-hash');
    expect(d).toMatchObject({
      deviceHash: 'dev-hash',
      userCode: 'ABCD-1234',
      accountId: '',
      status: DeviceStatus.Pending,
    });
    expect(await store.deviceCodeByHash('missing')).toBeNull();
  });

  it('approveDeviceCode binds a pending code and reports true once', async () => {
    await store.createAccount({ id: 'acct_1', subject: 'sub-1' });
    await store.createDeviceCode(deviceFixture());
    expect(await store.approveDeviceCode('ABCD-1234', 'acct_1', now())).toBe(true);
    const d = await store.deviceCodeByHash('dev-hash');
    expect(d?.status).toBe(DeviceStatus.Approved);
    expect(d?.accountId).toBe('acct_1');
    // A replayed approval on an already-approved code cannot re-open it.
    expect(await store.approveDeviceCode('ABCD-1234', 'acct_1', now())).toBe(false);
  });

  it('approveDeviceCode is false for unknown, expired, or claimed codes', async () => {
    await store.createAccount({ id: 'acct_1', subject: 'sub-1' });
    expect(await store.approveDeviceCode('NOPE-0000', 'acct_1', now())).toBe(false);
    await store.createDeviceCode(
      deviceFixture({ deviceHash: 'expired', userCode: 'EXPD-0001', expiresAt: now() - 1 }),
    );
    expect(await store.approveDeviceCode('EXPD-0001', 'acct_1', now())).toBe(false);
  });

  it('claimDeviceCode lets exactly one caller win', async () => {
    await store.createAccount({ id: 'acct_1', subject: 'sub-1' });
    await store.createDeviceCode(deviceFixture());
    await store.approveDeviceCode('ABCD-1234', 'acct_1', now());

    const results = await Promise.all([
      store.claimDeviceCode('dev-hash'),
      store.claimDeviceCode('dev-hash'),
      store.claimDeviceCode('dev-hash'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.claimDeviceCode('dev-hash')).toBe(false); // already claimed
  });

  it('claimDeviceCode is false for a code that is not approved', async () => {
    await store.createDeviceCode(deviceFixture());
    expect(await store.claimDeviceCode('dev-hash')).toBe(false); // still pending
  });

  // ---- apps ----

  it('createApp writes the app and an app.created event', async () => {
    await store.createAccount({ id: 'acct_test', subject: '' });
    const a = appFixture({ slug: 'my-app', framework: 'next' });
    await store.createApp(a);
    expect(await store.app('acct_test', a.id)).toEqual(a);
    const events = await store.recentEvents(10);
    expect(events[0]).toMatchObject({
      kind: EventKind.AppCreated,
      appId: a.id,
      accountId: 'acct_test',
    });
    expect(JSON.parse(events[0]!.detail)).toEqual({ slug: 'my-app', framework: 'next' });
  });

  it('app reads are account-scoped', async () => {
    const a = appFixture({ accountId: 'acct_test' });
    await store.createApp(a);
    expect(await store.app('acct_other', a.id)).toBeNull();
  });

  it('createApp rejects a duplicate client_ref within an account', async () => {
    const a = appFixture({ clientRef: 'ref-1' });
    await store.createApp(a);
    const twin = appFixture({ clientRef: 'ref-1' });
    // Partial unique index on (account_id, client_ref): losing the dedup race
    // must stay an error, not a silent second app.
    await expect(store.createApp(twin)).rejects.toThrow();
  });

  it('createApp allows many empty client_refs (partial index)', async () => {
    await store.createApp(appFixture({ clientRef: '' }));
    await store.createApp(appFixture({ clientRef: '' }));
    expect(await store.appsByAccount('acct_test')).toHaveLength(2);
  });

  it('script column is globally unique', async () => {
    await store.createApp(appFixture({ script: 'shared-host' }));
    await expect(
      store.createApp(appFixture({ id: 'app_zzz', script: 'shared-host' })),
    ).rejects.toThrow();
  });

  it('appsByFingerprint returns matches oldest first', async () => {
    const a = appFixture({ id: 'app_a', fingerprint: 'fp-1' });
    const b = appFixture({ id: 'app_b', fingerprint: 'fp-1' });
    await store.createApp(a);
    await store.createApp(b);
    const got = await store.appsByFingerprint('acct_test', 'fp-1');
    expect(got.map((x) => x.id)).toEqual(['app_a', 'app_b']);
  });

  it('appByClientRef resolves the dedup nonce', async () => {
    const a = appFixture({ clientRef: 'ref-1' });
    await store.createApp(a);
    expect((await store.appByClientRef('acct_test', 'ref-1'))?.id).toBe(a.id);
    expect(await store.appByClientRef('acct_test', 'missing')).toBeNull();
  });

  it('appByScript resolves a hostname label', async () => {
    const a = appFixture({ script: 'demo-host' });
    await store.createApp(a);
    expect((await store.appByScript('demo-host'))?.id).toBe(a.id);
    expect(await store.appByScript('unknown-host')).toBeNull();
  });

  it('setStoreId records the runtime store', async () => {
    const a = appFixture();
    await store.createApp(a);
    await store.setStoreId(a.id, 'store-xyz');
    expect((await store.app('acct_test', a.id))?.storeId).toBe('store-xyz');
  });

  it('deleteApp removes the app and its deploys, keeps events, is idempotent', async () => {
    const a = appFixture({ slug: 'to-delete' });
    await store.createApp(a);
    await store.openDeploy({
      appId: a.id,
      id: 'dep_1',
      manifest: emptyManifest,
      state: State.Uploading,
      failure: null,
    });
    expect(await store.deleteApp('acct_test', a.id)).toBe(true);
    expect(await store.app('acct_test', a.id)).toBeNull();
    expect(await store.deploy(a.id, 'dep_1')).toBeNull();
    // The history stays behind; deleting twice is not a failure.
    expect(await store.deleteApp('acct_test', a.id)).toBe(false);
    const kinds = (await store.recentEvents(50)).map((e) => e.kind);
    expect(kinds).toContain(EventKind.AppDeleted);
    expect(kinds).toContain(EventKind.AppCreated);
  });

  it('deleteApp is account-scoped', async () => {
    const a = appFixture();
    await store.createApp(a);
    expect(await store.deleteApp('acct_other', a.id)).toBe(false);
    expect(await store.app('acct_test', a.id)).not.toBeNull();
  });

  // ---- deploys ----

  it('openDeploy creates then reopens a failed deploy', async () => {
    const a = appFixture();
    await store.createApp(a);
    const d: Deploy = {
      appId: a.id,
      id: 'dep_1',
      manifest: manifestFor('a'.repeat(64)),
      state: State.Uploading,
      failure: null,
    };
    const opened = await store.openDeploy(d);
    expect(opened.state).toBe(State.Uploading);
    expect(opened.manifest.worker.digest).toBe('a'.repeat(64));

    // Fail it, then re-open: state returns to uploading and failure clears.
    await store.finishFailed(a.id, 'dep_1', {
      code: 'unavailable',
      message: 'boom',
      fix: 'run 280 push again',
      retryable: true,
      candidates: [],
    });
    let got = await store.deploy(a.id, 'dep_1');
    expect(got?.state).toBe(State.Failed);
    expect(got?.failure?.code).toBe('unavailable');

    const reopened = await store.openDeploy(d);
    expect(reopened.state).toBe(State.Uploading);
    expect(reopened.failure).toBeNull();

    // Re-opening a non-failed deploy leaves its state alone.
    got = await store.deploy(a.id, 'dep_1');
    expect(got?.state).toBe(State.Uploading);
  });

  it('openDeploys excludes terminal deploys', async () => {
    const a = appFixture();
    await store.createApp(a);
    await store.openDeploy({
      appId: a.id,
      id: 'dep_open',
      manifest: emptyManifest,
      state: State.Uploading,
      failure: null,
    });
    await store.openDeploy({
      appId: a.id,
      id: 'dep_done',
      manifest: emptyManifest,
      state: State.Uploading,
      failure: null,
    });
    await store.claimActivation(a.id, 'dep_done');
    await store.finishLive(a.id, 'dep_done');
    const open = await store.openDeploys(a.id);
    expect(open.map((d) => d.id)).toEqual(['dep_open']);
  });

  it('claimActivation moves uploading→activating for exactly one caller', async () => {
    const a = appFixture();
    await store.createApp(a);
    await store.openDeploy({
      appId: a.id,
      id: 'dep_1',
      manifest: emptyManifest,
      state: State.Uploading,
      failure: null,
    });
    const results = await Promise.all([
      store.claimActivation(a.id, 'dep_1'),
      store.claimActivation(a.id, 'dep_1'),
      store.claimActivation(a.id, 'dep_1'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.deploy(a.id, 'dep_1'))?.state).toBe(State.Activating);
    // A deploy not in uploading cannot be claimed.
    expect(await store.claimActivation(a.id, 'dep_1')).toBe(false);
  });

  it('finishLive marks live, points the app, deletes the superseded row', async () => {
    const a = appFixture();
    await store.createApp(a);
    // v1 goes live.
    await store.openDeploy({
      appId: a.id,
      id: 'dep_v1',
      manifest: manifestFor('1'.repeat(64)),
      state: State.Uploading,
      failure: null,
    });
    await store.claimActivation(a.id, 'dep_v1');
    await store.finishLive(a.id, 'dep_v1');
    expect((await store.app('acct_test', a.id))?.activeDeploy).toBe('dep_v1');
    expect((await store.deploy(a.id, 'dep_v1'))?.state).toBe(State.Live);

    // v2 goes live: the v1 row must be deleted so a revert to v1 re-activates.
    await store.openDeploy({
      appId: a.id,
      id: 'dep_v2',
      manifest: manifestFor('2'.repeat(64)),
      state: State.Uploading,
      failure: null,
    });
    await store.claimActivation(a.id, 'dep_v2');
    await store.finishLive(a.id, 'dep_v2');
    expect((await store.app('acct_test', a.id))?.activeDeploy).toBe('dep_v2');
    expect(await store.deploy(a.id, 'dep_v1')).toBeNull(); // superseded row gone
    expect((await store.deploy(a.id, 'dep_v2'))?.state).toBe(State.Live);

    const liveEvents = (await store.recentEvents(50)).filter(
      (e) => e.kind === EventKind.DeployLive,
    );
    expect(liveEvents).toHaveLength(2);
  });

  it('finishFailed records the failure and a deploy.failed event with the code only', async () => {
    const a = appFixture();
    await store.createApp(a);
    await store.openDeploy({
      appId: a.id,
      id: 'dep_1',
      manifest: emptyManifest,
      state: State.Uploading,
      failure: null,
    });
    await store.finishFailed(a.id, 'dep_1', {
      code: 'preflight_rejected',
      message: 'worker too big: /worker.js',
      fix: 'shrink the bundle',
      retryable: false,
      candidates: [],
    });
    const d = await store.deploy(a.id, 'dep_1');
    expect(d?.state).toBe(State.Failed);
    expect(d?.failure).toMatchObject({ code: 'preflight_rejected', fix: 'shrink the bundle' });
    const failed = (await store.recentEvents(50)).find((e) => e.kind === EventKind.DeployFailed);
    expect(JSON.parse(failed!.detail)).toEqual({ code: 'preflight_rejected' });
  });

  it('finishFailed with a null failure stores empty and null-decodes', async () => {
    const a = appFixture();
    await store.createApp(a);
    await store.openDeploy({
      appId: a.id,
      id: 'dep_1',
      manifest: emptyManifest,
      state: State.Uploading,
      failure: null,
    });
    await store.finishFailed(a.id, 'dep_1', null);
    const d = await store.deploy(a.id, 'dep_1');
    expect(d?.state).toBe(State.Failed);
    expect(d?.failure).toBeNull();
  });

  // ---- events ----

  it('recentEvents returns newest first and caps the page', async () => {
    await store.createAccount({ id: 'acct_test', subject: '' });
    const first = appFixture({ id: 'app_first', slug: 'first' });
    const second = appFixture({ id: 'app_second', slug: 'second' });
    await store.createApp(first);
    await store.createApp(second);
    const events = await store.recentEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: EventKind.AppCreated, appId: 'app_second' });
  });
});
