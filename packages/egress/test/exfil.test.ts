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
import { makeEgressHandler } from '../src/handler.js';
import { registerEgress, applyEgressPolicy } from '../src/register.js';
import { mapVault } from '../src/vault.js';
import type { CallLogEvent, MintEvent } from '../src/calllog.js';
import type { EgressContainerClass, OutboundHandlerCtx } from '../src/types.js';
import { FakeContainer } from './fake-container.js';
import { makeServiceAccount, fakeUpstream, googleParams } from './google-fixtures.js';

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

// The minted-credential exfiltration guarantee. What 280 guarantees: the service
// account private key and the minted access token never appear in the container's own
// (app-observable) request, the returned platform error body, or any audit event. The
// token is attached only to the outbound request to the Google API and is therefore
// visible to Google — that is intended. What is explicitly OUTSIDE the absolute
// guarantee: arbitrary provider RESPONSE content. Google (or any provider) could echo
// a token or key material in a response body, which the app then sees; 280 does not
// and cannot control that, so these tests deliberately do not assert on it.
describe('exfiltration / minted Google credentials', () => {
  function driveGoogle(secret: string, upstream = fakeUpstream()) {
    const events: CallLogEvent[] = [];
    const mints: MintEvent[] = [];
    const handler = makeEgressHandler({
      vaultFrom: () => mapVault({ GOOGLE_SA: secret }),
      callLog: (e) => events.push(e),
      mintLog: (e) => mints.push(e),
      fetchImpl: upstream.fetchImpl,
      clock: () => 1_000_000,
    });
    const ctx: OutboundHandlerCtx = { containerId: 'c', className: 'App280Container', params: googleParams() };
    return { handler, events, mints, upstream, ctx };
  }

  it('the private key and minted token never reach the app request, the error, or any log', async () => {
    const sa = await makeServiceAccount();
    const ACCESS_TOKEN = 'ya29.super-secret-access-token';
    const upstream = fakeUpstream({ defaultToken: { access_token: ACCESS_TOKEN, expires_in: 3600 } });
    const { handler, events, mints, ctx } = driveGoogle(sa.json, upstream);

    // The container issues a plain request with no auth header.
    const containerReq = new Request('https://sheets.googleapis.com/v4/spreadsheets/x/values/A1');
    expect(containerReq.headers.get('authorization')).toBeNull();

    const res = await handler(containerReq, {}, ctx);
    expect(res.status).toBe(200);

    // The private key material is never in any audit event.
    const logs = JSON.stringify([...events, ...mints]);
    expect(logs).not.toContain(sa.privateKeyPem);
    expect(logs).not.toContain('PRIVATE KEY');
    // The minted access token is never in any audit event...
    expect(logs).not.toContain(ACCESS_TOKEN);
    // ...but the mint event still records safe, non-sensitive fields.
    expect(mints[0]).toMatchObject({ kind: 'mint', secret: 'GOOGLE_SA', type: 'google-service-account' });

    // The token is attached to the outbound Google request only (intended), and the
    // container's original request object was never mutated to carry it.
    expect(upstream.downstreamCalls[0]!.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(containerReq.headers.get('authorization')).toBeNull();
  });

  it('a mint failure returns only the safe category, never the private key or assertion', async () => {
    const sa = await makeServiceAccount();
    // Force a token-endpoint rejection so the failure path is exercised end to end.
    const upstream = fakeUpstream({
      tokenResponse: () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });
    const { handler, events, mints, ctx } = driveGoogle(sa.json, upstream);

    const res = await handler(new Request('https://sheets.googleapis.com/v4/x'), {}, ctx);
    const body = await res.text();
    expect(res.status).toBe(520);
    expect(body).toBe('invalid_grant'); // fixed category, no values
    expect(body).not.toContain('PRIVATE KEY');

    const logs = JSON.stringify([...events, ...mints]);
    expect(logs).not.toContain(sa.privateKeyPem);
    expect(logs).not.toContain('PRIVATE KEY');
    expect(mints.at(-1)).toMatchObject({ outcome: 'failed', reason: 'invalid_grant' });
  });
});
