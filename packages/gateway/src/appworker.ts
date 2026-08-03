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
import { ID_COOKIE, SESSION_COOKIE, VIEW_COOKIE, readCookie, serializeCookie, stampIdentity } from './cookies.js';
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

  // Mint or refresh: resolve the session centrally into a token / login / deny.
  let result: MintResult;
  try {
    result = await gateway.mint({
      sessionToken: readCookie(request, SESSION_COOKIE),
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
  const setCookie = serializeCookie(ID_COOKIE, result.token, { maxAge: result.ttlSecs });
  return serveGated(request, result.token, verified, routes, path, deps.container, setCookie);
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
  if (setCookie === null) return res;
  const headers = new Headers(res.headers);
  headers.append('set-cookie', setCookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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
