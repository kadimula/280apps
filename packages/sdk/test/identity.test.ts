// The app-side of the identity header: build a token exactly as the gateway signs it,
// then prove @two80/sdk decodes it and exposes { user, can, scope }. The gateway verifies
// the signature, audience, and expiry upstream and owns the container's sole ingress,
// so the SDK trusts the stamped header and only reads its claims.

import { describe, expect, it } from 'vitest';
import { IdentitySigner, type SignInput } from '@280/contracts/identity';
import { identity, sdkApiUrl, IdentityError, ID_HEADER } from '../src/index.js';

const ISSUER = 'https://auth.280apps.run';
const AUD = 'renewals.280apps.run';

async function sign(input: SignInput, ttlSecs = 120): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return new IdentitySigner({ kid: 'k1', privateJwk, issuer: ISSUER, ttlSecs }).sign(input);
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

describe('sdkApiUrl', () => {
  it('resolves SDK paths against the injected platform origin', () => {
    expect(sdkApiUrl('/v1/sdk/database/query', { origin: 'https://api.280apps.com' }).href).toBe(
      'https://api.280apps.com/v1/sdk/database/query',
    );
  });

  it('rejects non SDK paths and non-HTTPS origins', () => {
    expect(() => sdkApiUrl('/v1/apps', { origin: 'https://api.280apps.com' })).toThrow(/\/v1\/sdk/);
    expect(() => sdkApiUrl('/v1/sdk/x', { origin: 'http://api.280apps.com' })).toThrow(/HTTPS origin/);
    expect(() => sdkApiUrl('/v1/sdk/x', { origin: 'not a url' })).toThrow(/HTTPS origin/);
  });
});

describe('identity()', () => {
  it('decodes a gateway-stamped header and exposes user, can, scope', async () => {
    const id = await identity(req(await sign(baseClaims())));

    expect(id.user).toEqual({ sub: 'usr_1', email: 'alice@evergreen.com', tenant: 'evergreen.com', name: 'Alice' });
    expect(id.appRole).toBe('viewer');
    expect(id.role).toBe('manager');
    expect(id.can('manager')).toBe(true);
    expect(id.can('admin')).toBe(false);
    expect(id.scope('salaries')).toEqual({ kind: 'team', value: 'emea' });
    expect(id.scope('unknown')).toBeNull();
  });

  it('can() reflects the feature role: no role means no capability', async () => {
    const id = await identity(req(await sign(baseClaims({ role: '', caps: [] }))));
    expect(id.role).toBe('');
    expect(id.can('manager')).toBe(false);
  });

  it('throws when the header is absent', async () => {
    await expect(identity(new Request('https://renewals.280apps.run/'))).rejects.toThrow(/no 280 identity header/);
  });

  it('throws on a malformed token', async () => {
    await expect(identity(req('not.a.jwt.at.all'))).rejects.toThrow(IdentityError);
    await expect(identity(req('junk'))).rejects.toThrow(IdentityError);
  });

  it('works from a Next-style headers() object', async () => {
    const headers = new Headers({ [ID_HEADER]: await sign(baseClaims()) });
    const nextHeaders = { get: headers.get.bind(headers), headers: {} };
    const id = await identity(nextHeaders);
    expect(id.user.email).toBe('alice@evergreen.com');
  });
});

describe('anonymous identity (public apps)', () => {
  it('exposes anonymous: true and an empty email for the platform-minted anonymous viewer', async () => {
    const token = await sign(
      baseClaims({ sub: 'anon', email: '', name: 'Anonymous', appRole: 'viewer', role: '', caps: [], scope: {}, anon: true }),
    );
    const id = await identity(req(token));
    expect(id.anonymous).toBe(true);
    expect(id.user.email).toBe('');
    expect(id.user.tenant).toBe('');
    expect(id.appRole).toBe('viewer');
    expect(id.can('manager')).toBe(false);
  });

  it('a real viewer is not anonymous, and an empty email without anon is rejected', async () => {
    const real = await identity(req(await sign(baseClaims())));
    expect(real.anonymous).toBe(false);
    await expect(identity(req(await sign(baseClaims({ email: '' }))))).rejects.toThrow(IdentityError);
  });
});
