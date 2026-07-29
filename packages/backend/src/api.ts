// api is HTTP API v1: the transport in front of the deploy service.
//
// Spec: platform/internal/api/api.go. It is deliberately thin. Every behavioral
// decision belongs to deploysvc, so this file only does the three things
// transport must: authenticate, translate the wire format, and map the seam's
// typed errors onto status codes. The wire format is HTTP API v1 (the client
// the conformance suite dials); Go is normative.

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  DeployCode,
  DeployErr,
  AuthCode,
  asDeployError,
  deleteRequestSchema,
  statusForCode,
  syncRequestSchema,
  tokenRequestSchema,
  approveRequestSchema,
  deleteAppRequestSchema,
  version,
  type App as PublicApp,
  type DeployError,
  type DeployStatus,
  type SyncResult,
  type DeleteResult,
} from '@280/contracts';
import { Platform, type Service } from './deploysvc.js';
import { docsRoutes } from './docs.js';
import { Auth, AuthError } from './authsvc.js';
import { markAccount, observe, type HonoEnv, type Logger } from './observe.js';
import { DeviceStatus, type User } from './seams.js';

// SESSION_COOKIE names the browser session the backend now owns. STATE_COOKIE is
// the short-lived CSRF binding for one in-flight OIDC login.
const SESSION_COOKIE = '280_session';
const STATE_COOKIE = '280_oauth';

// HeaderCLIVersion carries the caller's binary version. The server uses it to
// refuse a CLI too old to speak this API. Spec: deployhttp.HeaderCLIVersion.
const HEADER_CLI_VERSION = 'X-280-Cli-Version';

// MaxBlobBytes bounds one uploaded blob. The seam caps the worker; this is the
// backstop for assets, whose only other limit would be disk (api.go:33).
export const MAX_BLOB_BYTES = 100 << 20;

// Body limits per route (plan §3 table).
const SYNC_LIMIT = 8 << 20;
const SMALL_LIMIT = 64 << 10;

// Device-flow tuning. The TTL is what a human plausibly takes to notice the
// message, open a browser, and sign in (api.go:71).
const DEVICE_CODE_TTL_SECS = 15 * 60;
const DEVICE_POLL_SECS = 5;

// userCodeAlphabet omits characters that are misread when a human copies a code
// off one screen and types it into another (api.go:447; Go value, per plan §10).
const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ23456789';

// dashboardConfirm is what a human types into the delete dialog (api.go:372).
const DASHBOARD_CONFIRM = 'delete';

export interface ServerConfig {
  platform: Platform;
  logger?: Logger;
  // OpenSignup provisions an account for any bearer token that presents one.
  openSignup?: boolean;
  // VerificationURI is the browser page a human approves a login on.
  verificationUri?: string;
  // Auth owns the browser login flow and the sessions that authenticate the web
  // surface. Unset disables both the /auth/* endpoints and the session-gated
  // /internal/* endpoints outright: failing closed is the only safe default.
  auth?: Auth;
  // MinCLIVersion is the oldest CLI release this API still serves. Empty enforces
  // nothing, which is the right default.
  minCliVersion?: string;
}

export class Server {
  private readonly platform: Platform;
  private readonly log?: Logger;
  private readonly openSignup: boolean;
  private readonly verificationUri: string;
  private readonly auth?: Auth;
  private readonly minCliVersion: string;

  constructor(cfg: ServerConfig) {
    this.platform = cfg.platform;
    this.log = cfg.logger;
    this.openSignup = cfg.openSignup ?? false;
    this.verificationUri = cfg.verificationUri ?? '';
    this.auth = cfg.auth;
    this.minCliVersion = cfg.minCliVersion ?? '';
  }

  // handler returns the router.
  handler(): Hono<HonoEnv> {
    const app = new Hono<HonoEnv>();

    // Wrapping the whole app rather than each route is what makes the access log
    // cover a route someone adds later without remembering to.
    app.use('*', observe({ logger: () => this.logger(), renderPanic: (e) => this.renderPanic(e) }));

    app.post('/v1/sync', this.route((c) => this.handleSync(c)));
    app.put('/v1/apps/:app/blobs/:digest', this.route((c) => this.handlePutBlob(c)));
    app.get('/v1/apps/:app/deploys/:deploy', this.route((c) => this.handleStatus(c)));
    app.post('/v1/apps/:app/delete', this.route((c) => this.handleDelete(c)));

    // Device flow. The only unauthenticated endpoints: how a machine gets a
    // token in the first place.
    app.post('/v1/device/code', this.route((c) => this.handleDeviceCode(c)));
    app.post('/v1/device/token', this.route((c) => this.handleDeviceToken(c)));

    // Browser login the backend now owns. Start and callback are top-level
    // navigations that set cookies; me and logout serve the frontend's
    // signed-in state and sign-out.
    app.get('/auth/:provider/start', (c) => this.handleAuthStart(c));
    app.get('/auth/:provider/callback', (c) => this.handleAuthCallback(c));
    app.get('/auth/me', (c) => this.handleAuthMe(c));
    app.post('/auth/logout', (c) => this.handleAuthLogout(c));

    // The web surface, authenticated by the browser session rather than a shared
    // secret: the approving user is whoever the cookie resolves to, never a
    // subject named in the body.
    app.post('/internal/device/approve', this.route((c) => this.handleDeviceApprove(c)));
    app.get('/internal/apps', this.route((c) => this.handleApps(c)));
    app.post('/internal/apps/:app/delete', this.route((c) => this.handleInternalDelete(c)));

    app.get('/healthz', (c) => c.text('ok\n'));

    // Agent-facing product docs, served as markdown and JSON. Unauthenticated:
    // the frontend proxies these at their public URLs. Owned by docs.ts so the
    // transport core stays about deploy and auth.
    app.route('/v1/docs', docsRoutes());

    return app;
  }

  // route renders a handler's thrown DeployErr as the seam's error response; an
  // unmapped throw propagates to the observe panic backstop.
  private route(
    fn: (c: Context<HonoEnv>) => Promise<Response>,
  ): (c: Context<HonoEnv>) => Promise<Response> {
    return async (c) => {
      try {
        return await fn(c);
      } catch (err) {
        const de = asDeployError(err);
        if (de !== undefined) return this.failResponse(c, de);
        throw err;
      }
    };
  }

  // ---- deploy routes ----

  private async handleSync(c: Context<HonoEnv>): Promise<Response> {
    const svc = await this.authorize(c);
    const req = await readJson(c, SYNC_LIMIT, syncRequestSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the sync request',
      fix: 'upgrade the 280 CLI, then run 280 push again',
    });
    const res = await svc.sync(req);
    return c.json(encodeSyncResult(res));
  }

  private async handlePutBlob(c: Context<HonoEnv>): Promise<Response> {
    const svc = await this.authorize(c);
    const appId = (c.req.param('app') ?? '');
    const digest = (c.req.param('digest') ?? '');
    // The raw request stream, capped, never a buffered body (plan risk register).
    const body = cappedStream(c.req.raw.body, MAX_BLOB_BYTES);
    await svc.putBlob(appId, digest, contentLength(c), body);
    return c.body(null, 204);
  }

  private async handleStatus(c: Context<HonoEnv>): Promise<Response> {
    const svc = await this.authorize(c);
    const st = await svc.status((c.req.param('app') ?? ''), (c.req.param('deploy') ?? ''));
    return c.json(encodeStatus(st));
  }

  private async handleDelete(c: Context<HonoEnv>): Promise<Response> {
    const svc = await this.authorize(c);
    const req = await readJson(c, SMALL_LIMIT, deleteRequestSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the delete request',
      fix: 'upgrade the 280 CLI, then run 280 delete again',
    });
    // The path names the app, not the body. Two places to say which app to
    // destroy is one place too many.
    req.appId = (c.req.param('app') ?? '');
    const res = await svc.delete(req);
    return c.json(encodeDeleteResult(res));
  }

  // ---- device flow ----

  private async handleDeviceCode(c: Context<HonoEnv>): Promise<Response> {
    const deviceCode = randomSecret(32);
    const userCode = randomUserCode();
    const expiresAt = nowSecs() + DEVICE_CODE_TTL_SECS;
    try {
      await this.platform.store.createDeviceCode({
        deviceHash: hashToken(deviceCode),
        userCode,
        accountId: '',
        status: DeviceStatus.Pending,
        expiresAt,
      });
    } catch {
      throw unavailable('could not start login');
    }
    return c.json({
      deviceCode,
      userCode: displayUserCode(userCode),
      verificationUri: this.verificationUri,
      expiresIn: DEVICE_CODE_TTL_SECS,
      interval: DEVICE_POLL_SECS,
    });
  }

  private async handleDeviceToken(c: Context<HonoEnv>): Promise<Response> {
    let deviceCode = '';
    try {
      const raw = await readBodyText(c, SMALL_LIMIT);
      const req = tokenRequestSchema.parse(JSON.parse(raw));
      deviceCode = req.deviceCode;
    } catch {
      deviceCode = '';
    }
    if (deviceCode === '') {
      throw new DeployErr({
        code: AuthCode.ExpiredToken,
        message: 'that login request is not valid',
        fix: 'run 280 login',
      });
    }

    let dc;
    try {
      dc = await this.platform.store.deviceCodeByHash(hashToken(deviceCode));
    } catch {
      throw unavailable('login lookup failed');
    }
    // Unknown, expired, and already-claimed are one answer on purpose. Telling a
    // caller which of the three it hit is free reconnaissance on a guessed code.
    if (dc === null || dc.status === DeviceStatus.Claimed || nowSecs() >= dc.expiresAt) {
      throw new DeployErr({
        code: AuthCode.ExpiredToken,
        message: 'that login request expired',
        fix: 'run 280 login',
      });
    }
    if (dc.status === DeviceStatus.Pending) {
      throw new DeployErr({
        code: AuthCode.AuthorizationPending,
        message: 'waiting for the user to finish signing in',
        fix: 'ask your user to open the login link, then run 280 login again',
      });
    }

    // Claim first. Whoever wins this update is the only caller that may mint a
    // token for this code, so a duplicated poll cannot produce two credentials.
    let won: boolean;
    try {
      won = await this.platform.store.claimDeviceCode(dc.deviceHash);
    } catch {
      throw unavailable('could not complete login');
    }
    if (!won) {
      throw new DeployErr({
        code: AuthCode.ExpiredToken,
        message: 'that login request expired',
        fix: 'run 280 login',
      });
    }

    const token = randomSecret(32);
    try {
      await this.platform.store.addToken(dc.accountId, hashToken(token));
    } catch {
      throw unavailable('could not complete login');
    }
    return c.json({ token });
  }

  private async handleDeviceApprove(c: Context<HonoEnv>): Promise<Response> {
    const user = await this.sessionUser(c);

    const req = await readJson(c, SMALL_LIMIT, approveRequestSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the approval',
      appendReason: false,
    });

    // The subject is the signed-in user, not a body field: a browser cannot
    // approve a login for anyone but itself.
    let acct;
    try {
      acct = await this.platform.store.ensureAccount(user.id, newAccountId());
    } catch {
      throw unavailable('could not resolve the account');
    }
    let ok: boolean;
    try {
      ok = await this.platform.store.approveDeviceCode(normalizeUserCode(req.userCode), acct.id, nowSecs());
    } catch {
      throw unavailable('could not record the approval');
    }
    if (!ok) {
      throw new DeployErr({
        code: AuthCode.ExpiredToken,
        message: 'that code is not waiting for approval',
        fix: 'ask your agent to run 280 login again',
      });
    }
    return c.body(null, 204);
  }

  private async handleApps(c: Context<HonoEnv>): Promise<Response> {
    const user = await this.sessionUser(c);

    let acct;
    try {
      acct = await this.platform.store.accountBySubject(user.id);
    } catch {
      throw unavailable('could not resolve the account');
    }
    // No account means nothing pushed yet, which the dashboard renders as an
    // empty state. Not an error.
    if (acct === null) {
      return c.json({ apps: [] });
    }

    let apps;
    try {
      apps = await this.platform.store.appsByAccount(acct.id);
    } catch {
      throw unavailable('could not list apps');
    }
    return c.json({
      apps: apps.map((a) => ({
        id: a.id,
        slug: a.slug,
        url: a.url,
        // ActiveDeploy is set only once a deploy has gone live, so it doubles as
        // "is this URL serving anything".
        live: a.activeDeploy !== '',
      })),
    });
  }

  private async handleInternalDelete(c: Context<HonoEnv>): Promise<Response> {
    const user = await this.sessionUser(c);

    const req = await readJson(c, SMALL_LIMIT, deleteAppRequestSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the delete request',
      appendReason: false,
    });

    let acct;
    try {
      acct = await this.platform.store.accountBySubject(user.id);
    } catch {
      throw unavailable('could not resolve the account');
    }
    // No account is the same answer as no app.
    if (acct === null) {
      throw new DeployErr({ code: DeployCode.NoSuchApp, message: 'that app does not exist on this account' });
    }

    const svc = this.platform.for(acct.id);

    // The dry run does the looking up: it fails closed on an app this account
    // does not own, and it is where the slug comes from.
    const target = await svc.delete({ appId: (c.req.param('app') ?? ''), confirm: '' });
    if (req.confirm.trim().toLowerCase() !== DASHBOARD_CONFIRM) {
      throw new DeployErr({
        code: DeployCode.ConfirmationRequired,
        message: 'deleting ' + target.app.slug + ' destroys the app, its URL, and its data',
        fix: 'type ' + DASHBOARD_CONFIRM + ' to confirm',
      });
    }

    const res = await svc.delete({ appId: target.app.id, confirm: target.app.slug });
    return c.json(encodeDeleteResult(res));
  }

  // ---- auth (browser login) ----

  // handleAuthStart sends the browser to the provider's consent screen. A
  // failure here (unknown provider, rate limit) bounces back to the frontend
  // login page rather than showing a bare error to a human.
  private async handleAuthStart(c: Context<HonoEnv>): Promise<Response> {
    const auth = this.auth;
    if (auth === undefined) return c.text('login is not configured', 404);
    try {
      const { authUrl, stateCookie } = await auth.start(
        c.req.param('provider') ?? '',
        c.req.query('redirect') ?? '',
        clientIp(c),
      );
      setCookie(c, STATE_COOKIE, stateCookie, this.cookieOpts(c, 600));
      return c.redirect(authUrl, 302);
    } catch (err) {
      if (err instanceof AuthError) return this.authBounce(c, auth);
      throw err;
    }
  }

  // handleAuthCallback finishes the flow: it sets the session cookie, drops the
  // state cookie, and returns the browser to the destination the start endpoint
  // vetted.
  private async handleAuthCallback(c: Context<HonoEnv>): Promise<Response> {
    const auth = this.auth;
    if (auth === undefined) return c.text('login is not configured', 404);
    // A provider can decline; treat it like any other failed login.
    if ((c.req.query('error') ?? '') !== '') return this.authBounce(c, auth);
    try {
      const result = await auth.complete(
        c.req.param('provider') ?? '',
        c.req.query('code') ?? '',
        c.req.query('state') ?? '',
        getCookie(c, STATE_COOKIE) ?? '',
      );
      setCookie(c, SESSION_COOKIE, result.sessionToken, this.cookieOpts(c, auth.sessionTtlSecs));
      deleteCookie(c, STATE_COOKIE, this.cookieOpts(c, 0));
      return c.redirect(result.redirect, 302);
    } catch (err) {
      if (err instanceof AuthError) {
        deleteCookie(c, STATE_COOKIE, this.cookieOpts(c, 0));
        return this.authBounce(c, auth);
      }
      throw err;
    }
  }

  // handleAuthMe is what the frontend reads to render the signed-in state. It
  // never errors: no session is a null user, not a failure.
  private async handleAuthMe(c: Context<HonoEnv>): Promise<Response> {
    const auth = this.auth;
    if (auth === undefined) return c.json({ user: null });
    const user = await auth.me(getCookie(c, SESSION_COOKIE) ?? '');
    return c.json({ user: user === null ? null : encodeUser(user) });
  }

  // handleAuthLogout clears the session everywhere: the row, so the token is
  // dead, and the cookie, so the browser stops sending it.
  private async handleAuthLogout(c: Context<HonoEnv>): Promise<Response> {
    const auth = this.auth;
    if (auth === undefined) return c.text('login is not configured', 404);
    await auth.logout(getCookie(c, SESSION_COOKIE) ?? '');
    deleteCookie(c, SESSION_COOKIE, this.cookieOpts(c, 0));
    return c.redirect(auth.safeRedirect(c.req.query('redirect') ?? '/'), 303);
  }

  // authBounce returns a failed login to the frontend's login page. One message
  // for every failure: which step broke is not a browser's concern.
  private authBounce(c: Context<HonoEnv>, auth: Auth): Response {
    return c.redirect(auth.frontendOrigin + '/login?error=auth', 302);
  }

  // cookieOpts builds the attributes every cookie this server sets shares. maxAge
  // 0 expires the cookie. Secure rides on a real HTTPS request or a configured
  // cookie domain (production is always both); localhost dev over http is not
  // Secure, or the browser would drop the cookie.
  private cookieOpts(c: Context<HonoEnv>, maxAge: number): {
    httpOnly: true;
    sameSite: 'Lax';
    path: '/';
    secure: boolean;
    domain?: string;
    maxAge: number;
  } {
    const domain = this.auth?.cookieDomain ?? '';
    return {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: domain !== '' || isSecureRequest(c),
      ...(domain !== '' ? { domain } : {}),
      maxAge,
    };
  }

  // ---- gates ----

  // sessionUser resolves the browser session on a web-surface call, or refuses.
  // It is the session-cookie counterpart to authorize()'s bearer token. An unset
  // Auth is a closed door: the internal endpoints answer not-found rather than
  // trusting an unauthenticated caller.
  private async sessionUser(c: Context<HonoEnv>): Promise<User> {
    if (this.auth === undefined) {
      throw new DeployErr({ code: DeployCode.NotFound, message: 'the internal API is not configured' });
    }
    const user = await this.auth.me(getCookie(c, SESSION_COOKIE) ?? '');
    if (user === null) {
      throw new DeployErr({ code: DeployCode.Unauthorized, message: 'not signed in' });
    }
    return user;
  }

  // tooOld throws cli_too_old if the caller's CLI predates MinCLIVersion. It runs
  // before the token lookup: a binary that cannot speak this API gets the same
  // answer whether or not it is signed in, and the answer costs no DB round trip.
  private tooOld(c: Context<HonoEnv>): void {
    if (!version.valid(this.minCliVersion)) return;
    const got = c.req.header(HEADER_CLI_VERSION) ?? '';
    if (!version.valid(got) || !version.less(got, this.minCliVersion)) return;
    throw new DeployErr({
      code: DeployCode.CLITooOld,
      message: `this 280 CLI (${got}) is older than 280 supports (${this.minCliVersion})`,
      fix: 'run the same command again; 280 updates itself',
    });
  }

  // authorize resolves the bearer token to an account-scoped service.
  private async authorize(c: Context<HonoEnv>): Promise<Service> {
    this.tooOld(c);

    const header = c.req.header('Authorization') ?? '';
    const token = stripBearer(header);
    if (token === '' || token === header.trim()) {
      throw noAccount();
    }
    // Only the hash is stored, so a leaked database does not hand over the
    // ability to push to every account in it.
    const hash = hashToken(token);

    let acct;
    try {
      acct = await this.platform.store.accountByToken(hash);
    } catch {
      throw new DeployErr({ code: DeployCode.Unavailable, message: 'auth lookup failed', retryable: true });
    }
    if (acct === null) {
      if (!this.openSignup) throw noAccount();
      // Derive the id from the token so a repeated presentation of the same
      // token lands on the same account even if the insert below raced.
      acct = { id: 'acct_' + hash.slice(0, 12), subject: '' };
      try {
        await this.platform.store.createAccount(acct);
        await this.platform.store.addToken(acct.id, hash);
      } catch {
        throw new DeployErr({ code: DeployCode.Unavailable, message: 'could not create account', retryable: true });
      }
    }
    markAccount(c, acct.id);
    return this.platform.for(acct.id);
  }

  // ---- responses ----

  // failResponse writes the seam's error shape. The client parses the body first
  // and only falls back to the status code, so the body is the contract and the
  // status is a courtesy to anything else in the path.
  private failResponse(_c: Context<HonoEnv>, de: DeployError): Response {
    return new Response(JSON.stringify(encodeError(de)), {
      status: statusForCode(de.code),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // renderPanic is the observe backstop's error body: an unmapped throw is a
  // bug, not retryable, and the request id is how a user quotes it back.
  private renderPanic(_err: unknown): Response {
    const body = encodeError({
      code: DeployCode.Unavailable,
      message: '280 hit an internal error',
      fix: 'run 280 push again, and quote the request id in the response headers',
      retryable: false,
      candidates: [],
    });
    return new Response(JSON.stringify(body), {
      status: statusForCode(DeployCode.Unavailable),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private logger(): Logger {
    return this.log ?? SILENT;
  }
}

// ---- wire encoders (Go omitempty semantics) ----

function encodeError(e: DeployError): Record<string, unknown> {
  const out: Record<string, unknown> = { code: e.code, message: e.message };
  if (e.fix) out.fix = e.fix;
  if (e.retryable) out.retryable = e.retryable;
  if (e.candidates && e.candidates.length > 0) out.candidates = e.candidates;
  return out;
}

function encodeApp(a: PublicApp): Record<string, unknown> {
  return { id: a.id, slug: a.slug, url: a.url };
}

function encodeSyncResult(r: SyncResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    app: encodeApp(r.app),
    resolution: r.resolution,
    deployId: r.deployId,
    state: r.state,
    // Go's Blobs.Missing returns a nil slice when nothing is missing, which
    // encoding/json renders as null (never []). Mirror that on the wire byte for
    // byte; the loose client schema (arr) normalizes null back to [] on receipt.
    missing: r.missing && r.missing.length > 0 ? r.missing : null,
  };
  if (r.failure) out.failure = encodeError(r.failure as DeployError);
  return out;
}

function encodeStatus(s: DeployStatus): Record<string, unknown> {
  const out: Record<string, unknown> = { state: s.state };
  // url is omitempty and set by the service only when live.
  if (s.url) out.url = s.url;
  if (s.failure) out.failure = encodeError(s.failure as DeployError);
  return out;
}

function encodeDeleteResult(r: DeleteResult): Record<string, unknown> {
  return { app: encodeApp(r.app), deleted: r.deleted };
}

// ---- secrets ----

function randomSecret(n: number): string {
  return randomBytes(n).toString('hex');
}

// randomUserCode returns the canonical (storage) form: 8 characters, no
// separator. Everything that compares codes normalizes, so the dash only ever
// exists for human eyes.
function randomUserCode(): string {
  const b = randomBytes(8);
  let out = '';
  for (const v of b) out += USER_CODE_ALPHABET[v % USER_CODE_ALPHABET.length];
  return out;
}

// displayUserCode is the form a human reads: XXXX-XXXX.
function displayUserCode(code: string): string {
  if (code.length !== 8) return code;
  return code.slice(0, 4) + '-' + code.slice(4);
}

// normalizeUserCode accepts what a human actually types: any case, with or
// without the dash or surrounding space.
function normalizeUserCode(s: string): string {
  return s.trim().toUpperCase().replaceAll('-', '');
}

function hashToken(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function newAccountId(): string {
  return 'acct_' + randomSecret(9);
}

function stripBearer(header: string): string {
  const trimmed = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  return trimmed.trim();
}

function encodeUser(u: User): Record<string, unknown> {
  return { id: u.id, email: u.email, name: u.name, image: u.image };
}

// clientIp is the caller's address as seen past the proxy. Behind Railway (and
// any similar edge) the connecting address is the proxy, so the first
// X-Forwarded-For hop is the real one. It keys the login rate limiter.
function clientIp(c: Context<HonoEnv>): string {
  const fwd = c.req.header('x-forwarded-for') ?? '';
  const first = fwd.split(',')[0]?.trim() ?? '';
  return first !== '' ? first : (c.req.header('x-real-ip') ?? 'unknown');
}

// isSecureRequest reports whether the browser reached us over HTTPS, trusting
// the proxy's X-Forwarded-Proto since TLS terminates there.
function isSecureRequest(c: Context<HonoEnv>): boolean {
  if ((c.req.header('x-forwarded-proto') ?? '').split(',')[0]?.trim() === 'https') return true;
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

// ---- errors ----

function noAccount(): DeployErr {
  return new DeployErr({ code: DeployCode.Unauthorized, message: 'not logged in to 280', fix: 'run 280 login' });
}

function unavailable(msg: string): DeployErr {
  return new DeployErr({ code: DeployCode.Unavailable, message: msg, retryable: true });
}

// ---- body reading ----

function contentLength(c: Context<HonoEnv>): number {
  const len = c.req.header('Content-Length');
  if (len === undefined) return -1;
  const n = Number(len);
  return Number.isFinite(n) ? n : -1;
}

async function readBodyText(c: Context<HonoEnv>, limit: number): Promise<string> {
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > limit) throw new Error('request body too large');
  return Buffer.from(buf).toString('utf8');
}

// readJson reads a JSON body and validates it through a loose schema, throwing
// the given seam error on any failure. sync/delete append the decoder's reason
// (mirroring Go's decode error); the internal endpoints use a fixed message.
// Folding schema validation in here means a non-object body fails the same way
// a malformed one does, rather than escaping to the panic backstop.
async function readJson<T>(
  c: Context<HonoEnv>,
  limit: number,
  schema: { parse: (u: unknown) => T },
  onError: { code: string; message: string; fix?: string; appendReason?: boolean },
): Promise<T> {
  try {
    const text = await readBodyText(c, limit);
    return schema.parse(JSON.parse(text));
  } catch (err) {
    const reason =
      onError.appendReason === false ? '' : ': ' + (err instanceof Error ? err.message : String(err));
    throw new DeployErr({ code: onError.code, message: onError.message + reason, fix: onError.fix });
  }
}

// cappedStream enforces the byte cap on a streamed body without buffering it.
// Exceeding the cap errors the stream, which the blob store surfaces as an
// upload fault (deploysvc maps it to a retryable unavailable, mirroring Go's
// MaxBytesReader).
function cappedStream(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): AsyncIterable<Uint8Array> {
  const src = body ?? emptyStream();
  return {
    async *[Symbol.asyncIterator]() {
      let seen = 0;
      const reader = src.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            seen += value.byteLength;
            if (seen > limit) throw new Error(`blob exceeds ${limit} bytes`);
            yield value;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

const SILENT: Logger = {
  info() {},
  warn() {},
  error() {},
};
