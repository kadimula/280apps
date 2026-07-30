// The signed identity header scheme. See README.md "Signed identity header" for
// custody, TTL, claims, and verification rationale (report OQ8).

export const ID_HEADER = 'X-280-Identity';
export const ID_TYP = '280-identity+jwt';
export const ID_ALG = 'ES256';
export const DEFAULT_TTL_SECS = 120;
export const DEFAULT_SKEW_SECS = 30;

const EC_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const EC_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface IdentityClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  tenant: string;
  name: string;
  iat: number;
  exp: number;
}

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

// MVP tenant is the email domain (design §5.5 "evergreen.com"); Entra `tid` is a
// documented follow-up.
export function tenantFromEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
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

  private signingKey(): Promise<CryptoKey> {
    if (this.key === null) {
      this.key = crypto.subtle.importKey('jwk', this.privateJwk, EC_PARAMS, false, ['sign']);
    }
    return this.key;
  }

  async sign(input: { sub: string; email: string; name: string; aud: string }): Promise<string> {
    const iat = this.now();
    const header = { alg: ID_ALG, kid: this.kid, typ: ID_TYP };
    const claims: IdentityClaims = {
      iss: this.issuer,
      aud: input.aud,
      sub: input.sub,
      email: input.email,
      tenant: tenantFromEmail(input.email),
      name: input.name,
      iat,
      exp: iat + this.ttlSecs,
    };
    const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const sig = await crypto.subtle.sign(EC_SIGN, await this.signingKey(), utf8(signingInput));
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
      ok = await crypto.subtle.verify(EC_SIGN, key, b64urlDecode(s), utf8(`${h}.${p}`));
    } catch {
      throw new IdentityError('malformed signature');
    }
    if (!ok) throw new IdentityError('bad signature');

    const claims = decodeJson(p, 'payload') as Partial<IdentityClaims>;
    requireStr(claims.sub, 'sub');
    requireStr(claims.email, 'email');
    if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') {
      throw new IdentityError('missing iat/exp');
    }
    const now = this.now();
    if (claims.exp + this.skewSecs < now) throw new IdentityError('identity has expired');
    if (claims.iat - this.skewSecs > now) throw new IdentityError('identity is not yet valid');
    if (this.issuer !== undefined && claims.iss !== this.issuer) throw new IdentityError('wrong issuer');
    if (opts.audience !== undefined && claims.aud !== opts.audience) throw new IdentityError('wrong audience');

    const full: IdentityClaims = {
      iss: claims.iss ?? '',
      aud: claims.aud ?? '',
      sub: claims.sub!,
      email: claims.email!,
      tenant: claims.tenant ?? '',
      name: claims.name ?? '',
      iat: claims.iat,
      exp: claims.exp,
    };
    return {
      user: { sub: full.sub, email: full.email, tenant: full.tenant, name: full.name },
      claims: full,
    };
  }
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
