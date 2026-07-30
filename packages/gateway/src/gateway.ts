// The gateway: the only public entry to apps on *.280apps.run. Per request it
// classifies the host, resolves the session, checks access, then mints a signed
// identity header and proxies to the upstream. The OIDC handshake is the control
// plane's Auth service (reused), configured only with the gateway's app-host
// redirect guard. See README.md for the flow.

import type { Auth } from '@280/backend/authsvc';
import { AuthError } from '@280/backend/authsvc';
import type { AccessCheck } from './access.js';
import { classifyHost, type HostConfig } from './hosts.js';
import { ID_HEADER, IdentitySigner } from './identity.js';
import { denyPage, errorPage, loginPage, type ProviderLink } from './pages.js';
import type { Upstream } from './upstream.js';

export interface Logger {
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

export interface VerifiedViewer {
  id: string;
  email: string;
  name: string;
}

export const SESSION_COOKIE = '280_session';
export const STATE_COOKIE = '280_oauth';
const STATE_TTL_SECS = 600;

export interface GatewayOptions {
  auth: Auth;
  signer: IdentitySigner;
  access: AccessCheck;
  upstream: Upstream;
  hosts: HostConfig;
  authOrigin: string;
  cookieDomain: string;
  sessionTtlSecs: number;
  providers: ProviderLink[];
  publicJwks: Record<string, JsonWebKey>;
  fallbackRedirect: string;
  logger?: Logger;
}

export class Gateway {
  private readonly o: GatewayOptions;

  constructor(o: GatewayOptions) {
    this.o = o;
  }

  async handle(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (err) {
      this.o.logger?.error('gateway panic', { error: err instanceof Error ? err.message : String(err) });
      return html(errorPage(), 500);
    }
  }

  private route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const kind = classifyHost(url.hostname, this.o.hosts);
    if (kind.kind === 'auth') return this.handleAuthHost(request, url);
    if (kind.kind === 'app') return this.handleAppHost(request, url, kind.script);
    return Promise.resolve(notFound(request));
  }

  // The OIDC dance lives on one fixed host because an IdP redirect_uri must be a
  // registered exact URL, and *.280apps.run has unboundedly many app hosts.
  private async handleAuthHost(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === '/healthz') return text('ok\n');
    if (path === '/.well-known/280-identity.jwks') return this.serveJwks();
    if (path === '/login') return this.handleLogin(url);

    const start = matchProvider(path, '/start');
    if (start !== null && request.method === 'GET') return this.handleStart(request, url, start);

    const callback = matchProvider(path, '/callback');
    if (callback !== null && request.method === 'GET') return this.handleCallback(request, url, callback);

    if (path === '/logout') return this.handleLogout(request, url);
    return notFound(request);
  }

  private handleLogin(url: URL): Response {
    const redirect = this.confineRedirect(url.searchParams.get('return') ?? '');
    return html(loginPage(this.o.providers, redirect));
  }

  private async handleStart(request: Request, url: URL, provider: string): Promise<Response> {
    try {
      const { authUrl, stateCookie } = await this.o.auth.start(
        provider,
        url.searchParams.get('redirect') ?? '',
        clientIp(request),
      );
      const headers = new Headers({ location: authUrl });
      headers.append('set-cookie', this.cookie(STATE_COOKIE, stateCookie, STATE_TTL_SECS, { hostOnly: true }));
      return new Response(null, { status: 302, headers });
    } catch (err) {
      if (err instanceof AuthError) return this.loginBounce();
      throw err;
    }
  }

  private async handleCallback(request: Request, url: URL, provider: string): Promise<Response> {
    if ((url.searchParams.get('error') ?? '') !== '') return this.loginBounce();
    try {
      const result = await this.o.auth.complete(
        provider,
        url.searchParams.get('code') ?? '',
        url.searchParams.get('state') ?? '',
        readCookie(request, STATE_COOKIE),
      );
      const headers = new Headers({ location: result.redirect });
      headers.append('set-cookie', this.cookie(SESSION_COOKIE, result.sessionToken, this.o.sessionTtlSecs));
      headers.append('set-cookie', this.cookie(STATE_COOKIE, '', 0, { hostOnly: true }));
      return new Response(null, { status: 302, headers });
    } catch (err) {
      if (err instanceof AuthError) {
        const headers = new Headers({ location: `${this.o.authOrigin}/login?error=auth` });
        headers.append('set-cookie', this.cookie(STATE_COOKIE, '', 0, { hostOnly: true }));
        return new Response(null, { status: 302, headers });
      }
      throw err;
    }
  }

  private async handleLogout(request: Request, url: URL): Promise<Response> {
    await this.o.auth.logout(readCookie(request, SESSION_COOKIE));
    const dest = this.confineRedirect(url.searchParams.get('return') ?? '');
    const headers = new Headers({ location: dest === '' ? this.o.fallbackRedirect : dest });
    headers.append('set-cookie', this.cookie(SESSION_COOKIE, '', 0));
    return new Response(null, { status: 303, headers });
  }

  private serveJwks(): Response {
    return new Response(JSON.stringify({ keys: Object.values(this.o.publicJwks) }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  }

  private async handleAppHost(request: Request, url: URL, script: string): Promise<Response> {
    const viewer = await this.resolveViewer(request);
    if (viewer === null) return this.loginBounce(request.url);

    // SEAM (280-p2-gateway): the grants-based access check slots in here.
    const decision = await this.o.access.check({ viewer, appScript: script, host: url.hostname });
    if (!decision.allow) return html(denyPage(decision.reason), 403);

    const identityHeader = await this.o.signer.sign({
      sub: viewer.id,
      email: viewer.email,
      name: viewer.name,
      aud: url.hostname,
    });
    const forwarded = stampIdentity(request, identityHeader);
    return this.o.upstream.fetch({ request: forwarded, script, identityHeader });
  }

  private async resolveViewer(request: Request): Promise<VerifiedViewer | null> {
    const user = await this.o.auth.me(readCookie(request, SESSION_COOKIE));
    return user === null ? null : { id: user.id, email: user.email, name: user.name };
  }

  private confineRedirect(raw: string): string {
    return confineRedirect(raw, this.o.hosts);
  }

  // With a returnTo (app-host no-session path) it is confined and carried;
  // without, this is the generic failed-login bounce.
  private loginBounce(returnTo?: string): Response {
    const dest = new URL('/login', this.o.authOrigin);
    if (returnTo !== undefined) {
      const confined = this.confineRedirect(returnTo);
      if (confined !== '') dest.searchParams.set('return', confined);
    } else {
      dest.searchParams.set('error', 'auth');
    }
    return new Response(null, { status: 302, headers: { location: dest.toString() } });
  }

  // Secure rides on the configured cookie domain; a bare local loop with no
  // domain is not Secure so the browser keeps it. hostOnly omits Domain.
  private cookie(name: string, value: string, maxAge: number, opts: { hostOnly?: boolean } = {}): string {
    const domain = this.o.cookieDomain;
    const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (domain !== '' && opts.hostOnly !== true) parts.push(`Domain=${domain}`);
    if (domain !== '') parts.push('Secure');
    return parts.join('; ');
  }
}

// Allows only https hosts that are the app domain or a subdomain (never the auth
// host). Exported so deps can hand it to Auth as its redirect guard.
export function confineRedirect(raw: string, hosts: HostConfig): string {
  if (raw === '') return '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:') return '';
  const host = u.hostname.toLowerCase();
  const inZone = host === hosts.appDomain || host.endsWith('.' + hosts.appDomain);
  if (!inZone || host === hosts.authHost.toLowerCase()) return '';
  return u.toString();
}

// Strips client-supplied x-280-* headers (load-bearing: else a viewer forges
// their own identity) and sets the gateway-minted one.
function stampIdentity(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith('x-280-')) headers.delete(name);
  }
  headers.set(ID_HEADER, token);
  return new Request(request, { headers });
}

function matchProvider(path: string, tail: string): string | null {
  if (!path.startsWith('/auth/') || !path.endsWith(tail)) return null;
  const mid = path.slice('/auth/'.length, path.length - tail.length);
  if (mid === '' || mid.includes('/')) return null;
  return decodeURIComponent(mid);
}

function readCookie(request: Request, name: string): string {
  const raw = request.headers.get('cookie');
  if (raw === null) return '';
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    if (pair.slice(0, i).trim() === name) return pair.slice(i + 1).trim();
  }
  return '';
}

function clientIp(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf !== null && cf !== '') return cf;
  const first = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? '';
  return first !== '' ? first : 'unknown';
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function notFound(request: Request): Response {
  if (request.headers.get('accept')?.includes('application/json')) {
    return new Response(JSON.stringify({ error: 'app_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('This link is wrong, or the app was deleted.\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
