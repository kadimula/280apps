// Gateway.mintPreview: the grant-authorized sibling of mintForApp behind the
// dashboard iframe. These prove identity resolution for each viewAs kind, the
// dead-grant answers (unknown/expired/revoked), the per-mint admin+ re-check, the
// cross-app replay guard, and the impersonation audit trail.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PreviewGrant } from '@280/backend/seams';
import { IdentityVerifier } from '@280/contracts';
import { APP_DOMAIN, ISSUER, newGateway, signIn, type GatewayHarness } from './helpers.js';

const HOST = `renewals.${APP_DOMAIN}`;
const OWNER = 'owner@evergreen.com';

function hash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Signs the owner in (creating their users row), seeds their grant on
// app_renewals, and returns the harness plus a seedPreview helper that stores a
// grant under the hash of the opaque token it returns.
async function ownerHarness(
  over: { ownerRole?: string; grants?: Array<{ appId: string; principal: string; appRole?: string; featureRole?: string }> } = {},
): Promise<GatewayHarness & { seedPreview: (over?: Partial<PreviewGrant>) => Promise<string> }> {
  const h = await newGateway({
    grants: [
      { appId: 'app_renewals', principal: OWNER, appRole: over.ownerRole ?? 'owner' },
      ...(over.grants ?? []),
    ],
  });
  await signIn(h.gateway, 'google', OWNER);
  const owner = await h.store.userByEmail(OWNER);
  let seq = 0;
  const seedPreview = async (g: Partial<PreviewGrant> = {}): Promise<string> => {
    const token = `preview-token-${++seq}`;
    h.store.seedPreviewGrant({
      tokenHash: hash(token),
      appId: 'app_renewals',
      ownerUserId: owner!.id,
      viewAs: { kind: 'none' },
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      revoked: false,
      ...g,
    });
    return token;
  };
  return { ...h, seedPreview };
}

async function claimsOf(h: GatewayHarness, token: string) {
  const verifier = new IdentityVerifier({ publicJwks: h.publicJwks, issuer: ISSUER });
  return verifier.verify(token, { audience: HOST });
}

describe('Gateway.mintPreview', () => {
  it('viewAs none mints the owner identity at their real role', async () => {
    const h = await ownerHarness();
    const grant = await h.seedPreview();
    const res = await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { user, claims } = await claimsOf(h, res.token);
    expect(user.email).toBe(OWNER);
    expect(claims.aud).toBe(HOST);
    expect(claims.app).toBe('app_renewals');
    expect(claims.appRole).toBe('owner');
    const allowed = h.store.accessLog.filter((e) => e.allowed);
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!.kind).toBe('app.accessed');
    expect(allowed[0]!.detail).toContain('"preview":"1"');
  });

  it('viewAs role keeps the owner identity and overrides the roles', async () => {
    const h = await ownerHarness();
    const grant = await h.seedPreview({ viewAs: { kind: 'role', appRole: 'viewer', featureRole: '' } });
    const res = await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { user, claims } = await claimsOf(h, res.token);
    expect(user.email).toBe(OWNER); // still the owner's own identity
    expect(claims.appRole).toBe('viewer'); // previewed down
  });

  it('viewAs role with a feature role mints that role and its capability', async () => {
    const h = await ownerHarness();
    const grant = await h.seedPreview({ viewAs: { kind: 'role', appRole: '', featureRole: 'manager' } });
    const res = await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { claims } = await claimsOf(h, res.token);
    expect(claims.role).toBe('manager');
    expect(claims.caps).toEqual(['manager']);
  });

  it('viewAs user renders as the target user with their resolved access, audited as app.previewed_as', async () => {
    const h = await ownerHarness({
      grants: [{ appId: 'app_renewals', principal: 'bob@contoso.com', appRole: 'viewer', featureRole: 'manager' }],
    });
    await signIn(h.gateway, 'google', 'bob@contoso.com'); // bob has a users row
    const bob = await h.store.userByEmail('bob@contoso.com');
    const grant = await h.seedPreview({ viewAs: { kind: 'user', email: 'bob@contoso.com' } });

    const res = await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { user, claims } = await claimsOf(h, res.token);
    expect(user.sub).toBe(bob!.id);
    expect(user.email).toBe('bob@contoso.com');
    expect(claims.appRole).toBe('viewer');
    expect(claims.role).toBe('manager');

    // The impersonation trail names both the acting owner and the target.
    const audit = h.store.accessLog.filter((e) => e.kind === 'app.previewed_as');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.allowed).toBe(true);
    const detail = JSON.parse(audit[0]!.detail) as Record<string, string>;
    expect(detail.by).toBe(OWNER);
    expect(detail.as).toBe('bob@contoso.com');
  });

  it('viewAs user with no users row synthesizes a minimal identity from the email', async () => {
    const h = await ownerHarness({
      grants: [{ appId: 'app_renewals', principal: 'carol@firm.com', appRole: 'editor' }],
    });
    const grant = await h.seedPreview({ viewAs: { kind: 'user', email: 'carol@firm.com' } });
    const res = await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST });
    expect(res.kind).toBe('token');
    if (res.kind !== 'token') return;
    const { user, claims } = await claimsOf(h, res.token);
    expect(user.sub).toBe('carol@firm.com');
    expect(user.name).toBe('carol');
    expect(user.tenant).toBe('firm.com');
    expect(claims.appRole).toBe('editor');
  });

  it('viewAs user runs the normal admission: an unshared target on an invited app is denied', async () => {
    const h = await ownerHarness();
    const grant = await h.seedPreview({ viewAs: { kind: 'user', email: 'stranger@nowhere.com' } });
    const res = await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST });
    expect(res.kind).toBe('deny');
    expect(h.store.accessLog.filter((e) => !e.allowed)).toHaveLength(1);
  });

  it('denies an unknown, expired, or revoked grant with one answer', async () => {
    const h = await ownerHarness();
    const expired = await h.seedPreview({ expiresAt: Math.floor(Date.now() / 1000) - 1 });
    const revoked = await h.seedPreview({ revoked: true });
    for (const grant of ['no-such-token', expired, revoked, '']) {
      const res = await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST });
      expect(res.kind).toBe('deny');
    }
    expect(h.store.accessLog).toHaveLength(0); // dead grants never reach admission
  });

  it('re-checks the acting owner is still admin+ on every mint (mid-preview demotion stops it)', async () => {
    const h = await ownerHarness();
    const grant = await h.seedPreview();
    expect((await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST })).kind).toBe('token');

    h.store.seedGrant('app_renewals', OWNER, { appRole: 'editor' }); // demoted
    expect((await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST })).kind).toBe('deny');
  });

  it('refuses a grant replayed against a different app', async () => {
    const h = await ownerHarness({ grants: [{ appId: 'app_sales', principal: OWNER, appRole: 'owner' }] });
    const grant = await h.seedPreview({ appId: 'app_sales' });
    const res = await h.gateway.mintPreview({ grant, script: 'renewals', host: HOST });
    expect(res.kind).toBe('deny');
  });
});
