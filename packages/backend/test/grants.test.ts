// One grants suite run against both stores behind the seam: the in-memory store
// always (so coverage holds without a database) and the real Postgres store when
// TEST_DATABASE_URL is set. The asserted behavior must hold whatever backs it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppRole, type App, type Grant, type Store } from '../src/seams.js';
import { MemoryStore } from './helpers/memory-store.js';
import { hasDatabase, newStore } from './pg.js';

const now = () => Math.floor(Date.now() / 1000);

let appSeq = 0;
function appFixture(over: Partial<App> = {}): App {
  appSeq++;
  return {
    id: over.id ?? `app_${appSeq.toString(16).padStart(12, '0')}`,
    userId: over.userId ?? 'usr_test',
    slug: over.slug ?? 'demo',
    framework: over.framework ?? 'static',
    url: over.url ?? `https://demo-${appSeq}.280apps.run`,
    script: over.script ?? `demo-${appSeq}`,
    salt: over.salt ?? 'salt',
    fingerprint: over.fingerprint ?? '',
    clientRef: over.clientRef ?? '',
    storeId: over.storeId ?? '',
    activeDeploy: over.activeDeploy ?? '',
    createdAt: over.createdAt ?? 0,
    lastDeployAt: over.lastDeployAt ?? null,
  };
}

function grantFixture(over: Partial<Grant> = {}): Grant {
  return {
    appId: over.appId ?? 'app_grant',
    principal: over.principal ?? 'alice@firm.com',
    appRole: over.appRole ?? AppRole.Editor,
    featureRole: over.featureRole ?? '',
    dataScope: over.dataScope === undefined ? null : over.dataScope,
    grantedBy: over.grantedBy ?? 'owner@firm.com',
    grantedAt: over.grantedAt ?? now(),
  };
}

type StoreFactory = () => Promise<{ store: Store; cleanup: () => Promise<void> }>;

function grantSuite(name: string, makeStore: StoreFactory, skip: boolean) {
  describe.skipIf(skip)(name, () => {
    let store: Store;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ store, cleanup } = await makeStore());
    });
    afterEach(async () => {
      await cleanup();
    });

    it('putGrant then grant reads every field back', async () => {
      const g = grantFixture({
        appRole: AppRole.Admin,
        featureRole: 'manager',
        dataScope: { kind: 'team', value: 'emea' },
        grantedAt: 1000,
      });
      await store.putGrant(g);
      expect(await store.grant(g.appId, g.principal)).toEqual(g);
    });

    it('grant returns null for a principal with no grant', async () => {
      expect(await store.grant('app_grant', 'ghost@firm.com')).toBeNull();
    });

    it('putGrant upserts on (app_id, principal): re-sharing replaces the role', async () => {
      await store.putGrant(grantFixture({ appRole: AppRole.Viewer, grantedAt: 1000 }));
      await store.putGrant(
        grantFixture({
          appRole: AppRole.Admin,
          featureRole: 'manager',
          grantedBy: 'it@firm.com',
          grantedAt: 2000,
        }),
      );
      const got = await store.grant('app_grant', 'alice@firm.com');
      expect(got).toMatchObject({
        appRole: AppRole.Admin,
        featureRole: 'manager',
        grantedBy: 'it@firm.com',
        grantedAt: 2000,
      });
      // Upsert, not a second row.
      expect(await store.grantsByApp('app_grant')).toHaveLength(1);
    });

    it('grantsByApp lists an app grants oldest-first and is app-scoped', async () => {
      await store.putGrant(grantFixture({ principal: 'b@firm.com', grantedAt: 200 }));
      await store.putGrant(grantFixture({ principal: 'a@firm.com', grantedAt: 100 }));
      // A grant on another app must not leak into this app's list.
      await store.putGrant(grantFixture({ appId: 'app_other', principal: 'c@firm.com', grantedAt: 50 }));
      const got = await store.grantsByApp('app_grant');
      expect(got.map((x) => x.principal)).toEqual(['a@firm.com', 'b@firm.com']);
    });

    it('grantsByApp returns [] for an app with no grants', async () => {
      expect(await store.grantsByApp('app_empty')).toEqual([]);
    });

    it('revokeGrant removes the grant and is idempotent', async () => {
      await store.putGrant(grantFixture());
      expect(await store.revokeGrant('app_grant', 'alice@firm.com')).toBe(true);
      expect(await store.grant('app_grant', 'alice@firm.com')).toBeNull();
      // Revoking access that is already gone is not a failure.
      expect(await store.revokeGrant('app_grant', 'alice@firm.com')).toBe(false);
    });

    it('the two tiers are independent: an app Editor can hold a feature role', async () => {
      await store.putGrant(grantFixture({ appRole: AppRole.Editor, featureRole: 'manager' }));
      const g = await store.grant('app_grant', 'alice@firm.com');
      expect(g?.appRole).toBe(AppRole.Editor);
      expect(g?.featureRole).toBe('manager');
    });

    it('feature_role defaults to empty when a principal holds only an app role', async () => {
      await store.putGrant(grantFixture({ appRole: AppRole.Viewer }));
      expect((await store.grant('app_grant', 'alice@firm.com'))?.featureRole).toBe('');
    });

    it('a domain principal is stored like any other', async () => {
      await store.putGrant(grantFixture({ principal: 'domain:firm.com', appRole: AppRole.Viewer }));
      expect((await store.grant('app_grant', 'domain:firm.com'))?.appRole).toBe(AppRole.Viewer);
    });

    it('data_scope round-trips: an object survives, unset reads back null', async () => {
      await store.putGrant(grantFixture({ principal: 'scoped@firm.com', dataScope: { region: ['emea', 'us'] } }));
      await store.putGrant(grantFixture({ principal: 'plain@firm.com', dataScope: null }));
      expect((await store.grant('app_grant', 'scoped@firm.com'))?.dataScope).toEqual({
        region: ['emea', 'us'],
      });
      expect((await store.grant('app_grant', 'plain@firm.com'))?.dataScope).toBeNull();
    });

    it('deleteApp drops the app grants', async () => {
      const app = appFixture();
      await store.createApp(app);
      await store.putGrant(grantFixture({ appId: app.id, principal: 'alice@firm.com' }));
      await store.putGrant(grantFixture({ appId: app.id, principal: 'bob@firm.com' }));
      expect(await store.grantsByApp(app.id)).toHaveLength(2);

      expect(await store.deleteApp(app.userId, app.id)).toBe(true);
      // A re-created app id must inherit no access from the deleted app.
      expect(await store.grantsByApp(app.id)).toEqual([]);
    });
  });
}

grantSuite('grants (memory)', async () => ({ store: new MemoryStore(), cleanup: async () => {} }), false);
grantSuite('grants (postgres)', newStore, !hasDatabase());
