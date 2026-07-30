// Unit coverage for the outbound handler and the registration wiring, independent
// of the container-proxy precedence exercised by exfil.test.

import { describe, it, expect } from 'vitest';
import { makeEgressHandler } from '../src/handler.js';
import { registerEgress, applyEgressPolicy, EGRESS_HANDLER_NAME } from '../src/register.js';
import { mapVault, envVault } from '../src/vault.js';
import type { CallLogEvent } from '../src/calllog.js';
import type { ContainerStub, EgressContainerClass, OutboundByHostEntry } from '../src/types.js';

function collectingFetch() {
  const seen: Request[] = [];
  const fetchImpl = (async (input: Request | string | URL) => {
    const req = input instanceof Request ? input : new Request(String(input));
    seen.push(req);
    return new Response('ok', { status: 201 });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe('makeEgressHandler', () => {
  it('injects the credential from the vault and leaves the query out of the log path', async () => {
    const { seen, fetchImpl } = collectingFetch();
    const events: CallLogEvent[] = [];
    const handler = makeEgressHandler({
      vaultFrom: () => mapVault({ KEY: 'v-123' }),
      callLog: (e) => events.push(e),
      fetchImpl,
    });
    const res = await handler(new Request('https://api.example.com/path?token=leak'), {}, {
      containerId: 'c',
      className: 'App280Container',
      params: { appId: 'a1', host: 'api.example.com', secret: 'KEY', header: 'authorization', scheme: 'Bearer' },
    });
    expect(res.status).toBe(201);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer v-123');
    expect(events[0]!.path).toBe('/path'); // query dropped from the audit trail
    expect(events[0]!.status).toBe(201);
  });

  it('supports a raw-value header when scheme is empty', async () => {
    const { seen, fetchImpl } = collectingFetch();
    const handler = makeEgressHandler({ vaultFrom: () => mapVault({ SB: 'raw' }), fetchImpl });
    await handler(new Request('https://x.supabase.co/'), {}, {
      containerId: 'c',
      className: 'k',
      params: { appId: 'a', host: 'x.supabase.co', secret: 'SB', header: 'apikey', scheme: '' },
    });
    expect(seen[0]!.headers.get('apikey')).toBe('raw');
    expect(seen[0]!.headers.get('authorization')).toBeNull();
  });

  it('forwards without a credential when the host has no secret', async () => {
    const { seen, fetchImpl } = collectingFetch();
    const handler = makeEgressHandler({ vaultFrom: () => mapVault({}), fetchImpl });
    await handler(new Request('https://open.example.com/'), {}, {
      containerId: 'c',
      className: 'k',
      params: { appId: 'a', host: 'open.example.com', secret: '', header: 'authorization', scheme: 'Bearer' },
    });
    expect(seen[0]!.headers.get('authorization')).toBeNull();
  });

  it('reads secrets from the Worker env via the default envVault', async () => {
    const { seen, fetchImpl } = collectingFetch();
    const handler = makeEgressHandler({ vaultFrom: envVault, fetchImpl });
    await handler(new Request('https://api.example.com/'), { TOKEN: 'from-env' }, {
      containerId: 'c',
      className: 'k',
      params: { appId: 'a', host: 'api.example.com', secret: 'TOKEN', header: 'authorization', scheme: 'Bearer' },
    });
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer from-env');
  });
});

describe('registerEgress / applyEgressPolicy', () => {
  it('registers the handler by assignment so the library setter runs (no class-field shadow)', () => {
    const cls: EgressContainerClass = {};
    registerEgress(cls);
    expect(cls.outboundHandlers).toBeDefined();
    expect(typeof cls.outboundHandlers![EGRESS_HANDLER_NAME]).toBe('function');
  });

  it('binds every allowed host through the egress handler with per-host params', async () => {
    const calls: { hosts?: string[]; byHost?: Record<string, string | OutboundByHostEntry> } = {};
    const stub: ContainerStub = {
      async setAllowedHosts(hosts) {
        calls.hosts = hosts;
      },
      async setOutboundByHosts(byHost) {
        calls.byHost = byHost;
      },
    };
    await applyEgressPolicy(
      stub,
      {
        allowedHosts: ['api.stripe.com', 'data.example.com'],
        credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer' }],
      },
      'app_9',
    );
    expect(calls.hosts).toEqual(['api.stripe.com', 'data.example.com']);
    const stripe = calls.byHost!['api.stripe.com'] as OutboundByHostEntry;
    expect(stripe.method).toBe(EGRESS_HANDLER_NAME);
    expect(stripe.params).toMatchObject({ appId: 'app_9', host: 'api.stripe.com', secret: 'STRIPE_KEY' });
    // An allowed host with no credential still gets a handler binding (so it is logged).
    const data = calls.byHost!['data.example.com'] as OutboundByHostEntry;
    expect(data.params).toMatchObject({ host: 'data.example.com', secret: '' });
  });
});
