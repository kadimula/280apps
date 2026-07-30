import { describe, expect, it } from 'vitest';
import { APP_DOMAIN, AUTH_ORIGIN, cookiePair, newGateway, signIn, type UpstreamEcho } from './helpers.js';

const APP_ORIGIN = `https://renewals.${APP_DOMAIN}`;

async function echoBody(res: Response): Promise<UpstreamEcho> {
  return (await res.json()) as UpstreamEcho;
}

describe('gateway request flow', () => {
  it('bounces an unauthenticated app visitor to the login host, carrying the return URL', async () => {
    const { gateway } = await newGateway();
    const res = await gateway.handle(new Request(`${APP_ORIGIN}/renewals?q=1`));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.origin).toBe(AUTH_ORIGIN);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('return')).toBe(`${APP_ORIGIN}/renewals?q=1`);
  });

  it('proxies an invited viewer to the app container with a valid signed identity', async () => {
    const { gateway, verifier, containers } = await newGateway();
    const session = await signIn(gateway, 'google', 'alice@evergreen.com');

    const res = await gateway.handle(new Request(`${APP_ORIGIN}/`, { headers: { cookie: session } }));
    expect(res.status).toBe(200);
    const body = await echoBody(res);
    expect(body.upstream).toBe('container');
    expect(body.host).toBe(`renewals.${APP_DOMAIN}`);
    expect(containers.calls).toEqual(['renewals']);

    // The container received the header; it verifies offline, exactly as an app would.
    const { user, claims } = await verifier.verify(body.identity!, { audience: `renewals.${APP_DOMAIN}` });
    expect(user.email).toBe('alice@evergreen.com');
    expect(user.tenant).toBe('evergreen.com');
    expect(claims.aud).toBe(`renewals.${APP_DOMAIN}`);
  });

  it('lets an invited viewer in on a direct email grant (not only a domain grant)', async () => {
    const { gateway, verifier, containers } = await newGateway({
      grants: [{ appId: 'app_renewals', principal: 'carol@outside.com' }],
    });
    const session = await signIn(gateway, 'google', 'carol@outside.com');

    const res = await gateway.handle(new Request(`${APP_ORIGIN}/`, { headers: { cookie: session } }));
    expect(res.status).toBe(200);
    expect(containers.calls).toEqual(['renewals']);
    const { user } = await verifier.verify((await echoBody(res)).identity!, { audience: `renewals.${APP_DOMAIN}` });
    expect(user.email).toBe('carol@outside.com');
  });

  it('denies a signed-in viewer with no grant and never proxies to the container', async () => {
    const { gateway, containers } = await newGateway({ grants: [] });
    const session = await signIn(gateway, 'google', 'mallory@outsider.com');

    const res = await gateway.handle(new Request(`${APP_ORIGIN}/`, { headers: { cookie: session } }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('access');
    expect(containers.calls).toEqual([]);
  });

  it('denies identically when the app does not exist, so existence is not probeable', async () => {
    const { gateway, containers } = await newGateway();
    const session = await signIn(gateway, 'google', 'alice@evergreen.com', `https://ghost.${APP_DOMAIN}/`);

    const res = await gateway.handle(new Request(`https://ghost.${APP_DOMAIN}/`, { headers: { cookie: session } }));
    expect(res.status).toBe(403);
    expect(containers.calls).toEqual([]);
  });

  it('works identically through Microsoft Entra (one code path)', async () => {
    const { gateway, verifier } = await newGateway();
    const session = await signIn(gateway, 'microsoft', 'bob@contoso.com');

    const res = await gateway.handle(new Request(`${APP_ORIGIN}/`, { headers: { cookie: session } }));
    expect(res.status).toBe(200);
    const { user } = await verifier.verify((await echoBody(res)).identity!, { audience: `renewals.${APP_DOMAIN}` });
    expect(user.email).toBe('bob@contoso.com');
    expect(user.tenant).toBe('contoso.com');
  });

  it('strips a client-supplied identity header so a viewer cannot spoof identity', async () => {
    const { gateway, verifier } = await newGateway();
    const session = await signIn(gateway, 'google', 'alice@evergreen.com');

    const res = await gateway.handle(
      new Request(`${APP_ORIGIN}/`, {
        headers: { cookie: session, 'x-280-identity': 'forged', 'x-280-user': 'admin@evergreen.com' },
      }),
    );
    const body = await echoBody(res);
    expect(body.identity).not.toBe('forged');
    // The forwarded header is the gateway's genuine one.
    const { user } = await verifier.verify(body.identity!, { audience: `renewals.${APP_DOMAIN}` });
    expect(user.email).toBe('alice@evergreen.com');
  });

  it('binds the identity to the app host it was minted for', async () => {
    const { gateway, verifier } = await newGateway();
    const session = await signIn(gateway, 'google', 'alice@evergreen.com', `https://sales.${APP_DOMAIN}/`);
    const res = await gateway.handle(new Request(`https://sales.${APP_DOMAIN}/`, { headers: { cookie: session } }));
    const body = await echoBody(res);
    // A header minted for sales.* must not verify as sales' neighbour.
    await expect(
      verifier.verify(body.identity!, { audience: `renewals.${APP_DOMAIN}` }),
    ).rejects.toThrow(/audience/);
    await expect(verifier.verify(body.identity!, { audience: `sales.${APP_DOMAIN}` })).resolves.toBeTruthy();
  });

  it('lists both providers on the login page', async () => {
    const { gateway } = await newGateway();
    const res = await gateway.handle(new Request(`${AUTH_ORIGIN}/login?return=${encodeURIComponent(APP_ORIGIN + '/')}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/auth/google/start');
    expect(html).toContain('/auth/microsoft/start');
  });

  it('serves the public JWKS for verifiers', async () => {
    const { gateway, publicJwks } = await newGateway();
    const res = await gateway.handle(new Request(`${AUTH_ORIGIN}/.well-known/280-identity.jwks`));
    expect(res.status).toBe(200);
    const jwks = (await res.json()) as { keys: JsonWebKey[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]!.kid).toBe(Object.values(publicJwks)[0]!.kid);
    // Public only: the private scalar never ships.
    expect((jwks.keys[0] as { d?: string }).d).toBeUndefined();
  });

  it('confines an off-domain return to the fallback, not an open redirect', async () => {
    const { gateway } = await newGateway();
    const start = await gateway.handle(
      new Request(`${AUTH_ORIGIN}/auth/google/start?redirect=${encodeURIComponent('https://evil.example/steal')}`),
    );
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const stateCookie = cookiePair(start, '280_oauth')!;
    const cb = await gateway.handle(
      new Request(`${AUTH_ORIGIN}/auth/google/callback?code=alice@evergreen.com&state=${encodeURIComponent(state)}`, {
        headers: { cookie: stateCookie },
      }),
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('https://280apps.com');
  });

  it('logout clears the session so the token stops resolving', async () => {
    const { gateway } = await newGateway();
    const session = await signIn(gateway, 'google', 'alice@evergreen.com');
    expect((await gateway.handle(new Request(`${APP_ORIGIN}/`, { headers: { cookie: session } }))).status).toBe(200);

    const out = await gateway.handle(new Request(`${AUTH_ORIGIN}/logout`, { headers: { cookie: session } }));
    expect(out.status).toBe(303);
    // The now-dead session bounces back to login.
    expect((await gateway.handle(new Request(`${APP_ORIGIN}/`, { headers: { cookie: session } }))).status).toBe(302);
  });

  it('a mismatched OIDC state is refused (CSRF binding)', async () => {
    const { gateway } = await newGateway();
    const start = await gateway.handle(new Request(`${AUTH_ORIGIN}/auth/google/start?redirect=${encodeURIComponent(APP_ORIGIN + '/')}`));
    const stateCookie = cookiePair(start, '280_oauth')!;
    const cb = await gateway.handle(
      new Request(`${AUTH_ORIGIN}/auth/google/callback?code=alice@evergreen.com&state=forged`, { headers: { cookie: stateCookie } }),
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(`${AUTH_ORIGIN}/login?error=auth`);
    expect(cookiePair(cb, '280_session')).toBeNull();
  });

  it('an unknown or reserved host is a 404', async () => {
    const { gateway } = await newGateway();
    expect((await gateway.handle(new Request(`https://www.${APP_DOMAIN}/`))).status).toBe(404);
    expect((await gateway.handle(new Request('https://elsewhere.example/'))).status).toBe(404);
  });

  it('the auth host answers healthz', async () => {
    const { gateway } = await newGateway();
    const res = await gateway.handle(new Request(`${AUTH_ORIGIN}/healthz`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok\n');
  });

  it('the login rate limit bounces once the window is spent', async () => {
    const { gateway } = await newGateway({ rateMax: 1 });
    expect((await gateway.handle(new Request(`${AUTH_ORIGIN}/auth/google/start?redirect=${encodeURIComponent(APP_ORIGIN + '/')}`))).status).toBe(302);
    const second = await gateway.handle(new Request(`${AUTH_ORIGIN}/auth/google/start?redirect=${encodeURIComponent(APP_ORIGIN + '/')}`));
    expect(second.status).toBe(302);
    expect(second.headers.get('location')).toBe(`${AUTH_ORIGIN}/login?error=auth`);
  });
});
