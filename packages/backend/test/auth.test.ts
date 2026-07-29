// The browser-login flow the backend now owns: the OIDC handshake against a
// fake provider, session creation, /auth/me, logout, the open-redirect guard,
// account linking across a re-login, and the login rate limit.

import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { HonoEnv } from '../src/observe.js';
import { newPlatform, newServer, type Harness } from './helpers/harness.js';
import { cookiePair, newAuth, signIn, SESSION_COOKIE, STATE_COOKIE } from './helpers/auth.js';
import type { Auth } from '../src/authsvc.js';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

async function server(over: Parameters<typeof newAuth>[1] = {}): Promise<{ app: Hono<HonoEnv>; auth: Auth; harness: Harness }> {
  const harness = await newPlatform();
  live.push(harness);
  const auth = newAuth(harness.store, over);
  const s = await newServer({ harness, auth });
  return { app: s.app, auth, harness };
}

async function me(app: Hono<HonoEnv>, session: string | null): Promise<{ id: string; email: string; name: string; image: string } | null> {
  const res = await app.request('/auth/me', session === null ? {} : { headers: { Cookie: session } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { user: null | { id: string; email: string; name: string; image: string } }).user;
}

describe('browser login', () => {
  it('start redirects to the provider and sets a state cookie', async () => {
    const { app } = await server();
    const res = await app.request('/auth/google/start?redirect=/dashboard');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.searchParams.get('state')).not.toBe('');
    // The callback URL handed to the provider is this backend's own.
    expect(loc.searchParams.get('redirect_uri')).toBe('https://api.test/auth/google/callback');
    expect(cookiePair(res, STATE_COOKIE)).not.toBeNull();
  });

  it('a full handshake signs the user in and /auth/me reflects it', async () => {
    const { app } = await server();
    const session = await signIn(app, 'Alice@Test');
    const user = await me(app, session);
    expect(user).not.toBeNull();
    // Email is normalized to lowercase.
    expect(user!.email).toBe('alice@test');
    expect(user!.id).not.toBe('');
  });

  it('no session is a null user, not an error', async () => {
    const { app } = await server();
    expect(await me(app, null)).toBeNull();
  });

  it('logout clears the session so the token stops working', async () => {
    const { app } = await server();
    const session = await signIn(app, 'alice@test');
    expect(await me(app, session)).not.toBeNull();

    const out = await app.request('/auth/logout', { method: 'POST', headers: { Cookie: session } });
    expect(out.status).toBe(303);
    // The cleared cookie is sent back expired.
    const cleared = cookiePair(out, SESSION_COOKIE);
    expect(cleared).toBe(`${SESSION_COOKIE}=`);
    // And the original token no longer resolves.
    expect(await me(app, session)).toBeNull();
  });

  it('the same email lands on one user across logins, subject stable', async () => {
    const { app } = await server();
    const first = await me(app, await signIn(app, 'alice@test'));
    const second = await me(app, await signIn(app, 'alice@test'));
    expect(second!.id).toBe(first!.id);
  });

  it('a callback with a mismatched state is refused', async () => {
    const { app } = await server();
    const start = await app.request('/auth/google/start?redirect=/dashboard');
    const stateCookie = cookiePair(start, STATE_COOKIE)!;
    // Wrong state query against the real cookie.
    const cb = await app.request('/auth/google/callback?code=alice@test&state=forged', {
      headers: { Cookie: stateCookie },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('https://app.test/login?error=auth');
    expect(cookiePair(cb, SESSION_COOKIE)).toBeNull();
  });

  it('a failed provider exchange bounces to the login page', async () => {
    const { app } = await server();
    const start = await app.request('/auth/google/start?redirect=/dashboard');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const stateCookie = cookiePair(start, STATE_COOKIE)!;
    const cb = await app.request(`/auth/google/callback?code=boom&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: stateCookie },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('https://app.test/login?error=auth');
  });

  it('an off-origin redirect is confined to the frontend', async () => {
    const { app } = await server();
    // Drive start with an evil redirect; the callback must not honor it.
    const start = await app.request(`/auth/google/start?redirect=${encodeURIComponent('https://evil.test/steal')}`);
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const stateCookie = cookiePair(start, STATE_COOKIE)!;
    const cb = await app.request(`/auth/google/callback?code=alice@test&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: stateCookie },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('https://app.test/dashboard');
  });

  it('an unknown provider bounces rather than 500s', async () => {
    const { app } = await server();
    const res = await app.request('/auth/github/start?redirect=/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.test/login?error=auth');
  });

  it('the login rate limit bounces once the window is spent', async () => {
    const { app } = await server({ rate: { windowSecs: 600, max: 2 } });
    expect((await app.request('/auth/google/start?redirect=/')).status).toBe(302);
    expect((await app.request('/auth/google/start?redirect=/')).status).toBe(302);
    const third = await app.request('/auth/google/start?redirect=/');
    expect(third.status).toBe(302);
    expect(third.headers.get('location')).toBe('https://app.test/login?error=auth');
  });

  it('/auth/me is a null user when no auth is configured', async () => {
    const harness = await newPlatform();
    live.push(harness);
    const s = await newServer({ harness });
    const res = await s.app.request('/auth/me');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: null }).user).toBeNull();
  });
});
