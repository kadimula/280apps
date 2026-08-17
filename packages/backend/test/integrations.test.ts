// The executable end-to-end specification for the integrations feature (design phase
// 0): it drives the real Hono app against a fake Google server through the whole
// owner journey — start, callback, resource registration, SDK read/append, refresh,
// disconnect — and asserts the security boundaries: cross-app replay fails, anonymous
// is denied, a revoked connection stops serving, and an invalid grant surfaces as
// reauthorization_required. Nothing reaches the network.

import { afterEach, describe, expect, it } from 'vitest';
import { IdentitySigner, publicJwkFromPrivate } from '@280/contracts/identity';
import { Server } from '../src/api.js';
import type { RequestDeps } from '../src/config.js';
import { EnvelopeSecretCipher, LocalKeyWrapper } from '../src/secrets.js';
import { IntegrationService } from '../src/integrations/service.js';
import { ProviderRegistry } from '../src/integrations/registry.js';
import { GoogleWorkspaceProvider } from '../src/integrations/google/provider.js';
import { SdkIdentityVerifier } from '../src/integrations/sdk-identity.js';
import { State } from '@280/contracts';
import { newPlatform, testDeps, testManifest } from './helpers/harness.js';
import { newAuth, signIn, cookiePair } from './helpers/auth.js';

const INT_COOKIE = '280_int_oauth';
const JWKS_URI = 'https://auth.test/.well-known/280-identity.jwks';
const ISSUER = 'https://auth.test';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function googleIdToken(sub: string, email: string): string {
  return `${b64url({ alg: 'RS256' })}.${b64url({ sub, email })}.sig`;
}

interface DeletedDimension {
  sheetId: number;
  startIndex: number;
  endIndex: number;
}

interface GoogleState {
  refreshCalls: number;
  invalidGrant: boolean;
  revoked: boolean;
  appended: unknown[][];
  updated: unknown[][];
  deleted: DeletedDimension[];
  sheetsMeta: Array<{ sheetId: number; index: number; title: string }>;
}

function fakeGoogle(): { state: GoogleState; fetchImpl: typeof fetch } {
  const state: GoogleState = {
    refreshCalls: 0,
    invalidGrant: false,
    revoked: false,
    appended: [],
    updated: [],
    deleted: [],
    sheetsMeta: [
      { sheetId: 111, index: 0, title: 'Orders' },
      { sheetId: 222, index: 1, title: 'Archive' },
    ],
  };
  const json = (obj: unknown, status = 200): Response =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const params = new URLSearchParams(String(init?.body ?? ''));
      const grant = params.get('grant_type');
      if (grant === 'authorization_code') {
        return json({
          access_token: 'at1',
          refresh_token: 'rt1',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email https://www.googleapis.com/auth/drive.file',
          id_token: googleIdToken('g-owner', 'owner@acme.com'),
        });
      }
      if (grant === 'refresh_token') {
        state.refreshCalls++;
        if (state.invalidGrant) return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: 'at2', expires_in: 3600, token_type: 'Bearer' });
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }

    if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
      state.revoked = true;
      return new Response(null, { status: 200 });
    }

    if (url.startsWith('https://www.googleapis.com/drive/v3/files/')) {
      return json({ id: 'sheet_orders', name: 'Orders', mimeType: 'application/vnd.google-apps.spreadsheet' });
    }

    if (url.startsWith('https://sheets.googleapis.com/')) {
      if (method === 'GET' && !url.includes('/values/')) {
        return json({ sheets: state.sheetsMeta.map((s) => ({ properties: { sheetId: s.sheetId, index: s.index, title: s.title } })) });
      }
      if (method === 'GET') return json({ range: 'Orders!A:D', majorDimension: 'ROWS', values: state.appended });
      if (url.includes(':batchUpdate')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { requests?: Array<{ deleteDimension?: { range: DeletedDimension } }> };
        for (const req of body.requests ?? []) {
          if (req.deleteDimension) state.deleted.push(req.deleteDimension.range);
        }
        return json({ replies: [{}] });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { values?: unknown[][]; range?: string };
      const values = body.values ?? [];
      if (url.includes(':append')) {
        state.appended.push(...values);
        return json({ updates: { updatedRange: 'Orders!A5', updatedRows: values.length, updatedCells: values.flat().length } });
      }
      state.updated.push(...values);
      return json({ updatedRange: body.range ?? '', updatedRows: values.length, updatedCells: values.flat().length });
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return { state, fetchImpl };
}

interface World {
  app: ReturnType<Server['handler']>;
  session: string;
  google: GoogleState;
  integrations: IntegrationService;
  store: Awaited<ReturnType<typeof newPlatform>>['store'];
  identityToken: (over?: Record<string, unknown>) => Promise<string>;
  advance: (secs: number) => void;
  cleanup: () => Promise<void>;
}

async function makeWorld(): Promise<World> {
  const harness = await newPlatform();
  const cipher = new EnvelopeSecretCipher(new LocalKeyWrapper(Buffer.alloc(32, 9).toString('base64'), 'itest'));
  const google = fakeGoogle();
  const registry = new ProviderRegistry([
    new GoogleWorkspaceProvider({ clientId: 'cid', clientSecret: 'sec', fetch: google.fetchImpl }),
  ]);

  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const publicJwk = publicJwkFromPrivate(privateJwk, 'test-kid');
  const signer = new IdentitySigner({ kid: 'test-kid', privateJwk, issuer: ISSUER });
  const jwksFetch = (async (input: RequestInfo | URL): Promise<Response> =>
    String(input) === JWKS_URI
      ? new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'Content-Type': 'application/json' } })
      : new Response('not found', { status: 404 })) as typeof fetch;
  const identity = new SdkIdentityVerifier({ jwksUri: JWKS_URI, issuer: ISSUER, fetch: jwksFetch });

  let clock = Math.floor(Date.now() / 1000);
  const integrations = new IntegrationService({
    store: harness.store,
    cipher,
    registry,
    identity,
    config: { apiOrigin: 'https://api.test', frontendOrigin: 'https://app.test', picker: { apiKey: 'pk', projectNumber: '42' } },
    now: () => clock,
  });

  const auth = newAuth(harness.store);
  const deps: RequestDeps = { ...testDeps(harness, { auth }), integrations };
  const app = new Server({ buildDeps: () => deps }).handler();

  const session = await signIn(app, 'owner@acme.com');
  const owner = await harness.store.userByEmail('owner@acme.com');
  await harness.store.createApp({
    id: 'app_orders',
    userId: owner!.id,
    slug: 'orders',
    framework: 'next',
    url: 'https://orders.280apps.run',
    script: 'orders-script',
    salt: 's',
    fingerprint: '',
    clientRef: '',
    activeDeploy: '',
    createdAt: 0,
    lastDeployAt: null,
  });

  const identityToken = (over: Record<string, unknown> = {}): Promise<string> =>
    signer.sign({ sub: 'g-owner', email: 'owner@acme.com', name: 'Owner', aud: 'orders.280apps.run', app: 'app_orders', role: 'owner', ...over });

  return { app, session, google: google.state, integrations, store: harness.store, identityToken, advance: (s) => (clock += s), cleanup: harness.cleanup };
}

async function connect(w: World): Promise<string> {
  const start = await w.app.request('/internal/apps/app_orders/integrations/google/start?redirect=%2Fdashboard%2Fapp_orders', {
    headers: { Cookie: w.session },
  });
  if (start.status !== 302) throw new Error(`start ${start.status}`);
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const intCookie = cookiePair(start, INT_COOKIE);
  if (intCookie === null) throw new Error('no oauth cookie');

  const cb = await w.app.request(`/integrations/google/callback?code=auth123&state=${state}`, { headers: { Cookie: intCookie } });
  if (cb.status !== 302) throw new Error(`callback ${cb.status}`);

  const list = (await (await w.app.request('/internal/apps/app_orders/integrations', { headers: { Cookie: w.session } })).json()) as {
    connections: Array<{ id: string }>;
  };
  const connId = list.connections[0]!.id;
  await w.app.request(`/internal/apps/app_orders/integrations/${connId}/resources`, {
    method: 'POST',
    headers: { Cookie: w.session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ capability: 'google-sheets', alias: 'orders', externalId: 'sheet_orders' }),
  });
  return connId;
}

function sdk(w: World, op: string, token: string, body: unknown): Promise<Response> {
  return w.app.request(`/v1/sdk/integrations/google-sheets/${op}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('integrations end to end', () => {
  let world: World | null = null;
  afterEach(async () => {
    if (world) await world.cleanup();
    world = null;
  });

  it('runs the full owner journey and stops serving after disconnect', async () => {
    world = await makeWorld();
    const w = world;

    // Start: redirect to Google consent, offline access, drive.file scope.
    const start = await w.app.request('/internal/apps/app_orders/integrations/google/start', { headers: { Cookie: w.session } });
    expect(start.status).toBe(302);
    const authUrl = new URL(start.headers.get('location') ?? '');
    expect(authUrl.host).toBe('accounts.google.com');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('scope')).toContain('drive.file');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authUrl.searchParams.get('state') ?? '';
    const intCookie = cookiePair(start, INT_COOKIE) ?? '';

    // Callback: exchange the code, store the encrypted credential, land back safely.
    const cb = await w.app.request(`/integrations/google/callback?code=auth123&state=${state}`, { headers: { Cookie: intCookie } });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('https://app.test/dashboard');

    // List: one active connection to the right account, no resources yet.
    const list = (await (await w.app.request('/internal/apps/app_orders/integrations', { headers: { Cookie: w.session } })).json()) as {
      providers: Array<{ provider: string }>;
      connections: Array<{ id: string; provider: string; status: string; account: string; resources: unknown[] }>;
    };
    expect(list.providers).toEqual([{ provider: 'google', capabilities: ['google-sheets'] }]);
    expect(list.connections).toHaveLength(1);
    const conn = list.connections[0]!;
    expect(conn.provider).toBe('google');
    expect(conn.status).toBe('active');
    expect(conn.account).toBe('owner@acme.com');
    expect(conn.resources).toHaveLength(0);

    // Selector session: a short-lived token plus the restricted Picker config.
    const selRes = await w.app.request(`/internal/apps/app_orders/integrations/${conn.id}/selector-session`, {
      method: 'POST',
      headers: { Cookie: w.session },
    });
    expect(selRes.status).toBe(200);
    const sel = (await selRes.json()) as { accessToken: string; pickerApiKey: string; projectNumber: string };
    expect(sel.accessToken).toBe('at1');
    expect(sel.pickerApiKey).toBe('pk');
    expect(sel.projectNumber).toBe('42');

    // Register the selected spreadsheet under an alias; the backend validates it.
    const reg = await w.app.request(`/internal/apps/app_orders/integrations/${conn.id}/resources`, {
      method: 'POST',
      headers: { Cookie: w.session, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: 'google-sheets', alias: 'orders', externalId: 'sheet_orders' }),
    });
    expect(reg.status).toBe(200);
    expect((await reg.json()) as { displayName: string }).toMatchObject({ displayName: 'Orders' });

    // SDK append: the app sends an alias, never a file id or a Google token.
    const token = await w.identityToken();
    const appendRes = await sdk(w, 'append', token, { resource: 'orders', range: 'Orders!A:D', values: [['1', 'a@b.com', '9.99', 'now']] });
    expect(appendRes.status).toBe(200);
    expect((await appendRes.json()) as { updatedCells: number }).toMatchObject({ updatedCells: 4 });
    expect(w.google.appended).toContainEqual(['1', 'a@b.com', '9.99', 'now']);

    // SDK read returns what was appended.
    const readRes = await sdk(w, 'read', token, { resource: 'orders', range: 'Orders!A:D' });
    expect(readRes.status).toBe(200);
    expect(((await readRes.json()) as { values: unknown[][] }).values).toContainEqual(['1', 'a@b.com', '9.99', 'now']);

    // No refresh needed yet.
    expect(w.google.refreshCalls).toBe(0);

    // Advance past the access-token lifetime; the next call refreshes once, race-safe.
    w.advance(4000);
    const later = await sdk(w, 'append', await w.identityToken(), { resource: 'orders', range: 'Orders!A:D', values: [['2', 'c@d.com', '1', 'now']] });
    expect(later.status).toBe(200);
    expect(w.google.refreshCalls).toBe(1);

    // Disconnect revokes at Google and removes the connection locally.
    const disc = await w.app.request(`/internal/apps/app_orders/integrations/${conn.id}`, { method: 'DELETE', headers: { Cookie: w.session } });
    expect(disc.status).toBe(204);
    expect(w.google.revoked).toBe(true);

    // The old identity no longer resolves to any connection.
    const after = await sdk(w, 'append', await w.identityToken(), { resource: 'orders', range: 'Orders!A:D', values: [['x']] });
    expect(after.status).toBe(404);
    expect((await after.json()) as { error: string }).toMatchObject({ error: 'not_connected' });
  });

  it('surfaces declared required aliases and their readiness for the handoff', async () => {
    world = await makeWorld();
    const w = world;

    // A parked deploy declares a required alias. Its policy is not registered until
    // it goes live, so the list must read the requirement from the deploy manifest.
    const { manifest } = testManifest('parked worker');
    manifest.integrations = [{ alias: 'orders', capability: 'google-sheets', operations: ['read', 'append'] }];
    await w.store.openDeploy({ appId: 'app_orders', id: 'dep_parked', manifest, state: State.WaitingSecrets, failure: null });

    const listUrl = '/internal/apps/app_orders/integrations';
    type Catalog = {
      connections: Array<{ id: string; resources: Array<{ capability: string; alias: string }> }>;
      requirements: Array<{ alias: string; capability: string; operations: string[] }>;
    };
    const before = (await (await w.app.request(listUrl, { headers: { Cookie: w.session } })).json()) as Catalog;
    expect(before.requirements).toEqual([
      { alias: 'orders', capability: 'google-sheets', operations: ['read', 'append'] },
    ]);
    // Unbound: no connection carries a matching resource yet.
    const bound = (cat: Catalog) =>
      cat.connections.some((c) => c.resources.some((r) => r.capability === 'google-sheets' && r.alias === 'orders'));
    expect(bound(before)).toBe(false);

    // Binding the required alias (the connect helper connects and aliases 'orders')
    // readies it — the same state resumeWaiting keys on to un-park the deploy.
    await connect(w);
    const after = (await (await w.app.request(listUrl, { headers: { Cookie: w.session } })).json()) as Catalog;
    expect(after.requirements).toHaveLength(1);
    expect(bound(after)).toBe(true);
  });

  it('refuses a token minted for another app (cross-app replay)', async () => {
    world = await makeWorld();
    await connect(world);
    const foreign = await world.identityToken({ app: 'app_intruder', aud: 'intruder.280apps.run' });
    const res = await sdk(world, 'append', foreign, { resource: 'orders', range: 'Orders!A:D', values: [['x']] });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'not_connected' });
  });

  it('denies an anonymous identity', async () => {
    world = await makeWorld();
    await connect(world);
    const anon = await world.identityToken({ sub: 'anon', email: '', anon: true });
    const res = await sdk(world, 'read', anon, { resource: 'orders', range: 'Orders!A:D' });
    expect(res.status).toBe(403);
  });

  it('rejects an unsigned/garbage identity token', async () => {
    world = await makeWorld();
    await connect(world);
    const res = await sdk(world, 'read', 'not-a-jwt', { resource: 'orders', range: 'Orders!A:D' });
    expect(res.status).toBe(401);
  });

  it('surfaces an invalid grant as reauthorization_required and marks the connection', async () => {
    world = await makeWorld();
    const connId = await connect(world);
    world.google.invalidGrant = true;
    world.advance(4000);

    const res = await sdk(world, 'append', await world.identityToken(), { resource: 'orders', range: 'Orders!A:D', values: [['x']] });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'reauthorization_required' });

    const list = (await (await world.app.request('/internal/apps/app_orders/integrations', { headers: { Cookie: world.session } })).json()) as {
      connections: Array<{ id: string; status: string }>;
    };
    expect(list.connections.find((c) => c.id === connId)?.status).toBe('reauthorization_required');
  });

  it('enforces operation bounds', async () => {
    world = await makeWorld();
    await connect(world);
    const token = await world.identityToken();
    const noRange = await sdk(world, 'read', token, { resource: 'orders', range: '' });
    expect(noRange.status).toBe(400);
    const noResource = await sdk(world, 'append', token, { resource: '', range: 'Orders!A:D', values: [['x']] });
    expect(noResource.status).toBe(400);
  });

  it('deletes rows and resolves the sheet by index or title', async () => {
    world = await makeWorld();
    const w = world;
    await connect(w);
    const token = await w.identityToken();

    // Default sheet (index 0) maps to sheetId 111; startRow is one-based, so row 3 → startIndex 2.
    const del = await sdk(w, 'deleteRows', token, { resource: 'orders', startRow: 3, rowCount: 2 });
    expect(del.status).toBe(200);
    expect((await del.json()) as { sheetId: number; deletedRows: number; startRow: number }).toMatchObject({
      sheetId: 111,
      deletedRows: 2,
      startRow: 3,
    });
    expect(w.google.deleted).toContainEqual(expect.objectContaining({ sheetId: 111, dimension: 'ROWS', startIndex: 2, endIndex: 4 }));

    // Selecting by title resolves the second sheet.
    const byTitle = await sdk(w, 'deleteRows', token, { resource: 'orders', sheet: 'Archive', startRow: 1, rowCount: 1 });
    expect(byTitle.status).toBe(200);
    expect((await byTitle.json()) as { sheetId: number }).toMatchObject({ sheetId: 222 });
    expect(w.google.deleted).toContainEqual(expect.objectContaining({ sheetId: 222, startIndex: 0, endIndex: 1 }));
  });

  it('rejects invalid deleteRows bounds', async () => {
    world = await makeWorld();
    const w = world;
    await connect(w);
    const token = await w.identityToken();
    for (const body of [
      { resource: 'orders', startRow: 1, rowCount: 0 },
      { resource: 'orders', startRow: 1, rowCount: -2 },
      { resource: 'orders', startRow: 0, rowCount: 1 },
      { resource: 'orders', startRow: 1, rowCount: 100000 },
      { resource: 'orders', sheet: -1, startRow: 1, rowCount: 1 },
    ]) {
      const res = await sdk(w, 'deleteRows', token, body);
      expect(res.status).toBe(400);
    }
    expect(w.google.deleted).toHaveLength(0);
  });

  it('fails deleteRows on an unresolvable sheet or missing binding', async () => {
    world = await makeWorld();
    const w = world;
    await connect(w);
    const token = await w.identityToken();

    const outOfRange = await sdk(w, 'deleteRows', token, { resource: 'orders', sheet: 5, startRow: 1, rowCount: 1 });
    expect(outOfRange.status).toBe(409);
    expect((await outOfRange.json()) as { error: string }).toMatchObject({ error: 'resource_unavailable' });

    const unregistered = await sdk(w, 'deleteRows', token, { resource: 'ghost', startRow: 1, rowCount: 1 });
    expect(unregistered.status).toBe(404);
    expect((await unregistered.json()) as { error: string }).toMatchObject({ error: 'resource_not_found' });
  });

  it('denies deleteRows for an unauthenticated caller', async () => {
    world = await makeWorld();
    await connect(world);
    const res = await sdk(world, 'deleteRows', 'not-a-jwt', { resource: 'orders', startRow: 1, rowCount: 1 });
    expect(res.status).toBe(401);
  });
});
