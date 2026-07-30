import { describe, expect, it } from 'vitest';
import {
  ID_TYP,
  IdentityError,
  IdentitySigner,
  IdentityVerifier,
  tenantFromEmail,
} from '../src/identity.js';
import { genSigningKey } from './helpers.js';

const ISSUER = 'https://auth.280apps.run';
const AUD = 'renewals.280apps.run';

async function signer(now = () => 1_000_000): Promise<{ signer: IdentitySigner; publicJwks: Record<string, JsonWebKey> }> {
  const { privateJwk, publicJwks, kid } = await genSigningKey();
  return { signer: new IdentitySigner({ kid, privateJwk, issuer: ISSUER, ttlSecs: 120, now }), publicJwks };
}

describe('signed identity header', () => {
  it('mints a header a genuine verifier accepts', async () => {
    const { signer: s, publicJwks } = await signer();
    const token = await s.sign({ sub: 'usr_1', email: 'alice@evergreen.com', name: 'Alice', aud: AUD });

    const v = new IdentityVerifier({ publicJwks, issuer: ISSUER, now: () => 1_000_000 });
    const { user, claims } = await v.verify(token, { audience: AUD });
    expect(user).toEqual({ sub: 'usr_1', email: 'alice@evergreen.com', tenant: 'evergreen.com', name: 'Alice' });
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUD);
    expect(claims.exp - claims.iat).toBe(120);
  });

  it('is a compact JWS with typ 280-identity+jwt', async () => {
    const { signer: s } = await signer();
    const token = await s.sign({ sub: 'usr_1', email: 'a@b.com', name: 'A', aud: AUD });
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    expect(header).toMatchObject({ alg: 'ES256', typ: ID_TYP });
    expect(header.kid).toBeTruthy();
  });

  it('rejects a tampered payload', async () => {
    const { signer: s, publicJwks } = await signer();
    const token = await s.sign({ sub: 'usr_1', email: 'alice@evergreen.com', name: 'Alice', aud: AUD });
    const [h, p, sig] = token.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    claims.email = 'attacker@evil.com';
    const forgedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const forged = `${h}.${forgedPayload}.${sig}`;

    const v = new IdentityVerifier({ publicJwks, issuer: ISSUER, now: () => 1_000_000 });
    await expect(v.verify(forged, { audience: AUD })).rejects.toBeInstanceOf(IdentityError);
  });

  it('rejects a signature from a different key', async () => {
    const { signer: s } = await signer();
    const token = await s.sign({ sub: 'usr_1', email: 'a@b.com', name: 'A', aud: AUD });
    const other = await genSigningKey();
    // Re-key the header's kid to the other key so lookup succeeds but verify fails.
    const wrongKidJwks = { [other.kid]: Object.values(other.publicJwks)[0]! };
    const [h, p, sig] = token.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    header.kid = other.kid;
    const reheadered = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${p}.${sig}`;

    const v = new IdentityVerifier({ publicJwks: wrongKidJwks, issuer: ISSUER, now: () => 1_000_000 });
    await expect(v.verify(reheadered, { audience: AUD })).rejects.toThrow(/bad signature/);
  });

  it('rejects an expired header', async () => {
    const { signer: s, publicJwks } = await signer(() => 1_000_000);
    const token = await s.sign({ sub: 'usr_1', email: 'a@b.com', name: 'A', aud: AUD });
    const v = new IdentityVerifier({ publicJwks, issuer: ISSUER, now: () => 1_000_000 + 200 });
    await expect(v.verify(token, { audience: AUD })).rejects.toThrow(/expired/);
  });

  it('rejects a header minted for a different app (audience)', async () => {
    const { signer: s, publicJwks } = await signer();
    const token = await s.sign({ sub: 'usr_1', email: 'a@b.com', name: 'A', aud: 'appA.280apps.run' });
    const v = new IdentityVerifier({ publicJwks, issuer: ISSUER, now: () => 1_000_000 });
    await expect(v.verify(token, { audience: 'appB.280apps.run' })).rejects.toThrow(/audience/);
  });

  it('rejects an unknown signing key', async () => {
    const { signer: s } = await signer();
    const token = await s.sign({ sub: 'usr_1', email: 'a@b.com', name: 'A', aud: AUD });
    const v = new IdentityVerifier({ publicJwks: {}, issuer: ISSUER, now: () => 1_000_000 });
    await expect(v.verify(token, { audience: AUD })).rejects.toThrow(/unknown signing key/);
  });

  it('rejects a wrong issuer', async () => {
    const { signer: s, publicJwks } = await signer();
    const token = await s.sign({ sub: 'usr_1', email: 'a@b.com', name: 'A', aud: AUD });
    const v = new IdentityVerifier({ publicJwks, issuer: 'https://evil.example', now: () => 1_000_000 });
    await expect(v.verify(token, { audience: AUD })).rejects.toThrow(/issuer/);
  });

  it('tenantFromEmail is the lowercased domain', () => {
    expect(tenantFromEmail('Alice@Evergreen.com')).toBe('evergreen.com');
    expect(tenantFromEmail('nobody')).toBe('');
  });
});
