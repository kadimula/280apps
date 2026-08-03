import { describe, expect, it } from 'vitest';
import { APP_DOMAIN, AUTH_ORIGIN, cookiePair, newGateway, signIn } from './helpers.js';

const APP_ORIGIN = `https://renewals.${APP_DOMAIN}`;

const gatedPolicy = {
  appId: 'app_renewals',
  roles: ['manager'],
  routes: [
    { path: '/admin/*', appRole: 'admin', role: '' },
    { path: '/api/approve', appRole: '', role: 'manager' },
    { path: '/*', appRole: 'viewer', role: '' },
  ],
};

// The /view-as endpoint lives on the auth host. It sets a scoped preview cookie only
// for an admin (or above) on the app; the app Worker then re-checks the real role
// before honoring the cookie, so the cookie alone grants nothing (see access.test.ts
// for that enforcement, mint.test.ts for the previewed-role mint).
describe('gateway view-as endpoint', () => {
  it('sets a preview cookie for an admin and clears it on request', async () => {
    const { gateway } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'admin@evergreen.com', appRole: 'admin' }],
      policies: [gatedPolicy],
    });
    const session = await signIn(gateway, 'google', 'admin@evergreen.com');

    const set = await gateway.handle(
      new Request(`${AUTH_ORIGIN}/view-as?app=renewals&as=app:viewer&return=${encodeURIComponent(APP_ORIGIN + '/')}`, {
        headers: { cookie: session },
      }),
    );
    expect(set.status).toBe(303);
    expect(cookiePair(set, '280_view')).not.toBeNull();

    const cleared = await gateway.handle(
      new Request(`${AUTH_ORIGIN}/view-as?app=renewals&as=clear&return=${encodeURIComponent(APP_ORIGIN + '/')}`, {
        headers: { cookie: session },
      }),
    );
    expect(cleared.status).toBe(303);
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
