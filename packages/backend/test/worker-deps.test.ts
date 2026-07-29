// The request-scoped deps lifecycle: the keystone of the Workers entrypoint. The
// router is one isolate singleton; the deps middleware builds a fresh I/O
// container per request and schedules its close after the response via
// ctx.waitUntil (or, with no execution context, fire-and-forget). This drives
// app.fetch's env/ctx plumbing the way the Worker's fetch handler does, which
// the app.request-based suites do not otherwise cover.

import { afterEach, describe, expect, it } from 'vitest';
import { Server } from '../src/api.js';
import type { RequestDeps } from '../src/config.js';
import { newPlatform, testDeps, type Harness } from './helpers/harness.js';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

// fakeCtx stands in for the Workers ExecutionContext, recording what the deps
// middleware hands to waitUntil.
function fakeCtx(): { ctx: unknown; waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => void waited.push(p),
      passThroughOnException: () => {},
    },
    waited,
  };
}

describe('request-scoped deps lifecycle', () => {
  it('builds a fresh container per request and closes it via waitUntil', async () => {
    const harness = await newPlatform();
    live.push(harness);

    let builds = 0;
    let closes = 0;
    const buildDeps = (): RequestDeps => {
      builds++;
      return { ...testDeps(harness), close: async () => void closes++ };
    };
    const app = new Server({ buildDeps }).handler();

    const first = fakeCtx();
    const res1 = await app.request('/healthz', {}, {} as never, first.ctx as never);
    expect(await res1.text()).toBe('ok\n');
    expect(builds).toBe(1);
    // close is scheduled on waitUntil, not run inline before the response ships.
    expect(first.waited).toHaveLength(1);
    await Promise.all(first.waited);
    expect(closes).toBe(1);

    // A second request gets its own container, not the first one reused.
    const second = fakeCtx();
    await app.request('/healthz', {}, {} as never, second.ctx as never);
    expect(builds).toBe(2);
    await Promise.all(second.waited);
    expect(closes).toBe(2);
  });

  it('runs close fire-and-forget when there is no execution context', async () => {
    const harness = await newPlatform();
    live.push(harness);

    let closes = 0;
    const app = new Server({
      buildDeps: () => ({ ...testDeps(harness), close: async () => void closes++ }),
    }).handler();

    // No executionCtx passed: c.executionCtx throws, so close runs directly.
    const res = await app.request('/healthz');
    expect(await res.text()).toBe('ok\n');
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget settle
    expect(closes).toBe(1);
  });
});
