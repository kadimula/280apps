// The egress policy wire shape and its normalization: the allowlist is derived in
// exactly one place, and a policy change re-derives the manifest's canonical digest
// (so a new allowlist redeploys). Mirrors the schemas.test loose-parsing contract.

import { describe, it, expect } from 'vitest';
import {
  egressPolicySchema,
  egressCredentialSchema,
  normalizeEgressPolicy,
  manifestSchema,
  canonicalDigest,
  type Manifest,
} from '../src/types.js';

function manifest(egress?: unknown): Manifest {
  return manifestSchema.parse({
    kind: 'container',
    build: { builder: 'next', dockerfile: 'Dockerfile', port: 8080 },
    files: [{ path: 'Dockerfile', digest: 'a'.repeat(64), size: 10 }],
    ...(egress === undefined ? {} : { egress }),
  });
}

describe('egress policy schema', () => {
  it('defaults an absent policy to the empty, default-deny zero value', () => {
    const m = manifest();
    expect(m.egress).toEqual({ allowedHosts: [], credentials: [] });
  });

  it('defaults a credential header/scheme to bearer-auth and preserves an explicit empty scheme', () => {
    expect(egressCredentialSchema.parse({ host: 'api.stripe.com', secret: 'STRIPE_KEY' })).toEqual({
      host: 'api.stripe.com',
      secret: 'STRIPE_KEY',
      header: 'authorization',
      scheme: 'Bearer',
    });
    // A raw-value header (apikey: <value>) sets scheme to '' explicitly; the ?? default must not clobber it.
    expect(
      egressCredentialSchema.parse({ host: 'x.supabase.co', secret: 'SB', header: 'apikey', scheme: '' }),
    ).toMatchObject({ header: 'apikey', scheme: '' });
  });
});

describe('normalizeEgressPolicy', () => {
  it('folds every credential host into the allowlist, lowercases, trims, and dedupes', () => {
    const p = egressPolicySchema.parse({
      allowedHosts: ['  API.Stripe.com ', 'api.stripe.com', ''],
      credentials: [{ host: 'X.Supabase.co', secret: 'SB' }],
    });
    const n = normalizeEgressPolicy(p);
    expect(n.allowedHosts).toEqual(['api.stripe.com', 'x.supabase.co']);
    expect(n.credentials[0]!.host).toBe('x.supabase.co');
  });

  it('drops a credential with an empty host', () => {
    const n = normalizeEgressPolicy(
      egressPolicySchema.parse({ allowedHosts: [], credentials: [{ host: '  ', secret: 'X' }] }),
    );
    expect(n.credentials).toEqual([]);
    expect(n.allowedHosts).toEqual([]);
  });
});

describe('canonicalDigest includes egress', () => {
  it('changing the allowlist changes the digest', () => {
    const a = canonicalDigest(manifest({ allowedHosts: ['api.stripe.com'], credentials: [] }));
    const b = canonicalDigest(manifest({ allowedHosts: ['api.other.com'], credentials: [] }));
    expect(a).not.toBe(b);
  });

  it('changing only a credential (same allowlist) changes the digest', () => {
    const a = canonicalDigest(
      manifest({ allowedHosts: [], credentials: [{ host: 'api.stripe.com', secret: 'K1' }] }),
    );
    const b = canonicalDigest(
      manifest({ allowedHosts: [], credentials: [{ host: 'api.stripe.com', secret: 'K2' }] }),
    );
    expect(a).not.toBe(b);
  });

  it('an empty egress policy is digest-stable regardless of representation', () => {
    const absent = canonicalDigest(manifest());
    const explicitEmpty = canonicalDigest(manifest({ allowedHosts: [], credentials: [] }));
    expect(absent).toBe(explicitEmpty);
  });
});
