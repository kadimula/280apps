// The verify-and-forward middleware compiled into every tenant Worker. It holds only
// the public JWK set (fetched over the GATEWAY binding and cached) plus pure verify +
// route-gate logic: never the private signing key, the DB, or OIDC. See design §3.

import { IdentityVerifier, IdentityError, type VerifiedIdentity } from '@280/contracts/identity';
import { resolveRouteGate, routeGateSatisfied, type RouteGate } from '@280/contracts';
import { ID_COOKIE, PREVIEW_COOKIE, SESSION_COOKIE, VIEW_COOKIE, readCookie, serializeCookie, stampIdentity } from './cookies.js';
import type { GatewayBinding, MintResult } from './mint.js';
import { denyPage, errorPage, unavailablePage } from './pages.js';

const NO_ACCESS = 'Ask the app owner to share it with you, then reload.';

export interface GateRoles {
  appRole: string;
  featureRole: string;
}

export type GateDecision = { allow: true } | { allow: false; reason: string };

// The two-tier route model against a path with roles already resolved from a verified
// token (no DB). No declared routes → flat "any admitted viewer reaches everything";
// once any route is declared, an undeclared path resolves to the owner-only default.
export function gateForPath(routes: RouteGate[], roles: GateRoles, path: string): GateDecision {
  if (routes.length === 0) return { allow: true };
  const { gate, declared } = resolveRouteGate(routes, path);
  if (routeGateSatisfied(gate, roles)) return { allow: true };
  return { allow: false, reason: gateDenyReason(gate, declared) };
}

export function gateDenyReason(gate: RouteGate, declared: boolean): string {
  if (!declared) return 'This part of the app is limited to the owner.';
  if (gate.role !== '') return `This needs the "${gate.role}" role. Ask the owner to grant it.`;
  return NO_ACCESS;
}

// 5s absorbs benign edge clock jitter without inflating the revocation window
// (30s TTL + 5s ≈ 35s bound).
const EDGE_SKEW_SECS = 5;

// An unknown kid (a just-rotated key) forces one immediate refetch, so rotation does
// not wait out this TTL.
const JWKS_TTL_SECS = 300;

const PREVIEW_PATH = '/__280/preview';

// Outlives the grant on purpose: the server-side expires_at (re-checked on every mint)
// is authoritative, so a lingering cookie only earns a clean deny.
const PREVIEW_COOKIE_TTL_SECS = 1800;

const FRAME_ANCESTORS = 'https://www.280apps.com https://www-development.280apps.com';

export interface AppWorkerEnv {
  GATEWAY: GatewayBinding;
  TWO80_SCRIPT?: string;
  // Unset skips the issuer check; audience-scoping is the cross-app firewall regardless.
  TWO80_ID_ISSUER?: string;
  // Baked appPolicyFromManifest JSON. Unset means no declared routes; set but malformed
  // fails closed.
  TWO80_ROUTE_POLICY?: string;
}

export interface AppWorkerDeps {
  container: Fetcher;
  now?: () => number;
}

let jwksCache: { keys: Record<string, JsonWebKey>; exp: number } | null = null;

export function __resetJwksCache(): void {
  jwksCache = null;
}

// Cookieless clients on a public app (curl, crawlers) all get the same anonymous
// identity, so one token per TTL per isolate serves them all. Bounded by the token
// TTL, so un-publicing an app stops anonymous serving within TTL + skew.
const anonTokenCache = new Map<string, { token: string; exp: number; verified: VerifiedIdentity }>();

export function __resetAnonTokenCache(): void {
  anonTokenCache.clear();
}

// A cached token must outlive the request by a margin, or a token expiring mid-verify
// would 500 instead of re-minting.
const ANON_CACHE_MARGIN_SECS = 5;

export async function handleAppRequest(
  request: Request,
  env: AppWorkerEnv,
  deps: AppWorkerDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname;
  const path = url.pathname;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const issuer = env.TWO80_ID_ISSUER;
  const script = env.TWO80_SCRIPT ?? '';

  let routes: RouteGate[];
  try {
    routes = parseRoutes(env.TWO80_ROUTE_POLICY);
  } catch {
    // Fail closed: serving with unknown gates would be fail-open. Deploy produces this
    // JSON, so a malformed policy is a config bug, not viewer input.
    return html(errorPage(), 500);
  }
  const gateway = env.GATEWAY;

  if (path === PREVIEW_PATH) {
    return handlePreviewBootstrap(url, gateway, script, host);
  }

  // Steady state: a valid host-only token serves entirely locally, no central call.
  const idCookie = readCookie(request, ID_COOKIE);
  if (idCookie !== '') {
    try {
      const verified = await verifyToken(idCookie, { host, issuer, skew: EDGE_SKEW_SECS, gateway, now });
      return serveGated(request, idCookie, verified, routes, path, deps.container, null);
    } catch (err) {
      // Any verification failure means no usable local token: fall through to mint.
      if (!(err instanceof IdentityError)) throw err;
    }
  }

  // A present preview-grant cookie means the dashboard iframe, where no session cookie
  // ever arrives: refresh from the grant, which re-checks it is live and the acting
  // owner is still admin+ on every cycle.
  const previewGrant = readCookie(request, PREVIEW_COOKIE);
  const sessionToken = readCookie(request, SESSION_COOKIE);

  // A cookieless client on a public app is served from the isolate's cached anonymous
  // token by a plain expiry check; the identity was verified when the token was minted.
  if (previewGrant === '' && sessionToken === '') {
    const cached = anonTokenCache.get(host);
    if (cached !== undefined && cached.exp > now() + ANON_CACHE_MARGIN_SECS) {
      const setCookie = serializeCookie(ID_COOKIE, cached.token, { maxAge: cached.exp - now() });
      return serveGated(request, cached.token, cached.verified, routes, path, deps.container, setCookie);
    }
  }

  let result: MintResult;
  try {
    result =
      previewGrant !== ''
        ? await gateway.mintPreview({ grant: previewGrant, script, host })
        : await gateway.mint({
            sessionToken,
            viewCookie: readCookie(request, VIEW_COOKIE),
            script,
            host,
          });
  } catch {
    // Central unreachable and no valid local token: sign-in is down, not the app.
    return html(unavailablePage(), 503);
  }

  if (result.kind === 'login') {
    return new Response(null, { status: 302, headers: { location: result.url } });
  }
  if (result.kind === 'deny') {
    return html(denyPage(result.reason), 403);
  }

  let verified: VerifiedIdentity;
  try {
    verified = await verifyToken(result.token, { host, issuer, skew: EDGE_SKEW_SECS, gateway, now });
  } catch {
    // A freshly minted token that fails local verification is a key/config mismatch
    // between the gateway and this Worker's JWKS, not a viewer problem.
    return html(errorPage(), 500);
  }
  if (verified.claims.anon === true) {
    anonTokenCache.set(host, { token: result.token, exp: now() + result.ttlSecs, verified });
  }
  const setCookie = serializeCookie(ID_COOKIE, result.token, {
    maxAge: result.ttlSecs,
    // A cookie set from inside the cross-site iframe must be partitioned (CHIPS) or the
    // browser drops it, which would re-mint on every request.
    partitioned: previewGrant !== '',
  });
  return serveGated(request, result.token, verified, routes, path, deps.container, setCookie);
}

// Exchanges ?g=<grant> for the two partitioned cookies, then bounces to the target
// path so the grant never lingers in the iframe's address. A dead grant is a plain deny.
async function handlePreviewBootstrap(
  url: URL,
  gateway: GatewayBinding,
  script: string,
  host: string,
): Promise<Response> {
  const grant = url.searchParams.get('g') ?? '';
  if (grant === '') return html(errorPage(), 400);

  let result: MintResult;
  try {
    result = await gateway.mintPreview({ grant, script, host });
  } catch {
    return html(unavailablePage(), 503);
  }
  if (result.kind !== 'token') {
    return html(denyPage(result.kind === 'deny' ? result.reason : 'This preview is not available.'), 403);
  }

  const headers = new Headers({ location: sameOriginPathOrRoot(url.searchParams.get('to') ?? '') });
  headers.append(
    'set-cookie',
    serializeCookie(PREVIEW_COOKIE, grant, { maxAge: PREVIEW_COOKIE_TTL_SECS, partitioned: true }),
  );
  headers.append(
    'set-cookie',
    serializeCookie(ID_COOKIE, result.token, { maxAge: result.ttlSecs, partitioned: true }),
  );
  return new Response(null, { status: 302, headers });
}

// Anything but a same-origin absolute path ("//evil", "https://…", relative) collapses
// to the app root. "/\" is rejected too: URL parsing treats \ as /, so a
// "Location: /\evil.com" would resolve protocol-relative to evil.com.
function sameOriginPathOrRoot(raw: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

async function serveGated(
  request: Request,
  token: string,
  verified: VerifiedIdentity,
  routes: RouteGate[],
  path: string,
  container: Fetcher,
  setCookie: string | null,
): Promise<Response> {
  const { claims } = verified;
  const decision = gateForPath(routes, { appRole: claims.appRole, featureRole: claims.role }, path);
  if (!decision.allow) return html(denyPage(decision.reason), 403);

  const stamped = stampIdentity(request, token);
  const res = await container.fetch(stamped);
  const headers = new Headers(res.headers);
  ownFraming(headers);
  // Public means unlisted: stamping anonymous responses noindex keeps public apps out
  // of search.
  if (claims.anon === true) headers.set('x-robots-tag', 'noindex');
  if (setCookie !== null) headers.append('set-cookie', setCookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Who-may-frame-an-app-host is a platform guarantee: any container-supplied
// X-Frame-Options or frame-ancestors is replaced with the 280 dashboard origins. Other
// CSP directives the app set survive.
function ownFraming(headers: Headers): void {
  headers.delete('x-frame-options');
  const kept = (headers.get('content-security-policy') ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !d.toLowerCase().startsWith('frame-ancestors'));
  headers.set('content-security-policy', [`frame-ancestors ${FRAME_ANCESTORS}`, ...kept].join('; '));
}

async function verifyToken(
  token: string,
  opts: { host: string; issuer: string | undefined; skew: number; gateway: GatewayBinding; now: () => number },
): Promise<VerifiedIdentity> {
  const keys = await getJwks(opts.gateway, opts.now, false);
  try {
    return await newVerifier(keys, opts).verify(token, { audience: opts.host });
  } catch (err) {
    if (err instanceof IdentityError && err.message.includes('unknown signing key')) {
      const fresh = await getJwks(opts.gateway, opts.now, true);
      return newVerifier(fresh, opts).verify(token, { audience: opts.host });
    }
    throw err;
  }
}

function newVerifier(
  keys: Record<string, JsonWebKey>,
  opts: { issuer: string | undefined; skew: number; now: () => number },
): IdentityVerifier {
  return new IdentityVerifier({ publicJwks: keys, issuer: opts.issuer, skewSecs: opts.skew, now: opts.now });
}

async function getJwks(
  gateway: GatewayBinding,
  now: () => number,
  force: boolean,
): Promise<Record<string, JsonWebKey>> {
  if (!force && jwksCache !== null && jwksCache.exp > now()) return jwksCache.keys;
  const doc = await gateway.jwks();
  const keys: Record<string, JsonWebKey> = {};
  for (const k of doc.keys) {
    const kid = (k as { kid?: unknown }).kid;
    if (typeof kid === 'string' && kid !== '') keys[kid] = k;
  }
  jwksCache = { keys, exp: now() + JWKS_TTL_SECS };
  return keys;
}

// Unset → no routes (flat, open model). Malformed JSON throws so the caller fails closed.
function parseRoutes(raw: string | undefined): RouteGate[] {
  if (raw === undefined || raw === '') return [];
  const parsed = JSON.parse(raw) as { routes?: unknown };
  return Array.isArray(parsed.routes) ? (parsed.routes as RouteGate[]) : [];
}

function html(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
