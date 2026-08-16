// The app-Worker middleware: verify-and-forward against a fake GATEWAY binding and a
// fake container. These prove the hot path (local verify, no central call), the
// mint/refresh path (login/deny/token + host-only cookie), route gating, and the
// central-unreachable 503, entirely under node with WebCrypto.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleAppRequest,
  __resetJwksCache,
  __resetAnonTokenCache,
  type AppWorkerEnv,
  type AppWorkerDeps,
} from '../src/appworker.js';
import type { GatewayBinding, JwksDoc, MintInput, MintPreviewInput, MintResult } from '../src/mint.js';
import { ID_COOKIE, PREVIEW_COOKIE, SESSION_COOKIE } from '../src/cookies.js';
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
  over: { aud?: string; role?: string; title?: string; email?: string } = {},
): Promise<string> {
  return signer.sign({
    sub: 'u1',
    email: over.email ?? 'alice@evergreen.com',
    name: 'alice',
    aud: over.aud ?? HOST,
    app: 'app_renewals',
    role: over.role ?? 'viewer',
    title: over.title ?? '',
  });
}

// FakeGateway is the service-binding double: jwks() serves the public set and counts
// calls; mint() returns a scripted result (or throws to simulate a central outage).
class FakeGateway implements GatewayBinding {
  jwksCalls = 0;
  mintCalls: MintInput[] = [];
  mintPreviewCalls: MintPreviewInput[] = [];
  onMintPreview: (input: MintPreviewInput) => Promise<MintResult> = async () => {
    throw new Error('mintPreview not configured');
  };
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

  async mintPreview(input: MintPreviewInput): Promise<MintResult> {
    this.mintPreviewCalls.push(input);
    return this.onMintPreview(input);
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

beforeEach(() => {
  __resetJwksCache();
  __resetAnonTokenCache();
});

describe('app-worker middleware', () => {
  it('serves a valid token entirely locally, stamping identity, with no central call', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const container = new FakeContainer();
    const t = await token(signer);

    // A client-supplied identity header must never reach the container: stampIdentity
    // strips every inbound x-280-* before setting the genuine one (anti-spoofing).
    const spoofed = new Request(`https://${HOST}/`, {
      headers: { cookie: `${ID_COOKIE}=${t}`, 'x-280-identity': 'forged', 'x-280-user': 'admin@evergreen.com' },
    });
    const res = await handleAppRequest(spoofed, env(gw), deps(container));
    expect(res.status).toBe(200);
    expect(gw.mintCalls).toHaveLength(0); // steady state never mints
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(t);
    // The container saw exactly the minted token, not the forgery.
    expect(container.requests[0]!.headers.get('X-280-Identity')).toBe(t);
    expect(container.requests[0]!.headers.get('x-280-user')).toBeNull();
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
    const t = await token(signer, { role: 'viewer' });
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
    const t = await token(signer, { role: 'admin' });
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

describe('dashboard preview (partitioned-cookie flow)', () => {
  const PARTITIONED_ATTRS = ['HttpOnly', 'SameSite=None', 'Secure', 'Partitioned'];

  it('the /__280/preview bootstrap exchanges ?g= for partitioned cookies and bounces to the app', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    gw.onMintPreview = async () => ({ kind: 'token', token: await token(signer), ttlSecs: 30 });

    const res = await handleAppRequest(
      new Request(`https://${HOST}/__280/preview?g=grant-1&to=/reports`),
      env(gw),
      deps(new FakeContainer()),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/reports');
    expect(gw.mintPreviewCalls).toEqual([{ grant: 'grant-1', script: 'renewals', host: HOST }]);

    const preview = setCookie(res, PREVIEW_COOKIE);
    const id = setCookie(res, ID_COOKIE);
    expect(preview).toContain(`${PREVIEW_COOKIE}=grant-1`);
    for (const attr of PARTITIONED_ATTRS) {
      expect(preview).toContain(attr);
      expect(id).toContain(attr);
    }
    // Host-only, like every app-host cookie: never leaks to another app host.
    expect(preview).not.toContain('Domain=');
    expect(id).not.toContain('Domain=');
  });

  it('confines the bootstrap landing to a same-origin path', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    gw.onMintPreview = async () => ({ kind: 'token', token: await token(signer), ttlSecs: 30 });
    for (const to of ['https://evil.example/', '//evil.example/', 'reports']) {
      const res = await handleAppRequest(
        new Request(`https://${HOST}/__280/preview?g=grant-1&to=${encodeURIComponent(to)}`),
        env(gw),
        deps(new FakeContainer()),
      );
      expect(res.headers.get('location')).toBe('/');
    }
  });

  it('a dead grant at the bootstrap is a plain deny page', async () => {
    const { publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    gw.onMintPreview = async () => ({ kind: 'deny', reason: 'This preview is no longer available.' });
    const res = await handleAppRequest(
      new Request(`https://${HOST}/__280/preview?g=stale`),
      env(gw),
      deps(new FakeContainer()),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('no longer available');
  });

  it('refreshes an expired token from the preview grant, not the session, with a partitioned cookie', async () => {
    const fresh = await newSigner(() => NOW);
    const gw = new FakeGateway(fresh.publicJwks);
    gw.onMintPreview = async () => ({ kind: 'token', token: await token(fresh.signer), ttlSecs: 30 });
    const container = new FakeContainer();

    // No usable 280_id, but the partitioned grant cookie rode in with the iframe request.
    const res = await handleAppRequest(
      req(`${PREVIEW_COOKIE}=grant-1`),
      env(gw),
      deps(container),
    );
    expect(res.status).toBe(200);
    expect(gw.mintCalls).toHaveLength(0); // the session path was never consulted
    expect(gw.mintPreviewCalls).toEqual([{ grant: 'grant-1', script: 'renewals', host: HOST }]);
    const id = setCookie(res, ID_COOKIE);
    for (const attr of PARTITIONED_ATTRS) expect(id).toContain(attr);
  });

  it('a revoked or demoted preview stops with a deny on the next refresh', async () => {
    const { publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    gw.onMintPreview = async () => ({ kind: 'deny', reason: 'This preview is no longer available.' });
    const res = await handleAppRequest(req(`${PREVIEW_COOKIE}=grant-1`), env(gw), deps(new FakeContainer()));
    expect(res.status).toBe(403);
  });

  it('the preview cookie never reaches the container (reserved 280_ prefix strip)', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const container = new FakeContainer();
    const t = await token(signer);
    const res = await handleAppRequest(
      req(`${ID_COOKIE}=${t}; ${PREVIEW_COOKIE}=grant-1; app_theme=dark`),
      env(gw),
      deps(container),
    );
    expect(res.status).toBe(200);
    expect(container.requests[0]!.headers.get('cookie')).toBe('app_theme=dark');
  });
});

describe('gateway-owned framing', () => {
  // A container that tries to control its own framing; the platform must win.
  class FramedContainer {
    async fetch(_request: Request): Promise<Response> {
      return new Response('app', {
        status: 200,
        headers: {
          'x-frame-options': 'DENY',
          'content-security-policy': "frame-ancestors 'none'; img-src 'self'",
        },
      });
    }
  }

  it('strips container framing headers and pins frame-ancestors to the dashboard origins', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const t = await token(signer);
    const res = await handleAppRequest(
      req(`${ID_COOKIE}=${t}`),
      env(gw),
      deps(new FramedContainer() as unknown as FakeContainer),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBeNull();
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors https://console.280apps.com');
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self'"); // the app's other directives survive
  });

  it('sets the dashboard frame-ancestors even when the container sends no framing headers', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const t = await token(signer);
    const res = await handleAppRequest(req(`${ID_COOKIE}=${t}`), env(gw), deps(new FakeContainer()));
    expect(res.headers.get('content-security-policy')).toBe(
      'frame-ancestors https://console.280apps.com',
    );
  });

  it('honors the baked TWO80_FRAME_ANCESTORS over the default', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const t = await token(signer);
    const res = await handleAppRequest(
      req(`${ID_COOKIE}=${t}`),
      env(gw, { TWO80_FRAME_ANCESTORS: 'https://console-development.280apps.com https://preview.example' }),
      deps(new FakeContainer()),
    );
    expect(res.headers.get('content-security-policy')).toBe(
      'frame-ancestors https://console-development.280apps.com https://preview.example',
    );
  });
});

// Public mode at the edge: a cookieless client is served with the gateway-minted
// anonymous identity (no redirect), one central mint feeds every cookieless
// request in the isolate until the token's TTL, and anonymous responses carry
// X-Robots-Tag: noindex (public is unlisted).
describe('public app: anonymous serving and the isolate token cache', () => {
  function anonToken(signer: IdentitySigner): Promise<string> {
    return signer.sign({
      sub: 'anon',
      email: '',
      name: 'Anonymous',
      aud: HOST,
      app: 'app_renewals',
      role: 'viewer',
      anon: true,
    });
  }

  it('serves a cookieless request 200 with the anonymous identity, noindex, and no redirect', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW, 120);
    const gw = new FakeGateway(publicJwks, async () => ({
      kind: 'token',
      token: await anonToken(signer),
      ttlSecs: 120,
    }));
    const container = new FakeContainer();

    const res = await handleAppRequest(req(), env(gw), deps(container));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(gw.mintCalls).toHaveLength(1);
    expect(gw.mintCalls[0]!.sessionToken).toBe('');
    // The container received the verified anonymous token as the identity header.
    const stamped = container.requests[0]!.headers.get('X-280-Identity');
    expect(stamped).not.toBeNull();
  });

  it('one central mint serves many cookieless requests until the TTL, then re-mints', async () => {
    let clock = NOW;
    const { privateJwk, publicJwks, kid } = await genSigningKey();
    const signer = new IdentitySigner({ kid, privateJwk, issuer: ISSUER, ttlSecs: 120, now: () => clock });
    const gw = new FakeGateway(publicJwks, async () => ({
      kind: 'token',
      token: await anonToken(signer),
      ttlSecs: 120,
    }));
    const container = new FakeContainer();

    for (let i = 0; i < 3; i++) {
      const res = await handleAppRequest(req(), env(gw), deps(container, clock));
      expect(res.status).toBe(200);
    }
    expect(gw.mintCalls).toHaveLength(1); // requests 2 and 3 hit the isolate cache

    // Past the token TTL the cache is stale: the next request re-mints centrally,
    // which is exactly the bound (~TTL + skew) on un-publicing an app.
    clock = NOW + 121;
    const res = await handleAppRequest(req(), env(gw), deps(container, clock));
    expect(res.status).toBe(200);
    expect(gw.mintCalls).toHaveLength(2);
  });

  it('a session-carrying request never uses the anonymous cache', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW, 120);
    const gw = new FakeGateway(publicJwks, async () => ({
      kind: 'token',
      token: await anonToken(signer),
      ttlSecs: 120,
    }));
    const container = new FakeContainer();

    await handleAppRequest(req(), env(gw), deps(container)); // warms the cache
    const withSession = await handleAppRequest(req(`${SESSION_COOKIE}=sess`), env(gw), deps(container));
    expect(withSession.status).toBe(200);
    // Both requests minted centrally: the cache only ever answers cookieless clients.
    expect(gw.mintCalls).toHaveLength(2);
    expect(gw.mintCalls[1]!.sessionToken).toBe('sess');
  });

  it('a signed-in (non-anonymous) response is not stamped noindex', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const t = await token(signer);
    const res = await handleAppRequest(req(`${ID_COOKIE}=${t}`), env(gw), deps(new FakeContainer()));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  it('a browser holding the anonymous cookie is served locally with noindex', async () => {
    const { signer, publicJwks } = await newSigner(() => NOW);
    const gw = new FakeGateway(publicJwks);
    const t = await anonToken(signer);
    const res = await handleAppRequest(req(`${ID_COOKIE}=${t}`), env(gw), deps(new FakeContainer()));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(gw.mintCalls).toHaveLength(0); // steady state stays fully local
  });
});
