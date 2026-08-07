// The device-flow client: start, redeem, the polled authorization_pending answer, and error coercion.

import { describe, it, expect } from 'vitest';
import { Client } from '../src/auth/http.js';
import { asDeployError } from '../src/deploy/error.js';
import { AuthCode, DeployCode } from '../src/index.js';
import type { FetchInit, FetchLike } from '../src/deploy/http.js';

function mockFetch(reply: (url: string, init?: FetchInit) => Response): {
  fetch: FetchLike;
  calls: { url: string; init?: FetchInit }[];
} {
  const calls: { url: string; init?: FetchInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return reply(url, init);
  };
  return { fetch, calls };
}

async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('auth HTTP Client', () => {
  it('start posts to /v1/device/code and parses the response', async () => {
    const body = JSON.stringify({
      deviceCode: 'dc',
      userCode: 'BCDF-GHJK',
      verificationUri: 'https://280apps.com/activate',
      expiresIn: 900,
      interval: 5,
    });
    const { fetch, calls } = mockFetch(() => new Response(body, { status: 200 }));
    const c = new Client('https://api', { fetch });
    const res = await c.start();
    expect(res.userCode).toBe('BCDF-GHJK');
    expect(res.expiresIn).toBe(900);
    expect(calls[0]!.url).toBe('https://api/v1/device/code');
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('redeem posts the device code and returns the token', async () => {
    const { fetch, calls } = mockFetch(() => new Response(JSON.stringify({ token: 'tok_123' }), { status: 200 }));
    const c = new Client('https://api', { fetch });
    const token = await c.redeem('dc');
    expect(token).toBe('tok_123');
    expect(calls[0]!.url).toBe('https://api/v1/device/token');
    const sent = JSON.parse(calls[0]!.init?.body as string);
    expect(sent.deviceCode).toBe('dc');
  });

  it('surfaces authorization_pending as the polled answer', async () => {
    const body = JSON.stringify({ code: AuthCode.AuthorizationPending, message: 'not approved yet' });
    const { fetch } = mockFetch(() => new Response(body, { status: 400 }));
    const c = new Client('https://api', { fetch });
    const err = await catchErr(() => c.redeem('dc'));
    expect(asDeployError(err)?.code).toBe(AuthCode.AuthorizationPending);
  });

  it('coerces a non-error body to unavailable with a login fix', async () => {
    const { fetch } = mockFetch(() => new Response('<html>gateway</html>', { status: 502 }));
    const c = new Client('https://api', { fetch });
    const err = asDeployError(await catchErr(() => c.start()));
    expect(err?.code).toBe(DeployCode.Unavailable);
    expect(err?.fix).toBe('run two80 login again');
  });

  it('wraps a transport error as retryable unavailable', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ETIMEDOUT');
    };
    const c = new Client('https://api', { fetch });
    const err = asDeployError(await catchErr(() => c.start()));
    expect(err?.code).toBe(DeployCode.Unavailable);
    expect(err?.retryable).toBe(true);
    expect(err?.message).toContain('ETIMEDOUT');
  });
});
