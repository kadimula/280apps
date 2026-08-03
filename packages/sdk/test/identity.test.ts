// The app-side of the signed identity: sign a header exactly as the gateway does,
// then prove @280/sdk verifies it and exposes { user, can, scope } — and rejects a
// forged, expired, or wrong-audience token.

import { afterEach, describe, expect, it } from 'vitest';
import {
  IdentitySigner,
  publicJwkFromPrivate,
  type SignInput,
} from '@280/contracts/identity';
import { identity, verifyIdentityToken, IdentityError, ID_HEADER } from '../src/index.js';

const ISSUER = 'https://auth.280apps.run';
const AUD = 'renewals.280apps.run';

async function keys(): Promise<{ privateJwk: JsonWebKey; jwks: Record<string, JsonWebKey> }> {
  const kid = 'k1';
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { privateJwk, jwks: { [kid]: publicJwkFromPrivate(privateJwk, kid) } };
}

async function sign(privateJwk: JsonWebKey, input: SignInput, ttlSecs = 120): Promise<string> {
  const signer = new IdentitySigner({ kid: 'k1', privateJwk, issuer: ISSUER, ttlSecs });
  return signer.sign(input);
}

function req(token: string): Request {
  return new Request('https://renewals.280apps.run/', { headers: { [ID_HEADER]: token } });
}

const baseClaims = (over: Partial<SignInput> = {}): SignInput => ({
  sub: 'usr_1',
  email: 'alice@evergreen.com',
  name: 'Alice',
  aud: AUD,
  app: 'app_renewals',
  appRole: 'viewer',
  role: 'manager',
  caps: ['manager'],
  scope: { salaries: { kind: 'team', value: 'emea' } },
  ...over,
});

afterEach(() => {
  delete (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.TWO80_IDENTITY_JWKS;
});

describe('identity()', () => {
  it('verifies a gateway-signed header and exposes user, can, scope', async () => {
    const { privateJwk, jwks } = await keys();
    const token = await sign(privateJwk, baseClaims());
    const id = await identity(req(token), { jwks, issuer: ISSUER, audience: AUD });

    expect(id.user).toEqual({ sub: 'usr_1', email: 'alice@evergreen.com', tenant: 'evergreen.com', name: 'Alice' });
    expect(id.appRole).toBe('viewer');
    expect(id.role).toBe('manager');
    expect(id.can('manager')).toBe(true);
    expect(id.can('admin')).toBe(false);
    expect(id.scope('salaries')).toEqual({ kind: 'team', value: 'emea' });
    expect(id.scope('unknown')).toBeNull();
  });

  it('can() reflects the feature role: no role means no capability', async () => {
    const { privateJwk, jwks } = await keys();
    const token = await sign(privateJwk, baseClaims({ role: '', caps: [] }));
    const id = await identity(req(token), { jwks });
    expect(id.role).toBe('');
    expect(id.can('manager')).toBe(false);
  });

  it('reads the JWKS injected via TWO80_IDENTITY_JWKS', async () => {
    const { privateJwk, jwks } = await keys();
    (globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TWO80_IDENTITY_JWKS =
      JSON.stringify(jwks);
    const token = await sign(privateJwk, baseClaims());
    const id = await identity(req(token));
    expect(id.user.email).toBe('alice@evergreen.com');
  });

  it('accepts a JWKS { keys: [...] } document from the environment', async () => {
    const { privateJwk, jwks } = await keys();
    (globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TWO80_IDENTITY_JWKS =
      JSON.stringify({ keys: Object.values(jwks) });
    const token = await sign(privateJwk, baseClaims());
    const id = await identity(req(token));
    expect(id.user.email).toBe('alice@evergreen.com');
  });

  it('rejects a forged token (bad signature)', async () => {
    const a = await keys();
    const b = await keys(); // different key
    const token = await sign(a.privateJwk, baseClaims());
    await expect(identity(req(token), { jwks: b.jwks })).rejects.toThrow(IdentityError);
  });

  it('rejects an expired token', async () => {
    const { privateJwk, jwks } = await keys();
    const token = await sign(privateJwk, baseClaims(), -3600); // expired an hour ago
    await expect(identity(req(token), { jwks })).rejects.toThrow(/expired/);
  });

  it('rejects a token minted for another app host', async () => {
    const { privateJwk, jwks } = await keys();
    const token = await sign(privateJwk, baseClaims({ aud: 'sales.280apps.run' }));
    await expect(identity(req(token), { jwks, audience: AUD })).rejects.toThrow(/audience/);
  });

  it('throws when the header is absent', async () => {
    const { jwks } = await keys();
    await expect(identity(new Request('https://renewals.280apps.run/'), { jwks })).rejects.toThrow(
      /no 280 identity header/,
    );
  });

  it('works from a Next-style headers() object', async () => {
    const { privateJwk, jwks } = await keys();
    const token = await sign(privateJwk, baseClaims());
    const headers = new Headers({ [ID_HEADER]: token });
    const id = await verifyIdentityToken(headers.get(ID_HEADER)!, { jwks });
    expect(id.user.email).toBe('alice@evergreen.com');
  });
});

describe('anonymous identity (public apps)', () => {
  it('exposes anonymous: true and an empty email for the platform-minted anonymous viewer', async () => {
    const { privateJwk, jwks } = await keys();
    const token = await sign(
      privateJwk,
      baseClaims({ sub: 'anon', email: '', name: 'Anonymous', appRole: 'viewer', role: '', caps: [], scope: {}, anon: true }),
    );
    const id = await identity(req(token), { jwks, issuer: ISSUER, audience: AUD });
    expect(id.anonymous).toBe(true);
    expect(id.user.email).toBe('');
    expect(id.user.tenant).toBe('');
    expect(id.appRole).toBe('viewer');
    expect(id.can('manager')).toBe(false);
  });

  it('a real viewer is not anonymous, and an empty email without anon is rejected', async () => {
    const { privateJwk, jwks } = await keys();
    const real = await identity(req(await sign(privateJwk, baseClaims())), { jwks, issuer: ISSUER, audience: AUD });
    expect(real.anonymous).toBe(false);

    const forged = await sign(privateJwk, baseClaims({ email: '' }));
    await expect(identity(req(forged), { jwks, issuer: ISSUER, audience: AUD })).rejects.toThrow(IdentityError);
  });
});
