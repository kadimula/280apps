// Public access mode end to end at the gateway: the anonymous mint a public app's
// no-session visitors get instead of the sign-in page (its exact claim shape, no
// per-visit audit), signed-in visitors keeping their real identity and grants
// (design D3), and the fail-closed answers everywhere else.

import { describe, expect, it } from 'vitest';
import { APP_DOMAIN, ISSUER, newGateway, signIn } from './helpers.js';
import { IdentityVerifier } from '../src/identity.js';

const HOST = `renewals.${APP_DOMAIN}`;

function sessionValue(pair: string): string {
  return pair.slice(pair.indexOf('=') + 1);
}

const PUBLIC_POLICY = [{ appId: 'app_renewals', access: 'public' as const }];

describe('public app, anonymous visitor', () => {
  it('mints the anonymous identity instead of returning login', async () => {
    const { gateway, publicJwks } = await newGateway({ policies: PUBLIC_POLICY });
    const res = await gateway.mintForApp({ sessionToken: '', viewCookie: '', script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;

    const verifier = new IdentityVerifier({ publicJwks, issuer: ISSUER });
    const { user, claims } = await verifier.verify(res.token, { audience: HOST });
    expect(claims.sub).toBe('anon');
    expect(claims.email).toBe('');
    expect(claims.tenant).toBe('');
    expect(claims.name).toBe('Anonymous');
    expect(claims.anon).toBe(true);
    expect(claims.role).toBe('viewer');
    expect(claims.title).toBe('');
    expect(claims.caps).toEqual([]);
    expect(claims.scope).toEqual({});
    expect(claims.aud).toBe(HOST);
    expect(claims.app).toBe('app_renewals');
    expect(user.email).toBe('');
  });

  it('writes no per-visit audit row for anonymous mints', async () => {
    const { gateway, store } = await newGateway({ policies: PUBLIC_POLICY });
    await gateway.mintForApp({ sessionToken: '', viewCookie: '', script: 'renewals', host: HOST });
    expect(store.accessLog).toHaveLength(0);
  });

  it('still bounces to login when the app is not public', async () => {
    for (const access of ['invited', 'anyone-at-tenant'] as const) {
      const { gateway } = await newGateway({ policies: [{ appId: 'app_renewals', access }] });
      const res = await gateway.mintForApp({ sessionToken: '', viewCookie: '', script: 'renewals', host: HOST });
      expect(res.kind).toBe('login');
    }
  });

  it('still bounces to login with no policy row or an unknown script (fail closed)', async () => {
    const { gateway } = await newGateway(); // no policies seeded
    const noPolicy = await gateway.mintForApp({ sessionToken: '', viewCookie: '', script: 'renewals', host: HOST });
    expect(noPolicy.kind).toBe('login');
    const ghost = await gateway.mintForApp({ sessionToken: '', viewCookie: '', script: 'ghost', host: HOST });
    expect(ghost.kind).toBe('login');
  });

  it('an invalid (garbage) session on a public app still gets the anonymous mint', async () => {
    const { gateway, publicJwks } = await newGateway({ policies: PUBLIC_POLICY });
    const res = await gateway.mintForApp({ sessionToken: 'not-a-session', viewCookie: '', script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { claims } = await new IdentityVerifier({ publicJwks, issuer: ISSUER }).verify(res.token, { audience: HOST });
    expect(claims.anon).toBe(true);
  });
});

describe('public app, signed-in visitor (D3: no anonymizing branch)', () => {
  it('a stranger keeps their real identity at the implicit viewer role', async () => {
    const { gateway, publicJwks, store } = await newGateway({ grants: [], policies: PUBLIC_POLICY });
    const session = sessionValue(await signIn(gateway, 'google', 'stranger@anywhere.com'));
    const res = await gateway.mintForApp({ sessionToken: session, viewCookie: '', script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { user, claims } = await new IdentityVerifier({ publicJwks, issuer: ISSUER }).verify(res.token, { audience: HOST });
    expect(user.email).toBe('stranger@anywhere.com');
    expect(claims.anon).toBeUndefined();
    expect(claims.role).toBe('viewer');
    // Signed-in access on a public app is audited like any other mint.
    expect(store.accessLog.filter((e) => e.allowed)).toHaveLength(1);
  });

  it('a granted editor still edits on a public app (grants win)', async () => {
    const { gateway, publicJwks } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'ed@evergreen.com', appRole: 'editor' }],
      policies: PUBLIC_POLICY,
    });
    const session = sessionValue(await signIn(gateway, 'google', 'ed@evergreen.com'));
    const res = await gateway.mintForApp({ sessionToken: session, viewCookie: '', script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { claims } = await new IdentityVerifier({ publicJwks, issuer: ISSUER }).verify(res.token, { audience: HOST });
    expect(claims.role).toBe('editor');
  });
});

describe('anonymous identity verification rules', () => {
  it('rejects an empty email on a non-anonymous token (the relaxation is anon-only)', async () => {
    const { IdentitySigner } = await import('../src/identity.js');
    const { genSigningKey } = await import('./helpers.js');
    const { privateJwk, publicJwks, kid } = await genSigningKey();
    const signer = new IdentitySigner({ kid, privateJwk, issuer: ISSUER, ttlSecs: 120 });
    const verifier = new IdentityVerifier({ publicJwks, issuer: ISSUER });

    const noAnon = await signer.sign({ sub: 'u1', email: '', name: 'x', aud: HOST });
    await expect(verifier.verify(noAnon, { audience: HOST })).rejects.toThrow(/email/);

    const anon = await signer.sign({ sub: 'anon', email: '', name: 'Anonymous', aud: HOST, anon: true });
    const { claims } = await verifier.verify(anon, { audience: HOST });
    expect(claims.anon).toBe(true);
    expect(claims.email).toBe('');
  });
});
