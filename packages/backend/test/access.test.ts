// The Share modal's "General access" dial, server side: the owner-only mutation
// endpoint, its validation and audit, the override's durability across redeploys
// (design D5: the dashboard wins), and the grants-list fields the dialog renders
// (ownerTenant + consumer-domain flag, accessSource).

import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  MANIFEST_KIND_CONTAINER,
  digestBytes,
  type Identity,
  type Manifest,
} from '@280/contracts';
import { EventKind } from '../src/seams.js';
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

function policyManifest(over: Partial<Manifest> = {}): { manifest: Manifest; digest: string; body: Uint8Array } {
  const body = bytesOf('FROM scratch\n');
  const digest = digestBytes(body);
  return {
    manifest: {
      kind: MANIFEST_KIND_CONTAINER,
      build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
      files: [{ path: 'Dockerfile', digest, size: body.byteLength }],
      egress: { allowedHosts: [], credentials: [] },
      access: 'invited',
      roles: [],
      routes: [],
      secrets: [],
      ...over,
    },
    digest,
    body,
  };
}

interface Owned {
  app: Hono<HonoEnv>;
  session: string;
  appId: string;
  userId: string;
  harness: Harness;
}

// Signs the owner in, pushes their app live, and returns the wired router.
async function ownerApp(email = 'boss@firm.com'): Promise<Owned> {
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

async function setAccess(app: Hono<HonoEnv>, session: string, appId: string, access: string): Promise<Response> {
  return app.request(`/internal/apps/${appId}/access`, {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access }),
  });
}

async function grantsList(app: Hono<HonoEnv>, session: string, appId: string): Promise<Record<string, unknown>> {
  const res = await app.request(`/internal/apps/${appId}/grants`, { headers: { Cookie: session } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('POST /internal/apps/:app/access', () => {
  it('lets the owner set each of the three modes, effective immediately', async () => {
    const { app, session, appId, harness } = await ownerApp();

    for (const access of ['public', 'anyone-at-tenant', 'invited'] as const) {
      expect((await setAccess(app, session, appId, access)).status).toBe(204);
      expect((await harness.store.appPolicy(appId))!.access).toBe(access);
    }
  });

  it('marks the mode dashboard-sourced and audits the change naming the actor', async () => {
    const { app, session, appId, harness } = await ownerApp();
    expect((await setAccess(app, session, appId, 'public')).status).toBe(204);

    const data = await grantsList(app, session, appId);
    expect(data.access).toBe('public');
    expect(data.accessSource).toBe('dashboard');

    const events = await harness.store.recentEvents(50);
    const changed = events.find((e) => e.kind === EventKind.PolicyAccessChanged && e.appId === appId);
    expect(changed).toBeDefined();
    expect(JSON.parse(changed!.detail)).toEqual({ from: 'invited', to: 'public', by: 'boss@firm.com' });
  });

  it('rejects unknown modes, including the retired link value (fail closed)', async () => {
    const { app, session, appId, harness } = await ownerApp();
    expect((await setAccess(app, session, appId, 'link')).status).toBe(422);
    expect((await setAccess(app, session, appId, 'everyone')).status).toBe(422);
    expect((await setAccess(app, session, appId, '')).status).toBe(422);
    expect((await harness.store.appPolicy(appId))!.access).toBe('invited');
  });

  it('answers not-found for a signed-in non-owner and 401 unauthenticated', async () => {
    const { app, appId } = await ownerApp();
    const intruder = await signIn(app, 'mallory@evil.com');
    expect((await setAccess(app, intruder, appId, 'public')).status).toBe(404);

    const anon = await app.request(`/internal/apps/${appId}/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access: 'public' }),
    });
    expect(anon.status).toBe(401);
  });

  it('refuses an app that has never gone live (no policy row to override)', async () => {
    const harness = await newPlatform();
    live.push(harness);
    const auth = newAuth(harness.store);
    const s = await newServer({ harness, auth });
    const session = await signIn(s.app, 'boss@firm.com');
    const meRes = await s.app.request('/auth/me', { headers: { Cookie: session } });
    const userId = ((await meRes.json()) as { user: { id: string } }).user.id;

    // Sync only: the blob never lands, so the deploy never settles live.
    const { manifest } = policyManifest();
    const res = await harness.platform.for(userId).sync({ identity: ident(), manifest });

    expect((await setAccess(s.app, session, res.app.id, 'public')).status).toBe(422);
  });

  it('the dashboard override survives a redeploy whose 280.json says otherwise (D5)', async () => {
    const { app, session, appId, userId, harness } = await ownerApp();
    expect((await setAccess(app, session, appId, 'public')).status).toBe(204);

    // Redeploy declaring invited (also different roles, so the deploy id shifts).
    const { manifest, digest, body } = policyManifest({ roles: ['manager'] });
    const svc = harness.platform.for(userId);
    const res = await svc.sync({ identity: ident({ appId }), manifest });
    if (res.missing.length > 0) await svc.putBlob(appId, digest, body.byteLength, bodyOf(body));

    const policy = await harness.store.appPolicy(appId);
    expect(policy!.access).toBe('public');
    expect(policy!.accessSource).toBe('dashboard');
    expect(policy!.roles).toEqual(['manager']); // the deploy still registered everything else

    // The deploy status carries the one-line divergence notice for two80 push.
    const status = await svc.status(appId, res.deployId);
    expect(status.notice).toContain('"public"');
    expect(status.notice).toContain('280.json');
  });

  it('reports no notice while the override matches 280.json', async () => {
    const { app, session, appId, userId, harness } = await ownerApp();
    expect((await setAccess(app, session, appId, 'invited')).status).toBe(204);
    const svc = harness.platform.for(userId);
    const res = await svc.sync({ identity: ident({ appId }), manifest: policyManifest().manifest });
    expect((await svc.status(appId, res.deployId)).notice).toBe('');
  });
});

describe('grants list General-access fields', () => {
  it('returns ownerTenant with the consumer-domain flag off for an org owner', async () => {
    const { app, session, appId } = await ownerApp('boss@firm.com');
    const data = await grantsList(app, session, appId);
    expect(data.ownerTenant).toBe('firm.com');
    expect(data.ownerTenantIsConsumer).toBe(false);
    expect(data.accessSource).toBe('manifest');
  });

  it('flags a consumer-mail owner tenant so the dialog can disable anyone-at-tenant', async () => {
    const { app, session, appId } = await ownerApp('someone@gmail.com');
    const data = await grantsList(app, session, appId);
    expect(data.ownerTenant).toBe('gmail.com');
    expect(data.ownerTenantIsConsumer).toBe(true);
  });
});
