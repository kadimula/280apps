// Exhaustive coverage of the Google service-account minter behind the handler seam:
// deterministic RS256 assertion signing, single-flight caching, refresh, rotation,
// scope change, rejected-mint retry, 401 invalidation, the provider host boundary,
// and every safe failure category. Signing is verified against a real WebCrypto
// public key — the JWT is genuinely signed, not mocked.

import { describe, it, expect } from 'vitest';
import { makeEgressHandler } from '../src/handler.js';
import type { CallLogEvent, MintEvent } from '../src/calllog.js';
import type { OutboundHandlerCtx } from '../src/types.js';
import {
  makeServiceAccount,
  verifyAssertion,
  fakeUpstream,
  googleParams,
  googleFieldParams,
  GOOGLE_TOKEN_ENDPOINT,
  type FakeUpstreamOptions,
} from './google-fixtures.js';

const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets/abc/values/A1';

interface Rig {
  handler: ReturnType<typeof makeEgressHandler>;
  events: CallLogEvent[];
  mints: MintEvent[];
  vault: { value: string | undefined };
  clock: { t: number };
  call: (params: Record<string, unknown>, url?: string) => Promise<Response>;
}

function rig(upstream: FakeUpstreamOptions & { fetchImpl?: typeof fetch } = {}, initialSecret = ''): Rig {
  const events: CallLogEvent[] = [];
  const mints: MintEvent[] = [];
  const vault = { value: initialSecret as string | undefined };
  const clock = { t: 1_000_000 };
  const fetchImpl = upstream.fetchImpl ?? fakeUpstream(upstream).fetchImpl;
  const handler = makeEgressHandler({
    vaultFrom: () => ({ get: (name) => (name === 'GOOGLE_SA' ? vault.value : undefined) }),
    callLog: (e) => events.push(e),
    mintLog: (e) => mints.push(e),
    fetchImpl,
    clock: () => clock.t,
  });
  const ctx = (params: Record<string, unknown>): OutboundHandlerCtx => ({
    containerId: 'c',
    className: 'App280Container',
    params,
  });
  return {
    handler,
    events,
    mints,
    vault,
    clock,
    call: (params, url = SHEETS_URL) => handler(new Request(url), {}, ctx(params)),
  };
}

describe('google-service-account minter: signing', () => {
  it('signs a valid RS256 assertion with the hardcoded endpoint, ignoring the secret token_uri', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream();
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);

    const res = await r.call(
      googleParams({
        scopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/spreadsheets', // duplicate → deduped
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(up.tokenCalls).toHaveLength(1);
    const { grantType, assertion, redirect } = up.tokenCalls[0]!;
    expect(grantType).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(redirect).toBe('error');

    const decoded = await verifyAssertion(sa.publicKey, assertion);
    expect(decoded.valid).toBe(true); // genuinely signed by the SA private key
    expect(decoded.header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(decoded.claims.iss).toBe(sa.clientEmail);
    expect(decoded.claims.aud).toBe(GOOGLE_TOKEN_ENDPOINT); // never the secret's token_uri
    // scopes normalized: deduped and byte-sorted (drive < spreadsheets)
    expect(decoded.claims.scope).toBe(
      'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    );
    expect((decoded.claims.exp as number) - (decoded.claims.iat as number)).toBe(3600); // ≤ 1h

    // The token reaches the upstream Google API request, not the container's request.
    expect(up.downstreamCalls).toHaveLength(1);
    expect(up.downstreamCalls[0]!.authorization).toBe('Bearer ya29.mock-access-token');

    const mint = r.mints.find((m) => m.kind === 'mint')!;
    expect(mint).toMatchObject({ outcome: 'minted', type: 'google-service-account', reason: '' });
    expect(mint.expiresAtMs).toBe(1_000_000 + 3600 * 1000);
  });
});

describe('google-service-account minter: cache', () => {
  it('single-flight: one cold concurrent burst makes exactly one token-endpoint request', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream();
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);

    const results = await Promise.all(Array.from({ length: 6 }, () => r.call(googleParams())));

    expect(results.every((res) => res.status === 200)).toBe(true);
    expect(up.tokenCalls).toHaveLength(1); // single-flight collapsed the burst
    expect(up.downstreamCalls).toHaveLength(6);
    expect(up.downstreamCalls.every((c) => c.authorization === 'Bearer ya29.mock-access-token')).toBe(true);
  });

  it('serves a cached token on a second call without re-minting', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream();
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);

    await r.call(googleParams());
    r.clock.t += 1000; // still well within validity
    const res = await r.call(googleParams());

    expect(res.status).toBe(200);
    expect(up.tokenCalls).toHaveLength(1);
    const outcomes = r.mints.map((m) => m.outcome);
    expect(outcomes).toEqual(['minted', 'cache']);
  });

  it('refreshes within 60s of expiry', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream({
      tokenResponse: (n) =>
        new Response(JSON.stringify({ access_token: `tok-${n}`, expires_in: 3600 }), { status: 200 }),
    });
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);

    await r.call(googleParams());
    r.clock.t += 3600_000 - 30_000; // inside the 60s refresh lead
    const res = await r.call(googleParams());

    expect(res.status).toBe(200);
    expect(up.tokenCalls).toHaveLength(2); // re-minted before expiry
    expect(up.downstreamCalls[1]!.authorization).toBe('Bearer tok-1');
  });

  it('re-mints when the secret value rotates (value-hash change), same app/secret/scopes', async () => {
    const sa1 = await makeServiceAccount('a@proj.iam.gserviceaccount.com');
    const sa2 = await makeServiceAccount('b@proj.iam.gserviceaccount.com');
    const up = fakeUpstream();
    const r = rig({ fetchImpl: up.fetchImpl }, sa1.json);

    await r.call(googleParams());
    r.vault.value = sa2.json; // rotation
    const res = await r.call(googleParams());

    expect(res.status).toBe(200);
    expect(up.tokenCalls).toHaveLength(2);
    // The second assertion is signed by the rotated key and carries the new issuer.
    const decoded = await verifyAssertion(sa2.publicKey, up.tokenCalls[1]!.assertion);
    expect(decoded.valid).toBe(true);
    expect(decoded.claims.iss).toBe('b@proj.iam.gserviceaccount.com');
  });

  it('re-mints when scopes change', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream();
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);

    await r.call(googleParams({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] }));
    await r.call(googleParams({ scopes: ['https://www.googleapis.com/auth/drive'] }));

    expect(up.tokenCalls).toHaveLength(2);
  });

  it('evicts a rejected mint so the next call retries', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream({ tokenThrows: (n) => n === 0 });
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);

    const first = await r.call(googleParams());
    expect(first.status).toBe(520);
    expect(await first.text()).toBe('token-endpoint-unreachable');

    const second = await r.call(googleParams()); // retried, not a poisoned cache hit
    expect(second.status).toBe(200);
    expect(up.tokenCalls).toHaveLength(2);
  });

  it('invalidates the cached token on a downstream 401 so the next call re-mints', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream({
      downstreamResponse: (n) => new Response('', { status: n === 0 ? 401 : 200 }),
    });
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);

    const first = await r.call(googleParams());
    expect(first.status).toBe(401); // forwarded to the app; entry evicted
    const second = await r.call(googleParams());
    expect(second.status).toBe(200);
    expect(up.tokenCalls).toHaveLength(2); // re-minted rather than served from cache
  });

  it('does not re-mint on a non-401 downstream error (entry stays cached)', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream({
      downstreamResponse: (n) => new Response('', { status: n === 0 ? 500 : 200 }),
    });
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);

    await r.call(googleParams());
    await r.call(googleParams());
    expect(up.tokenCalls).toHaveLength(1);
  });
});

describe('google-service-account minter: fail-closed dispatch', () => {
  it('unknown credential type returns 520 mint-failed and forwards nothing', async () => {
    const up = fakeUpstream();
    const r = rig({ fetchImpl: up.fetchImpl }, 'secret-value-must-not-forward');

    const res = await r.call(googleParams({ type: 'aws-sigv4' }));
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('mint-failed');
    expect(up.tokenCalls).toHaveLength(0);
    expect(up.downstreamCalls).toHaveLength(0);
    expect(r.mints.at(-1)).toMatchObject({ outcome: 'failed', reason: 'mint-failed' });
  });

  it('a host outside the provider boundary returns 520 provider-host-forbidden, no token exchange', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream();
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);

    for (const host of ['api.notgoogle.com', 'googleapis.com.evil.com', 'evilgoogleapis.com']) {
      const res = await r.call(googleParams({ host }), `https://${host}/x`);
      expect(res.status).toBe(520);
      expect(await res.text()).toBe('provider-host-forbidden');
    }
    expect(up.tokenCalls).toHaveLength(0);
    expect(up.downstreamCalls).toHaveLength(0);
  });

  it('accepts the apex and label-boundary Google hosts', async () => {
    const sa = await makeServiceAccount();
    for (const host of ['googleapis.com', 'sheets.googleapis.com']) {
      const up = fakeUpstream();
      const r = rig({ fetchImpl: up.fetchImpl }, sa.json);
      const res = await r.call(googleParams({ host }), `https://${host}/x`);
      expect(res.status).toBe(200);
      expect(up.tokenCalls).toHaveLength(1);
    }
  });
});

describe('google-service-account minter: safe failure categories', () => {
  const cases: { name: string; secret: string; up?: FakeUpstreamOptions; category: string }[] = [
    { name: 'malformed JSON secret', secret: 'this-is-not-json', category: 'malformed-secret' },
    {
      name: 'missing client_email',
      secret: JSON.stringify({ private_key: '-----BEGIN PRIVATE KEY-----\nMII=\n-----END PRIVATE KEY-----' }),
      category: 'malformed-secret',
    },
    {
      name: 'malformed PEM (non-base64 body)',
      secret: JSON.stringify({
        client_email: 'x@y.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\n!!!not base64!!!\n-----END PRIVATE KEY-----',
      }),
      category: 'malformed-secret',
    },
    {
      name: 'well-formed base64 but not a PKCS8 key',
      secret: JSON.stringify({
        client_email: 'x@y.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nQUJDRA==\n-----END PRIVATE KEY-----',
      }),
      category: 'malformed-secret',
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.category}`, async () => {
      const up = fakeUpstream(c.up);
      const r = rig({ fetchImpl: up.fetchImpl }, c.secret);
      const res = await r.call(googleParams());
      expect(res.status).toBe(520);
      expect(await res.text()).toBe(c.category);
      expect(up.downstreamCalls).toHaveLength(0);
    });
  }

  it('token endpoint network error → token-endpoint-unreachable', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream({ tokenThrows: () => true });
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);
    const res = await r.call(googleParams());
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('token-endpoint-unreachable');
  });

  it('token endpoint 400 invalid_grant → invalid_grant', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream({
      tokenResponse: () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);
    const res = await r.call(googleParams());
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('invalid_grant');
  });

  it('token endpoint 500 → token-endpoint-status', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream({ tokenResponse: () => new Response('upstream boom', { status: 500 }) });
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);
    const res = await r.call(googleParams());
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('token-endpoint-status');
  });

  it('200 with non-JSON body → invalid-token-response', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream({ tokenResponse: () => new Response('not json', { status: 200 }) });
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);
    const res = await r.call(googleParams());
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('invalid-token-response');
  });

  it('200 with missing access_token → invalid-token-response', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream({ tokenResponse: () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }) });
    const r = rig({ fetchImpl: up.fetchImpl }, sa.json);
    const res = await r.call(googleParams());
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('invalid-token-response');
  });

  for (const expires of [0, -5, 999_999, undefined]) {
    it(`200 with invalid expires_in=${expires} → invalid-token-response`, async () => {
      const sa = await makeServiceAccount();
      const body: Record<string, unknown> = { access_token: 'x' };
      if (expires !== undefined) body.expires_in = expires;
      const up = fakeUpstream({ tokenResponse: () => new Response(JSON.stringify(body), { status: 200 }) });
      const r = rig({ fetchImpl: up.fetchImpl }, sa.json);
      const res = await r.call(googleParams());
      expect(res.status).toBe(520);
      expect(await res.text()).toBe('invalid-token-response');
    });
  }
});

describe('google-service-account minter: multi-field form', () => {
  // A handler backed by a per-NAME vault, so field NAMEs resolve independently.
  function fieldRig(secrets: Record<string, string | undefined>, upstream = fakeUpstream()) {
    const events: CallLogEvent[] = [];
    const mints: MintEvent[] = [];
    const handler = makeEgressHandler({
      vaultFrom: () => ({ get: (name) => secrets[name] }),
      callLog: (e) => events.push(e),
      mintLog: (e) => mints.push(e),
      fetchImpl: upstream.fetchImpl,
      clock: () => 1_000_000,
    });
    const ctx = (params: Record<string, unknown>): OutboundHandlerCtx => ({
      containerId: 'c',
      className: 'App280Container',
      params,
    });
    return {
      handler,
      events,
      mints,
      upstream,
      call: (params: Record<string, unknown>, url = SHEETS_URL) => handler(new Request(url), {}, ctx(params)),
    };
  }

  it('mints a byte-identical assertion to the blob form (same key, same claims)', async () => {
    const sa = await makeServiceAccount();

    const blobUp = fakeUpstream();
    const blob = rig({ fetchImpl: blobUp.fetchImpl }, sa.json);
    const blobRes = await blob.call(googleParams());

    const fieldUp = fakeUpstream();
    const fields = fieldRig(
      { GOOGLE_CLIENT_EMAIL: sa.clientEmail, GOOGLE_PRIVATE_KEY: sa.privateKeyPem },
      fieldUp,
    );
    const fieldRes = await fields.call(googleFieldParams());

    expect(blobRes.status).toBe(200);
    expect(fieldRes.status).toBe(200);
    // The blob was only ever client_email + private_key, so the discrete fields sign
    // the exact same JWT (RS256/PKCS1-v1.5 is deterministic; the clock is fixed).
    expect(fieldUp.tokenCalls[0]!.assertion).toBe(blobUp.tokenCalls[0]!.assertion);
    const decoded = await verifyAssertion(sa.publicKey, fieldUp.tokenCalls[0]!.assertion);
    expect(decoded.valid).toBe(true);
    expect(decoded.claims.iss).toBe(sa.clientEmail);

    // The mint audit identity is the joined field NAMEs, never a value.
    expect(fields.mints[0]).toMatchObject({ outcome: 'minted', secret: 'GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY' });
  });

  it('fails closed when any one field is unprovisioned, forwarding nothing', async () => {
    const sa = await makeServiceAccount();
    const up = fakeUpstream();
    const r = fieldRig({ GOOGLE_CLIENT_EMAIL: sa.clientEmail /* GOOGLE_PRIVATE_KEY missing */ }, up);

    const res = await r.call(googleFieldParams());
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('Origin is disallowed');
    expect(up.tokenCalls).toHaveLength(0);
    expect(up.downstreamCalls).toHaveLength(0);
    expect(r.events.at(-1)).toMatchObject({ outcome: 'denied', reason: 'missing-secret', credentialAttached: false });
  });

  it('reports malformed field values with the same safe category as the blob path', async () => {
    const up = fakeUpstream();
    const r = fieldRig({ GOOGLE_CLIENT_EMAIL: 'x@y.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: 'not-a-pem' }, up);
    const res = await r.call(googleFieldParams());
    expect(res.status).toBe(520);
    expect(await res.text()).toBe('malformed-secret');
    expect(up.downstreamCalls).toHaveLength(0);
  });
});

describe('google-service-account minter: header path preserved', () => {
  it('a header-type credential still injects statically, byte for byte, with no mint event', async () => {
    const up = fakeUpstream();
    const r = rig({ fetchImpl: up.fetchImpl }, 'raw-secret');
    const res = await r.call({
      appId: 'app_1',
      host: 'api.example.com',
      secret: 'GOOGLE_SA',
      type: 'header',
      header: 'authorization',
      scheme: 'Bearer',
      scopes: [],
    }, 'https://api.example.com/x');
    expect(res.status).toBe(200);
    expect(up.downstreamCalls[0]!.authorization).toBe('Bearer raw-secret');
    expect(r.mints).toHaveLength(0); // header path emits no mint event
    expect(up.tokenCalls).toHaveLength(0);
  });
});
