// Cross-language conformance, TS → foreign server. The mirror image of Go's
// platform/crossconformance_test.go: it runs the same 20-case suite (the array
// exported from src/deploy/conformance.ts) through the TS HTTP client against
// whatever server TWO80_CONFORMANCE_URL points at — in practice the Go platform.
// Together the two directions prove the two servers are interchangeable behind
// the one client the CLI ships.
//
// Gated on the env var so the ordinary `pnpm -r test` run skips it; wired to a
// live Go server by tests/cross-conformance.sh.

import { describe, it } from 'vitest';
import { cases } from '../src/deploy/conformance.js';
import { newClient } from '../src/deploy/http.js';

const url = process.env.TWO80_CONFORMANCE_URL;

// A fresh, empty account per case is a token nothing has used before: an
// OpenSignup server derives the account id from the token hash, so a unique token
// is a unique account. The nanosecond base keeps that true across re-runs against
// a server whose database persists.
const base = `xconf-ts-${process.pid}-${Date.now()}`;
let seq = 0;

describe.skipIf(!url)('cross conformance (TS suite → foreign server)', () => {
  for (const c of cases) {
    it(c.name, () => c.run(() => newClient(url as string, `${base}-${seq++}`)));
  }
});
