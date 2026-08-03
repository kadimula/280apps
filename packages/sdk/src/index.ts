// @280/sdk: the only identity code a 280 app ever contains. The gateway verifies
// the caller, gates the route, and forwards a short-lived ES256-signed header; this
// SDK verifies that header offline and hands the app one object — the user, a can()
// capability check, and a scope() resolver. Apps write no auth: no sessions, no
// token handling, no user table (the-280-way).
//
//   import { identity } from "@280/sdk";
//   const { user, can, scope } = await identity(request);
//   user.email            // verified by the gateway, not by app code
//   can("approvals.edit") // true when the viewer holds that feature role
//   scope("salaries")     // the advisory data scope, or null

import {
  ID_HEADER,
  IdentityError,
  IdentityVerifier,
  type IdentityClaims,
} from '@280/contracts/identity';

export { ID_HEADER, IdentityError };
export type { IdentityClaims };

export interface User280 {
  sub: string;
  email: string;
  tenant: string;
  name: string;
}

// The one object an app reads per request. can()/scope() are the gateway-resolved
// grants; role/appRole are exposed directly for apps that branch on them.
export interface Identity280 {
  user: User280;
  can(capability: string): boolean;
  scope(name: string): unknown;
  role: string; // the viewer's feature role, '' if none
  appRole: string; // the viewer's app role
  // True on the platform-minted anonymous viewer a public app serves to visitors
  // with no session (user.email is '' then). Branch on this before writes or
  // per-user rows: `if (identity.anonymous) ...`.
  anonymous: boolean;
  claims: IdentityClaims;
}

// Anything the SDK can read a header off: a Fetch Request, a Headers, or Next's
// headers() result — all expose `.get(name)`; a Request nests it under `.headers`.
export interface HeaderSource {
  get(name: string): string | null | undefined;
}
export type RequestLike = HeaderSource | { headers: HeaderSource };

export interface IdentityOptions {
  // The platform's public JWKS. Defaults to TWO80_IDENTITY_JWKS (the JSON the
  // runtime injects into the container), so a scaffolded app needs no config.
  jwks?: Record<string, JsonWebKey>;
  // The expected issuer and audience (the app's own host). Both optional; when set,
  // a token from another issuer or minted for another app is rejected.
  issuer?: string;
  audience?: string;
  now?: () => number;
}

// identity reads the signed header off the request and returns the verified viewer.
// Throws IdentityError when the header is absent, malformed, expired, or not signed
// by the platform — an app treats that as "no authenticated caller".
export async function identity(request: RequestLike, opts: IdentityOptions = {}): Promise<Identity280> {
  const token = readHeader(request, ID_HEADER);
  if (token === '') throw new IdentityError('no 280 identity header on the request');
  return verifyIdentityToken(token, opts);
}

// verifyIdentityToken is the lower-level entry for callers that already hold the
// header value (e.g. a framework middleware that extracted it).
export async function verifyIdentityToken(token: string, opts: IdentityOptions = {}): Promise<Identity280> {
  const verifier = verifierFor(opts);
  const audience = opts.audience;
  const { user, claims } = await verifier.verify(token, audience !== undefined ? { audience } : {});
  const caps = new Set(claims.caps);
  return {
    user,
    role: claims.role,
    appRole: claims.appRole,
    anonymous: claims.anon === true,
    claims,
    can: (capability: string) => caps.has(capability),
    scope: (name: string) => (name in claims.scope ? claims.scope[name] : null),
  };
}

// verifierFor builds the ES256 verifier from the provided or injected JWKS. The
// verifier is cheap and stateless beyond its imported keys, so a fresh one per call
// is fine; apps that want caching can hold their own via verifyIdentityToken.
function verifierFor(opts: IdentityOptions): IdentityVerifier {
  const jwks = opts.jwks ?? injectedJwks();
  if (jwks === null) {
    throw new IdentityError(
      'no identity JWKS: pass { jwks } or set TWO80_IDENTITY_JWKS (the platform injects it at deploy)',
    );
  }
  return new IdentityVerifier({
    publicJwks: jwks,
    ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

// injectedJwks reads the platform-injected public key set from the environment,
// tolerating its absence (returns null) and a malformed value (throws a clear
// error, since a present-but-broken JWKS is a misconfiguration, not "unset").
function injectedJwks(): Record<string, JsonWebKey> | null {
  const raw = readEnv('TWO80_IDENTITY_JWKS');
  if (raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IdentityError('TWO80_IDENTITY_JWKS is not valid JSON');
  }
  // Accept either a bare { kid: jwk } map or a JWKS { keys: [ ... ] } document.
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { keys?: unknown }).keys)) {
    const out: Record<string, JsonWebKey> = {};
    for (const k of (parsed as { keys: JsonWebKey[] }).keys) {
      const kid = (k as { kid?: unknown }).kid;
      if (typeof kid === 'string') out[kid] = k;
    }
    return out;
  }
  if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, JsonWebKey>;
  throw new IdentityError('TWO80_IDENTITY_JWKS must be a JWKS object');
}

function readEnv(name: string): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.[name];
  return typeof v === 'string' ? v : '';
}

function readHeader(request: RequestLike, name: string): string {
  const src: HeaderSource =
    'headers' in request && request.headers !== undefined ? (request as { headers: HeaderSource }).headers : (request as HeaderSource);
  const v = src.get(name) ?? src.get(name.toLowerCase());
  return typeof v === 'string' ? v : '';
}
