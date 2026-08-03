// The thin verify-and-forward middleware compiled into every tenant Worker. It holds
// only the public JWK set (fetched over the GATEWAY service binding and cached) plus
// pure verify + route-gate logic. It never holds the private signing key, the DB, or
// OIDC. See gateway-identity-token-design.md §3.
//
// Hot path: read the host-only 280_id cookie, verify it locally with zero network
// (WebCrypto against the cached JWKS), enforce the route gate against the baked policy
// and the token's roles, stamp X-280-Identity, hand off to the container. Login and
// token mint/refresh are the only paths that call the central gateway.

import { IdentityVerifier, IdentityError, type VerifiedIdentity } from '@280/contracts/identity';
import type { RouteGate } from '@280/contracts';
import { gateForPath } from './routegate.js';
import { ID_COOKIE, PREVIEW_COOKIE, SESSION_COOKIE, VIEW_COOKIE, readCookie, serializeCookie, stampIdentity } from './cookies.js';
import type { GatewayBinding, MintResult } from './mint.js';
import { denyPage, errorPage, unavailablePage } from './pages.js';

// Cloudflare edge clocks are NTP-tight; 5s absorbs real jitter without inflating the
// revocation window (30s TTL + 5s = ~35s bound). It is the practical floor below which
// benign jitter starts producing false "expired" re-mints.
const DEFAULT_EDGE_SKEW_SECS = 5;

// The public JWKS rarely changes; a 300s cache keeps steady-state verification fully
// local. An unknown kid (a just-rotated key) forces one immediate refetch, so rotation
// does not wait out the TTL.
const JWKS_TTL_SECS = 300;

// The platform-reserved path where the dashboard iframe exchanges its preview
// grant (?g=) for partitioned cookies. Never forwarded to the container.
const PREVIEW_PATH = '/__280/preview';

// Outlives the grant on purpose: the server-side expires_at (re-checked on every
// mint) is authoritative, so a lingering cookie only earns a clean deny.
const PREVIEW_COOKIE_TTL_SECS = 1800;

// The platform, not the builder, decides who may frame an app host: only the 280
// dashboard origins, applied to every served response in serveGated.
const FRAME_ANCESTORS = 'https://www.280apps.com https://www-development.280apps.com';

export interface AppWorkerEnv {
  // This app's App280Container namespace. The harness Worker (not this middleware)
  // resolves it into the container Fetcher and passes it in via deps.
  APP?: DurableObjectNamespace;
  // The service binding to the central gateway (RPC). A reference, never a secret.
  GATEWAY: GatewayBinding;
  // The app's stable script name, becomes the mint `script`.
  TWO80_SCRIPT?: string;
  TWO80_APP_HOST_SUFFIX?: string;
  // The issuer the token must carry; unset skips the issuer check (audience-scoping is
  // the cross-app firewall regardless).
  TWO80_ID_ISSUER?: string;
  // The tight edge-verify skew in seconds; defaults to 5.
  TWO80_ID_SKEW_SECS?: string;
  // The baked JSON of appPolicyFromManifest(manifest): { access, roles, routes, secrets }.
  // Unset means no declared routes (the flat model, open to any admitted viewer). Set
  // but malformed fails closed.
  TWO80_ROUTE_POLICY?: string;
}

export interface AppWorkerDeps {
  // The Fetcher that reaches this app's running container (harness: getContainer(env.APP)).
  container: Fetcher;
  // Epoch-seconds clock, injected for tests; defaults to wall clock.
  now?: () => number;
}

// A module-level cache so verification is local across requests in one isolate.
let jwksCache: { keys: Record<string, JsonWebKey>; exp: number } | null = null;

// Test-only: clears the isolate JWKS cache so each case starts from a fresh binding.
export function __resetJwksCache(): void {
  jwksCache = null;
}

// The per-isolate anonymous-token cache, keyed by host. Cookieless clients on a
// public app (curl, crawlers) would otherwise cost one central mint per request;
// the anonymous identity is the same for all of them, so one token per TTL per
// isolate serves them all. Bounded by the ~120s token TTL, so flipping the app
// off public stops anonymous serving within TTL + skew.
const anonTokenCache = new Map<string, { token: string; exp: number }>();

// Test-only: clears the isolate anonymous-token cache between cases.
export function __resetAnonTokenCache(): void {
  anonTokenCache.clear();
}

// A cached token must outlive the request by a margin, or a token expiring
// mid-verify would 500 instead of re-minting.
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
  const skew = intOr(env.TWO80_ID_SKEW_SECS, DEFAULT_EDGE_SKEW_SECS);
  const script = env.TWO80_SCRIPT ?? '';

  let routes: RouteGate[];
  try {
    routes = parseRoutes(env.TWO80_ROUTE_POLICY);
  } catch {
    // A set-but-malformed policy fails closed: serving with unknown gates would be
    // fail-open. Deploy produces this JSON, so this is a config bug, not a viewer input.
    return html(errorPage(), 500);
  }
  const gateway = env.GATEWAY;

  // The preview bootstrap: the dashboard iframe's first hop, carrying the grant in
  // the URL exactly once before it moves into the partitioned cookie.
  if (path === PREVIEW_PATH) {
    return handlePreviewBootstrap(url, gateway, script, host);
  }

  // Steady state: a valid host-only token serves entirely locally, no central call.
  const idCookie = readCookie(request, ID_COOKIE);
  if (idCookie !== '') {
    try {
      const verified = await verifyToken(idCookie, { host, issuer, skew, gateway, now });
      return serveGated(request, idCookie, verified, routes, path, deps.container, null);
    } catch (err) {
      // Any verification failure (expired, wrong audience, bad signature, unknown key
      // after a refetch) means there is no usable local token: fall through to mint.
      if (!(err instanceof IdentityError)) throw err;
    }
  }

  // Mint or refresh: resolve the session centrally into a token / login / deny. A
  // present preview-grant cookie means this is the dashboard iframe, where no
  // session cookie ever arrives: refresh from the grant instead, which re-checks
  // it is live and the acting owner is still admin+ on every cycle.
  const previewGrant = readCookie(request, PREVIEW_COOKIE);
  const sessionToken = readCookie(request, SESSION_COOKIE);

  // A cookieless client (no session, no preview, no id cookie) on a public app is
  // served from the isolate's cached anonymous token; a cache entry that fails
  // verification is dropped and the request falls through to a central mint.
  if (previewGrant === '' && sessionToken === '') {
    const cached = anonTokenCache.get(host);
    if (cached !== undefined && cached.exp > now() + ANON_CACHE_MARGIN_SECS) {
      try {
        const verified = await verifyToken(cached.token, { host, issuer, skew, gateway, now });
        const setCookie = serializeCookie(ID_COOKIE, cached.token, { maxAge: cached.exp - now() });
        return serveGated(request, cached.token, verified, routes, path, deps.container, setCookie);
      } catch (err) {
        if (!(err instanceof IdentityError)) throw err;
        anonTokenCache.delete(host);
      }
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
    verified = await verifyToken(result.token, { host, issuer, skew, gateway, now });
  } catch {
    // A freshly minted token that fails local verification is a key/config mismatch
    // between the gateway and this Worker's JWKS, not a viewer problem.
    return html(errorPage(), 500);
  }
  if (verified.claims.anon === true) {
    anonTokenCache.set(host, { token: result.token, exp: now() + result.ttlSecs });
  }
  const setCookie = serializeCookie(ID_COOKIE, result.token, {
    maxAge: result.ttlSecs,
    // A cookie set from inside the cross-site iframe must be partitioned or the
    // browser drops it, which would re-mint on every single request.
    partitioned: previewGrant !== '',
  });
  return serveGated(request, result.token, verified, routes, path, deps.container, setCookie);
}

// handlePreviewBootstrap exchanges ?g=<grant> for the two partitioned cookies (the
// grant reference and a first identity token), then bounces to the target path so
// the grant never lingers in the iframe's address. Everything the grant authorizes
// is decided centrally in mintPreview; a dead grant is a plain deny page.
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

  const headers = new Headers({ location: confinePath(url.searchParams.get('to') ?? '') });
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

// Only a same-origin absolute path may be the bootstrap's landing: anything else
// ("//evil", "https://…", relative) collapses to the app root.
function confinePath(raw: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

// serveGated enforces the route gate against the token's roles, then stamps the raw
// token as X-280-Identity and forwards to the container. A minted-this-request token is
// delivered back as the host-only 280_id cookie via setCookie.
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
  // Public means unlisted: everything a crawler can fetch is served anonymously,
  // so stamping the anonymous responses noindex keeps public apps out of search.
  if (claims.anon === true) headers.set('x-robots-tag', 'noindex');
  if (setCookie !== null) headers.append('set-cookie', setCookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ownFraming makes who-may-frame-an-app-host a platform guarantee: any
// container-supplied X-Frame-Options or frame-ancestors is replaced with the 280
// dashboard origins, so a builder's headers can neither break the dashboard embed
// nor open the app to other embedders. Other CSP directives the app set survive.
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

// parseRoutes reads the baked policy JSON and returns its route gates. Unset → no
// routes (flat, open model). Malformed JSON throws so the caller can fail closed.
function parseRoutes(raw: string | undefined): RouteGate[] {
  if (raw === undefined || raw === '') return [];
  const parsed = JSON.parse(raw) as { routes?: unknown };
  return Array.isArray(parsed.routes) ? (parsed.routes as RouteGate[]) : [];
}

function intOr(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function html(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
