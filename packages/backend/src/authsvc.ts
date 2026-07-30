// The browser-login half of the backend, the counterpart to deploysvc. It owns
// the OIDC flow, the user store, and the session store; the HTTP transport in
// api.ts is thin over it, doing only cookies and redirects. Clock, randomness,
// and the identity providers are injected seams, so the whole flow runs
// in-process against a fake provider in tests.
//
// Sessions are opaque random tokens stored only as a hash, so there is no signing
// secret to manage: a token is valid because its hash is in the table and the
// row has not expired, and logging out is deleting the row.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OidcProvider } from './auth/oidc.js';
import type { Session, Store, User } from './seams.js';

// AuthError is thrown for anything the flow refuses: an unknown provider, a bad
// state, a rate-limited caller. api.ts renders it as a plain 400/429 rather than
// a deploy-shaped error, since the audience here is a browser, not the CLI.
export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthConfig {
  // providers is keyed by name ("google"); the map is the whole registry, so a
  // second provider is one more entry and nothing else.
  providers: Record<string, OidcProvider>;
  // apiOrigin is this backend's own public origin, used to build the OIDC
  // callback URL. It must match what the provider console has registered.
  apiOrigin: string;
  // frontendOrigin is the only origin a post-login redirect may land on. It is
  // the open-redirect whitelist the default guard enforces.
  frontendOrigin: string;
  // resolveRedirect optionally overrides that guard. The gateway sets it (its
  // valid destinations are the whole *.280apps.run space, not one origin); the
  // control plane leaves it unset for the single-origin default below.
  resolveRedirect?: (raw: string) => string;
  // cookieDomain scopes the session cookie. Empty is host-only (localhost dev);
  // ".280apps.com" lets api and www share it in production.
  cookieDomain: string;
  sessionTtlSecs: number;
  // rate is the login limiter, applied per client IP at the start of the flow.
  rate: { windowSecs: number; max: number };
  // Injected seams; defaulted for production.
  now?: () => number;
  randomToken?: () => string;
  newUserId?: () => string;
}

// StartResult is what the transport needs to begin a login: where to send the
// browser, and the state cookie to set so the callback can prove the flow is
// this browser's.
export interface StartResult {
  authUrl: string;
  stateCookie: string;
}

// CompleteResult is a finished login: the session token to set as a cookie and
// the validated URL to send the browser back to.
export interface CompleteResult {
  user: User;
  sessionToken: string;
  redirect: string;
}

export class Auth {
  private readonly store: Store;
  private readonly cfg: AuthConfig;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly newUserId: () => string;

  constructor(store: Store, cfg: AuthConfig) {
    this.store = store;
    this.cfg = cfg;
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.randomToken = cfg.randomToken ?? (() => randomBytes(32).toString('hex'));
    this.newUserId = cfg.newUserId ?? (() => 'usr_' + randomBytes(12).toString('hex'));
  }

  get cookieDomain(): string {
    return this.cfg.cookieDomain;
  }

  get sessionTtlSecs(): number {
    return this.cfg.sessionTtlSecs;
  }

  get frontendOrigin(): string {
    return this.cfg.frontendOrigin;
  }

  // safeRedirect confines a destination to the frontend origin. Public so the
  // transport can vet a logout redirect through the same guard the login flow
  // uses.
  safeRedirect(raw: string): string {
    return this.resolveRedirect(raw);
  }

  // start validates the request, rate-limits it, and returns the provider's
  // authorization URL plus the state cookie the callback will check. The state
  // cookie carries the validated redirect target, so the callback trusts a
  // destination this browser was actually issued.
  async start(providerName: string, rawRedirect: string, clientIp: string): Promise<StartResult> {
    const provider = this.provider(providerName);

    const allowed = await this.store.touchLoginRate(
      'login:' + clientIp,
      this.now(),
      this.cfg.rate.windowSecs,
      this.cfg.rate.max,
    );
    if (!allowed) {
      throw new AuthError(429, 'too many login attempts');
    }

    const redirect = this.resolveRedirect(rawRedirect);
    const state = this.randomToken();
    const authUrl = provider.authUrl({ state, redirectUri: this.callbackUrl(provider.name) });
    return { authUrl, stateCookie: encodeState(state, redirect) };
  }

  // complete verifies the callback belongs to a flow this browser started, trades
  // the code for an identity, resolves it to a user (creating or linking as
  // needed), and mints a session.
  async complete(
    providerName: string,
    code: string,
    stateQuery: string,
    stateCookie: string,
  ): Promise<CompleteResult> {
    const provider = this.provider(providerName);

    const parsed = decodeState(stateCookie);
    if (parsed === null || code === '' || stateQuery === '' || !constantTimeEqual(stateQuery, parsed.state)) {
      throw new AuthError(400, 'that login could not be verified');
    }

    let identity;
    try {
      identity = await provider.exchange({ code, redirectUri: this.callbackUrl(provider.name) });
    } catch {
      throw new AuthError(400, 'that login could not be completed');
    }

    const user = await this.resolveUser(provider.name, identity);
    const sessionToken = this.randomToken();
    const session: Session = {
      tokenHash: hashToken(sessionToken),
      userId: user.id,
      expiresAt: this.now() + this.cfg.sessionTtlSecs,
    };
    await this.store.createSession(session);
    return { user, sessionToken, redirect: parsed.redirect };
  }

  // me resolves a session token to its user, or null if the token is empty,
  // unknown, or expired.
  async me(sessionToken: string): Promise<User | null> {
    if (sessionToken === '') return null;
    const session = await this.store.sessionByHash(hashToken(sessionToken));
    if (session === null || session.expiresAt <= this.now()) return null;
    return this.store.userById(session.userId);
  }

  // logout deletes the session behind a token. Unknown tokens are a no-op, so
  // signing out twice is not an error.
  async logout(sessionToken: string): Promise<void> {
    if (sessionToken === '') return;
    await this.store.deleteSession(hashToken(sessionToken));
  }

  // ---- helpers ----

  // resolveUser maps an external identity onto a stable user. The order is what
  // preserves accounts across the migration: an existing provider login wins,
  // then a matching email (a migrated password user, or a first Google login for
  // a known address) which gets the provider linked onto it, then a fresh user.
  private async resolveUser(provider: string, identity: { subject: string; email: string; name: string; image: string }): Promise<User> {
    const email = identity.email.trim().toLowerCase();

    const link = await this.store.oauthAccount(provider, identity.subject);
    if (link !== null) {
      const existing = await this.store.userById(link.userId);
      if (existing !== null) return existing;
    }

    const byEmail = await this.store.userByEmail(email);
    if (byEmail !== null) {
      await this.store.linkOAuthAccount({ provider, providerAccountId: identity.subject, userId: byEmail.id });
      return byEmail;
    }

    const user: User = {
      id: this.newUserId(),
      email,
      name: identity.name,
      image: identity.image,
    };
    await this.store.createUser(user);
    await this.store.linkOAuthAccount({ provider, providerAccountId: identity.subject, userId: user.id });
    return user;
  }

  private provider(name: string): OidcProvider {
    const p = this.cfg.providers[name];
    if (p === undefined) throw new AuthError(404, `unknown login provider "${name}"`);
    return p;
  }

  private callbackUrl(provider: string): string {
    return `${this.cfg.apiOrigin}/auth/${provider}/callback`;
  }

  // resolveRedirect confines the post-login destination. When the config
  // supplies its own guard (the gateway's *.280apps.run policy) it wins;
  // otherwise the default confines to the single frontend origin: a bare path is
  // resolved against it, a full URL must already be on it, anything else falls
  // back to the dashboard. This is the open-redirect guard.
  private resolveRedirect(raw: string): string {
    if (this.cfg.resolveRedirect !== undefined) return this.cfg.resolveRedirect(raw);
    const origin = this.cfg.frontendOrigin;
    const fallback = origin + '/dashboard';
    if (raw === '') return fallback;
    if (raw.startsWith('/') && !raw.startsWith('//')) return origin + raw;
    try {
      const u = new URL(raw);
      if (u.origin === origin) return u.toString();
    } catch {
      // not a URL; fall through
    }
    return fallback;
  }
}

// State is bound to its redirect so the callback cannot be tricked into sending
// the browser somewhere the start endpoint did not vet.
function encodeState(state: string, redirect: string): string {
  return state + '|' + encodeURIComponent(redirect);
}

function decodeState(raw: string): { state: string; redirect: string } | null {
  const i = raw.indexOf('|');
  if (i <= 0) return null;
  try {
    return { state: raw.slice(0, i), redirect: decodeURIComponent(raw.slice(i + 1)) };
  } catch {
    return null;
  }
}

function hashToken(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
