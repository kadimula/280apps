// Pure cookie + identity-header helpers shared by the central gateway and the
// app-Worker middleware. No backend, DB, or secret material — safe to compile into a
// tenant Worker.

import { ID_HEADER } from '@280/contracts/identity';

export { ID_HEADER };

// Cookie names, shared by the central gateway and the app-Worker middleware.
export const SESSION_COOKIE = '280_session'; // SSO session, Domain=.<appDomain>
export const STATE_COOKIE = '280_oauth'; // OIDC state, host-only on the auth host
export const VIEW_COOKIE = '280_view'; // view-as preview, Domain=.<appDomain>
export const ID_COOKIE = '280_id'; // per-app identity token, host-only on the app host

// readCookie pulls one cookie value off a request's Cookie header, '' when absent.
export function readCookie(request: Request, name: string): string {
  const raw = request.headers.get('cookie');
  if (raw === null) return '';
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    if (pair.slice(0, i).trim() === name) return pair.slice(i + 1).trim();
  }
  return '';
}

export interface CookieOptions {
  maxAge: number;
  domain?: string; // omitted → host-only cookie
  secure?: boolean; // default true when a domain is set; overridable for local loops
}

// serializeCookie builds a Set-Cookie value. HttpOnly + SameSite=Lax always; a
// host-only cookie (no Domain) is used for the per-app identity token so it never
// leaks to another app host.
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${opts.maxAge}`];
  if (opts.domain !== undefined && opts.domain !== '') parts.push(`Domain=${opts.domain}`);
  const secure = opts.secure ?? true;
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// stampIdentity strips any client-supplied x-280-* headers (load-bearing: else a
// viewer forges their own identity) and sets the gateway-minted one for the container.
export function stampIdentity(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith('x-280-')) headers.delete(name);
  }
  headers.set(ID_HEADER, token);
  return new Request(request, { headers });
}
