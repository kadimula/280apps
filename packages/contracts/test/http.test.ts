// The HTTP adapter's error mapping by status, retryable transport-error coercion,
// and the deliberate omission of Content-Length on blob PUT.

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { Client, HEADER_CLI_VERSION, type FetchInit, type FetchLike } from '../src/deploy/http.js';
import { asDeployError } from '../src/deploy/error.js';
import { DeployCode } from '../src/index.js';

interface Captured {
  url: string;
  init?: FetchInit;
}

function mockFetch(reply: (url: string, init?: FetchInit) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return reply(url, init);
  };
  return { fetch, calls };
}

const okSync = JSON.stringify({
  app: { id: 'app_000001', slug: 'demo', url: 'https://demo-abcdef0123.280apps.run' },
  resolution: 'created',
  deployId: 'dep_x',
  state: 'uploading',
  missing: ['aa', 'bb'],
});

async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('HTTP Client', () => {
  it('sync posts to /v1/sync and parses the result (loose)', async () => {
    const { fetch, calls } = mockFetch(() => new Response(okSync, { status: 200 }));
    const c = new Client('https://api.280apps.com', { token: 't', fetch });
    const res = await c.sync({
      identity: { appId: '', slug: 'demo', framework: 'next', gitRemote: '', clientRef: '', forceNew: false },
      manifest: { kind: 'bundle', worker: { path: '', digest: 'aa', size: 1 }, assets: [], cache: [] },
    });
    expect(res.app.id).toBe('app_000001');
    expect(res.missing).toEqual(['aa', 'bb']);
    expect(res.failure).toBeUndefined();
    expect(calls[0]!.url).toBe('https://api.280apps.com/v1/sync');
    expect(calls[0]!.init?.method).toBe('POST');
    const h = calls[0]!.init?.headers as Record<string, string>;
    expect(h['Authorization']).toBe('Bearer t');
    expect(h['Content-Type']).toBe('application/json');
    expect(h['Accept']).toBe('application/json');
  });

  it('parses the secret notice and defaults it for older servers', async () => {
    const reply = (body: Record<string, unknown>) =>
      mockFetch(() => new Response(JSON.stringify({ state: 'live', url: 'https://app.example', ...body }), { status: 200 }));
    const current = new Client('https://api', {
      fetch: reply({ secretNotice: 'configure STRIPE_KEY' }).fetch,
    });
    const older = new Client('https://api', { fetch: reply({}).fetch });

    expect((await current.status('app_1', 'dep_1')).secretNotice).toBe('configure STRIPE_KEY');
    expect((await older.status('app_1', 'dep_1')).secretNotice).toBe('');
  });

  it('sends the CLI version header only when set', async () => {
    const { fetch, calls } = mockFetch(() => new Response(okSync, { status: 200 }));
    const withV = new Client('https://api', { token: 't', cliVersion: '0.2.0', fetch });
    await withV.sync({
      identity: { appId: '', slug: 's', framework: 'next', gitRemote: '', clientRef: '', forceNew: false },
      manifest: { kind: 'bundle', worker: { path: '', digest: 'aa', size: 1 }, assets: [], cache: [] },
    });
    const h = calls[0]!.init?.headers as Record<string, string>;
    expect(h[HEADER_CLI_VERSION]).toBe('0.2.0');
  });

  it('returns the server error shape verbatim', async () => {
    const body = JSON.stringify({
      code: 'ambiguous_identity',
      message: '2 apps match this project',
      fix: 'run 280 link <app-id>',
      candidates: ['app_1', 'app_2'],
    });
    const { fetch } = mockFetch(() => new Response(body, { status: 409 }));
    const c = new Client('https://api', { token: 't', fetch });
    const err = asDeployError(await catchErr(() => c.status('app_1', 'dep_1')));
    expect(err?.code).toBe('ambiguous_identity');
    expect(err?.fix).toBe('run 280 link <app-id>');
    expect(err?.candidates).toEqual(['app_1', 'app_2']);
  });

  it('coerces a non-error 401 body to unauthorized with a login fix', async () => {
    const { fetch } = mockFetch(() => new Response('<html>nope</html>', { status: 401 }));
    const c = new Client('https://api', { token: 't', fetch });
    const err = asDeployError(await catchErr(() => c.status('a', 'd')));
    expect(err?.code).toBe(DeployCode.Unauthorized);
    expect(err?.fix).toBe('run 280 login');
  });

  it('coerces a non-error 404 body to not_found', async () => {
    const { fetch } = mockFetch(() => new Response('nope', { status: 404 }));
    const c = new Client('https://api', { token: 't', fetch });
    const err = asDeployError(await catchErr(() => c.status('a', 'd')));
    expect(err?.code).toBe(DeployCode.NotFound);
    expect(err?.fix).toBe('run 280 push again');
  });

  it('coerces 503/502/504/429 to a retryable unavailable', async () => {
    for (const status of [503, 502, 504, 429]) {
      const { fetch } = mockFetch(() => new Response('busy', { status }));
      const c = new Client('https://api', { token: 't', fetch });
      const err = asDeployError(await catchErr(() => c.status('a', 'd')));
      expect(err?.code).toBe(DeployCode.Unavailable);
      expect(err?.retryable).toBe(true);
    }
  });

  it('coerces any other status to unavailable with a fix', async () => {
    const { fetch } = mockFetch(() => new Response('boom', { status: 500 }));
    const c = new Client('https://api', { token: 't', fetch });
    const err = asDeployError(await catchErr(() => c.status('a', 'd')));
    expect(err?.code).toBe(DeployCode.Unavailable);
    expect(err?.retryable).toBe(false);
    expect(err?.fix).toContain('280 push again');
  });

  it('wraps a transport error as a retryable unavailable', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const c = new Client('https://api', { token: 't', fetch });
    const err = asDeployError(await catchErr(() => c.status('a', 'd')));
    expect(err?.code).toBe(DeployCode.Unavailable);
    expect(err?.retryable).toBe(true);
    expect(err?.message).toContain('ECONNREFUSED');
  });

  it('putBlob streams the body, sets octet-stream, and forces no Content-Length', async () => {
    let seenBody = '';
    const { fetch, calls } = mockFetch(async (_url, init) => {
      seenBody = await new Response(init?.body as BodyInit).text();
      return new Response(null, { status: 204 });
    });
    const c = new Client('https://api', { token: 't', fetch });
    await c.putBlob('app_1', 'deadbeef', 5, Readable.from([Buffer.from('hello')]));
    expect(seenBody).toBe('hello');
    const call = calls[0]!;
    expect(call.url).toBe('https://api/v1/apps/app_1/blobs/deadbeef');
    expect(call.init?.method).toBe('PUT');
    expect(call.init?.duplex).toBe('half');
    const h = call.init?.headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(h['Authorization']).toBe('Bearer t');
    expect(Object.keys(h).some((k) => k.toLowerCase() === 'content-length')).toBe(false);
  });

  it('putBlob maps a failure status to the typed error', async () => {
    const body = JSON.stringify({ code: 'digest_mismatch', message: 'bytes changed', fix: 'run 280 push again' });
    const { fetch } = mockFetch(() => new Response(body, { status: 422 }));
    const c = new Client('https://api', { token: 't', fetch });
    const err = asDeployError(
      await catchErr(() => c.putBlob('app_1', 'deadbeef', 5, Readable.from([Buffer.from('hello')]))),
    );
    expect(err?.code).toBe('digest_mismatch');
  });

  it('delete posts to the app-scoped delete route', async () => {
    const body = JSON.stringify({ app: { id: 'app_1', slug: 'demo', url: 'u' }, deleted: true });
    const { fetch, calls } = mockFetch(() => new Response(body, { status: 200 }));
    const c = new Client('https://api', { token: 't', fetch });
    const res = await c.delete({ appId: 'app_1', confirm: 'demo' });
    expect(res.deleted).toBe(true);
    expect(calls[0]!.url).toBe('https://api/v1/apps/app_1/delete');
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('omits the Authorization header when no token is set', async () => {
    const { fetch, calls } = mockFetch(() => new Response(okSync, { status: 200 }));
    const c = new Client('https://api', { fetch });
    await c.status('a', 'd');
    const h = calls[0]!.init?.headers as Record<string, string>;
    expect('Authorization' in h).toBe(false);
  });
});
