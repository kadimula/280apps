// The SDK mirrors the backend's not-ready-vs-failure split (see
// packages/backend/src/integrations/service.ts): the platform's expected not-ready
// codes degrade to a safe empty result so an unmodified app never 500s, while every
// genuine failure still throws IntegrationRequestError.

import { describe, expect, it } from 'vitest';
import { ID_HEADER } from '@280/contracts/identity';
import { googleSheets, IntegrationRequestError } from '../src/index.js';

const ORIGIN = 'https://api.280apps.com';

function req(): Request {
  return new Request('https://todos.280apps.run/', { headers: { [ID_HEADER]: 'gateway-token' } });
}

function fetchReturning(status: number, body: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

function client(status: number, body: Record<string, unknown>) {
  return googleSheets(req(), { origin: ORIGIN, fetch: fetchReturning(status, body) });
}

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

describe('googleSheets not-ready codes degrade gracefully', () => {
  for (const { code, status } of NOT_READY) {
    it(`read → empty values + notReady on ${code}`, async () => {
      const res = await client(status, { error: code, message: 'x' }).read({ resource: 'todos', range: 'A:C' });
      expect(res.values).toEqual([]);
      expect(res.notReady).toBe(code);
      expect(res.range).toBe('A:C');
    });

    it(`append → zero-write + notReady on ${code}`, async () => {
      const res = await client(status, { error: code, message: 'x' }).append({
        resource: 'todos',
        range: 'A:C',
        values: [['1', 'a', 'FALSE']],
      });
      expect(res.updatedRows).toBe(0);
      expect(res.updatedCells).toBe(0);
      expect(res.notReady).toBe(code);
    });

    it(`update → zero-write + notReady on ${code}`, async () => {
      const res = await client(status, { error: code, message: 'x' }).update({
        resource: 'todos',
        range: 'C1',
        values: [['TRUE']],
      });
      expect(res.updatedRows).toBe(0);
      expect(res.notReady).toBe(code);
    });

    it(`deleteRows → zero-delete + notReady on ${code}`, async () => {
      const res = await client(status, { error: code, message: 'x' }).deleteRows({
        resource: 'todos',
        startRow: 2,
        rowCount: 1,
      });
      expect(res.deletedRows).toBe(0);
      expect(res.startRow).toBe(2);
      expect(res.notReady).toBe(code);
    });
  }
});

describe('googleSheets genuine failures still throw', () => {
  for (const { code, status } of GENUINE) {
    it(`read throws IntegrationRequestError on ${code}`, async () => {
      await expect(
        client(status, { error: code, message: 'boom', retryable: status === 503 }).read({
          resource: 'todos',
          range: 'A:C',
        }),
      ).rejects.toMatchObject({ name: 'IntegrationRequestError', code, status });
    });

    it(`append throws IntegrationRequestError on ${code}`, async () => {
      await expect(
        client(status, { error: code, message: 'boom' }).append({ resource: 'todos', range: 'A:C', values: [] }),
      ).rejects.toBeInstanceOf(IntegrationRequestError);
    });
  }
});

describe('googleSheets success path is unchanged', () => {
  it('read returns the backend values with no notReady flag', async () => {
    const res = await client(200, { range: 'A:C', majorDimension: 'ROWS', values: [['1', 'a', 'FALSE']] }).read({
      resource: 'todos',
      range: 'A:C',
    });
    expect(res.values).toEqual([['1', 'a', 'FALSE']]);
    expect(res.notReady).toBeUndefined();
  });
});
