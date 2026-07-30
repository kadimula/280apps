import { describe, expect, it } from 'vitest';
import { APP_DOMAIN, AUTH_ORIGIN, cookiePair, newGateway, signIn, type UpstreamEcho } from './helpers.js';

const APP_ORIGIN = `https://renewals.${APP_DOMAIN}`;

// A policy that gates /admin/* to app admins and /api/approve to the manager
// feature role, and opens the rest to viewers via a catch-all.
const gatedPolicy = {
  appId: 'app_renewals',
  roles: ['manager'],
  routes: [
    { path: '/admin/*', appRole: 'admin', role: '' },
    { path: '/api/approve', appRole: '', role: 'manager' },
    { path: '/*', appRole: 'viewer', role: '' },
  ],
};

async function body(res: Response): Promise<UpstreamEcho> {
  return (await res.json()) as UpstreamEcho;
}

// A document navigation, so the access audit records it.
function nav(url: string, cookie: string): Request {
  return new Request(url, { headers: { cookie, 'sec-fetch-dest': 'document' } });
}

describe('gateway route gates (end to end)', () => {
  it('denies an undeclared route to a viewer (fail closed) and never proxies', async () => {
    const { gateway, containers } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'domain:evergreen.com', appRole: 'viewer' }],
      policies: [{ appId: 'app_renewals', routes: [{ path: '/admin/*', appRole: 'admin', role: '' }] }],
    });
    const session = await signIn(gateway, 'google', 'v@evergreen.com');
    const res = await gateway.handle(nav(`${APP_ORIGIN}/api/export`, session));
    expect(res.status).toBe(403);
    expect(containers.calls).toEqual([]);
  });

  it('lets a viewer reach a viewer route but not an admin route', async () => {
    const { gateway, containers } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'domain:evergreen.com', appRole: 'viewer' }],
      policies: [gatedPolicy],
    });
    const session = await signIn(gateway, 'google', 'v@evergreen.com');
    expect((await gateway.handle(nav(`${APP_ORIGIN}/dashboard`, session))).status).toBe(200);
    expect((await gateway.handle(nav(`${APP_ORIGIN}/admin/users`, session))).status).toBe(403);
    expect(containers.calls).toEqual(['renewals']); // only the allowed one proxied
  });

  it('gates /api/approve on the manager feature role and mints it into the identity', async () => {
    const { gateway, verifier } = await newGateway({
      grants: [
        { appId: 'app_renewals', principal: 'mgr@evergreen.com', appRole: 'viewer', featureRole: 'manager' },
      ],
      policies: [gatedPolicy],
    });
    const session = await signIn(gateway, 'google', 'mgr@evergreen.com');
    const res = await gateway.handle(nav(`${APP_ORIGIN}/api/approve`, session));
    expect(res.status).toBe(200);
    const { claims } = await verifier.verify((await body(res)).identity!, { audience: `renewals.${APP_DOMAIN}` });
    expect(claims.role).toBe('manager');
    expect(claims.caps).toEqual(['manager']);
    expect(claims.appRole).toBe('viewer');
  });
});

describe('gateway view-as (end to end)', () => {
  it('an admin previews as viewer and loses the admin route until cleared', async () => {
    const { gateway } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'admin@evergreen.com', appRole: 'admin' }],
      policies: [gatedPolicy],
    });
    const session = await signIn(gateway, 'google', 'admin@evergreen.com');
    // Without a preview, the admin reaches /admin/*.
    expect((await gateway.handle(nav(`${APP_ORIGIN}/admin/users`, session))).status).toBe(200);

    // Set the preview via the auth host, then carry the cookie with the session.
    const set = await gateway.handle(
      new Request(`${AUTH_ORIGIN}/view-as?app=renewals&as=app:viewer&return=${encodeURIComponent(APP_ORIGIN + '/')}`, {
        headers: { cookie: session },
      }),
    );
    expect(set.status).toBe(303);
    const viewCookie = cookiePair(set, '280_view');
    expect(viewCookie).not.toBeNull();

    const previewed = await gateway.handle(nav(`${APP_ORIGIN}/admin/users`, `${session}; ${viewCookie}`));
    expect(previewed.status).toBe(403);

    // Clearing restores the admin's own view.
    const cleared = await gateway.handle(
      new Request(`${AUTH_ORIGIN}/view-as?app=renewals&as=clear&return=${encodeURIComponent(APP_ORIGIN + '/')}`, {
        headers: { cookie: session },
      }),
    );
    expect(cookiePair(cleared, '280_view')).toBe('280_view=');
  });

  it('refuses to set a preview for a non-admin viewer', async () => {
    const { gateway } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'domain:evergreen.com', appRole: 'viewer' }],
      policies: [gatedPolicy],
    });
    const session = await signIn(gateway, 'google', 'v@evergreen.com');
    const res = await gateway.handle(
      new Request(`${AUTH_ORIGIN}/view-as?app=renewals&as=app:owner&return=${encodeURIComponent(APP_ORIGIN + '/')}`, {
        headers: { cookie: session },
      }),
    );
    expect(res.status).toBe(403);
    expect(cookiePair(res, '280_view')).toBeNull();
  });
});

describe('gateway access audit', () => {
  it('records an allowed navigation and a denial', async () => {
    const { gateway, store } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'domain:evergreen.com', appRole: 'viewer' }],
      policies: [gatedPolicy],
    });
    const session = await signIn(gateway, 'google', 'v@evergreen.com');
    await gateway.handle(nav(`${APP_ORIGIN}/dashboard`, session)); // allowed
    await gateway.handle(nav(`${APP_ORIGIN}/admin/users`, session)); // denied

    const allowed = store.accessLog.filter((e) => e.allowed);
    const denied = store.accessLog.filter((e) => !e.allowed);
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!.principal).toBe('v@evergreen.com');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.appId).toBe('app_renewals');
  });

  it('does not audit a subresource fetch as a page open', async () => {
    const { gateway, store } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'domain:evergreen.com', appRole: 'viewer' }],
      policies: [{ appId: 'app_renewals', routes: [] }],
    });
    const session = await signIn(gateway, 'google', 'v@evergreen.com');
    // A script/asset request (sec-fetch-dest != document) is allowed but not logged.
    await gateway.handle(
      new Request(`${APP_ORIGIN}/app.js`, { headers: { cookie: session, 'sec-fetch-dest': 'script' } }),
    );
    expect(store.accessLog.filter((e) => e.allowed)).toHaveLength(0);
  });
});
