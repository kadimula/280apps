// Test support: an in-memory Store (auth + apps + grants), fake OIDC providers, a
// fresh signing keypair, fake app containers, and a wired Gateway with a matching
// verifier. Nothing here reaches the network; a login "code" is the email the fake
// signs in as, and a "container" echoes the request it was proxied.

import { Auth } from '@280/backend/authsvc';
import type { OidcIdentity, OidcProvider } from '@280/backend/auth/oidc';
import type { Grant, Session, Store, User, OAuthAccount } from '@280/backend/seams';
import { GrantsAccess } from '../src/access.js';
import { confineRedirect, Gateway, type GatewayOptions } from '../src/gateway.js';
import { IdentitySigner, IdentityVerifier, publicJwkFromPrivate } from '../src/identity.js';
import { ContainerUpstream, type AppContainers } from '../src/upstream.js';
import type { ProviderLink } from '../src/pages.js';

const APP_DOMAIN = '280apps.run';
const AUTH_HOST = 'auth.280apps.run';
const AUTH_ORIGIN = `https://${AUTH_HOST}`;
const ISSUER = AUTH_ORIGIN;

// Apps and grants the default harness seeds so the request-flow tests have someone
// to let in: alice's org and bob's org each hold a grant on the apps they open.
const DEFAULT_APPS: Array<{ script: string; id: string }> = [
  { script: 'renewals', id: 'app_renewals' },
  { script: 'sales', id: 'app_sales' },
];
const DEFAULT_GRANTS: Array<{ appId: string; principal: string }> = [
  { appId: 'app_renewals', principal: 'domain:evergreen.com' },
  { appId: 'app_renewals', principal: 'domain:contoso.com' },
  { appId: 'app_sales', principal: 'domain:evergreen.com' },
];

// FakeProvider maps a login code to an identity: sign in as anyone by passing
// their email as the code. "boom" fails the exchange.
export class FakeProvider implements OidcProvider {
  constructor(readonly name: string) {}

  authUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    return `https://fake.test/${this.name}?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async exchange({ code }: { code: string }): Promise<OidcIdentity> {
    if (code === 'boom') throw new Error('exchange failed');
    const email = code.toLowerCase();
    return { subject: `${this.name}-${email}`, email, name: email.split('@')[0] ?? email, image: '' };
  }
}

// FakeStore is the auth + access slice of Store; the deploy methods the gateway
// never calls are absent (the value is cast to Store where needed).
class FakeStore {
  private readonly users = new Map<string, User>();
  private readonly oauth = new Map<string, OAuthAccount>();
  private readonly sessions = new Map<string, Session>();
  private readonly rate = new Map<string, { count: number; expiresAt: number }>();
  private readonly apps = new Map<string, { id: string }>();
  private readonly grants = new Map<string, Grant>();

  seedApp(script: string, id: string): void {
    this.apps.set(script, { id });
  }
  seedGrant(appId: string, principal: string): void {
    this.grants.set(`${appId} ${principal}`, {
      appId,
      principal,
      appRole: 'viewer',
      featureRole: '',
      dataScope: null,
      grantedBy: 'test',
      grantedAt: 0,
    });
  }

  async userById(id: string): Promise<User | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }
  async userByEmail(email: string): Promise<User | null> {
    for (const u of this.users.values()) if (u.email === email) return { ...u };
    return null;
  }
  async createUser(u: User): Promise<void> {
    this.users.set(u.id, { ...u });
  }
  async oauthAccount(provider: string, providerAccountId: string): Promise<OAuthAccount | null> {
    const a = this.oauth.get(`${provider}/${providerAccountId}`);
    return a ? { ...a } : null;
  }
  async linkOAuthAccount(a: OAuthAccount): Promise<void> {
    const k = `${a.provider}/${a.providerAccountId}`;
    if (!this.oauth.has(k)) this.oauth.set(k, { ...a });
  }
  async createSession(s: Session): Promise<void> {
    this.sessions.set(s.tokenHash, { ...s });
  }
  async sessionByHash(tokenHash: string): Promise<Session | null> {
    const s = this.sessions.get(tokenHash);
    return s ? { ...s } : null;
  }
  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }
  async touchLoginRate(key: string, now: number, windowSecs: number, limit: number): Promise<boolean> {
    const cur = this.rate.get(key);
    if (!cur || cur.expiresAt <= now) {
      this.rate.set(key, { count: 1, expiresAt: now + windowSecs });
      return 1 <= limit;
    }
    cur.count += 1;
    return cur.count <= limit;
  }

  async appByScript(script: string): Promise<{ id: string } | null> {
    return this.apps.get(script) ?? null;
  }
  async grant(appId: string, principal: string): Promise<Grant | null> {
    return this.grants.get(`${appId} ${principal}`) ?? null;
  }
}

// FakeContainer echoes the request it was proxied so a test can prove the signed
// identity header arrived; FakeContainers records which scripts were reached so a
// deny test can assert no proxy happened.
export interface UpstreamEcho {
  upstream: 'container';
  host: string;
  path: string;
  method: string;
  identity: string | null;
}

class FakeContainer {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body: UpstreamEcho = {
      upstream: 'container',
      host: url.hostname,
      path: url.pathname + url.search,
      method: request.method,
      identity: request.headers.get('X-280-Identity'),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}

export class FakeContainers implements AppContainers {
  readonly calls: string[] = [];

  forScript(script: string): Fetcher | null {
    this.calls.push(script);
    return new FakeContainer() as unknown as Fetcher;
  }
}

export async function genSigningKey(): Promise<{ privateJwk: JsonWebKey; publicJwks: Record<string, JsonWebKey>; kid: string }> {
  const kid = 'test-k1';
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { privateJwk, publicJwks: { [kid]: publicJwkFromPrivate(privateJwk, kid) }, kid };
}

export interface GatewayHarness {
  gateway: Gateway;
  verifier: IdentityVerifier;
  publicJwks: Record<string, JsonWebKey>;
  containers: FakeContainers;
}

export async function newGateway(
  over: {
    rateMax?: number;
    apps?: Array<{ script: string; id: string }>;
    grants?: Array<{ appId: string; principal: string }>;
  } = {},
): Promise<GatewayHarness> {
  const store = new FakeStore();
  for (const a of over.apps ?? DEFAULT_APPS) store.seedApp(a.script, a.id);
  for (const g of over.grants ?? DEFAULT_GRANTS) store.seedGrant(g.appId, g.principal);
  const { privateJwk, publicJwks, kid } = await genSigningKey();

  const hosts = { appDomain: APP_DOMAIN, authHost: AUTH_HOST, hostSuffix: '' };
  const auth = new Auth(store as unknown as Store, {
    providers: { google: new FakeProvider('google'), microsoft: new FakeProvider('microsoft') },
    apiOrigin: AUTH_ORIGIN,
    frontendOrigin: 'https://280apps.com',
    cookieDomain: `.${APP_DOMAIN}`,
    sessionTtlSecs: 3600,
    rate: { windowSecs: 600, max: over.rateMax ?? 1000 },
    resolveRedirect: (raw) => {
      const dest = confineRedirect(raw, hosts);
      return dest === '' ? 'https://280apps.com' : dest;
    },
  });

  const signer = new IdentitySigner({ kid, privateJwk, issuer: ISSUER, ttlSecs: 120 });
  const providers: ProviderLink[] = [
    { name: 'google', label: 'Continue with Google' },
    { name: 'microsoft', label: 'Continue with Microsoft' },
  ];
  const containers = new FakeContainers();
  const opts: GatewayOptions = {
    auth,
    signer,
    access: new GrantsAccess(store),
    upstream: new ContainerUpstream(containers),
    hosts,
    authOrigin: AUTH_ORIGIN,
    cookieDomain: `.${APP_DOMAIN}`,
    sessionTtlSecs: 3600,
    providers,
    publicJwks,
    fallbackRedirect: 'https://280apps.com',
  };

  const verifier = new IdentityVerifier({ publicJwks, issuer: ISSUER });
  return { gateway: new Gateway(opts), verifier, publicJwks, containers };
}

// cookiePair extracts a "name=value" from the response's Set-Cookie headers.
export function cookiePair(res: Response, name: string): string | null {
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith(name + '=')) return sc.split(';')[0] ?? null;
  }
  return null;
}

// signIn drives the real start -> callback handshake against a fake provider on
// the auth host and returns the session cookie pair.
export async function signIn(
  gateway: Gateway,
  provider: string,
  email: string,
  returnTo = `https://renewals.${APP_DOMAIN}/`,
): Promise<string> {
  const start = await gateway.handle(
    new Request(`${AUTH_ORIGIN}/auth/${provider}/start?redirect=${encodeURIComponent(returnTo)}`),
  );
  if (start.status !== 302) throw new Error(`start returned ${start.status}`);
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const stateCookie = cookiePair(start, '280_oauth');
  if (stateCookie === null) throw new Error('start set no state cookie');

  const cb = await gateway.handle(
    new Request(`${AUTH_ORIGIN}/auth/${provider}/callback?code=${encodeURIComponent(email)}&state=${encodeURIComponent(state)}`, {
      headers: { cookie: stateCookie },
    }),
  );
  if (cb.status !== 302) throw new Error(`callback returned ${cb.status}`);
  const session = cookiePair(cb, '280_session');
  if (session === null) throw new Error('callback set no session cookie');
  return session;
}

export { AUTH_ORIGIN, AUTH_HOST, APP_DOMAIN, ISSUER };
