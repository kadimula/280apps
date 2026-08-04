// The site-wide admin read surface: every app across all owners and every user,
// gated server-side to the admin allowlist. Driven through the real router with a
// browser session, against whichever store backs the harness. The gate is the
// security boundary these tests exist to pin: a non-admin session, and an
// unauthenticated request, must both be refused here regardless of any frontend.

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

const ADMIN_EMAIL = 'admin@280.test';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

const ident = (over: Partial<Identity> = {}): Identity => ({
  appId: '',
  slug: 'demo',
  framework: 'next',
  gitRemote: '',
  clientRef: 'ref',
  forceNew: false,
  ...over,
});

// A minimal container manifest whose single file is the Dockerfile; access is the
// mode a live deploy registers into app_policies.
function policyManifest(access = 'invited'): { manifest: Manifest; digest: string; body: Uint8Array } {
  const body = bytesOf(`FROM scratch\n# ${access}\n`);
  const digest = digestBytes(body);
  return {
    manifest: {
      kind: MANIFEST_KIND_CONTAINER,
      build: { builder: 'static', dockerfile: 'Dockerfile', port: 8080 },
      files: [{ path: 'Dockerfile', digest, size: body.byteLength }],
      egress: { allowedHosts: [], credentials: [] },
      access,
      roles: [],
      routes: [],
      secrets: [],
    },
    digest,
    body,
  };
}

async function userIdOf(app: Hono<HonoEnv>, session: string): Promise<string> {
  const res = await app.request('/auth/me', { headers: { Cookie: session } });
  return ((await res.json()) as { user: { id: string } }).user.id;
}

// Creates an app for the given user; when live it also uploads the one blob so a
// policy row is registered (giving it a real access mode).
async function makeApp(
  harness: Harness,
  userId: string,
  opts: { slug: string; clientRef: string; live: boolean; access?: string },
): Promise<string> {
  const { manifest, digest, body } = policyManifest(opts.access ?? 'invited');
  const svc = harness.platform.for(userId);
  const res = await svc.sync({ identity: ident({ slug: opts.slug, clientRef: opts.clientRef }), manifest });
  if (opts.live && res.missing.length > 0) {
    await svc.putBlob(res.app.id, digest, body.byteLength, bodyOf(body));
  }
  return res.app.id;
}

// A harness with an admin signed in, plus a separate non-admin owner who owns one
// live app. Returns the router, both sessions, and the identifiers a test asserts on.
async function fixture(): Promise<{
  app: Hono<HonoEnv>;
  adminSession: string;
  ownerSession: string;
  ownerEmail: string;
  liveAppId: string;
  draftAppId: string;
}> {
  const harness = await newPlatform();
  live.push(harness);
  const auth = newAuth(harness.store);
  const { app } = await newServer({ harness, auth, adminEmails: [ADMIN_EMAIL] });

  const adminSession = await signIn(app, ADMIN_EMAIL);
  const adminId = await userIdOf(app, adminSession);

  const ownerEmail = 'owner@firm.com';
  const ownerSession = await signIn(app, ownerEmail);
  const ownerId = await userIdOf(app, ownerSession);

  // An app owned by someone other than the admin, so the owner join is exercised.
  const liveAppId = await makeApp(harness, ownerId, {
    slug: 'renewals',
    clientRef: 'owner-1',
    live: true,
    access: 'invited',
  });
  // An app the admin owns that never went live: no policy row, so access is ''.
  const draftAppId = await makeApp(harness, adminId, {
    slug: 'draft',
    clientRef: 'admin-1',
    live: false,
  });

  return { app, adminSession, ownerSession, ownerEmail, liveAppId, draftAppId };
}

interface AdminAppsBody {
  apps: Array<{ id: string; slug: string; url: string; access: string; createdAt: number; owner: { id: string; email: string; name: string } }>;
}
interface AdminUsersBody {
  users: Array<{ id: string; email: string; name: string; image: string; appCount: number; createdAt: number | null }>;
}

describe('admin apps listing', () => {
  it('returns every app with owner identity and effective access mode', async () => {
    const { app, adminSession, ownerEmail, liveAppId, draftAppId } = await fixture();
    const res = await app.request('/internal/admin/apps', { headers: { Cookie: adminSession } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminAppsBody;

    const found = new Map(body.apps.map((a) => [a.id, a]));
    const liveApp = found.get(liveAppId);
    expect(liveApp).toBeDefined();
    expect(liveApp?.owner.email).toBe(ownerEmail);
    expect(liveApp?.slug).toBe('renewals');
    expect(liveApp?.access).toBe('invited');
    expect(typeof liveApp?.createdAt).toBe('number');

    // The admin's own never-live app has no policy row, so its access is empty.
    expect(found.get(draftAppId)?.access).toBe('');
  });

  it('sorts newest-first by created_at', async () => {
    const { app, adminSession } = await fixture();
    const body = (await (await app.request('/internal/admin/apps', { headers: { Cookie: adminSession } })).json()) as AdminAppsBody;
    const times = body.apps.map((a) => a.createdAt);
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });
});

describe('admin users listing', () => {
  it('returns every user with the count of apps they own', async () => {
    const { app, adminSession, ownerEmail } = await fixture();
    const res = await app.request('/internal/admin/users', { headers: { Cookie: adminSession } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminUsersBody;

    const byEmail = new Map(body.users.map((u) => [u.email, u]));
    expect(byEmail.get(ADMIN_EMAIL)?.appCount).toBe(1);
    expect(byEmail.get(ownerEmail)?.appCount).toBe(1);
    // created_at is a real column, so it is always present as a number.
    expect(typeof byEmail.get(ownerEmail)?.createdAt).toBe('number');
  });
});

describe('admin gate', () => {
  it('refuses an authenticated non-admin with 403 on both endpoints', async () => {
    const { app, ownerSession } = await fixture();
    expect((await app.request('/internal/admin/apps', { headers: { Cookie: ownerSession } })).status).toBe(403);
    expect((await app.request('/internal/admin/users', { headers: { Cookie: ownerSession } })).status).toBe(403);
  });

  it('refuses an unauthenticated caller with 401 on both endpoints', async () => {
    const { app } = await fixture();
    expect((await app.request('/internal/admin/apps')).status).toBe(401);
    expect((await app.request('/internal/admin/users')).status).toBe(401);
  });

  it('does not leak data to a non-admin: the refusal carries no app or user list', async () => {
    const { app, ownerSession } = await fixture();
    const res = await app.request('/internal/admin/apps', { headers: { Cookie: ownerSession } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.apps).toBeUndefined();
  });
});
