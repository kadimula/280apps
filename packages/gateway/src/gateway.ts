// The gateway: the central identity authority on *.280apps.run. It serves the auth
// host (OIDC handshake, JWKS, view-as, logout) over HTTP and, over a service binding,
// mints signed identity tokens for the per-app Workers (mintForApp). App hosts are
// served by each app's own Worker (appworker.ts), which calls mintForApp; the gateway
// never proxies app traffic itself. The OIDC handshake is the control plane's Auth
// service (reused), configured only with the gateway's app-host redirect guard. See
// README.md for the flow.

import type { Auth } from '@280/backend/authsvc';
import { AuthError } from '@280/backend/authsvc';
import { tenantFromEmail } from '@280/contracts';
import { Authorizer, type EffectiveGrant, type ViewAs } from './access.js';
import { classifyHost, type HostConfig } from './hosts.js';
import { IdentitySigner } from './identity.js';
import { denyPage, errorPage, loginPage, type ProviderLink } from './pages.js';
import { readCookie, SESSION_COOKIE, STATE_COOKIE, VIEW_COOKIE } from './cookies.js';
import type { MintInput, MintResult } from './mint.js';

// The audit seam the gateway writes access decisions through. The pg Store
// satisfies it; injected so the proxy stays unit-testable and audit stays optional.
export interface AccessAudit {
  recordAppAccess(e: { appId: string; principal: string; allowed: boolean; detail?: string }): Promise<void>;
}

export interface Logger {
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

export interface VerifiedViewer {
  id: string;
  email: string;
  name: string;
  tenant: string;
}

const STATE_TTL_SECS = 600;
const VIEW_TTL_SECS = 3600;

export interface GatewayOptions {
  auth: Auth;
  signer: IdentitySigner;
  authz: Authorizer;
  hosts: HostConfig;
  authOrigin: string;
  cookieDomain: string;
  sessionTtlSecs: number;
  providers: ProviderLink[];
  publicJwks: Record<string, JsonWebKey>;
  fallbackRedirect: string;
  audit?: AccessAudit;
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
    // App hosts are served by each app's own Worker, not this gateway; a request
    // for one reaching here is misrouted and is not found.
    return Promise.resolve(notFound(request));
  }

  // The OIDC dance lives on one fixed host because an IdP redirect_uri must be a
  // registered exact URL, and *.280apps.run has unboundedly many app hosts.
  private async handleAuthHost(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === '/healthz') return text('ok\n');
    if (path === '/.well-known/280-identity.jwks') return this.serveJwks();
    if (path === '/login') return this.handleLogin(url);
    if (path === '/view-as' && request.method === 'GET') return this.handleViewAs(request, url);

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
    headers.append('set-cookie', this.cookie(VIEW_COOKIE, '', 0));
    return new Response(null, { status: 303, headers });
  }

  // handleViewAs is how the share dialog's "View as" button previews the app as a
  // role. It sets a scoped preview cookie only after confirming the signed-in viewer
  // is admin or above on the app, then bounces to the app; the app-host path re-checks
  // that real role before honoring the cookie, so the cookie alone grants nothing.
  // as = "clear" | "app:<role>" | "role:<featureRole>".
  private async handleViewAs(request: Request, url: URL): Promise<Response> {
    const viewer = await this.resolveViewer(request);
    if (viewer === null) return this.loginBounce(url.toString());

    const script = url.searchParams.get('app') ?? '';
    const as = url.searchParams.get('as') ?? '';
    const dest = this.confineRedirect(url.searchParams.get('return') ?? '');
    const bounce = dest === '' ? this.o.fallbackRedirect : dest;

    if (as === 'clear') {
      const headers = new Headers({ location: bounce });
      headers.append('set-cookie', this.cookie(VIEW_COOKIE, '', 0));
      return new Response(null, { status: 303, headers });
    }

    const appId = await this.o.authz.viewAsAllowed(script, viewer.email);
    if (appId === null) return html(denyPage('Only an app admin can preview it as another role.'), 403);

    const view = parseViewTarget(script, as);
    if (view === null) return html(errorPage(), 400);
    const headers = new Headers({ location: bounce });
    headers.append('set-cookie', this.cookie(VIEW_COOKIE, encodeView(view), VIEW_TTL_SECS));
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

  // mintForApp is the container-only decision service, called over the service binding
  // by an app Worker (never a proxy hop). It resolves the viewer from the session,
  // decides admission (DB), and on success mints an identity token audience-scoped to
  // the app host. Route gating is NOT done here — the app Worker enforces it locally
  // per path against the token's roles, so one 30s token serves many paths.
  async mintForApp(input: MintInput): Promise<MintResult> {
    const viewer = await this.viewerFromToken(input.sessionToken);
    if (viewer === null) {
      const url = new URL('/login', this.o.authOrigin);
      url.searchParams.set('return', `https://${input.host}/`);
      return { kind: 'login', url: url.toString() };
    }

    const viewAs = parseViewCookie(input.viewCookie);
    const adm = await this.o.authz.admit({ viewer, script: input.script, viewAs });
    if (!adm.allow) {
      await this.audit(adm.appId, viewer.email, false, { reason: adm.reason });
      return { kind: 'deny', reason: adm.reason };
    }

    // A mint is a coarse "opened the app" event (≤ once per token TTL per viewer/app),
    // the container-only replacement for the per-navigation proxy audit.
    await this.audit(adm.appId, viewer.email, true, {
      appRole: adm.effective.appRole,
      role: adm.effective.featureRole,
      viewAs: adm.viewAsApplied ? '1' : '',
    });

    const eff: EffectiveGrant = adm.effective;
    const token = await this.o.signer.sign({
      sub: viewer.id,
      email: viewer.email,
      name: viewer.name,
      aud: input.host,
      app: adm.appId,
      appRole: eff.appRole,
      role: eff.featureRole,
      caps: eff.featureRole !== '' ? [eff.featureRole] : [],
      scope: eff.dataScope ?? {},
    });
    return { kind: 'token', token, ttlSecs: this.o.signer.ttlSeconds };
  }

  // Access is audited only for top-level navigations (document requests), not every
  // asset/API hit a page fans out, so the log answers "who opened this app when"
  // without one page view becoming dozens of rows. Best-effort: a failed write is
  // logged and swallowed, never surfaced to the viewer.
  private async audit(
    appId: string,
    principal: string,
    allowed: boolean,
    detail: Record<string, string>,
  ): Promise<void> {
    if (this.o.audit === undefined || appId === '') return;
    try {
      await this.o.audit.recordAppAccess({ appId, principal, allowed, detail: JSON.stringify(detail) });
    } catch (err) {
      this.o.logger?.warn('access audit failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private resolveViewer(request: Request): Promise<VerifiedViewer | null> {
    return this.viewerFromToken(readCookie(request, SESSION_COOKIE));
  }

  private async viewerFromToken(sessionToken: string): Promise<VerifiedViewer | null> {
    const user = await this.o.auth.me(sessionToken);
    return user === null
      ? null
      : { id: user.id, email: user.email, name: user.name, tenant: tenantFromEmail(user.email) };
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

// The view cookie is a compact url-encoded JSON of {script, appRole, role}. Parsing
// tolerates any malformed value as "no preview" — a bad cookie must never break
// serving.
function parseViewCookie(raw: string): ViewAs | null {
  if (raw === '') return null;
  try {
    const o = JSON.parse(decodeURIComponent(raw)) as Partial<ViewAs>;
    if (typeof o.script !== 'string' || o.script === '') return null;
    return { script: o.script, appRole: typeof o.appRole === 'string' ? o.appRole : '', role: typeof o.role === 'string' ? o.role : '' };
  } catch {
    return null;
  }
}

function encodeView(v: ViewAs): string {
  return encodeURIComponent(JSON.stringify(v));
}

// parseViewTarget reads the /view-as `as` param: "app:<role>" previews an app role,
// "role:<featureRole>" previews a feature role (at viewer app-level). Unknown forms
// yield null.
function parseViewTarget(script: string, as: string): ViewAs | null {
  if (as.startsWith('app:')) {
    const role = as.slice('app:'.length);
    return role === '' ? null : { script, appRole: role, role: '' };
  }
  if (as.startsWith('role:')) {
    const role = as.slice('role:'.length);
    return role === '' ? null : { script, appRole: '', role };
  }
  return null;
}

function matchProvider(path: string, tail: string): string | null {
  if (!path.startsWith('/auth/') || !path.endsWith(tail)) return null;
  const mid = path.slice('/auth/'.length, path.length - tail.length);
  if (mid === '' || mid.includes('/')) return null;
  return decodeURIComponent(mid);
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
