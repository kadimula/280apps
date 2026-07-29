// Test support for the browser-login flow: a fake OIDC provider and a driver
// that runs the real start -> callback handshake to hand a test a session
// cookie. Nothing here reaches the network; the fake stands in for Google, and
// the identity a login produces is encoded in the "code" the test supplies.

import type { Hono } from 'hono';
import { Auth, type AuthConfig } from '../../src/authsvc.js';
import type { OidcIdentity, OidcProvider } from '../../src/auth/oidc.js';
import type { Store } from '../../src/seams.js';
import type { HonoEnv } from '../../src/observe.js';

export const SESSION_COOKIE = '280_session';
export const STATE_COOKIE = '280_oauth';

// FakeProvider maps a login code straight to an identity, so a test signs in as
// anyone by passing their email as the code. The code "boom" fails the exchange,
// which is how the failed-login path is exercised.
export class FakeProvider implements OidcProvider {
  readonly name = 'google';

  authUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    return `https://fake.test/consent?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async exchange({ code }: { code: string }): Promise<OidcIdentity> {
    if (code === 'boom') throw new Error('exchange failed');
    const email = code.toLowerCase();
    return {
      subject: 'g-' + email,
      email,
      name: email.split('@')[0] ?? email,
      image: '',
    };
  }
}

// newAuth builds an Auth on the given store with the fake provider and test
// origins. Overrides let a case tighten the rate limit or pin the clock.
export function newAuth(store: Store, over: Partial<AuthConfig> = {}): Auth {
  return new Auth(store, {
    providers: { google: new FakeProvider() },
    apiOrigin: 'https://api.test',
    frontendOrigin: 'https://app.test',
    cookieDomain: '',
    sessionTtlSecs: 3600,
    rate: { windowSecs: 600, max: 1000 },
    ...over,
  });
}

// cookiePair returns the "name=value" a Set-Cookie header carries, verbatim, so
// it can be echoed back on the next request without re-encoding.
export function cookiePair(res: Response, name: string): string | null {
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith(name + '=')) return sc.split(';')[0] ?? null;
  }
  return null;
}

// signIn drives the real handshake against the fake provider and returns the
// session cookie pair. redirect is where the flow would send the browser; the
// caller rarely cares, but it exercises the redirect whitelist.
export async function signIn(
  app: Hono<HonoEnv>,
  email: string,
  redirect = '/dashboard',
): Promise<string> {
  const start = await app.request(`/auth/google/start?redirect=${encodeURIComponent(redirect)}`);
  if (start.status !== 302) throw new Error(`start returned ${start.status}`);
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const stateCookie = cookiePair(start, STATE_COOKIE);
  if (stateCookie === null) throw new Error('start set no state cookie');

  const cb = await app.request(
    `/auth/google/callback?code=${encodeURIComponent(email)}&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: stateCookie } },
  );
  if (cb.status !== 302) throw new Error(`callback returned ${cb.status}`);
  const session = cookiePair(cb, SESSION_COOKIE);
  if (session === null) throw new Error('callback set no session cookie');
  return session;
}
