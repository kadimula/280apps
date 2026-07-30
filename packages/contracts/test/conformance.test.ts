// Holds the Fake to the shared behavioral suite (src/deploy/conformance.ts); the
// HTTP adapter runs the same array over the network via TWO80_CONFORMANCE_URL.

import { describe, it } from 'vitest';
import { cases } from '../src/deploy/conformance.js';
import { Fake } from '../src/deploy/fake.js';

describe('deploy conformance (Fake)', () => {
  for (const c of cases) {
    it(c.name, () => c.run(() => new Fake()));
  }
});
