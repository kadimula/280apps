// Ported from platform/observe_test.go: the access log records every request but
// health checks, splits client faults (4xx) from platform faults (5xx) by level,
// and the request id is honored inbound and echoed outbound.

import { afterEach, describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '../src/observe.js';
import { HttpClient, capturingLogger, newServer, requests, testManifest, type Harness } from './helpers/harness.js';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

describe('access log', () => {
  it('records every request but health checks, at the right level', async () => {
    const { logger, records } = capturingLogger();
    const s = await newServer({ openSignup: true, logger });
    live.push(s.harness);
    const app = s.app;

    const client = new HttpClient(app, 'log-token');
    await client.sync({
      identity: { slug: 'demo', framework: 'static' } as never,
      manifest: testManifest().manifest,
    });
    // a missing app is a client fault: status must 404 and log at WARN
    await expect(client.status('app_missing', 'dep_missing')).rejects.toThrow();
    const health = await app.request('/healthz');
    expect(await health.text()).toBe('ok\n');

    const lines = requests(records);
    expect(lines.length).toBe(2); // health checks are not logged

    const sync = lines[0]!;
    expect(sync.attrs.method).toBe('POST');
    expect(sync.attrs.path).toBe('/v1/sync');
    expect(sync.attrs.status).toBe(200);
    expect(String(sync.attrs.account)).toMatch(/^acct_/);
    expect(sync.attrs.ms).toBeDefined();
    expect(String(sync.attrs.request)).not.toBe('');

    const status = lines[1]!;
    expect(status.level).toBe('WARN');
    expect(status.attrs.status).toBe(404);
  });
});

describe('request id', () => {
  it('is minted when absent and honored when supplied, and echoed both ways', async () => {
    const { logger, records } = capturingLogger();
    const s = await newServer({ logger });
    live.push(s.harness);
    const app = s.app;

    const first = await app.request('/v1/apps/app_x/deploys/dep_x');
    const minted = first.headers.get(REQUEST_ID_HEADER);
    expect(minted).toBeTruthy();

    const second = await app.request('/v1/apps/app_x/deploys/dep_x', {
      headers: { [REQUEST_ID_HEADER]: 'caller-supplied-id' },
    });
    expect(second.headers.get(REQUEST_ID_HEADER)).toBe('caller-supplied-id');

    const lines = requests(records);
    expect(lines.length).toBe(2);
    expect(lines[0]!.attrs.request).toBe(minted);
    expect(lines[1]!.attrs.request).toBe('caller-supplied-id');
  });
});
