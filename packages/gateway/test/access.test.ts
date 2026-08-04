import { describe, expect, it } from 'vitest';
import type { AppPolicy, RouteGate } from '@280/contracts';
import type { Grant } from '@280/backend/seams';
import { Authorizer, resolveEffectiveGrant, type AccessReader, type ViewAs } from '../src/access.js';
import { gateForPath } from '../src/appworker.js';
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
            accessSource: p.accessSource ?? 'manifest',
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

const admit = (r: AccessReader, v: VerifiedViewer, script = 'renewals', viewAs: ViewAs | null = null) =>
  new Authorizer(r).admit({ viewer: v, script, viewAs });

// Production composes admission (DB) with the pure per-path route gate: mintForApp
// admits and snapshots the effective roles into the token, then the app Worker runs
// gateForPath against them. reach mirrors that, so a route-gate test exercises exactly
// what an admitted viewer would hit at the edge.
async function reach(
  r: AccessReader,
  v: VerifiedViewer,
  path: string,
  opts: { script?: string; viewAs?: ViewAs | null } = {},
): Promise<{ allow: boolean; viewAsApplied: boolean; effectiveAppRole: string }> {
  const script = opts.script ?? 'renewals';
  const adm = await admit(r, v, script, opts.viewAs ?? null);
  if (!adm.allow) return { allow: false, viewAsApplied: adm.viewAsApplied, effectiveAppRole: adm.effective.appRole };
  const policy = await r.appPolicy(adm.appId);
  const decision = gateForPath(
    policy?.routes ?? [],
    { appRole: adm.effective.appRole, featureRole: adm.effective.featureRole },
    path,
  );
  return { allow: decision.allow, viewAsApplied: adm.viewAsApplied, effectiveAppRole: adm.effective.appRole };
}

describe('Authorizer.admit — open access', () => {
  it('allows a viewer named directly by email', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 alice@evergreen.com': { appRole: 'viewer' } });
    expect((await admit(r, viewer('alice@evergreen.com'))).allow).toBe(true);
  });

  it('allows a viewer covered by a domain grant', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 domain:evergreen.com': { appRole: 'viewer' } });
    expect((await admit(r, viewer('anyone@evergreen.com'))).allow).toBe(true);
  });

  it('denies a viewer with no matching grant', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 domain:evergreen.com': { appRole: 'viewer' } });
    expect((await admit(r, viewer('mallory@outsider.com'))).allow).toBe(false);
  });

  it("does not treat one app's grant as access to another", async () => {
    const r = reader(
      { renewals: 'app_1', sales: 'app_2' },
      { 'app_1 domain:evergreen.com': { appRole: 'viewer' } },
    );
    expect((await admit(r, viewer('alice@evergreen.com'), 'sales')).allow).toBe(false);
  });

  it('denies when the app does not exist, identically to no grant', async () => {
    const denied = await admit(reader({}, {}), viewer('alice@evergreen.com'), 'ghost');
    const missing = await admit(reader({ renewals: 'app_1' }, {}), viewer('alice@evergreen.com'));
    expect(denied.allow).toBe(false);
    if (!denied.allow && !missing.allow) expect(denied.reason).toBe(missing.reason);
  });

  it('admits any signed-in viewer to a public app as an implicit viewer', async () => {
    const r = reader({ renewals: 'app_1' }, {}, { app_1: { access: 'public' } });
    const d = await admit(r, viewer('stranger@anywhere.com'));
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.effective.appRole).toBe('viewer');
  });

  it('a grant still wins over the implicit viewer on a public app', async () => {
    const r = reader(
      { renewals: 'app_1' },
      { 'app_1 ed@evergreen.com': { appRole: 'editor' } },
      { app_1: { access: 'public' } },
    );
    const d = await admit(r, viewer('ed@evergreen.com'));
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.effective.appRole).toBe('editor');
  });

  it('denies under the retired link value (unknown modes fail closed)', async () => {
    const r = reader({ renewals: 'app_1' }, {}, { app_1: { access: 'link' as AppPolicy['access'] } });
    expect((await admit(r, viewer('stranger@anywhere.com'))).allow).toBe(false);
  });

  it('admits only same-tenant viewers to an anyone-at-tenant app', async () => {
    const r = reader(
      { renewals: 'app_1' },
      {},
      { app_1: { access: 'anyone-at-tenant', ownerTenant: 'evergreen.com' } },
    );
    expect((await admit(r, viewer('sam@evergreen.com'))).allow).toBe(true);
    expect((await admit(r, viewer('sam@rival.com'))).allow).toBe(false);
  });

  it('never admits anyone-at-tenant on a consumer ownerTenant (gmail is not an org)', async () => {
    const r = reader(
      { renewals: 'app_1' },
      {},
      { app_1: { access: 'anyone-at-tenant', ownerTenant: 'gmail.com' } },
    );
    expect((await admit(r, viewer('sam@gmail.com'))).allow).toBe(false);
  });

  it('publicAppId answers the app id only for an effective-public policy', async () => {
    const r = reader(
      { renewals: 'app_1', sales: 'app_2' },
      {},
      { app_1: { access: 'public' }, app_2: { access: 'invited' } },
    );
    expect(await new Authorizer(r).publicAppId('renewals')).toBe('app_1');
    expect(await new Authorizer(r).publicAppId('sales')).toBe(null);
    expect(await new Authorizer(r).publicAppId('ghost')).toBe(null);
  });
});

describe('admit + route gate (no unguarded route, fail closed)', () => {
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
    expect((await reach(r, viewer('v@e.com'), '/api/export')).allow).toBe(false);
  });

  it('lets a viewer reach a viewer-gated route', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 v@e.com': { appRole: 'viewer' } }, { app_1: policy });
    expect((await reach(r, viewer('v@e.com'), '/dashboard')).allow).toBe(true);
  });

  it('denies a viewer at an admin-gated route, allows an admin', async () => {
    const r = reader(
      { renewals: 'app_1' },
      { 'app_1 v@e.com': { appRole: 'viewer' }, 'app_1 a@e.com': { appRole: 'admin' } },
      { app_1: policy },
    );
    expect((await reach(r, viewer('v@e.com'), '/admin/users')).allow).toBe(false);
    expect((await reach(r, viewer('a@e.com'), '/admin/users')).allow).toBe(true);
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
    expect((await reach(r, viewer('mgr@e.com'), '/api/approve')).allow).toBe(true);
    // An app Editor without the manager feature role cannot approve.
    expect((await reach(r, viewer('ed@e.com'), '/api/approve')).allow).toBe(false);
  });

  it('lets the owner reach everything, including undeclared routes', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 o@e.com': { appRole: 'owner' } }, { app_1: policy });
    expect((await reach(r, viewer('o@e.com'), '/api/export')).allow).toBe(true);
    expect((await reach(r, viewer('o@e.com'), '/admin/users')).allow).toBe(true);
  });

  it('keeps an app that declares no routes fully open to a grant', async () => {
    const r = reader(
      { renewals: 'app_1' },
      { 'app_1 v@e.com': { appRole: 'viewer' } },
      { app_1: { routes: [] } },
    );
    expect((await reach(r, viewer('v@e.com'), '/anything/here')).allow).toBe(true);
  });
});

describe('admit — view as', () => {
  const policy: Partial<AppPolicy> = { routes: [route('/admin/*', { appRole: 'admin' })] };

  it('lets an admin preview as a viewer, losing admin-only routes', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 a@e.com': { appRole: 'admin' } }, { app_1: policy });
    const d = await reach(r, viewer('a@e.com'), '/admin/users', {
      viewAs: { script: 'renewals', appRole: 'viewer', role: '' },
    });
    expect(d.viewAsApplied).toBe(true);
    expect(d.effectiveAppRole).toBe('viewer');
    expect(d.allow).toBe(false); // as a viewer, the admin route is now closed
  });

  it('ignores a view-as cookie from a non-admin (no privilege effect)', async () => {
    const r = reader({ renewals: 'app_1' }, { 'app_1 v@e.com': { appRole: 'viewer' } }, { app_1: policy });
    const d = await reach(r, viewer('v@e.com'), '/admin/users', {
      viewAs: { script: 'renewals', appRole: 'owner', role: '' }, // tries to escalate
    });
    expect(d.viewAsApplied).toBe(false);
    expect(d.effectiveAppRole).toBe('viewer'); // the escalation had no effect
    expect(d.allow).toBe(false);
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
