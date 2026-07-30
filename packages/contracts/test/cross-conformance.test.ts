// Cross-language conformance, TS → foreign server: runs the shared suite through
// the TS HTTP client against whatever TWO80_CONFORMANCE_URL points at (the Go
// platform), proving the two servers are interchangeable behind the CLI's client.
// Gated on the env var so the ordinary `pnpm -r test` run skips it.

import { describe, it } from 'vitest';
import { cases } from '../src/deploy/conformance.js';
import { newClient } from '../src/deploy/http.js';

const url = process.env.TWO80_CONFORMANCE_URL;

// A fresh account per case needs a token nothing has used before: an OpenSignup
// server derives the account id from the token hash. The timestamp base keeps
// that true across re-runs against a persistent database.
const base = `xconf-ts-${process.pid}-${Date.now()}`;
let seq = 0;

describe.skipIf(!url)('cross conformance (TS suite → foreign server)', () => {
  for (const c of cases) {
    it(c.name, () => c.run(() => newClient(url as string, `${base}-${seq++}`)));
  }
});
