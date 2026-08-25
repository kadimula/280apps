import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { AuthError, type Auth } from '../../authsvc.js';
import type { HonoEnv } from '../../observe.js';
import { encodeUser } from '../encode.js';
import { cookieOpts } from '../kernel.js';

export function authRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.get('/auth/:provider/start', handleAuthStart);
  app.get('/auth/:provider/callback', handleAuthCallback);
  app.get('/auth/me', handleAuthMe);
  app.post('/auth/logout', handleAuthLogout);
  return app;
}

async function handleAuthStart(c: Context<HonoEnv>): Promise<Response> {
  const auth = c.get('deps').auth;
  if (auth === undefined) return c.text('login is not configured', 404);
  try {
    const { authUrl, stateCookie } = await auth.start(
      c.req.param('provider') ?? '',
      c.req.query('redirect') ?? '',
      clientIp(c),
    );
    setCookie(c, auth.oauthCookieName, stateCookie, cookieOpts(c, 600));
    return c.redirect(authUrl, 302);
  } catch (err) {
    if (err instanceof AuthError) return authBounce(c, auth);
    throw err;
  }
}

async function handleAuthCallback(c: Context<HonoEnv>): Promise<Response> {
  const auth = c.get('deps').auth;
  if (auth === undefined) return c.text('login is not configured', 404);
  if ((c.req.query('error') ?? '') !== '') return authBounce(c, auth);
  try {
    const result = await auth.complete(
      c.req.param('provider') ?? '',
      c.req.query('code') ?? '',
      c.req.query('state') ?? '',
      getCookie(c, auth.oauthCookieName) ?? '',
    );
    setCookie(c, auth.sessionCookieName, result.sessionToken, cookieOpts(c, auth.sessionTtlSecs));
    deleteCookie(c, auth.oauthCookieName, cookieOpts(c, 0));
    return c.redirect(result.redirect, 302);
  } catch (err) {
    if (err instanceof AuthError) {
      deleteCookie(c, auth.oauthCookieName, cookieOpts(c, 0));
      return authBounce(c, auth);
    }
    throw err;
  }
}

async function handleAuthMe(c: Context<HonoEnv>): Promise<Response> {
  const auth = c.get('deps').auth;
  if (auth === undefined) return c.json({ user: null });
  const user = await auth.me(getCookie(c, auth.sessionCookieName) ?? '');
  return c.json({ user: user === null ? null : encodeUser(user) });
}

async function handleAuthLogout(c: Context<HonoEnv>): Promise<Response> {
  const auth = c.get('deps').auth;
  if (auth === undefined) return c.text('login is not configured', 404);
  await auth.logout(getCookie(c, auth.sessionCookieName) ?? '');
  deleteCookie(c, auth.sessionCookieName, cookieOpts(c, 0));
  return c.redirect(auth.safeRedirect(c.req.query('redirect') ?? '/'), 303);
}

function authBounce(c: Context<HonoEnv>, auth: Auth): Response {
  return c.redirect(auth.frontendOrigin + '/login?error=auth', 302);
}

// Behind Railway the connecting address is the proxy, so the first X-Forwarded-For
// hop is the real caller. Keys the login rate limiter.
function clientIp(c: Context<HonoEnv>): string {
  const fwd = c.req.header('x-forwarded-for') ?? '';
  const first = fwd.split(',')[0]?.trim() ?? '';
  return first !== '' ? first : (c.req.header('x-real-ip') ?? 'unknown');
}
