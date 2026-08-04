// Pure cookie + identity-header helpers shared by the central gateway and the app
// Worker. No backend, DB, or secret material, so safe to compile into a tenant Worker.

import { ID_HEADER } from '@280/contracts/identity';

export const SESSION_COOKIE = '280_session'; // SSO session, Domain=.<appDomain>
export const STATE_COOKIE = '280_oauth'; // OIDC state, host-only on the auth host
export const VIEW_COOKIE = '280_view'; // view-as preview, Domain=.<appDomain>
export const ID_COOKIE = '280_id'; // per-app identity token, host-only on the app host
// Host-only + CHIPS-partitioned so it rides only inside the dashboard iframe; the
// reserved 280_ prefix keeps stampIdentity from leaking it to container code.
export const PREVIEW_COOKIE = '280_preview';

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
  domain?: string; // omitted is host-only
  secure?: boolean; // default true when a domain is set; overridable for local loops
  // CHIPS (SameSite=None; Secure; Partitioned): the only cookie shape browsers still
  // deliver inside a cross-site iframe, isolated per top-level site.
  partitioned?: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const partitioned = opts.partitioned === true;
  const sameSite = partitioned ? 'None' : 'Lax';
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${opts.maxAge}`];
  if (opts.domain !== undefined && opts.domain !== '') parts.push(`Domain=${opts.domain}`);
  const secure = partitioned || (opts.secure ?? true);
  if (secure) parts.push('Secure');
  if (partitioned) parts.push('Partitioned');
  return parts.join('; ');
}

// Every 280_* cookie is stripped before the request reaches untrusted container code:
// 280_session is a portable SSO bearer, and apps read identity from X-280-Identity.
const RESERVED_COOKIE_PREFIX = '280_';

function stripReservedCookies(headers: Headers): void {
  const raw = headers.get('cookie');
  if (raw === null) return;
  const kept = raw
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (pair === '') return false;
      const i = pair.indexOf('=');
      const name = (i < 0 ? pair : pair.slice(0, i)).trim();
      return !name.startsWith(RESERVED_COOKIE_PREFIX);
    });
  if (kept.length === 0) headers.delete('cookie');
  else headers.set('cookie', kept.join('; '));
}

// Strips client-supplied x-280-* headers (else a viewer forges their identity) and the
// platform's 280_* cookies (else container code sees the SSO session), then sets the
// gateway-minted identity header.
export function stampIdentity(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith('x-280-')) headers.delete(name);
  }
  stripReservedCookies(headers);
  headers.set(ID_HEADER, token);
  return new Request(request, { headers });
}
