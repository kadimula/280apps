import { describe, expect, it } from 'vitest';
import { APP_DOMAIN, AUTH_ORIGIN, cookiePair, newGateway, signIn } from './helpers.js';

const APP_ORIGIN = `https://renewals.${APP_DOMAIN}`;
const APP_HOST = `renewals.${APP_DOMAIN}`;

function sessionValue(pair: string): string {
  return pair.slice(pair.indexOf('=') + 1);
}

// The gateway serves only the auth host and the mint service binding; app hosts are
// served by their own Workers. These cases cover the auth-host HTTP surface.
describe('gateway auth host', () => {
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

  it('does not serve app hosts itself: a request for one is a 404', async () => {
    const { gateway } = await newGateway();
    // A valid app host, a reserved label, and an off-domain host all 404 at the
    // gateway — app hosts are served by their own Workers.
    expect((await gateway.handle(new Request(`${APP_ORIGIN}/`))).status).toBe(404);
    expect((await gateway.handle(new Request(`https://www.${APP_DOMAIN}/`))).status).toBe(404);
    expect((await gateway.handle(new Request('https://elsewhere.example/'))).status).toBe(404);
  });

  it('logout clears the session so the mint stops resolving it', async () => {
    const { gateway } = await newGateway();
    const session = sessionValue(await signIn(gateway, 'google', 'alice@evergreen.com'));
    expect((await gateway.mintForApp({ sessionToken: session, viewCookie: '', script: 'renewals', host: APP_HOST })).kind).toBe('token');

    const out = await gateway.handle(new Request(`${AUTH_ORIGIN}/logout`, { headers: { cookie: `280_session=${session}` } }));
    expect(out.status).toBe(303);
    // The now-dead session no longer mints a token: it resolves to a login redirect.
    expect((await gateway.mintForApp({ sessionToken: session, viewCookie: '', script: 'renewals', host: APP_HOST })).kind).toBe('login');
  });
});
