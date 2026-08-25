// The browser-login half of the backend, counterpart to deploysvc: it owns the OIDC
// flow, the user store, and the session store, with api.ts thin over it. Clock,
// randomness, and providers are injected seams, so the flow runs in-process in tests.
//
// Sessions are opaque random tokens stored only as a hash, so there is no signing
// secret: a token is valid because its unexpired hash is in the table, and logging
// out is deleting the row.

import { randomBytes } from 'node:crypto';
import { constantTimeEqual, hashToken } from './crypto.js';
import type { OidcProvider } from './auth/oidc.js';
import type { Session, Store, User } from './seams.js';

// AuthError is thrown for anything the flow refuses. api.ts renders it as a plain
// 400/429, since the audience here is a browser, not the CLI.
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
  providers: Record<string, OidcProvider>; // provider registry keyed by name, e.g. { google: {...} }
  apiOrigin: string; // this backend's public origin for the OIDC callback, e.g. "https://api.280apps.com"
  frontendOrigin: string; // sole allowed post-login redirect origin, e.g. "https://www.280apps.com"
  resolveRedirect?: (raw: string) => string; // overrides the redirect guard, e.g. gateway's *.280apps.run resolver
  cookieDomain: string; // session cookie scope, e.g. "" (host-only dev) or ".280apps.com"
  sessionCookieName: string; // e.g. "280_session"
  oauthCookieName: string; // e.g. "280_oauth_state"
  sessionTtlSecs: number; // e.g. 2592000 (30 days)
  rate: { windowSecs: number; max: number }; // per-IP login limiter, e.g. { windowSecs: 60, max: 10 }
  now?: () => number; // injected clock, e.g. () => Math.floor(Date.now() / 1000)
  randomToken?: () => string; // injected token generator, e.g. () => randomBytes(32).toString('hex')
  newUserId?: () => string; // injected id generator, e.g. () => 'usr_' + randomBytes(12).toString('hex')
}

export interface StartResult {
  authUrl: string;
  stateCookie: string;
}

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

  get sessionCookieName(): string {
    return this.cfg.sessionCookieName;
  }

  get oauthCookieName(): string {
    return this.cfg.oauthCookieName;
  }

  get sessionTtlSecs(): number {
    return this.cfg.sessionTtlSecs;
  }

  get frontendOrigin(): string {
    return this.cfg.frontendOrigin;
  }

  safeRedirect(raw: string): string {
    return this.resolveRedirect(raw);
  }

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

  async me(sessionToken: string): Promise<User | null> {
    if (sessionToken === '') return null;
    const session = await this.store.sessionByHash(hashToken(sessionToken));
    if (session === null || session.expiresAt <= this.now()) return null;
    return this.store.userById(session.userId);
  }

  async logout(sessionToken: string): Promise<void> {
    if (sessionToken === '') return;
    await this.store.deleteSession(hashToken(sessionToken));
  }

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
      return fallback;
    }
    return fallback;
  }
}

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

