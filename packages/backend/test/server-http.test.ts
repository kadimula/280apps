// Boots the real Node HTTP server over an ephemeral socket and drives it with
// fetch: the one path app.request cannot exercise, covering the raw streamed
// blob PUT (c.req.raw.body), the request-id echo across a real connection, and
// the activation-sized timeouts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { Server as NodeHttpServer } from 'node:http';
import { Server } from '../src/api.js';
import { REQUEST_ID_HEADER } from '../src/observe.js';
import { newPlatform, seedToken, testDeps, testManifest, type Harness } from './helpers/harness.js';

let harness: Harness;
let node: NodeHttpServer;
let base: string;

beforeAll(async () => {
  harness = await newPlatform();
  await seedToken(harness, 'acct_http', 'http-smoke-token');
  const app = new Server({ buildDeps: () => testDeps(harness) }).handler();
  await new Promise<void>((resolve) => {
    node = serve({ fetch: app.fetch, port: 0 }, () => resolve()) as NodeHttpServer;
    node.requestTimeout = 6 * 60 * 1000;
    node.headersTimeout = 20 * 1000;
  });
  const addr = node.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => node.close(() => resolve()));
  await harness.cleanup();
});

const auth = { Authorization: 'Bearer http-smoke-token' };

describe('real node server', () => {
  it('serves healthz', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.text()).toBe('ok\n');
  });

  it('echoes the request id', async () => {
    const res = await fetch(`${base}/v1/apps/app_x/deploys/dep_x`, {
      headers: { ...auth, [REQUEST_ID_HEADER]: 'smoke-id' },
    });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('smoke-id');
  });

  it('completes a push: sync, stream the blob, go live', async () => {
    const { manifest, worker, digest } = testManifest('http worker');

    const syncRes = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: { slug: 'smoke', framework: 'static' }, manifest }),
    });
    expect(syncRes.status).toBe(200);
    const sync = (await syncRes.json()) as { app: { id: string; url: string }; deployId: string; missing: string[] };
    expect(sync.missing).toEqual([digest]);

    // a real streamed octet-stream PUT through c.req.raw.body
    const put = await fetch(`${base}/v1/apps/${sync.app.id}/blobs/${digest}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: worker,
    });
    expect(put.status).toBe(204);

    const stRes = await fetch(`${base}/v1/apps/${sync.app.id}/deploys/${sync.deployId}`, { headers: auth });
    const st = (await stRes.json()) as { state: string; url: string };
    expect(st.state).toBe('live');
    expect(st.url).toBe(sync.app.url);
  });
});
