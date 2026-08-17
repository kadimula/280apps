import type { JsonWebKey } from 'node:crypto';
import { IdentityError, IdentityVerifier, type VerifiedIdentity } from '@280/contracts/identity';

const DEFAULT_CACHE_TTL_SECS = 300;

export interface SdkIdentityOptions {
  jwksUri: string;
  issuer?: string;
  cacheTtlSecs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class SdkIdentityVerifier {
  private readonly jwksUri: string;
  private readonly issuer: string | undefined;
  private readonly ttlSecs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cache: { verifier: IdentityVerifier; exp: number } | null = null;

  constructor(opts: SdkIdentityOptions) {
    this.jwksUri = opts.jwksUri;
    this.issuer = opts.issuer;
    this.ttlSecs = opts.cacheTtlSecs ?? DEFAULT_CACHE_TTL_SECS;
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async verify(token: string, opts: { audience?: string } = {}): Promise<VerifiedIdentity> {
    const verifier = await this.verifier(false);
    try {
      return await verifier.verify(token, opts);
    } catch (err) {
      if (err instanceof IdentityError && err.message.includes('unknown signing key')) {
        const refreshed = await this.verifier(true);
        return refreshed.verify(token, opts);
      }
      throw err;
    }
  }

  private async verifier(force: boolean): Promise<IdentityVerifier> {
    if (!force && this.cache !== null && this.cache.exp > this.now()) return this.cache.verifier;
    const publicJwks = await this.loadJwks();
    const verifier = new IdentityVerifier({ publicJwks, issuer: this.issuer, now: this.now });
    this.cache = { verifier, exp: this.now() + this.ttlSecs };
    return verifier;
  }

  private async loadJwks(): Promise<Record<string, JsonWebKey>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.jwksUri);
    } catch {
      throw new IdentityError('could not reach the identity key set');
    }
    if (!res.ok) throw new IdentityError(`identity key set unavailable: HTTP ${res.status}`);
    const doc = (await res.json()) as { keys?: unknown };
    const keys: Record<string, JsonWebKey> = {};
    if (Array.isArray(doc.keys)) {
      for (const k of doc.keys) {
        const kid = (k as { kid?: unknown }).kid;
        if (typeof kid === 'string' && kid !== '') keys[kid] = k as JsonWebKey;
      }
    }
    if (Object.keys(keys).length === 0) throw new IdentityError('identity key set is empty');
    return keys;
  }
}
