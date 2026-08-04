// Gateway.mintForApp is the container-only decision service the app Worker calls over
// the service binding: it resolves the viewer from the session, decides admission
// (DB), and on success mints an identity token audience-scoped to the app host. It does
// NOT route-gate (the app Worker does that per path), so one token serves many paths.

import { describe, expect, it } from 'vitest';
import { APP_DOMAIN, ISSUER, newGateway, signIn } from './helpers.js';
import { IdentityVerifier } from '@280/contracts';

const HOST = `renewals.${APP_DOMAIN}`;

function sessionValue(pair: string): string {
  return pair.slice(pair.indexOf('=') + 1);
}

function encodeView(v: { script: string; appRole: string; role: string }): string {
  return encodeURIComponent(JSON.stringify(v));
}

describe('Gateway.mintForApp', () => {
  it('mints an audience-scoped token for an admitted viewer and audits the access', async () => {
    const { gateway, publicJwks, store } = await newGateway();
    const session = sessionValue(await signIn(gateway, 'google', 'alice@evergreen.com'));

    const res = await gateway.mintForApp({ sessionToken: session, viewCookie: '', script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    expect(res.ttlSecs).toBe(120); // the harness signer's configured TTL

    const verifier = new IdentityVerifier({ publicJwks, issuer: ISSUER });
    const { user, claims } = await verifier.verify(res.token, { audience: HOST });
    expect(user.email).toBe('alice@evergreen.com');
    expect(claims.aud).toBe(HOST);
    expect(claims.app).toBe('app_renewals');

    // A mint is the coarse "opened the app" audit event (the container-only
    // replacement for the deleted per-navigation proxy audit).
    const allowed = store.accessLog.filter((e) => e.allowed);
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!).toMatchObject({ appId: 'app_renewals', principal: 'alice@evergreen.com' });
  });

  it('returns login (no token) when there is no session', async () => {
    const { gateway } = await newGateway();
    const res = await gateway.mintForApp({ sessionToken: '', viewCookie: '', script: 'renewals', host: HOST });
    expect(res.kind).toBe('login');
    if (res.kind !== 'login') return;
    expect(res.url).toContain('/login');
    expect(res.url).toContain(`return=${encodeURIComponent(`https://${HOST}/`)}`);
  });

  it('denies a signed-in viewer with no grant and audits the denial', async () => {
    const { gateway, store } = await newGateway({ grants: [] });
    const session = sessionValue(await signIn(gateway, 'google', 'mallory@outsider.com'));
    const res = await gateway.mintForApp({ sessionToken: session, viewCookie: '', script: 'renewals', host: HOST });
    expect(res.kind).toBe('deny');
    expect(store.accessLog.filter((e) => !e.allowed)).toHaveLength(1);
  });

  it('admits without route-gating: a viewer token is minted even for an admin-gated app', async () => {
    const { gateway, publicJwks } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'alice@evergreen.com', appRole: 'viewer' }],
      policies: [{ appId: 'app_renewals', routes: [{ path: '/admin/*', appRole: 'admin', role: '' }] }],
    });
    const session = sessionValue(await signIn(gateway, 'google', 'alice@evergreen.com'));
    const res = await gateway.mintForApp({ sessionToken: session, viewCookie: '', script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { claims } = await new IdentityVerifier({ publicJwks, issuer: ISSUER }).verify(res.token, { audience: HOST });
    expect(claims.appRole).toBe('viewer');
  });

  it('applies a view-as preview from an admin, minting the previewed role', async () => {
    const { gateway, publicJwks } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'alice@evergreen.com', appRole: 'admin' }],
    });
    const session = sessionValue(await signIn(gateway, 'google', 'alice@evergreen.com'));
    const view = encodeView({ script: 'renewals', appRole: 'viewer', role: '' });
    const res = await gateway.mintForApp({ sessionToken: session, viewCookie: view, script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { claims } = await new IdentityVerifier({ publicJwks, issuer: ISSUER }).verify(res.token, { audience: HOST });
    expect(claims.appRole).toBe('viewer'); // previewed down from the real admin role
  });
});
