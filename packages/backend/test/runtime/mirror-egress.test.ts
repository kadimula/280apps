// The production appcontainer mirror's egress floor: a credential type this floor
// does not implement must fail closed (HTTP 520, no upstream request, vault never
// read) rather than fall through to raw header injection — otherwise a typed
// credential's full value (e.g. a service-account private key) would reach the wire.
// Drives the dep-free mirror module directly through a faithful ContainerProxy
// double, exactly as the per-app Worker would (only JSON params cross the DO
// boundary). Keep in step with packages/egress/test/exfil.test.ts.

import { describe, it, expect, vi } from 'vitest';
import {
  egressHandler,
  applyEgressPolicy,
  EGRESS_HANDLER,
} from '../../../../platform/appcontainer/src/egress.js';

// Captures the per-host handler params applyEgressPolicy binds, so the handler is
// invoked with exactly what the runtime would pass it.
function fakeStub() {
  let byHost: Record<string, { method: string; params: Record<string, unknown> }> = {};
  return {
    setAllowedHosts: async () => {},
    setOutboundByHosts: async (m: typeof byHost) => {
      byHost = m;
    },
    paramsFor: (host: string) => byHost[host]?.params,
    methodFor: (host: string) => byHost[host]?.method,
  };
}

describe('appcontainer mirror egress floor', () => {
  it('rejects an unknown credential type with 520, no upstream request, and no vault read', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const stub = fakeStub();
      const policy = {
        allowedHosts: ['sheets.googleapis.com'],
        credentials: [
          {
            host: 'sheets.googleapis.com',
            secret: 'GOOGLE_SA',
            header: 'authorization',
            scheme: 'Bearer',
            type: 'google-service-account',
          },
        ],
      };
      await applyEgressPolicy(stub, policy, 'app_1');

      const params = stub.paramsFor('sheets.googleapis.com')!;
      // applyEgressPolicy must PROPAGATE the type: a guard living only in the handler
      // would be defeated if the type were dropped when the params are bound.
      expect(params.type).toBe('google-service-account');
      expect(stub.methodFor('sheets.googleapis.com')).toBe(EGRESS_HANDLER);

      const secret = 'PRIVATE-KEY-MATERIAL';
      const res = egressHandler(
        new Request('https://sheets.googleapis.com/v4/spreadsheets/abc'),
        { GOOGLE_SA: secret },
        { params },
      );
      expect(res.status).toBe(520);
      expect(await res.text()).toBe('Origin is disallowed');
      // Failed closed before the vault read and before any forward: no fetch, and the
      // secret value never surfaced.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still injects a static header credential (no type) in-flight', async () => {
    const seen: (string | null)[] = [];
    const fetchSpy = vi.fn(async (input: Request | string | URL) => {
      const req = input instanceof Request ? input : new Request(String(input));
      seen.push(req.headers.get('authorization'));
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const stub = fakeStub();
      const policy = {
        allowedHosts: ['api.stripe.com'],
        credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer' }],
      };
      await applyEgressPolicy(stub, policy, 'app_1');

      const params = stub.paramsFor('api.stripe.com')!;
      expect(params.type).toBe(''); // absent type => static header form
      const res = await egressHandler(
        new Request('https://api.stripe.com/v1/charges'),
        { STRIPE_KEY: 'sk_live_x' },
        { params },
      );
      expect(res.status).toBe(200);
      expect(seen).toEqual(['Bearer sk_live_x']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts an explicit type of "header" (the static form named)', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const res = await egressHandler(
        new Request('https://api.stripe.com/v1/charges'),
        { STRIPE_KEY: 'sk_live_x' },
        { params: { host: 'api.stripe.com', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer', type: 'header' } },
      );
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
