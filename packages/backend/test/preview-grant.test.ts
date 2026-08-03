// The dashboard preview-grant endpoint: session-authed, scoped to an app the
// caller owns, admin+ enforced, viewAs validated against the app's roles, and the
// grant stored only as a hash (the device-code discipline).

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  MANIFEST_KIND_CONTAINER,
  digestBytes,
  type Identity,
  type Manifest,
} from '@280/contracts';
import type { HonoEnv } from '../src/observe.js';
import { bodyOf, bytesOf, newPlatform, newServer, type Harness } from './helpers/harness.js';
import { newAuth, signIn } from './helpers/auth.js';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

const ident = (over: Partial<Identity> = {}): Identity => ({
  appId: '',
  slug: 'renewals',
  framework: 'next',
  gitRemote: '',
  clientRef: 'ref1',
  forceNew: false,
  ...over,
});

function policyManifest(): { manifest: Manifest; digest: string; body: Uint8Array } {
  const body = bytesOf('FROM scratch\n');
  const digest = digestBytes(body);
  return {
    manifest: {
      kind: MANIFEST_KIND_CONTAINER,
      build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
      files: [{ path: 'Dockerfile', digest, size: body.byteLength }],
      egress: { allowedHosts: [], credentials: [] },
      access: 'invited',
      roles: ['manager'],
      routes: [],
      secrets: [],
    },
    digest,
    body,
  };
}

function hashToken(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function ownerApp(email = 'boss@firm.com'): Promise<{
  app: Hono<HonoEnv>;
  session: string;
  appId: string;
  userId: string;
  harness: Harness;
}> {
  const harness = await newPlatform();
  live.push(harness);
  const auth = newAuth(harness.store);
  const s = await newServer({ harness, auth });
  const session = await signIn(s.app, email);

  const meRes = await s.app.request('/auth/me', { headers: { Cookie: session } });
  const userId = ((await meRes.json()) as { user: { id: string } }).user.id;

  const { manifest, digest, body } = policyManifest();
  const svc = harness.platform.for(userId);
  const res = await svc.sync({ identity: ident(), manifest });
  if (res.missing.length > 0) await svc.putBlob(res.app.id, digest, body.byteLength, bodyOf(body));

  return { app: s.app, session, appId: res.app.id, userId, harness };
}

async function requestGrant(
  app: Hono<HonoEnv>,
  session: string,
  appId: string,
  viewAs?: unknown,
): Promise<Response> {
  return app.request(`/internal/apps/${appId}/preview-grant`, {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'application/json' },
    body: JSON.stringify(viewAs === undefined ? {} : { viewAs }),
  });
}

interface GrantBody {
  grant: string;
  expiresIn: number;
  url: string;
}

describe('preview-grant endpoint', () => {
  it('issues an opaque grant, stored only as a hash, defaulting to viewAs none', async () => {
    const { app, session, appId, userId, harness } = await ownerApp();
    const res = await requestGrant(app, session, appId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GrantBody;
    expect(body.grant).not.toBe('');
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.url).toContain(`/__280/preview?g=${body.grant}`);

    // Only the hash reaches the store; the row binds app, owner, and target.
    expect(await harness.store.previewGrantByHash(body.grant)).toBeNull();
    const stored = await harness.store.previewGrantByHash(hashToken(body.grant));
    expect(stored).toMatchObject({
      appId,
      ownerUserId: userId,
      viewAs: { kind: 'none' },
      revoked: false,
    });
    expect(stored!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('bakes a user target into the grant, lowercasing the email', async () => {
    const { app, session, appId, harness } = await ownerApp();
    const res = await requestGrant(app, session, appId, { kind: 'user', email: 'Alice@Firm.com' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GrantBody;
    const stored = await harness.store.previewGrantByHash(hashToken(body.grant));
    expect(stored!.viewAs).toEqual({ kind: 'user', email: 'alice@firm.com' });
  });

  it('accepts a declared feature role and refuses an undeclared one', async () => {
    const { app, session, appId } = await ownerApp();
    const ok = await requestGrant(app, session, appId, { kind: 'role', featureRole: 'manager' });
    expect(ok.status).toBe(200);
    const bad = await requestGrant(app, session, appId, { kind: 'role', featureRole: 'ghost' });
    expect(bad.status).toBe(422);
  });

  it('refuses a malformed target: an unknown app role, an empty role, a non-email user', async () => {
    const { app, session, appId } = await ownerApp();
    expect((await requestGrant(app, session, appId, { kind: 'role', appRole: 'root' })).status).toBe(422);
    expect((await requestGrant(app, session, appId, { kind: 'role' })).status).toBe(422);
    expect((await requestGrant(app, session, appId, { kind: 'user', email: 'not-an-email' })).status).toBe(422);
    expect((await requestGrant(app, session, appId, { kind: 'wat' })).status).toBe(422);
  });

  it("is scoped to the caller's own apps: another account gets not-found", async () => {
    const { app, appId } = await ownerApp();
    const otherSession = await signIn(app, 'other@elsewhere.com');
    expect((await requestGrant(app, otherSession, appId)).status).toBe(404);
    expect((await requestGrant(app, otherSession, appId, { kind: 'none' })).status).toBe(404);
  });

  it('requires the caller to still hold admin+ on the app (viewAsAllowed semantics)', async () => {
    const { app, session, appId, harness } = await ownerApp();
    // A second owner exists, so demoting the caller below admin is allowed…
    await harness.store.putGrant({
      appId,
      principal: 'co-owner@firm.com',
      appRole: 'owner',
      featureRole: '',
      dataScope: null,
      grantedBy: 'test',
      grantedAt: 0,
    });
    await harness.store.putGrant({
      appId,
      principal: 'boss@firm.com',
      appRole: 'editor',
      featureRole: '',
      dataScope: null,
      grantedBy: 'test',
      grantedAt: 0,
    });
    // …and once demoted, the account owner can no longer issue preview grants.
    expect((await requestGrant(app, session, appId)).status).toBe(422);
  });
});
