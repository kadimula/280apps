// The CI exfiltration test: the regression guard for the load-bearing wall. It
// drives the real egress handler + applyEgressPolicy through a faithful
// ContainerProxy double and proves the acceptance criteria:
//   - a container with no egress config reaches nothing (default-deny);
//   - an allowlisted host is reachable with the credential attached by the handler,
//     and the app/container never sees the raw credential;
//   - a non-allowlisted host fails closed (HTTP 520);
//   - a call-log event is emitted per outbound request, and never leaks the secret.
// If a regression opens egress (enableInternet flipped, exfil host allowlisted,
// creds handed to the container), one of these assertions fails.

import { describe, it, expect } from 'vitest';
import { normalizeEgressPolicy, type EgressPolicy } from '@280/contracts';
import { registerEgress, applyEgressPolicy } from '../src/register.js';
import { mapVault } from '../src/vault.js';
import type { CallLogEvent } from '../src/calllog.js';
import type { EgressContainerClass } from '../src/types.js';
import { FakeContainer } from './fake-container.js';

const SECRET_VALUE = 'sk_live_must_never_reach_the_container';

// An upstream double that records what it received, so we can prove the credential
// arrived at the destination (and only there). Returns 200 echoing the headers.
function recordingUpstream() {
  const seen: { url: string; authorization: string | null; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: Request | string | URL) => {
    const req = input instanceof Request ? input : new Request(String(input));
    seen.push({
      url: req.url,
      authorization: req.headers.get('authorization'),
      headers: Object.fromEntries(req.headers),
    });
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

function setup(policy: EgressPolicy, secrets: Record<string, string>) {
  const upstream = recordingUpstream();
  const events: CallLogEvent[] = [];
  const cls: EgressContainerClass = {};
  registerEgress(cls, {
    vaultFrom: () => mapVault(secrets),
    callLog: (e) => events.push(e),
    fetchImpl: upstream.fetchImpl,
  });
  const container = new FakeContainer({ cls, env: {} });
  return { upstream, events, cls, container, apply: () => applyEgressPolicy(container, policy, 'app_1') };
}

describe('exfiltration / egress fail-closed', () => {
  it('default-deny: a container with no egress config reaches nothing', async () => {
    const cls: EgressContainerClass = {};
    registerEgress(cls, { vaultFrom: () => mapVault({}) });
    const container = new FakeContainer({ cls, env: {} });
    // No applyEgressPolicy call at all: allowedHosts unset, enableInternet false.
    const res = await container.outboundFetch(new Request('https://anything.example/x'));
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('Origin is disallowed');
  });

  it('allowlisted host is reachable with the credential attached in-flight', async () => {
    const policy = normalizeEgressPolicy({
      allowedHosts: ['data.example.com'],
      credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer' }],
    });
    const { upstream, events, container, apply } = setup(policy, { STRIPE_KEY: SECRET_VALUE });
    await apply();

    // The container issues a plain request with NO auth header.
    const containerReq = new Request('https://api.stripe.com/v1/charges');
    expect(containerReq.headers.get('authorization')).toBeNull();

    const res = await container.outboundFetch(containerReq);
    expect(res.status).toBe(200);
    // Upstream received the injected credential; the container's own request did not.
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]!.authorization).toBe(`Bearer ${SECRET_VALUE}`);
    // Exactly one call-log event, marking the credential attached, naming the secret
    // but never carrying its value.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      appId: 'app_1',
      host: 'api.stripe.com',
      status: 200,
      credentialAttached: true,
      secret: 'STRIPE_KEY',
      outcome: 'forwarded',
    });
    expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
  });

  it('non-allowlisted host fails closed with HTTP 520 and never reaches upstream', async () => {
    const policy = normalizeEgressPolicy({
      allowedHosts: [],
      credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY' }],
    });
    const { upstream, events, container, apply } = setup(policy, { STRIPE_KEY: SECRET_VALUE });
    await apply();

    const res = await container.outboundFetch(new Request('https://evil.example/steal'));
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('Origin is disallowed');
    // Blocked at the allowlist gate before any handler ran: no fetch, no cred, no log.
    expect(upstream.seen).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('an allowlisted host without a credential is reachable and logged, no creds attached', async () => {
    const policy = normalizeEgressPolicy({ allowedHosts: ['data.example.com'], credentials: [] });
    const { upstream, events, container, apply } = setup(policy, {});
    await apply();

    const res = await container.outboundFetch(new Request('https://data.example.com/rows'));
    expect(res.status).toBe(200);
    expect(upstream.seen[0]!.authorization).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ credentialAttached: false, secret: '', outcome: 'forwarded' });
  });

  it('a credentialed host with no provisioned secret fails closed (does not forward un-credentialed)', async () => {
    const policy = normalizeEgressPolicy({
      allowedHosts: [],
      credentials: [{ host: 'api.stripe.com', secret: 'STRIPE_KEY' }],
    });
    const { upstream, events, container, apply } = setup(policy, {}); // vault empty
    await apply();

    const res = await container.outboundFetch(new Request('https://api.stripe.com/v1/charges'));
    expect(res.status).toBe(520);
    expect(upstream.seen).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'denied', reason: 'missing-secret', credentialAttached: false });
  });

  it('glob allowlist matches subdomains but not the bare domain (library semantics)', async () => {
    const policy = normalizeEgressPolicy({
      allowedHosts: ['*.supabase.co'],
      credentials: [{ host: '*.supabase.co', secret: 'SB', header: 'apikey', scheme: '' }],
    });
    const { upstream, container, apply } = setup(policy, { SB: 'sb_secret' });
    await apply();

    const ok = await container.outboundFetch(new Request('https://xyz.supabase.co/rest/v1/rows'));
    expect(ok.status).toBe(200);
    expect(upstream.seen[0]!.url).toContain('xyz.supabase.co');
    // Raw-value header (scheme ''): the value is set without a scheme prefix.
    expect(upstream.seen[0]!.headers['apikey']).toBe('sb_secret');

    const bare = await container.outboundFetch(new Request('https://supabase.co/'));
    expect(bare.status).toBe(520);
  });
});
