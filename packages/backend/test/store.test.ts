// Store tests, run against real Postgres with a schema per test. Behavior spec:
// platform/internal/store/store.go. The claims that matter are the ones a
// pure-logic port can silently break: conditional-UPDATE winner counts, the
// partial unique indexes, ON CONFLICT reopen, and the FinishLive superseded-row
// delete.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from '@280/contracts';
import { State } from '@280/contracts';
import type { App, Deploy, DeviceCode, PreviewGrant, Store } from '../src/seams.js';
import { DeviceStatus, EventKind } from '../src/seams.js';
import { hasDatabase, newStore } from './pg.js';

const emptyManifest: Manifest = {
  kind: 'container',
  build: { builder: '', dockerfile: '', port: 0 },
  files: [],
};

function manifestFor(dockerfileDigest: string, size = 6): Manifest {
  return {
    kind: 'container',
    build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
    files: [{ path: 'Dockerfile', digest: dockerfileDigest, size }],
  };
}

let seq = 0;
function appFixture(over: Partial<App> = {}): App {
  seq++;
  return {
    id: over.id ?? `app_${seq.toString(16).padStart(12, '0')}`,
    userId: over.userId ?? 'usr_test',
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
  let schema: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ store, schema, cleanup } = await newStore());
  });
  afterEach(async () => {
    await cleanup();
  });

  it('re-running migrations on an already-migrated schema is a no-op', async () => {
    // no schema version table; every migration statement is idempotent, so a
    // second Open on the same schema must succeed
    const base = process.env.TEST_DATABASE_URL as string;
    const { open } = await import('../src/store/store.js');
    const schema = `t_mig_${process.pid}_${Date.now()}`;
    const admin = new (await import('pg')).default.Client({ connectionString: base });
    await admin.connect();
    try {
      const first = await open(base, schema);
      await first.createUser({ id: 'usr_mig', email: 'mig@example.com', name: 'Mig', image: '' });
      await first.close();
      // re-open: migrations run again against a populated schema, data intact
      const second = await open(base, schema);
      expect(await second.userById('usr_mig')).toEqual({
        id: 'usr_mig',
        email: 'mig@example.com',
        name: 'Mig',
        image: '',
      });
      await second.close();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('userByToken joins tokens to users', async () => {
    await store.createUser({ id: 'usr_1', email: 'u1@example.com', name: 'U1', image: '' });
    await store.addToken('usr_1', 'hash-1');
    const u = await store.userByToken('hash-1', 0);
    expect(u).toEqual({ id: 'usr_1', email: 'u1@example.com', name: 'U1', image: '' });
    expect(await store.userByToken('nope', 0)).toBeNull();
  });

  it('userByToken rejects a token created at or before the cutoff', async () => {
    await store.createUser({ id: 'usr_1', email: 'u1@example.com', name: 'U1', image: '' });
    await store.addToken('usr_1', 'hash-1'); // created_at defaults to ~now
    const t = now();
    // A cutoff in the future is past the token's created_at: expired, so null.
    expect(await store.userByToken('hash-1', t + 3600)).toBeNull();
    // A cutoff in the past leaves it valid.
    expect((await store.userByToken('hash-1', t - 3600))?.id).toBe('usr_1');
  });

  it('addToken is idempotent on token hash', async () => {
    await store.createUser({ id: 'usr_1', email: 'u1@example.com', name: '', image: '' });
    await store.addToken('usr_1', 'hash-1');
    await store.addToken('usr_1', 'hash-1'); // ON CONFLICT DO NOTHING
    expect((await store.userByToken('hash-1', 0))?.id).toBe('usr_1');
  });

  function deviceFixture(over: Partial<DeviceCode> = {}): DeviceCode {
    return {
      deviceHash: over.deviceHash ?? 'dev-hash',
      userCode: over.userCode ?? 'ABCD-1234',
      userId: over.userId ?? '',
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
      userId: '',
      status: DeviceStatus.Pending,
    });
    expect(await store.deviceCodeByHash('missing')).toBeNull();
  });

  it('approveDeviceCode binds a pending code and reports true once', async () => {
    await store.createDeviceCode(deviceFixture());
    expect(await store.approveDeviceCode('ABCD-1234', 'usr_1', now())).toBe(true);
    const d = await store.deviceCodeByHash('dev-hash');
    expect(d?.status).toBe(DeviceStatus.Approved);
    expect(d?.userId).toBe('usr_1');
    // a replayed approval on an already-approved code cannot re-open it
    expect(await store.approveDeviceCode('ABCD-1234', 'usr_1', now())).toBe(false);
  });

  it('approveDeviceCode is false for unknown, expired, or claimed codes', async () => {
    expect(await store.approveDeviceCode('NOPE-0000', 'usr_1', now())).toBe(false);
    await store.createDeviceCode(
      deviceFixture({ deviceHash: 'expired', userCode: 'EXPD-0001', expiresAt: now() - 1 }),
    );
    expect(await store.approveDeviceCode('EXPD-0001', 'usr_1', now())).toBe(false);
  });

  it('claimDeviceCode lets exactly one caller win', async () => {
    await store.createDeviceCode(deviceFixture());
    await store.approveDeviceCode('ABCD-1234', 'usr_1', now());

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

  function previewGrantFixture(over: Partial<PreviewGrant> = {}): PreviewGrant {
    return {
      tokenHash: over.tokenHash ?? 'pv-hash',
      appId: over.appId ?? 'app_pv',
      ownerUserId: over.ownerUserId ?? 'usr_owner',
      viewAs: over.viewAs ?? { kind: 'user', email: 'target@firm.com' },
      expiresAt: over.expiresAt ?? now() + 600,
      revoked: over.revoked ?? false,
    };
  }

  it('createPreviewGrant round-trips the view-as target by hash', async () => {
    await store.createPreviewGrant(previewGrantFixture());
    const g = await store.previewGrantByHash('pv-hash');
    expect(g).toMatchObject({
      tokenHash: 'pv-hash',
      appId: 'app_pv',
      ownerUserId: 'usr_owner',
      viewAs: { kind: 'user', email: 'target@firm.com' },
      revoked: false,
    });
    expect(await store.previewGrantByHash('missing')).toBeNull();
  });

  it('revokePreviewGrant kills a grant exactly once', async () => {
    await store.createPreviewGrant(previewGrantFixture());
    expect(await store.revokePreviewGrant('pv-hash')).toBe(true);
    expect((await store.previewGrantByHash('pv-hash'))?.revoked).toBe(true);
    expect(await store.revokePreviewGrant('pv-hash')).toBe(false); // already revoked
    expect(await store.revokePreviewGrant('missing')).toBe(false);
  });

  it('deleteExpired sweeps lapsed preview grants', async () => {
    const t = now();
    await store.createPreviewGrant(previewGrantFixture({ tokenHash: 'pv-old', expiresAt: t - 1 }));
    await store.createPreviewGrant(previewGrantFixture({ tokenHash: 'pv-new', expiresAt: t + 600 }));
    expect(await store.deleteExpired(t, 90 * 24 * 60 * 60)).toMatchObject({ previewGrants: 1 });
    expect(await store.previewGrantByHash('pv-old')).toBeNull();
    expect(await store.previewGrantByHash('pv-new')).not.toBeNull();
  });

  it('deleteExpired removes only lapsed sessions, device codes, and rate windows', async () => {
    const t = now();
    await store.createUser({ id: 'usr_exp', email: 'exp@example.com', name: '', image: '' });
    await store.createSession({ tokenHash: 'sess_old', userId: 'usr_exp', expiresAt: t - 1 });
    await store.createSession({ tokenHash: 'sess_new', userId: 'usr_exp', expiresAt: t + 3600 });
    await store.createDeviceCode(
      deviceFixture({ deviceHash: 'dc_old', userCode: 'OLDX-0001', expiresAt: t - 1 }),
    );
    await store.createDeviceCode(
      deviceFixture({ deviceHash: 'dc_new', userCode: 'NEWX-0002', expiresAt: t + 3600 }),
    );
    // touchLoginRate stores expires_at = start + window: the first window lapsed
    // before now, the second is current.
    await store.touchLoginRate('ip_old', t - 1000, 1, 100);
    await store.touchLoginRate('ip_new', t, 600, 100);

    const ttl = 90 * 24 * 60 * 60;
    expect(await store.deleteExpired(t, ttl)).toEqual({ sessions: 1, deviceCodes: 1, rateLimits: 1, tokens: 0, previewGrants: 0 });

    expect(await store.sessionByHash('sess_old')).toBeNull();
    expect(await store.sessionByHash('sess_new')).not.toBeNull();
    expect(await store.deviceCodeByHash('dc_old')).toBeNull();
    expect(await store.deviceCodeByHash('dc_new')).not.toBeNull();
    // a second sweep with nothing left to expire removes nothing
    expect(await store.deleteExpired(t, ttl)).toEqual({ sessions: 0, deviceCodes: 0, rateLimits: 0, tokens: 0, previewGrants: 0 });
  });

  it('deleteExpired removes only machine tokens created past the ttl', async () => {
    const t = now();
    const ttl = 90 * 24 * 60 * 60;
    await store.createUser({ id: 'usr_tok', email: 'tok@example.com', name: '', image: '' });
    await store.addToken('usr_tok', 'tok_old');
    await store.addToken('usr_tok', 'tok_new');
    // Backdate one token past the ttl; created_at is not a seam parameter, so the
    // test sets it directly, mirroring an aged production row.
    const admin = new (await import('pg')).default.Client({
      connectionString: process.env.TEST_DATABASE_URL as string,
    });
    await admin.connect();
    try {
      await admin.query(`UPDATE "${schema}".tokens SET created_at = $1 WHERE token_hash = 'tok_old'`, [
        t - ttl - 1,
      ]);
    } finally {
      await admin.end();
    }

    expect(await store.deleteExpired(t, ttl)).toMatchObject({ tokens: 1 });
    expect(await store.userByToken('tok_old', 0)).toBeNull();
    expect((await store.userByToken('tok_new', t - ttl))?.id).toBe('usr_tok');
    // idempotent: nothing left past the ttl
    expect(await store.deleteExpired(t, ttl)).toMatchObject({ tokens: 0 });
  });

  it('createApp writes the app and an app.created event', async () => {
    const a = appFixture({ slug: 'my-app', framework: 'next' });
    await store.createApp(a);
    expect(await store.app('usr_test', a.id)).toEqual(a);
    const events = await store.recentEvents(10);
    expect(events[0]).toMatchObject({
      kind: EventKind.AppCreated,
      appId: a.id,
      userId: 'usr_test',
    });
    expect(JSON.parse(events[0]!.detail)).toEqual({ slug: 'my-app', framework: 'next' });
  });

  it('app reads are account-scoped', async () => {
    const a = appFixture({ userId: 'usr_test' });
    await store.createApp(a);
    expect(await store.app('usr_other', a.id)).toBeNull();
  });

  it('createApp rejects a duplicate client_ref within an account', async () => {
    const a = appFixture({ clientRef: 'ref-1' });
    await store.createApp(a);
    const twin = appFixture({ clientRef: 'ref-1' });
    // partial unique index on (account_id, client_ref): losing the dedup race
    // must stay an error, not a silent second app
    await expect(store.createApp(twin)).rejects.toThrow();
  });

  it('createApp allows many empty client_refs (partial index)', async () => {
    await store.createApp(appFixture({ clientRef: '' }));
    await store.createApp(appFixture({ clientRef: '' }));
    expect(await store.appsByUser('usr_test')).toHaveLength(2);
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
    const got = await store.appsByFingerprint('usr_test', 'fp-1');
    expect(got.map((x) => x.id)).toEqual(['app_a', 'app_b']);
  });

  it('appByClientRef resolves the dedup nonce', async () => {
    const a = appFixture({ clientRef: 'ref-1' });
    await store.createApp(a);
    expect((await store.appByClientRef('usr_test', 'ref-1'))?.id).toBe(a.id);
    expect(await store.appByClientRef('usr_test', 'missing')).toBeNull();
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
    expect((await store.app('usr_test', a.id))?.storeId).toBe('store-xyz');
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
    expect(await store.deleteApp('usr_test', a.id)).toBe(true);
    expect(await store.app('usr_test', a.id)).toBeNull();
    expect(await store.deploy(a.id, 'dep_1')).toBeNull();
    // the history stays behind; deleting twice is not a failure
    expect(await store.deleteApp('usr_test', a.id)).toBe(false);
    const kinds = (await store.recentEvents(50)).map((e) => e.kind);
    expect(kinds).toContain(EventKind.AppDeleted);
    expect(kinds).toContain(EventKind.AppCreated);
  });

  it('deleteApp is account-scoped', async () => {
    const a = appFixture();
    await store.createApp(a);
    expect(await store.deleteApp('usr_other', a.id)).toBe(false);
    expect(await store.app('usr_test', a.id)).not.toBeNull();
  });

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
    expect(opened.manifest.files[0]!.digest).toBe('a'.repeat(64));

    // fail it, then re-open: state returns to uploading and failure clears
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

    // re-opening a non-failed deploy leaves its state alone
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
    // a deploy not in uploading cannot be claimed
    expect(await store.claimActivation(a.id, 'dep_1')).toBe(false);
  });

  it('finishLive marks live, points the app, deletes the superseded row', async () => {
    const a = appFixture();
    await store.createApp(a);
    await store.openDeploy({
      appId: a.id,
      id: 'dep_v1',
      manifest: manifestFor('1'.repeat(64)),
      state: State.Uploading,
      failure: null,
    });
    await store.claimActivation(a.id, 'dep_v1');
    await store.finishLive(a.id, 'dep_v1');
    expect((await store.app('usr_test', a.id))?.activeDeploy).toBe('dep_v1');
    expect((await store.deploy(a.id, 'dep_v1'))?.state).toBe(State.Live);

    // v2 goes live: the v1 row must be deleted so a revert to v1 re-activates
    await store.openDeploy({
      appId: a.id,
      id: 'dep_v2',
      manifest: manifestFor('2'.repeat(64)),
      state: State.Uploading,
      failure: null,
    });
    await store.claimActivation(a.id, 'dep_v2');
    await store.finishLive(a.id, 'dep_v2');
    expect((await store.app('usr_test', a.id))?.activeDeploy).toBe('dep_v2');
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

  it('recentEvents returns newest first and caps the page', async () => {
    const first = appFixture({ id: 'app_first', slug: 'first' });
    const second = appFixture({ id: 'app_second', slug: 'second' });
    await store.createApp(first);
    await store.createApp(second);
    const events = await store.recentEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: EventKind.AppCreated, appId: 'app_second' });
  });
});
