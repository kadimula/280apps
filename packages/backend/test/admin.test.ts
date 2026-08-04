// The site-wide admin read surface: the server-side gate (its security core) and
// the JSON projection of each listing. Data-correctness of the joins, ordering,
// access override, and counts is owned by store.test.ts against real Postgres.

import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Identity } from '@280/contracts';
import type { HonoEnv } from '../src/observe.js';
import { newPlatform, newServer, testManifest, type Harness } from './helpers/harness.js';
import { newAuth, signIn } from './helpers/auth.js';

const ADMIN_EMAIL = 'admin@280.test';
const OWNER_EMAIL = 'owner@firm.com';
const ADMIN_ROUTES = ['/internal/admin/apps', '/internal/admin/users'];

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

async function userIdOf(app: Hono<HonoEnv>, session: string): Promise<string> {
  const res = await app.request('/auth/me', { headers: { Cookie: session } });
  return ((await res.json()) as { user: { id: string } }).user.id;
}

// A draft app (synced, never live): allAppsWithOwners LEFT-JOINs policies, so it
// still appears (with access '') without any live-deploy scaffolding.
async function draftApp(harness: Harness, userId: string, slug: string, clientRef: string): Promise<string> {
  const { manifest } = testManifest(`FROM scratch\n# ${slug}\n`);
  const res = await harness.platform.for(userId).sync({ identity: ident({ slug, clientRef }), manifest });
  return res.app.id;
}

// A harness with an admin signed in plus a separate non-admin owner who owns one
// app, so the owner join is exercised across a different owner.
async function fixture(): Promise<{
  app: Hono<HonoEnv>;
  adminSession: string;
  ownerSession: string;
  ownerAppId: string;
}> {
  const harness = await newPlatform();
  live.push(harness);
  const auth = newAuth(harness.store);
  const { app } = await newServer({ harness, auth, adminEmails: [ADMIN_EMAIL] });

  const adminSession = await signIn(app, ADMIN_EMAIL);
  const ownerSession = await signIn(app, OWNER_EMAIL);
  const ownerId = await userIdOf(app, ownerSession);
  const ownerAppId = await draftApp(harness, ownerId, 'renewals', 'owner-1');

  return { app, adminSession, ownerSession, ownerAppId };
}

interface AdminAppsBody {
  apps: Array<{ id: string; slug: string; url: string; access: string; createdAt: number; owner: { id: string; email: string; name: string } }>;
}
interface AdminUsersBody {
  users: Array<{ id: string; email: string; name: string; image: string; appCount: number; createdAt: number | null }>;
}

describe('admin listings (projection)', () => {
  it('apps: projects every app with its owner', async () => {
    const { app, adminSession, ownerAppId } = await fixture();
    const res = await app.request('/internal/admin/apps', { headers: { Cookie: adminSession } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminAppsBody;

    const ownerApp = body.apps.find((a) => a.id === ownerAppId);
    expect(ownerApp).toMatchObject({
      slug: 'renewals',
      owner: expect.objectContaining({ email: OWNER_EMAIL }),
    });
    expect(typeof ownerApp?.access).toBe('string');
    expect('url' in (ownerApp ?? {})).toBe(true);
  });

  it('users: projects every user with an app count', async () => {
    const { app, adminSession } = await fixture();
    const res = await app.request('/internal/admin/users', { headers: { Cookie: adminSession } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminUsersBody;

    const byEmail = new Map(body.users.map((u) => [u.email, u]));
    expect(byEmail.has(ADMIN_EMAIL)).toBe(true);
    expect(typeof byEmail.get(OWNER_EMAIL)?.appCount).toBe('number');
  });
});

describe('admin gate', () => {
  it.each(ADMIN_ROUTES)('refuses an authenticated non-admin with 403: %s', async (route) => {
    const { app, ownerSession } = await fixture();
    expect((await app.request(route, { headers: { Cookie: ownerSession } })).status).toBe(403);
  });

  it.each(ADMIN_ROUTES)('refuses an unauthenticated caller with 401: %s', async (route) => {
    const { app } = await fixture();
    expect((await app.request(route)).status).toBe(401);
  });

  it('a refusal carries no app or user list', async () => {
    const { app, ownerSession } = await fixture();
    const body = (await (await app.request('/internal/admin/apps', { headers: { Cookie: ownerSession } })).json()) as Record<string, unknown>;
    expect(body.apps).toBeUndefined();
    expect(body.users).toBeUndefined();
  });
});
