// Mirrors test/googleSheets.test.ts: the platform's expected not-ready codes
// degrade to a safe empty result so an unmodified app never 500s, while every
// genuine failure still throws IntegrationRequestError.

import { describe, expect, it } from 'vitest';
import { ID_HEADER } from '@280/contracts/identity';
import { supabaseTables, IntegrationRequestError, type SupabaseFilter } from '../src/index.js';

const ORIGIN = 'https://api.280apps.com';

function req(): Request {
  return new Request('https://todos.280apps.run/', { headers: { [ID_HEADER]: 'gateway-token' } });
}

interface Captured {
  url: string;
  authorization: string | null;
  body: unknown;
}

function capturingFetch(status: number, body: Record<string, unknown>, captured: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured.push({
      url: url.toString(),
      authorization: headers.get('Authorization'),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function client(status: number, body: Record<string, unknown>, captured: Captured[] = []) {
  return supabaseTables(req(), { origin: ORIGIN, fetch: capturingFetch(status, body, captured) });
}

const FILTERS: SupabaseFilter[] = [{ column: 'done', op: 'eq', value: false }];

const NOT_READY = [
  { code: 'not_connected', status: 404 },
  { code: 'resource_not_found', status: 404 },
  { code: 'reauthorization_required', status: 409 },
] as const;

const GENUINE = [
  { code: 'provider_error', status: 502 },
  { code: 'provider_unavailable', status: 503 },
  { code: 'invalid_request', status: 400 },
  { code: 'unauthenticated', status: 401 },
  { code: 'internal_error', status: 500 },
] as const;

describe('supabaseTables success path hits the right endpoint', () => {
  it('select posts to /select with auth + body, returns rows and count', async () => {
    const captured: Captured[] = [];
    const res = await client(200, { rows: [{ id: 1 }], count: 1 }, captured).select({
      resource: 'todos',
      columns: ['id'],
      filters: FILTERS,
      limit: 10,
    });
    expect(res.rows).toEqual([{ id: 1 }]);
    expect(res.count).toBe(1);
    expect(res.notReady).toBeUndefined();
    expect(new URL(captured[0].url).pathname).toBe('/v1/sdk/integrations/supabase-tables/select');
    expect(captured[0].authorization).toBe('Bearer gateway-token');
    expect(captured[0].body).toEqual({ resource: 'todos', columns: ['id'], filters: FILTERS, limit: 10 });
  });

  it('insert posts to /insert and returns insertedCount', async () => {
    const captured: Captured[] = [];
    const res = await client(200, { rows: [{ id: 2 }], insertedCount: 1 }, captured).insert({
      resource: 'todos',
      rows: [{ title: 'x' }],
    });
    expect(res.insertedCount).toBe(1);
    expect(new URL(captured[0].url).pathname).toBe('/v1/sdk/integrations/supabase-tables/insert');
    expect(captured[0].body).toEqual({ resource: 'todos', rows: [{ title: 'x' }] });
  });

  it('update posts to /update and returns updatedCount', async () => {
    const captured: Captured[] = [];
    const res = await client(200, { rows: [{ id: 3 }], updatedCount: 1 }, captured).update({
      resource: 'todos',
      values: { done: true },
      filters: FILTERS,
    });
    expect(res.updatedCount).toBe(1);
    expect(new URL(captured[0].url).pathname).toBe('/v1/sdk/integrations/supabase-tables/update');
    expect(captured[0].body).toEqual({ resource: 'todos', values: { done: true }, filters: FILTERS });
  });

  it('delete posts to /delete and returns deletedCount', async () => {
    const captured: Captured[] = [];
    const res = await client(200, { deletedCount: 2 }, captured).delete({ resource: 'todos', filters: FILTERS });
    expect(res.deletedCount).toBe(2);
    expect(new URL(captured[0].url).pathname).toBe('/v1/sdk/integrations/supabase-tables/delete');
    expect(captured[0].body).toEqual({ resource: 'todos', filters: FILTERS });
  });
});

describe('supabaseTables not-ready codes degrade gracefully', () => {
  for (const { code, status } of NOT_READY) {
    it(`select → empty rows + notReady on ${code}`, async () => {
      const res = await client(status, { error: code, message: 'x' }).select({ resource: 'todos' });
      expect(res.rows).toEqual([]);
      expect(res.count).toBe(0);
      expect(res.notReady).toBe(code);
    });

    it(`insert → zero insertedCount + notReady on ${code}`, async () => {
      const res = await client(status, { error: code, message: 'x' }).insert({ resource: 'todos', rows: [{ a: 1 }] });
      expect(res.rows).toEqual([]);
      expect(res.insertedCount).toBe(0);
      expect(res.notReady).toBe(code);
    });

    it(`update → zero updatedCount + notReady on ${code}`, async () => {
      const res = await client(status, { error: code, message: 'x' }).update({
        resource: 'todos',
        values: { done: true },
        filters: FILTERS,
      });
      expect(res.rows).toEqual([]);
      expect(res.updatedCount).toBe(0);
      expect(res.notReady).toBe(code);
    });

    it(`delete → zero deletedCount + notReady on ${code}`, async () => {
      const res = await client(status, { error: code, message: 'x' }).delete({ resource: 'todos', filters: FILTERS });
      expect(res.deletedCount).toBe(0);
      expect(res.notReady).toBe(code);
    });
  }
});

describe('supabaseTables genuine failures still throw', () => {
  for (const { code, status } of GENUINE) {
    it(`select throws IntegrationRequestError on ${code}`, async () => {
      await expect(
        client(status, { error: code, message: 'boom', retryable: status === 503 }).select({ resource: 'todos' }),
      ).rejects.toMatchObject({ name: 'IntegrationRequestError', code, status, retryable: status === 503 });
    });

    it(`insert throws IntegrationRequestError on ${code}`, async () => {
      await expect(
        client(status, { error: code, message: 'boom' }).insert({ resource: 'todos', rows: [] }),
      ).rejects.toBeInstanceOf(IntegrationRequestError);
    });
  }
});

describe('supabaseTables handles malformed responses', () => {
  it('throws a generic IntegrationRequestError when an error body is not JSON', async () => {
    const badFetch = (async () =>
      new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch;
    await expect(
      supabaseTables(req(), { origin: ORIGIN, fetch: badFetch }).select({ resource: 'todos' }),
    ).rejects.toMatchObject({ name: 'IntegrationRequestError', code: 'request_failed', status: 502 });
  });

  it('treats a malformed 200 body as an empty result object', async () => {
    const badFetch = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const res = await supabaseTables(req(), { origin: ORIGIN, fetch: badFetch }).select({ resource: 'todos' });
    expect(res.rows).toBeUndefined();
    expect(res.count).toBeUndefined();
  });
});
