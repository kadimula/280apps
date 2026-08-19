// End-to-end specification for the Supabase integration: it drives the real Hono app
// against a fake Supabase (management API + PostgREST) through the whole owner journey
// — connect, server-side browse, resource registration, SDK select/insert/update/delete
// — and asserts the security and correctness boundaries: rotating refresh tokens are
// persisted, an invalid grant surfaces as reauthorization_required, filters are bound
// and encoded exactly, and the project secret key is cached and re-fetched on a 401.
// Nothing reaches the network.

import { afterEach, describe, expect, it } from 'vitest';
import { IdentitySigner, publicJwkFromPrivate } from '@280/contracts/identity';
import { Server } from '../src/api.js';
import type { RequestDeps } from '../src/config.js';
import { EnvelopeSecretCipher, LocalKeyWrapper } from '../src/secrets.js';
import { IntegrationService } from '../src/integrations/service.js';
import { ProviderRegistry } from '../src/integrations/registry.js';
import { SupabaseProvider } from '../src/integrations/supabase/provider.js';
import { GoogleWorkspaceProvider } from '../src/integrations/google/provider.js';
import { SdkIdentityVerifier } from '../src/integrations/sdk-identity.js';
import { newPlatform, testDeps } from './helpers/harness.js';
import { newAuth, signIn, cookiePair } from './helpers/auth.js';

const INT_COOKIE = '280_int_oauth';
const JWKS_URI = 'https://auth.test/.well-known/280-identity.jwks';
const ISSUER = 'https://auth.test';
const REF = 'abcdefghij0123456789';
const ORDERS_ID = JSON.stringify({ ref: REF, schema: 'public', table: 'orders' });

interface RestCall {
  method: string;
  url: string;
  prefer: string | null;
  apikey: string | null;
  body: string | null;
}

interface SupabaseState {
  refreshToken: string;
  refreshCalls: number;
  invalidGrant: boolean;
  apiKeyCalls: number;
  rest401Remaining: number;
  restStatus: number;
  contentRange: string;
  rows: unknown[];
  restCalls: RestCall[];
  revoked: string[];
  lastTokenAuth: string | null;
  lastTokenGrant: string | null;
}

function fakeSupabase(): { state: SupabaseState; fetchImpl: typeof fetch } {
  const state: SupabaseState = {
    refreshToken: '',
    refreshCalls: 0,
    invalidGrant: false,
    apiKeyCalls: 0,
    rest401Remaining: 0,
    restStatus: 200,
    contentRange: 'items 0-0/57',
    rows: [{ id: 1, city: 'sf' }],
    restCalls: [],
    revoked: [],
    lastTokenAuth: null,
    lastTokenGrant: null,
  };
  const json = (obj: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const h = new Headers((init?.headers as HeadersInit | undefined) ?? {});

    if (url === 'https://api.supabase.com/v1/oauth/token') {
      const params = new URLSearchParams(String(init?.body ?? ''));
      state.lastTokenAuth = h.get('Authorization');
      const grant = params.get('grant_type');
      state.lastTokenGrant = grant;
      if (grant === 'authorization_code') {
        state.refreshToken = 'rt-1';
        return json({ access_token: 'at-0', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' });
      }
      if (grant === 'refresh_token') {
        state.refreshCalls++;
        if (state.invalidGrant) return json({ error: 'invalid_grant' }, 400);
        if (params.get('refresh_token') !== state.refreshToken) return json({ error: 'invalid_grant' }, 400);
        const n = state.refreshCalls;
        state.refreshToken = `rt-${n + 1}`;
        return json({ access_token: `at-${n}`, refresh_token: state.refreshToken, expires_in: 3600, token_type: 'Bearer' });
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }

    if (url === 'https://api.supabase.com/v1/oauth/revoke') {
      const params = new URLSearchParams(String(init?.body ?? ''));
      state.revoked.push(params.get('refresh_token') ?? '');
      return new Response(null, { status: 200 });
    }

    if (url === 'https://api.supabase.com/v1/organizations') return json([{ id: 'org1', name: 'Acme Org' }]);
    if (url === 'https://api.supabase.com/v1/projects') {
      if (state.restStatus === 429 && method === 'GET') return json({ message: 'rate limited' }, 429);
      return json([{ id: REF, name: 'Orders DB' }]);
    }
    if (url === `https://api.supabase.com/v1/projects/${REF}`) return json({ id: REF, name: 'Orders DB' });
    if (url.startsWith(`https://api.supabase.com/v1/projects/${REF}/api-keys`)) {
      state.apiKeyCalls++;
      return json([
        { type: 'secret', api_key: 'sb_secret_live' },
        { name: 'service_role', api_key: 'legacy_role_key' },
      ]);
    }

    if (url.startsWith(`https://${REF}.supabase.co/rest/v1`)) {
      const path = new URL(url).pathname;
      if (path === '/rest/v1/') {
        return json({ paths: { '/': {}, '/orders': {}, '/customers': {}, '/rpc/do_thing': {} } });
      }
      state.restCalls.push({
        method,
        url,
        prefer: h.get('Prefer'),
        apikey: h.get('apikey'),
        body: init?.body === undefined || init?.body === null ? null : String(init.body),
      });
      if (state.rest401Remaining > 0) {
        state.rest401Remaining--;
        return json({ message: 'JWT expired' }, 401);
      }
      if (state.restStatus !== 200) return json({ message: 'boom' }, state.restStatus);
      return json(state.rows, 200, { 'Content-Range': state.contentRange });
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return { state, fetchImpl };
}

interface World {
  app: ReturnType<Server['handler']>;
  session: string;
  supa: SupabaseState;
  store: Awaited<ReturnType<typeof newPlatform>>['store'];
  identityToken: (over?: Record<string, unknown>) => Promise<string>;
  advance: (secs: number) => void;
  cleanup: () => Promise<void>;
}

async function makeWorld(): Promise<World> {
  const harness = await newPlatform();
  const cipher = new EnvelopeSecretCipher(new LocalKeyWrapper(Buffer.alloc(32, 9).toString('base64'), 'itest'));
  const supa = fakeSupabase();
  const registry = new ProviderRegistry([
    new SupabaseProvider({ clientId: 'cid', clientSecret: 'sec', fetch: supa.fetchImpl }),
    new GoogleWorkspaceProvider({ clientId: 'gid', clientSecret: 'gsec', fetch: supa.fetchImpl }),
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

  return { app, session, supa: supa.state, store: harness.store, identityToken, advance: (s) => (clock += s), cleanup: harness.cleanup };
}

async function connect(w: World, register = true): Promise<string> {
  const start = await w.app.request('/internal/apps/app_orders/integrations/supabase/start?redirect=%2Fdashboard%2Fapp_orders', {
    headers: { Cookie: w.session },
  });
  if (start.status !== 302) throw new Error(`start ${start.status}`);
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const intCookie = cookiePair(start, INT_COOKIE);
  if (intCookie === null) throw new Error('no oauth cookie');

  const cb = await w.app.request(`/integrations/supabase/callback?code=auth123&state=${state}`, { headers: { Cookie: intCookie } });
  if (cb.status !== 302) throw new Error(`callback ${cb.status}`);

  const connId = await connectionId(w);
  if (register) {
    const reg = await w.app.request(`/internal/apps/app_orders/integrations/${connId}/resources`, {
      method: 'POST',
      headers: { Cookie: w.session, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: 'supabase-tables', alias: 'orders', externalId: ORDERS_ID }),
    });
    if (reg.status !== 200) throw new Error(`register ${reg.status}`);
  }
  return connId;
}

async function connectionId(w: World): Promise<string> {
  const list = (await (await w.app.request('/internal/apps/app_orders/integrations', { headers: { Cookie: w.session } })).json()) as {
    connections: Array<{ id: string; provider: string }>;
  };
  const conn = list.connections.find((c) => c.provider === 'supabase');
  if (conn === undefined) throw new Error('no supabase connection');
  return conn.id;
}

function sdk(w: World, op: string, token: string, body: unknown): Promise<Response> {
  return w.app.request(`/v1/sdk/integrations/supabase-tables/${op}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function browse(w: World, connId: string, body: unknown): Promise<Response> {
  return w.app.request(`/internal/apps/app_orders/integrations/${connId}/browse`, {
    method: 'POST',
    headers: { Cookie: w.session, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('supabase integration end to end', () => {
  let world: World | null = null;
  afterEach(async () => {
    if (world) await world.cleanup();
    world = null;
  });

  it('connects and stores a credential with the org account label', async () => {
    world = await makeWorld();
    const w = world;

    const start = await w.app.request('/internal/apps/app_orders/integrations/supabase/start', { headers: { Cookie: w.session } });
    expect(start.status).toBe(302);
    const authUrl = new URL(start.headers.get('location') ?? '');
    expect(authUrl.host).toBe('api.supabase.com');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    const state = authUrl.searchParams.get('state') ?? '';
    const intCookie = cookiePair(start, INT_COOKIE) ?? '';

    const cb = await w.app.request(`/integrations/supabase/callback?code=auth123&state=${state}`, { headers: { Cookie: intCookie } });
    expect(cb.status).toBe(302);
    expect(w.supa.lastTokenGrant).toBe('authorization_code');
    expect(w.supa.lastTokenAuth).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`);

    const list = (await (await w.app.request('/internal/apps/app_orders/integrations', { headers: { Cookie: w.session } })).json()) as {
      connections: Array<{ id: string; provider: string; status: string; account: string }>;
    };
    const conn = list.connections.find((c) => c.provider === 'supabase')!;
    expect(conn.status).toBe('active');
    expect(conn.account).toBe('Acme Org');
  });

  it('persists the rotated refresh token across refreshes', async () => {
    world = await makeWorld();
    const w = world;
    await connect(w);
    const token = await w.identityToken();

    // First expiry forces a refresh; the fake rotates rt-1 -> rt-2.
    w.advance(4000);
    const first = await sdk(w, 'select', token, { resource: 'orders', filters: [] });
    expect(first.status).toBe(200);
    expect(w.supa.refreshCalls).toBe(1);
    expect(w.supa.refreshToken).toBe('rt-2');

    // Second expiry must present the rotated rt-2; the fake rejects any stale token.
    w.advance(4000);
    const second = await sdk(w, 'select', token, { resource: 'orders', filters: [] });
    expect(second.status).toBe(200);
    expect(w.supa.refreshCalls).toBe(2);
    expect(w.supa.refreshToken).toBe('rt-3');
  });

  it('marks reauthorization_required when the refresh grant is invalid', async () => {
    world = await makeWorld();
    const w = world;
    const connId = await connect(w);
    w.supa.invalidGrant = true;
    w.advance(4000);

    const res = await sdk(w, 'select', await w.identityToken(), { resource: 'orders', filters: [] });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'reauthorization_required' });

    const list = (await (await w.app.request('/internal/apps/app_orders/integrations', { headers: { Cookie: w.session } })).json()) as {
      connections: Array<{ id: string; status: string }>;
    };
    expect(list.connections.find((c) => c.id === connId)?.status).toBe('reauthorization_required');
  });

  it('browses projects and tables and rejects the client-side selector', async () => {
    world = await makeWorld();
    const w = world;
    const connId = await connect(w, false);

    const projects = (await (await browse(w, connId, { capability: 'supabase-tables', kind: 'projects' })).json()) as {
      items: Array<{ id: string; name: string }>;
    };
    expect(projects.items).toEqual([{ id: REF, name: 'Orders DB' }]);

    const tables = (await (await browse(w, connId, { capability: 'supabase-tables', kind: 'tables', project: REF })).json()) as {
      items: Array<{ id: string; name: string }>;
    };
    expect(tables.items.map((t) => t.name)).toEqual(['customers', 'orders']);
    const orders = tables.items.find((t) => t.name === 'orders')!;
    expect(orders.id).toBe(ORDERS_ID);
    expect(JSON.parse(orders.id)).toEqual({ ref: REF, schema: 'public', table: 'orders' });

    // A server-side-selecting provider refuses the picker selector session.
    const sel = await w.app.request(`/internal/apps/app_orders/integrations/${connId}/selector-session`, {
      method: 'POST',
      headers: { Cookie: w.session },
    });
    expect(sel.status).toBe(422);
  });

  it('validates a resource and rejects malformed external ids', async () => {
    world = await makeWorld();
    const w = world;
    const connId = await connect(w, false);

    const ok = await w.app.request(`/internal/apps/app_orders/integrations/${connId}/resources`, {
      method: 'POST',
      headers: { Cookie: w.session, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: 'supabase-tables', alias: 'orders', externalId: ORDERS_ID }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { displayName: string }).toMatchObject({ displayName: 'Orders DB · orders' });

    for (const bad of ['not-json', JSON.stringify({ ref: 'short', schema: 'public', table: 'orders' }), JSON.stringify({ ref: REF, schema: 'public', table: '1bad' })]) {
      const res = await w.app.request(`/internal/apps/app_orders/integrations/${connId}/resources`, {
        method: 'POST',
        headers: { Cookie: w.session, 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability: 'supabase-tables', alias: 'x', externalId: bad }),
      });
      expect(res.status).toBe(422);
    }
  });

  it('encodes select, insert, update, and delete exactly on the wire', async () => {
    world = await makeWorld();
    const w = world;
    await connect(w);
    const token = await w.identityToken();

    // select with columns + eq filter; default limit 100 and count=exact.
    w.supa.rows = [{ id: 1, city: 'sf' }];
    const sel = await sdk(w, 'select', token, { resource: 'orders', columns: ['id', 'city'], filters: [{ column: 'city', op: 'eq', value: 'sf' }] });
    expect(sel.status).toBe(200);
    expect((await sel.json()) as { count: number }).toMatchObject({ count: 57 });
    const selCall = w.supa.restCalls.at(-1)!;
    const selQuery = new URL(selCall.url).searchParams;
    expect(selCall.method).toBe('GET');
    expect(selQuery.get('select')).toBe('id,city');
    expect(selQuery.get('city')).toBe('eq.sf');
    expect(selQuery.get('limit')).toBe('100');
    expect(selCall.prefer).toBe('count=exact');

    // in-filter quoting and is.null.
    await sdk(w, 'select', token, { resource: 'orders', filters: [{ column: 'city', op: 'in', value: ['a,b', 'c'] }] });
    expect(new URL(w.supa.restCalls.at(-1)!.url).searchParams.get('city')).toBe('in.("a,b","c")');
    await sdk(w, 'select', token, { resource: 'orders', filters: [{ column: 'deleted', op: 'is', value: null }] });
    expect(new URL(w.supa.restCalls.at(-1)!.url).searchParams.get('deleted')).toBe('is.null');

    // insert: JSON array body, return=representation.
    const ins = await sdk(w, 'insert', token, { resource: 'orders', rows: [{ id: 2, city: 'la' }] });
    expect(ins.status).toBe(200);
    expect((await ins.json()) as { insertedCount: number }).toMatchObject({ insertedCount: 1 });
    const insCall = w.supa.restCalls.at(-1)!;
    expect(insCall.method).toBe('POST');
    expect(insCall.prefer).toContain('return=representation');
    expect(JSON.parse(insCall.body ?? '[]')).toEqual([{ id: 2, city: 'la' }]);

    // update: PATCH with filters and an object body.
    const upd = await sdk(w, 'update', token, { resource: 'orders', values: { city: 'nyc' }, filters: [{ column: 'id', op: 'eq', value: 2 }] });
    expect(upd.status).toBe(200);
    const updCall = w.supa.restCalls.at(-1)!;
    expect(updCall.method).toBe('PATCH');
    expect(new URL(updCall.url).searchParams.get('id')).toBe('eq.2');
    expect(JSON.parse(updCall.body ?? '{}')).toEqual({ city: 'nyc' });

    // delete: filters only.
    const del = await sdk(w, 'delete', token, { resource: 'orders', filters: [{ column: 'id', op: 'eq', value: 2 }] });
    expect(del.status).toBe(200);
    const delCall = w.supa.restCalls.at(-1)!;
    expect(delCall.method).toBe('DELETE');
    expect(new URL(delCall.url).searchParams.get('id')).toBe('eq.2');
  });

  it('rejects update and delete without filters and issues no rest call', async () => {
    world = await makeWorld();
    const w = world;
    await connect(w);
    const token = await w.identityToken();
    const before = w.supa.restCalls.length;

    expect((await sdk(w, 'update', token, { resource: 'orders', values: { city: 'x' } })).status).toBe(400);
    expect((await sdk(w, 'update', token, { resource: 'orders', values: { city: 'x' }, filters: [] })).status).toBe(400);
    expect((await sdk(w, 'delete', token, { resource: 'orders' })).status).toBe(400);
    expect((await sdk(w, 'delete', token, { resource: 'orders', filters: [] })).status).toBe(400);
    expect(w.supa.restCalls.length).toBe(before);
  });

  it('caches the secret key, re-fetches on a rest 401, and fails on persistent 401', async () => {
    world = await makeWorld();
    const w = world;
    await connect(w);
    const token = await w.identityToken();

    // Registration warmed the key; two more ops reveal it zero extra times: a single
    // fetch covers registration and both operations.
    expect(w.supa.apiKeyCalls).toBe(1);
    await sdk(w, 'select', token, { resource: 'orders', filters: [] });
    await sdk(w, 'select', token, { resource: 'orders', filters: [] });
    expect(w.supa.apiKeyCalls).toBe(1);

    // A single 401 evicts and re-fetches the key, then the retry succeeds.
    w.supa.rest401Remaining = 1;
    const retried = await sdk(w, 'select', token, { resource: 'orders', filters: [] });
    expect(retried.status).toBe(200);
    expect(w.supa.apiKeyCalls).toBe(2);

    // Persistent 401 surfaces a 502-class provider error after the single retry.
    w.supa.rest401Remaining = 10;
    const failed = await sdk(w, 'select', token, { resource: 'orders', filters: [] });
    expect(failed.status).toBe(502);
    expect(w.supa.apiKeyCalls).toBe(3);
  });

  it('surfaces a throttled management browse as unavailable', async () => {
    world = await makeWorld();
    const w = world;
    const connId = await connect(w, false);
    w.supa.restStatus = 429;
    const res = await browse(w, connId, { capability: 'supabase-tables', kind: 'projects' });
    expect(res.status).toBe(503);
  });

  it('refuses a token minted for another app', async () => {
    world = await makeWorld();
    await connect(world);
    const foreign = await world.identityToken({ app: 'app_intruder', aud: 'intruder.280apps.run' });
    const res = await sdk(world, 'select', foreign, { resource: 'orders', filters: [] });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'not_connected' });
  });

  it('denies an anonymous identity', async () => {
    world = await makeWorld();
    await connect(world);
    const anon = await world.identityToken({ sub: 'anon', email: '', anon: true });
    expect((await sdk(world, 'select', anon, { resource: 'orders', filters: [] })).status).toBe(403);
  });
});
