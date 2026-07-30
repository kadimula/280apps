import { describe, expect, it } from 'vitest';
import type { AppPolicy, RouteGate } from '@280/contracts';
import type { Grant } from '@280/backend/seams';
import { Authorizer, resolveEffectiveGrant, type AccessReader } from '../src/access.js';
import type { VerifiedViewer } from '../src/gateway.js';

// An AccessReader over fixed maps: apps by script, grants by "appId principal",
// policies by appId. Grants carry an app role (and optional feature role).
function reader(
  apps: Record<string, string>,
  grants: Record<string, { appRole: string; featureRole?: string }>,
  policies: Record<string, Partial<AppPolicy>> = {},
): AccessReader {
  return {
    async appByScript(script) {
      const id = apps[script];
      return id === undefined ? null : { id };
    },
    async grant(appId, principal): Promise<Grant | null> {
      const g = grants[`${appId} ${principal}`];
      return g === undefined
        ? null
        : {
            appId,
            principal,
            appRole: g.appRole,
            featureRole: g.featureRole ?? '',
            dataScope: null,
            grantedBy: 't',
            grantedAt: 0,
          };
    },
    async appPolicy(appId): Promise<AppPolicy | null> {
      const p = policies[appId];
      return p === undefined
        ? null
        : {
            appId,
            access: p.access ?? 'invited',
            roles: p.roles ?? [],
            routes: p.routes ?? [],
            secrets: p.secrets ?? [],
            ownerTenant: p.ownerTenant ?? '',
            updatedAt: 0,
          };
    },
  };
}

const viewer = (email: string): VerifiedViewer => {
  const at = email.lastIndexOf('@');
  return { id: 'usr_1', email, name: 'Test', tenant: at >= 0 ? email.slice(at + 1) : '' };
};

const route = (path: string, gate: Partial<RouteGate>): RouteGate => ({
  path,
  appRole: gate.appRole ?? '',
  role: gate.role ?? '',
});

const evaluate = (r: AccessReader, v: VerifiedViewer, path = '/', script = 'renewals') =>
  new Authorizer(r).evaluate({ viewer: v, script, host: `${script}.280apps.run`, path, viewAs: null });

describe('Authorizer — open access', () => {
  it('allows a viewer named directly by email', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 alice@evergreen.com': { appRole: 'viewer' } });
    expect((await evaluate(r, viewer('alice@evergreen.com'))).allow).toBe(true);
  });

  it('allows a viewer covered by a domain grant', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 domain:evergreen.com': { appRole: 'viewer' } });
    expect((await evaluate(r, viewer('anyone@evergreen.com'))).allow).toBe(true);
  });

  it('denies a viewer with no matching grant', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 domain:evergreen.com': { appRole: 'viewer' } });
    expect((await evaluate(r, viewer('mallory@outsider.com'))).allow).toBe(false);
  });

  it("does not treat one app's grant as access to another", async () => {
    const r = reader(
      { renewals: 'app_1', sales: 'app_2' },
      { 'app_1 domain:evergreen.com': { appRole: 'viewer' } },
    );
    expect((await evaluate(r, viewer('alice@evergreen.com'), '/', 'sales')).allow).toBe(false);
  });

  it('denies when the app does not exist, identically to no grant', async () => {
    const denied = await evaluate(reader({}, {}), viewer('alice@evergreen.com'), '/', 'ghost');
    const missing = await evaluate(reader({ renewals: 'app_1' }, {}), viewer('alice@evergreen.com'));
    expect(denied.allow).toBe(false);
    if (!denied.allow && !missing.allow) expect(denied.reason).toBe(missing.reason);
  });

  it('admits any signed-in viewer to a link-access app as an implicit viewer', async () => {
    const r = reader({ renewals: 'app_1' }, {}, { app_1: { access: 'link' } });
    const d = await evaluate(r, viewer('stranger@anywhere.com'));
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.effective.appRole).toBe('viewer');
  });

  it('admits only same-tenant viewers to an anyone-at-tenant app', async () => {
    const r = reader(
      { renewals: 'app_1' },
      {},
      { app_1: { access: 'anyone-at-tenant', ownerTenant: 'evergreen.com' } },
    );
    expect((await evaluate(r, viewer('sam@evergreen.com'))).allow).toBe(true);
    expect((await evaluate(r, viewer('sam@rival.com'))).allow).toBe(false);
  });
});

describe('Authorizer — route gates (no unguarded route, fail closed)', () => {
  const policy: Partial<AppPolicy> = {
    roles: ['manager'],
    routes: [
      route('/admin/*', { appRole: 'admin' }),
      route('/api/approve', { role: 'manager' }),
      route('/*', { appRole: 'viewer' }),
    ],
  };

  it('denies an undeclared route (fail closed to owner-only) even for a viewer', async () => {
    const strict: Partial<AppPolicy> = { routes: [route('/admin/*', { appRole: 'admin' })] };
    const r = reader({ renewals: 'app_1' }, { 'app_1 v@e.com': { appRole: 'viewer' } }, { app_1: strict });
    const d = await evaluate(r, viewer('v@e.com'), '/api/export');
    expect(d.allow).toBe(false);
  });

  it('lets a viewer reach a viewer-gated route', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 v@e.com': { appRole: 'viewer' } }, { app_1: policy });
    expect((await evaluate(r, viewer('v@e.com'), '/dashboard')).allow).toBe(true);
  });

  it('denies a viewer at an admin-gated route, allows an admin', async () => {
    const r = reader(
      { renewals: 'app_1' },
      { 'app_1 v@e.com': { appRole: 'viewer' }, 'app_1 a@e.com': { appRole: 'admin' } },
      { app_1: policy },
    );
    expect((await evaluate(r, viewer('v@e.com'), '/admin/users')).allow).toBe(false);
    expect((await evaluate(r, viewer('a@e.com'), '/admin/users')).allow).toBe(true);
  });

  it('gates a feature-role route on the feature role, not the app role', async () => {
    const r = reader(
      { renewals: 'app_1' },
      {
        'app_1 mgr@e.com': { appRole: 'viewer', featureRole: 'manager' },
        'app_1 ed@e.com': { appRole: 'editor' },
      },
      { app_1: policy },
    );
    expect((await evaluate(r, viewer('mgr@e.com'), '/api/approve')).allow).toBe(true);
    // An app Editor without the manager feature role cannot approve.
    expect((await evaluate(r, viewer('ed@e.com'), '/api/approve')).allow).toBe(false);
  });

  it('lets the owner reach everything, including undeclared routes', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 o@e.com': { appRole: 'owner' } }, { app_1: policy });
    expect((await evaluate(r, viewer('o@e.com'), '/api/export')).allow).toBe(true);
    expect((await evaluate(r, viewer('o@e.com'), '/admin/users')).allow).toBe(true);
  });

  it('keeps an app that declares no routes fully open to a grant', async () => {
    const r = reader(
      { renewals: 'app_1' },
      { 'app_1 v@e.com': { appRole: 'viewer' } },
      { app_1: { routes: [] } },
    );
    expect((await evaluate(r, viewer('v@e.com'), '/anything/here')).allow).toBe(true);
  });
});

describe('Authorizer — view as', () => {
  const policy: Partial<AppPolicy> = { routes: [route('/admin/*', { appRole: 'admin' })] };

  it('lets an admin preview as a viewer, losing admin-only routes', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 a@e.com': { appRole: 'admin' } }, { app_1: policy });
    const d = await new Authorizer(r).evaluate({
      viewer: viewer('a@e.com'),
      script: 'renewals',
      host: 'renewals.280apps.run',
      path: '/admin/users',
      viewAs: { script: 'renewals', appRole: 'viewer', role: '' },
    });
    expect(d.allow).toBe(false); // as a viewer, the admin route is now closed
  });

  it('ignores a view-as cookie from a non-admin (no privilege effect)', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 v@e.com': { appRole: 'viewer' } }, { app_1: policy });
    const d = await new Authorizer(r).evaluate({
      viewer: viewer('v@e.com'),
      script: 'renewals',
      host: 'renewals.280apps.run',
      path: '/admin/users',
      viewAs: { script: 'renewals', appRole: 'owner', role: '' }, // tries to escalate
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.viewAsApplied).toBe(false);
  });

  it('viewAsAllowed authorizes only admin and above', async () => {
    const r = reader(
      { renewals: 'app_1' },
      { 'app_1 a@e.com': { appRole: 'admin' }, 'app_1 v@e.com': { appRole: 'viewer' } },
    );
    const authz = new Authorizer(r);
    expect(await authz.viewAsAllowed('renewals', 'a@e.com')).toBe('app_1');
    expect(await authz.viewAsAllowed('renewals', 'v@e.com')).toBeNull();
  });
});

describe('resolveEffectiveGrant', () => {
  it('takes the higher app role and the direct feature role', async () => {
    const r = reader(
      { renewals: 'app_1' },
      {
        'app_1 alice@e.com': { appRole: 'editor', featureRole: 'manager' },
        'app_1 domain:e.com': { appRole: 'viewer' },
      },
    );
    const eff = await resolveEffectiveGrant(r, 'app_1', 'alice@e.com');
    expect(eff.appRole).toBe('editor');
    expect(eff.featureRole).toBe('manager');
  });
});
