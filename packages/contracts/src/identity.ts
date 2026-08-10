// The signed identity header scheme, shared by the gateway (which mints it) and
// @280/sdk (which verifies it inside the app). One source of truth for the claim
// set and the ES256 verification so the two sides can never drift. See the gateway
// README "Signed identity header" for custody, TTL, and rationale (report OQ8).

export const ID_HEADER = 'X-280-Identity';
export const ID_TYP = '280-identity+jwt';
export const ID_ALG = 'ES256';
export const DEFAULT_TTL_SECS = 120;
export const DEFAULT_SKEW_SECS = 30;

const EC_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const EC_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

// The claim set the gateway signs. Beyond who the viewer is (sub/email/tenant/name)
// it carries what the gateway already resolved from the grants table for this one
// app: their app_role (tier 1), feature role (tier 2), the capabilities can() reads,
// and the advisory data scope. The app trusts these because only the gateway holds
// the signing key and the container has no other ingress.
export interface IdentityClaims {
  iss: string;
  aud: string; // the app host the identity was minted for
  sub: string;
  email: string;
  tenant: string;
  name: string;
  app: string; // the app id, so the SDK binds identity to one app
  appRole: string; // '' | owner | admin | editor | viewer
  role: string; // '' | a builder-defined feature role
  caps: string[]; // capabilities can() checks (MVP: [role] when a feature role is held)
  scope: Record<string, unknown>; // advisory data scope, {} when unset
  // True only on the anonymous identity the gateway mints for a public app's
  // no-session visitors (sub 'anon', empty email). Absent on every real viewer.
  anon?: boolean;
  iat: number;
  exp: number;
}

// What the SDK hands the app: the verified viewer plus the full claims.
export interface VerifiedIdentity {
  user: { sub: string; email: string; tenant: string; name: string };
  claims: IdentityClaims;
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

// MVP tenant is the email domain; Entra `tid` is a documented follow-up.
export function tenantFromEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

// What the gateway passes when minting an identity: who the viewer is plus the
// access the gateway already resolved for this app. Optional access fields default
// to "no access" so a link/anonymous viewer still gets a well-formed identity.
export interface SignInput {
  sub: string;
  email: string;
  name: string;
  aud: string;
  app?: string;
  appRole?: string;
  role?: string;
  caps?: string[];
  scope?: Record<string, unknown>;
  anon?: boolean;
}

export class IdentitySigner {
  private readonly kid: string;
  private readonly privateJwk: JsonWebKey;
  private readonly issuer: string;
  private readonly ttlSecs: number;
  private readonly now: () => number;
  private key: Promise<CryptoKey> | null = null;

  constructor(opts: {
    kid: string;
    privateJwk: JsonWebKey;
    issuer: string;
    ttlSecs?: number;
    now?: () => number;
  }) {
    this.kid = opts.kid;
    this.privateJwk = opts.privateJwk;
    this.issuer = opts.issuer;
    this.ttlSecs = opts.ttlSecs ?? DEFAULT_TTL_SECS;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // The configured token lifetime, so a caller can set a matching cookie Max-Age.
  get ttlSeconds(): number {
    return this.ttlSecs;
  }

  private signingKey(): Promise<CryptoKey> {
    if (this.key === null) {
      this.key = crypto.subtle.importKey('jwk', this.privateJwk, EC_PARAMS, false, ['sign']);
    }
    return this.key;
  }

  async sign(input: SignInput): Promise<string> {
    const iat = this.now();
    const header = { alg: ID_ALG, kid: this.kid, typ: ID_TYP };
    const claims: IdentityClaims = {
      iss: this.issuer,
      aud: input.aud,
      sub: input.sub,
      email: input.email,
      tenant: tenantFromEmail(input.email),
      name: input.name,
      app: input.app ?? '',
      appRole: input.appRole ?? '',
      role: input.role ?? '',
      caps: input.caps ?? [],
      scope: input.scope ?? {},
      ...(input.anon === true ? { anon: true } : {}),
      iat,
      exp: iat + this.ttlSecs,
    };
    const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const sig = await crypto.subtle.sign(EC_SIGN, await this.signingKey(), bytes(utf8(signingInput)));
    return `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;
  }
}

export class IdentityVerifier {
  private readonly jwks: Map<string, JsonWebKey>;
  private readonly issuer: string | undefined;
  private readonly skewSecs: number;
  private readonly now: () => number;
  private readonly imported = new Map<string, Promise<CryptoKey>>();

  constructor(opts: {
    publicJwks: Record<string, JsonWebKey>;
    issuer?: string;
    skewSecs?: number;
    now?: () => number;
  }) {
    this.jwks = new Map(Object.entries(opts.publicJwks));
    this.issuer = opts.issuer;
    this.skewSecs = opts.skewSecs ?? DEFAULT_SKEW_SECS;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private verifyKey(kid: string): Promise<CryptoKey> {
    let p = this.imported.get(kid);
    if (p === undefined) {
      const jwk = this.jwks.get(kid);
      if (jwk === undefined) throw new IdentityError(`unknown signing key "${kid}"`);
      p = crypto.subtle.importKey('jwk', jwk, EC_PARAMS, false, ['verify']);
      this.imported.set(kid, p);
    }
    return p;
  }

  async verify(token: string, opts: { audience?: string } = {}): Promise<VerifiedIdentity> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new IdentityError('token is not a compact JWS');
    const [h, p, s] = parts as [string, string, string];

    const header = decodeJson(h, 'header') as { alg?: unknown; kid?: unknown; typ?: unknown };
    if (header.typ !== ID_TYP) throw new IdentityError('wrong token type');
    if (header.alg !== ID_ALG) throw new IdentityError(`unexpected alg "${String(header.alg)}"`);
    if (typeof header.kid !== 'string' || header.kid === '') throw new IdentityError('missing kid');

    const key = await this.verifyKey(header.kid);
    let ok: boolean;
    try {
      ok = await crypto.subtle.verify(EC_SIGN, key, bytes(b64urlDecode(s)), bytes(utf8(`${h}.${p}`)));
    } catch {
      throw new IdentityError('malformed signature');
    }
    if (!ok) throw new IdentityError('bad signature');

    const claims = decodeJson(p, 'payload') as Partial<IdentityClaims>;
    requireClaimShape(claims);
    const now = this.now();
    if (claims.exp! + this.skewSecs < now) throw new IdentityError('identity has expired');
    if (claims.iat! - this.skewSecs > now) throw new IdentityError('identity is not yet valid');
    if (this.issuer !== undefined && claims.iss !== this.issuer) throw new IdentityError('wrong issuer');
    if (opts.audience !== undefined && claims.aud !== opts.audience) throw new IdentityError('wrong audience');
    return toVerified(normalizeClaims(claims));
  }
}

// decodeIdentityToken reads the claims WITHOUT checking the signature or expiry. It
// is for a caller that already sits behind the gateway: the gateway verified both and
// owns the container's sole ingress, so the app only needs to read the claims. Never
// call it on a token from an untrusted source; use IdentityVerifier there.
export function decodeIdentityToken(token: string): VerifiedIdentity {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdentityError('token is not a compact JWS');
  const [, p] = parts as [string, string, string];
  const claims = decodeJson(p, 'payload') as Partial<IdentityClaims>;
  requireClaimShape(claims);
  return toVerified(normalizeClaims(claims));
}

// The anonymous identity (anon: true) is the one claim set allowed an empty email;
// every real viewer must carry one.
function requireClaimShape(claims: Partial<IdentityClaims>): void {
  requireStr(claims.sub, 'sub');
  if (claims.anon === true) {
    if (typeof claims.email !== 'string') throw new IdentityError('missing email');
  } else {
    requireStr(claims.email, 'email');
  }
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') {
    throw new IdentityError('missing iat/exp');
  }
}

function normalizeClaims(claims: Partial<IdentityClaims>): IdentityClaims {
  return {
    iss: claims.iss ?? '',
    aud: claims.aud ?? '',
    sub: claims.sub!,
    email: claims.email!,
    tenant: claims.tenant ?? '',
    name: claims.name ?? '',
    app: claims.app ?? '',
    appRole: claims.appRole ?? '',
    role: claims.role ?? '',
    caps: Array.isArray(claims.caps) ? claims.caps.filter((c): c is string => typeof c === 'string') : [],
    scope:
      claims.scope !== null && typeof claims.scope === 'object' && !Array.isArray(claims.scope)
        ? (claims.scope as Record<string, unknown>)
        : {},
    ...(claims.anon === true ? { anon: true } : {}),
    iat: claims.iat!,
    exp: claims.exp!,
  };
}

function toVerified(full: IdentityClaims): VerifiedIdentity {
  return { user: { sub: full.sub, email: full.email, tenant: full.tenant, name: full.name }, claims: full };
}

// Drops the private scalar `d`, leaving the public JWK the verifier and JWKS
// endpoint publish.
export function publicJwkFromPrivate(privateJwk: JsonWebKey, kid: string): JsonWebKey {
  const { kty, crv, x, y } = privateJwk;
  return { kty, crv, x, y, kid, use: 'sig', alg: ID_ALG } as JsonWebKey;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// bytes hands WebCrypto a plain ArrayBuffer view: a bare Uint8Array is typed over
// ArrayBufferLike (which includes SharedArrayBuffer), which the strict BufferSource
// signatures reject. Copying into a fresh ArrayBuffer is unambiguous on every runtime.
function bytes(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj: unknown): string {
  return b64urlBytes(utf8(JSON.stringify(obj)));
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  let bin: string;
  try {
    bin = atob(s + pad);
  } catch {
    throw new IdentityError('malformed base64url');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(seg: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(seg)));
  } catch {
    throw new IdentityError(`malformed ${what}`);
  }
  if (parsed === null || typeof parsed !== 'object') throw new IdentityError(`${what} is not an object`);
  return parsed as Record<string, unknown>;
}

function requireStr(v: unknown, field: string): asserts v is string {
  if (typeof v !== 'string' || v === '') throw new IdentityError(`missing ${field}`);
}
