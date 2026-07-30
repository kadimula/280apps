// The share dialog's server surface: list/grant/revoke on both tiers, the
// server-rendered dialog page, the view-as link target, last-owner protection, and
// account-scoped authorization. Driven through the real router with a browser
// session, against whichever store backs the harness.

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
      roles: ['manager', 'analyst'],
      routes: [{ path: '/admin/*', appRole: 'admin', role: '' }],
      secrets: [],
    },
    digest,
    body,
  };
}

// Signs the owner in, gives their account an app with a live policy, and returns
// the router, the session cookie, and the app id.
async function ownerApp(email = 'boss@firm.com'): Promise<{ app: Hono<HonoEnv>; session: string; appId: string; harness: Harness }> {
  const harness = await newPlatform();
  live.push(harness);
  const auth = newAuth(harness.store);
  const s = await newServer({ harness, auth });
  const session = await signIn(s.app, email);

  const meRes = await s.app.request('/auth/me', { headers: { Cookie: session } });
  const userId = ((await meRes.json()) as { user: { id: string } }).user.id;
  const acct = await harness.store.ensureAccount(userId, 'acct_' + userId);

  const { manifest, digest, body } = policyManifest();
  const svc = harness.platform.for(acct.id);
  const res = await svc.sync({ identity: ident(), manifest });
  if (res.missing.length > 0) await svc.putBlob(res.app.id, digest, body.byteLength, bodyOf(body));

  return { app: s.app, session, appId: res.app.id, harness };
}

async function grants(app: Hono<HonoEnv>, session: string, appId: string): Promise<Response> {
  return app.request(`/internal/apps/${appId}/grants`, { headers: { Cookie: session } });
}

async function putGrant(app: Hono<HonoEnv>, session: string, appId: string, body: unknown): Promise<Response> {
  return app.request(`/internal/apps/${appId}/grants`, {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function revoke(app: Hono<HonoEnv>, session: string, appId: string, principal: string): Promise<Response> {
  return app.request(`/internal/apps/${appId}/grants/revoke`, {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ principal }),
  });
}

describe('share dialog data', () => {
  it('lists the owner grant, the role vocabulary, and the view-as origin', async () => {
    const { app, session, appId } = await ownerApp();
    const res = await grants(app, session, appId);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      access: string;
      roles: string[];
      viewAsOrigin: string;
      script: string;
      grants: Array<{ principal: string; appRole: string }>;
    };
    expect(data.access).toBe('invited');
    expect(data.roles).toEqual(['manager', 'analyst']);
    expect(data.viewAsOrigin).toBe('https://auth.280apps.run');
    expect(data.grants.find((g) => g.principal === 'boss@firm.com')?.appRole).toBe('owner');
  });

  it('grants a viewer and then revokes them (tier 1)', async () => {
    const { app, session, appId } = await ownerApp();
    expect((await putGrant(app, session, appId, { principal: 'Alice@Firm.com', appRole: 'viewer' })).status).toBe(204);

    let data = (await (await grants(app, session, appId)).json()) as { grants: Array<{ principal: string; appRole: string }> };
    // The principal was normalized to lowercase so the gateway will match it.
    expect(data.grants.find((g) => g.principal === 'alice@firm.com')?.appRole).toBe('viewer');

    expect((await revoke(app, session, appId, 'alice@firm.com')).status).toBe(204);
    data = (await (await grants(app, session, appId)).json()) as { grants: Array<{ principal: string }> };
    expect(data.grants.some((g) => g.principal === 'alice@firm.com')).toBe(false);
  });

  it('assigns a declared feature role but rejects an undeclared one (tier 2)', async () => {
    const { app, session, appId } = await ownerApp();
    expect(
      (await putGrant(app, session, appId, { principal: 'm@firm.com', appRole: 'viewer', featureRole: 'manager' })).status,
    ).toBe(204);
    const bad = await putGrant(app, session, appId, { principal: 'g@firm.com', appRole: 'viewer', featureRole: 'ghost' });
    expect(bad.status).toBe(422);
  });

  it('rejects an unknown app role', async () => {
    const { app, session, appId } = await ownerApp();
    expect((await putGrant(app, session, appId, { principal: 'x@firm.com', appRole: 'superuser' })).status).toBe(422);
  });

  it('will not remove the app\'s only owner', async () => {
    const { app, session, appId } = await ownerApp();
    expect((await revoke(app, session, appId, 'boss@firm.com')).status).toBe(422);
    expect((await putGrant(app, session, appId, { principal: 'boss@firm.com', appRole: 'editor' })).status).toBe(422);
  });
});

describe('share dialog page', () => {
  it('renders both surfaces and the view-as origin', async () => {
    const { app, session, appId } = await ownerApp();
    const res = await app.request(`/internal/apps/${appId}/share`, { headers: { Cookie: session } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('App access');
    expect(html).toContain('Feature roles');
    expect(html).toContain('https://auth.280apps.run');
    expect(html).toContain('renewals');
  });
});

describe('share dialog authorization', () => {
  it('answers not-found for a signed-in user who does not own the app', async () => {
    const { app, appId } = await ownerApp();
    const intruder = await signIn(app, 'mallory@evil.com');
    expect((await grants(app, intruder, appId)).status).toBe(404);
    expect((await putGrant(app, intruder, appId, { principal: 'x@e.com', appRole: 'admin' })).status).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    const { app, appId } = await ownerApp();
    const res = await app.request(`/internal/apps/${appId}/grants`);
    expect(res.status).toBe(401);
  });
});
