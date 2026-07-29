// Holds the Fake to the seam's behavioral contract: the same 20 cases the Go
// suite runs, ported in src/deploy/conformance.ts. The production HTTP adapter
// runs this identical array over the network at Gate C (TWO80_CONFORMANCE_URL).

import { describe, it } from 'vitest';
import { cases } from '../src/deploy/conformance.js';
import { Fake } from '../src/deploy/fake.js';

describe('deploy conformance (Fake)', () => {
  for (const c of cases) {
    it(c.name, () => c.run(() => new Fake()));
  }
});
