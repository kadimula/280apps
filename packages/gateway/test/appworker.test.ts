// The app-Worker middleware: verify-and-forward against a fake GATEWAY binding and a
// fake container. These prove the hot path (local verify, no central call), the
// mint/refresh path (login/deny/token + host-only cookie), route gating, and the
// central-unreachable 503, entirely under node with WebCrypto.

import { beforeEach, describe, expect, it } from 'vitest';
import { handleAppRequest, __resetJwksCache, type AppWorkerEnv, type AppWorkerDeps } from '../src/appworker.js';
import type { GatewayBinding, JwksDoc, MintInput, MintResult } from '../src/mint.js';
import { ID_COOKIE, SESSION_COOKIE } from '../src/cookies.js';
import { IdentitySigner } from '../src/identity.js';
import { genSigningKey, ISSUER } from './helpers.js';

const HOST = 'renewals.280apps.run';
const NOW = 1_800_000_000;

interface Signed {
  signer: IdentitySigner;
  publicJwks: Record<string, JsonWebKey>;
}

async function newSigner(now: () => number, ttlSecs = 30): Promise<Signed> {
  const { privateJwk, publicJwks, kid } = await genSigningKey();
  return { signer: new IdentitySigner({ kid, privateJwk, issuer: ISSUER, ttlSecs, now }), publicJwks };
}

function token(
  signer: IdentitySigner,
  over: { aud?: string; appRole?: string; role?: string; email?: string } = {},
): Promise<string> {
  return signer.sign({
    sub: 'u1',
    email: over.email ?? 'alice@evergreen.com',
    name: 'alice',
    aud: over.aud ?? HOST,
    app: 'app_renewals',
    appRole: over.appRole ?? 'viewer',
    role: over.role ?? '',
  });
}

// FakeGateway is the service-binding double: jwks() serves the public set and counts
// calls; mint() returns a scripted result (or throws to simulate a central outage).
class FakeGateway implements GatewayBinding {
  jwksCalls = 0;
  mintCalls: MintInput[] = [];
  constructor(
    private publicJwks: Record<string, JsonWebKey>,
    private onMint: (input: MintInput) => Promise<MintResult> = async () => {
      throw new Error('mint not configured');
    },
  ) {}

  async jwks(): Promise<JwksDoc> {
    this.jwksCalls++;
    return { keys: Object.values(this.publicJwks) };
  }

  async mint(input: MintInput): Promise<MintResult> {
    this.mintCalls.push(input);
    return this.onMint(input);
  }
}

// FakeContainer echoes the stamped identity header so a test can prove what reached it.
class FakeContainer {
  requests: Request[] = [];
  async fetch(request: Request): Promise<Response> {
    this.requests.push(request);
    return new Response(JSON.stringify({ id: request.headers.get('X-280-Identity') }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}

function env(gateway: GatewayBinding, over: Partial<AppWorkerEnv> = {}): AppWorkerEnv {
  return {
    GATEWAY: gateway,
    TWO80_SCRIPT: 'renewals',
    TWO80_ID_ISSUER: ISSUER,
    TWO80_ID_SKEW_SECS: '5',
    ...over,
  };
}

function req(cookie?: string): Request {
  return new Request(`https://${HOST}/`, cookie ? { headers: { cookie } } : {});
}

function deps(container: FakeContainer, now = NOW): AppWorkerDeps {
  return { container: container as unknown as Fetcher, now: () => now };
}

function setCookie(res: Response, name: string): string | null {
  for (const sc of res.headers.getSetCookie()) if (sc.startsWith(name + '=')) return sc;
  return null;
}

beforeEach(() => __resetJwksCache());

describe('app-worker middleware', () => {
  it('serves a valid token entirely locally, stamping identity, with no central call', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const container = new FakeContainer();
    const t = await token(signer);

    const res = await handleAppRequest(req(`${ID_COOKIE}=${t}`), env(gw), deps(container));
    expect(res.status).toBe(200);
    expect(gw.mintCalls).toHaveLength(0); // steady state never mints
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(t);
    // The container saw exactly the minted token, no client-supplied x-280-* leaks.
    expect(container.requests[0]!.headers.get('X-280-Identity')).toBe(t);
  });

  it('re-mints silently when the token has expired and delivers a host-only cookie', async () => {
    const { signer } = await newSigner(() => NOW - 100); // exp = NOW-70, expired
    const fresh = await newSigner(() => NOW); // the token the central mint hands back
    const gw = new FakeGateway(fresh.publicJwks, async () => ({
      kind: 'token',
      token: await token(fresh.signer),
      ttlSecs: 30,
    }));
    const container = new FakeContainer();
    const expired = await token(signer);

    const res = await handleAppRequest(
      req(`${ID_COOKIE}=${expired}; ${SESSION_COOKIE}=sess`),
      env(gw),
      deps(container),
    );
    expect(res.status).toBe(200);
    expect(gw.mintCalls).toHaveLength(1);
    expect(gw.mintCalls[0]!.sessionToken).toBe('sess');
    const sc = setCookie(res, ID_COOKIE);
    expect(sc).not.toBeNull();
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).toContain('Max-Age=30');
    expect(sc).not.toContain('Domain='); // host-only: never leaks to another app host
  });

  it('mints on first visit (no id cookie) and serves', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks, async () => ({ kind: 'token', token: await token(signer), ttlSecs: 30 }));
    const container = new FakeContainer();

    const res = await handleAppRequest(req(`${SESSION_COOKIE}=sess`), env(gw), deps(container));
    expect(res.status).toBe(200);
    expect(setCookie(res, ID_COOKIE)).not.toBeNull();
  });

  it('302s to the login URL when there is no session', async () => {
    const { publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks, async () => ({
      kind: 'login',
      url: 'https://auth.280apps.run/login?return=x',
    }));
    const res = await handleAppRequest(req(), env(gw), deps(new FakeContainer()));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://auth.280apps.run/login?return=x');
  });

  it('403s when the mint denies access', async () => {
    const { publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks, async () => ({ kind: 'deny', reason: 'no grant' }));
    const container = new FakeContainer();
    const res = await handleAppRequest(req(`${SESSION_COOKIE}=sess`), env(gw), deps(container));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('no grant');
    expect(container.requests).toHaveLength(0);
  });

  it('503s when the central gateway is unreachable and no valid token is held', async () => {
    const { publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks, async () => {
      throw new Error('binding down');
    });
    const res = await handleAppRequest(req(`${SESSION_COOKIE}=sess`), env(gw), deps(new FakeContainer()));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('unavailable');
  });

  it('enforces the baked route gate locally against the token roles', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const container = new FakeContainer();
    // A viewer-role token hitting an admin-gated /admin path is refused with no proxy.
    const policy = JSON.stringify({ access: 'invited', roles: [], routes: [{ path: '/admin/*', appRole: 'admin', role: '' }], secrets: [] });
    const t = await token(signer, { appRole: 'viewer' });
    const res = await handleAppRequest(
      new Request(`https://${HOST}/admin/users`, { headers: { cookie: `${ID_COOKIE}=${t}` } }),
      env(gw, { TWO80_ROUTE_POLICY: policy }),
      deps(container),
    );
    expect(res.status).toBe(403);
    expect(container.requests).toHaveLength(0);
  });

  it('admits an admin token through the same admin-gated route', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const policy = JSON.stringify({ access: 'invited', roles: [], routes: [{ path: '/admin/*', appRole: 'admin', role: '' }], secrets: [] });
    const t = await token(signer, { appRole: 'admin' });
    const res = await handleAppRequest(
      new Request(`https://${HOST}/admin/users`, { headers: { cookie: `${ID_COOKIE}=${t}` } }),
      env(gw, { TWO80_ROUTE_POLICY: policy }),
      deps(new FakeContainer()),
    );
    expect(res.status).toBe(200);
  });

  it('fails closed (500) on a set-but-malformed route policy', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const t = await token(signer);
    const res = await handleAppRequest(
      req(`${ID_COOKIE}=${t}`),
      env(gw, { TWO80_ROUTE_POLICY: '{not json' }),
      deps(new FakeContainer()),
    );
    expect(res.status).toBe(500);
  });

  it('rejects a token minted for another app host (audience firewall) and re-mints', async () => {
    const { signer } = await newSigner(() => NOW);
    const fresh = await newSigner(() => NOW);
    const gw = new FakeGateway(fresh.publicJwks, async () => ({ kind: 'token', token: await token(fresh.signer), ttlSecs: 30 }));
    const foreign = await token(signer, { aud: 'other.280apps.run' });
    const res = await handleAppRequest(
      req(`${ID_COOKIE}=${foreign}; ${SESSION_COOKIE}=sess`),
      env(gw),
      deps(new FakeContainer()),
    );
    expect(res.status).toBe(200);
    expect(gw.mintCalls).toHaveLength(1); // the foreign token did not serve; a fresh one was minted
  });

  it('caches the JWKS across requests (one fetch serves many verifications)', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const container = new FakeContainer();
    const t = await token(signer);
    await handleAppRequest(req(`${ID_COOKIE}=${t}`), env(gw), deps(container));
    await handleAppRequest(req(`${ID_COOKIE}=${t}`), env(gw), deps(container));
    expect(gw.jwksCalls).toBe(1);
  });
});
