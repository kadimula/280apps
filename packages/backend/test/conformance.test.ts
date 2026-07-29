// The deploy seam's behavioral contract (W1's suite, contracts/deploy/
// conformance) run in-process against the real deploy Service. This is the
// platform half of platform/conformance_test.go TestConformanceInProcess: the
// same named cases the Fake passes, now proving the server behaves identically.
// Cross-conformance over HTTP in both directions is W8.

import { afterEach, describe, it } from 'vitest';
import { conformance, type Port } from '@280/contracts';
import { newPlatform, portFor, type Harness } from './helpers/harness.js';

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

describe('deploy conformance (in-process Service)', () => {
  for (const c of conformance.cases) {
    it(c.name, async () => {
      // A fresh, empty account per case, as the suite's factory promises. Built
      // before run() so the factory it calls can stay synchronous.
      const h = await newPlatform();
      live.push(h);
      const port = (await portFor(h)) as Port;
      await c.run(() => port);
    });
  }
});
