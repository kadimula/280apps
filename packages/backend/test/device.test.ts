// The device login flow and the session-gated web-surface endpoints (approve,
// list, delete). Ported from platform/device_test.go, then updated for phase 1:
// the web surface authenticates with the browser session, not a shared secret,
// and the approving user is whoever the session resolves to.

import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { AuthCode } from '@280/contracts';
import type { HonoEnv } from '../src/observe.js';
import { HttpClient, newPlatform, newServer, testManifest, type Harness } from './helpers/harness.js';
import { newAuth, signIn } from './helpers/auth.js';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

// shares the harness store so sessions and the deploy seam agree.
async function authServer(): Promise<Hono<HonoEnv>> {
  const harness = await newPlatform();
  live.push(harness);
  const auth = newAuth(harness.store);
  const s = await newServer({ harness, auth, verificationUri: 'https://280apps.com/activate' });
  return s.app;
}

interface Start {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
}

async function start(app: Hono<HonoEnv>): Promise<Start> {
  const res = await app.request('/v1/device/code', { method: 'POST' });
  expect(res.status).toBe(200);
  return (await res.json()) as Start;
}

interface TokenBody {
  code?: string;
  token?: string;
}

async function redeem(app: Hono<HonoEnv>, deviceCode: string): Promise<{ status: number; body: TokenBody }> {
  const res = await app.request('/v1/device/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceCode }),
  });
  return { status: res.status, body: (await res.json()) as TokenBody };
}

// a null session omits the cookie, exercising the sessionless-call case.
async function approve(app: Hono<HonoEnv>, userCode: string, session: string | null): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session !== null) headers.Cookie = session;
  const res = await app.request('/internal/device/approve', {
    method: 'POST',
    headers,
    body: JSON.stringify({ userCode }),
  });
  return res.status;
}

async function listApps(
  app: Hono<HonoEnv>,
  session: string | null,
): Promise<{ status: number; apps: Array<{ id: string; slug: string; url: string; live: boolean }> }> {
  const headers: Record<string, string> = {};
  if (session !== null) headers.Cookie = session;
  const res = await app.request('/internal/apps', { headers });
  const apps = res.status === 200 ? ((await res.json()) as { apps: [] }).apps : [];
  return { status: res.status, apps };
}

async function deleteApp(
  app: Hono<HonoEnv>,
  appId: string,
  confirm: string,
  session: string | null,
): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session !== null) headers.Cookie = session;
  const res = await app.request(`/internal/apps/${encodeURIComponent(appId)}/delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ confirm }),
  });
  return res.status;
}

// signs a browser in and runs a device flow it approves, returning the CLI token
// and the session that approved it.
async function login(app: Hono<HonoEnv>, email: string): Promise<{ token: string; session: string }> {
  const session = await signIn(app, email);
  const s = await start(app);
  expect(await approve(app, s.userCode, session)).toBe(204);
  const r = await redeem(app, s.deviceCode);
  expect(r.status).toBe(200);
  return { token: r.body.token as string, session };
}

describe('device flow', () => {
  it('start, approve in a browser, then redeem a working token', async () => {
    const app = await authServer();
    const session = await signIn(app, 'alice@test');
    const s = await start(app);
    expect(s.deviceCode).not.toBe('');
    expect(s.userCode).not.toBe('');
    expect(s.verificationUri).not.toBe('');

    // before approval the CLI must be told to wait, not that it failed
    const pending = await redeem(app, s.deviceCode);
    expect(pending.body.code).toBe(AuthCode.AuthorizationPending);

    expect(await approve(app, s.userCode, session)).toBe(204);

    const redeemed = await redeem(app, s.deviceCode);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.token).not.toBe('');

    // the token has to work on the deploy seam
    const client = new HttpClient(app, redeemed.body.token as string);
    const res = await client.sync({
      identity: { slug: 'demo', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });
    expect(res.app.id).not.toBe('');
  });

  it('a device code redeems exactly once', async () => {
    const app = await authServer();
    const session = await signIn(app, 'alice@test');
    const s = await start(app);
    await approve(app, s.userCode, session);
    expect((await redeem(app, s.deviceCode)).status).toBe(200);
    expect((await redeem(app, s.deviceCode)).status).not.toBe(200);
  });

  it('approve rejects a sessionless call and leaves the code pending', async () => {
    const app = await authServer();
    const s = await start(app);
    expect(await approve(app, s.userCode, null)).toBe(401);
    expect((await redeem(app, s.deviceCode)).body.code).toBe(AuthCode.AuthorizationPending);
  });

  it('same user converges on one identity across machines', async () => {
    const app = await authServer();
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const session = await signIn(app, 'alice@test');
      const s = await start(app);
      await approve(app, s.userCode, session);
      const r = await redeem(app, s.deviceCode);
      tokens.push(r.body.token as string);
    }
    expect(tokens[0]).not.toBe(tokens[1]);

    const first = await new HttpClient(app, tokens[0]!).sync({
      identity: { slug: 'demo', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });
    const second = await new HttpClient(app, tokens[1]!).sync({
      identity: { appId: first.app.id, slug: 'demo', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });
    expect(second.app.id).toBe(first.app.id);
  });

  it('user code is case- and dash-insensitive', async () => {
    const app = await authServer();
    const session = await signIn(app, 'alice@test');
    const s = await start(app);
    const sloppy = `  ${s.userCode.toLowerCase()}  `;
    expect(await approve(app, sloppy, session)).toBe(204);
    expect((await redeem(app, s.deviceCode)).status).toBe(200);
  });
});

describe('dashboard (session-gated endpoints)', () => {
  it('lists only the signed-in user own apps', async () => {
    const app = await authServer();
    const alice = await login(app, 'alice@test');
    await new HttpClient(app, alice.token).sync({
      identity: { slug: 'notes', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });
    const bob = await login(app, 'bob@test');
    await new HttpClient(app, bob.token).sync({
      identity: { slug: 'budget', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });

    const listed = await listApps(app, alice.session);
    expect(listed.status).toBe(200);
    expect(listed.apps.length).toBe(1);
    expect(listed.apps[0]!.slug).toBe('notes');
    expect(listed.apps[0]!.url).not.toBe('');
    expect(listed.apps[0]!.id).not.toBe('');
  });

  it('a signed-in user with no apps lists empty, not an error', async () => {
    const app = await authServer();
    const session = await signIn(app, 'nobody@test');
    const listed = await listApps(app, session);
    expect(listed.status).toBe(200);
    expect(listed.apps.length).toBe(0);
  });

  it('deletes an own app once the word is typed', async () => {
    const app = await authServer();
    const alice = await login(app, 'alice@test');
    const pushed = await new HttpClient(app, alice.token).sync({
      identity: { slug: 'notes', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });
    expect(await deleteApp(app, pushed.app.id, 'DELETE ', alice.session)).toBe(200);
    expect((await listApps(app, alice.session)).apps.length).toBe(0);
  });

  it('a missing or wrong confirmation destroys nothing', async () => {
    const app = await authServer();
    const alice = await login(app, 'alice@test');
    const pushed = await new HttpClient(app, alice.token).sync({
      identity: { slug: 'notes', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });
    for (const confirm of ['', 'notes', 'delet', 'yes']) {
      expect(await deleteApp(app, pushed.app.id, confirm, alice.session)).toBe(428);
    }
    expect((await listApps(app, alice.session)).apps.length).toBe(1);
  });

  it('cannot delete another user app', async () => {
    const app = await authServer();
    const alice = await login(app, 'alice@test');
    const pushed = await new HttpClient(app, alice.token).sync({
      identity: { slug: 'notes', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });
    const bob = await login(app, 'bob@test');
    expect(await deleteApp(app, pushed.app.id, 'delete', bob.session)).toBe(404);
    expect((await listApps(app, alice.session)).apps.length).toBe(1);
  });

  it('delete rejects a sessionless call', async () => {
    const app = await authServer();
    const alice = await login(app, 'alice@test');
    const pushed = await new HttpClient(app, alice.token).sync({
      identity: { slug: 'notes', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });
    expect(await deleteApp(app, pushed.app.id, 'delete', null)).toBe(401);
    expect((await listApps(app, alice.session)).apps.length).toBe(1);
  });

  it('list rejects a sessionless call', async () => {
    const app = await authServer();
    const listed = await listApps(app, null);
    expect(listed.status).toBe(401);
  });

  it('internal endpoints 404 when no auth is configured (fail closed)', async () => {
    const noAuth = await newServer({});
    live.push(noAuth.harness);
    const listed = await listApps(noAuth.app, 'anything=x');
    expect(listed.status).toBe(404);
  });
});
