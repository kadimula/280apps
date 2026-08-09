// HTTP API v1: the thin transport in front of deploysvc. It only authenticates,
// translates the wire format, and maps seam errors to status codes; Go is normative.

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  APP_ROLE_ORDER,
  DeployCode,
  DeployErr,
  AuthCode,
  appRoleAtLeast,
  asDeployError,
  deleteRequestSchema,
  isAppAccess,
  isConsumerEmailDomain,
  requiredConfigNames,
  statusForCode,
  syncRequestSchema,
  tenantFromEmail,
  tokenRequestSchema,
  approveRequestSchema,
  deleteAppRequestSchema,
  previewGrantRequestSchema,
  version,
  type App as PublicApp,
  type DeployError,
  type DeployStatus,
  type SyncResult,
  type DeleteResult,
  type ViewAsTarget,
} from '@280/contracts';
import type { Service } from './deploysvc.js';
import { docsRoutes } from './docs.js';
import { sharePage } from './sharepage.js';
import { Auth, AuthError } from './authsvc.js';
import { markAccount, observe, type HonoEnv, type Logger } from './observe.js';
import type { RequestDeps } from './config.js';
import { DeviceStatus, type App as StoreApp, type AppRole, type User } from './seams.js';
import { containerApp } from './activator.js';

// Caller's binary version; the server uses it to refuse a CLI too old for this API.
const HEADER_CLI_VERSION = 'X-280-Cli-Version';

// Bounds one uploaded blob, deliberately UNDER Cloudflare's ~100 MB edge limit: a
// blob at the old 100 MiB cap would die at the edge with an HTML 413 the CLI cannot
// parse. Raise only against a verified higher zone limit.
export const MAX_BLOB_BYTES = 95 << 20;

const SYNC_LIMIT = 8 << 20;
const SMALL_LIMIT = 64 << 10;

// TTL is what a human plausibly takes to notice the message, open a browser, and
// sign in.
const DEVICE_CODE_TTL_SECS = 15 * 60;
const DEVICE_POLL_SECS = 5;

// Omits characters that are misread when a human copies a code off one screen and
// types it into another.
const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ23456789';

// What a human types into the delete dialog.
const DASHBOARD_CONFIRM = 'delete';

// A preview grant outlives one dashboard visit, not a session: the app-host
// middleware re-mints ~120s identity tokens from it while the iframe is open, and
// the dashboard re-issues a grant when it lapses.
const PREVIEW_GRANT_TTL_SECS = 15 * 60;

export interface ServerConfig {
  // buildDeps constructs the I/O container from the Hono context.
  buildDeps: (c: Context<HonoEnv>) => RequestDeps | Promise<RequestDeps>;
  logger?: Logger;
}

export class Server {
  private readonly buildDeps: ServerConfig['buildDeps'];
  private readonly log?: Logger;

  constructor(cfg: ServerConfig) {
    this.buildDeps = cfg.buildDeps;
    this.log = cfg.logger;
  }

  // The router, built once and reused; the leading deps middleware builds fresh I/O
  // per request so reuse is safe.
  handler(): Hono<HonoEnv> {
    const app = new Hono<HonoEnv>();

    // Wrapping the whole app rather than each route covers a route someone adds
    // later without remembering to.
    app.use('*', observe({ logger: () => this.logger(), renderPanic: (e) => this.renderPanic(e) }));

    // Deps on the context. Runs inside observe so a build failure renders as a
    // seam error, not a dropped connection.
    app.use('*', (c, next) => this.withDeps(c, next));

    app.post('/v1/sync', this.route((c) => this.handleSync(c)));
    app.put('/v1/apps/:app/blobs/:digest', this.route((c) => this.handlePutBlob(c)));
    app.get('/v1/apps/:app/deploys/:deploy', this.route((c) => this.handleStatus(c)));
    app.post('/v1/apps/:app/delete', this.route((c) => this.handleDelete(c)));

    // The only unauthenticated deploy endpoints: how a machine gets a token.
    app.post('/v1/device/code', this.route((c) => this.handleDeviceCode(c)));
    app.post('/v1/device/token', this.route((c) => this.handleDeviceToken(c)));

    // Browser login: start/callback are cookie-setting navigations; me/logout serve
    // signed-in state and sign-out.
    app.get('/auth/:provider/start', (c) => this.handleAuthStart(c));
    app.get('/auth/:provider/callback', (c) => this.handleAuthCallback(c));
    app.get('/auth/me', (c) => this.handleAuthMe(c));
    app.post('/auth/logout', (c) => this.handleAuthLogout(c));

    // The web surface, authenticated by the browser session: the acting user is
    // whoever the cookie resolves to.
    app.post('/internal/device/approve', this.route((c) => this.handleDeviceApprove(c)));
    app.get('/internal/apps', this.route((c) => this.handleApps(c)));
    app.post('/internal/apps/:app/delete', this.route((c) => this.handleInternalDelete(c)));

    // The share dialog and its data: list/grant/revoke access (both tiers) and the
    // rendered page. Session-authenticated, scoped to an app the caller owns.
    app.get('/internal/apps/:app/grants', this.route((c) => this.handleGrantsList(c)));
    app.post('/internal/apps/:app/grants', this.route((c) => this.handleGrantPut(c)));
    app.post('/internal/apps/:app/grants/revoke', this.route((c) => this.handleGrantRevoke(c)));
    app.post('/internal/apps/:app/access', this.route((c) => this.handleSetAccess(c)));
    app.get('/internal/apps/:app/share', this.route((c) => this.handleShareDialog(c)));

    app.get('/internal/apps/:app/secrets', this.route((c) => this.handleSecretsList(c)));
    app.post('/internal/apps/:app/secrets', this.route((c) => this.handleSecretPut(c)));
    app.post('/internal/apps/:app/secrets/reveal', this.route((c) => this.handleSecretReveal(c)));
    app.post('/internal/apps/:app/secrets/delete', this.route((c) => this.handleSecretDelete(c)));

    // The dashboard preview: issues the opaque grant the iframe exchanges at the
    // app host's /__280/preview for a gateway-minted identity.
    app.post('/internal/apps/:app/preview-grant', this.route((c) => this.handlePreviewGrant(c)));

    app.get('/healthz', (c) => c.text('ok\n'));

    // Agent-facing product docs, unauthenticated; the frontend proxies these at
    // their public URLs. Owned by docs.ts.
    app.route('/v1/docs', docsRoutes());

    return app;
  }

  private async withDeps(c: Context<HonoEnv>, next: () => Promise<void>): Promise<void> {
    c.set('deps', await this.buildDeps(c));
    await next();
  }

  private deps(c: Context<HonoEnv>): RequestDeps {
    return c.get('deps');
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

  private async handleSync(c: Context<HonoEnv>): Promise<Response> {
    const svc = await this.authorize(c);
    const req = await readJson(c, SYNC_LIMIT, syncRequestSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the sync request',
      fix: 'upgrade the two80 CLI, then run two80 push again',
    });
    const res = await svc.sync(req);
    return c.json(encodeSyncResult(res));
  }

  private async handlePutBlob(c: Context<HonoEnv>): Promise<Response> {
    const svc = await this.authorize(c);
    const appId = (c.req.param('app') ?? '');
    const digest = (c.req.param('digest') ?? '');
    // The raw request stream, capped, never a buffered body.
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
      fix: 'upgrade the two80 CLI, then run two80 delete again',
    });
    // The path names the app, not the body.
    req.appId = (c.req.param('app') ?? '');
    const res = await svc.delete(req);
    return c.json(encodeDeleteResult(res));
  }

  private async handleDeviceCode(c: Context<HonoEnv>): Promise<Response> {
    const deviceCode = randomSecret(32);
    const userCode = randomUserCode();
    const expiresAt = nowSecs() + DEVICE_CODE_TTL_SECS;
    try {
      await this.deps(c).platform.store.createDeviceCode({
        deviceHash: hashToken(deviceCode),
        userCode,
        userId: '',
        status: DeviceStatus.Pending,
        expiresAt,
      });
    } catch {
      throw unavailable('could not start login');
    }
    return c.json({
      deviceCode,
      userCode: displayUserCode(userCode),
      verificationUri: this.deps(c).verificationUri,
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
        fix: 'run two80 login',
      });
    }

    let dc;
    try {
      dc = await this.deps(c).platform.store.deviceCodeByHash(hashToken(deviceCode));
    } catch {
      throw unavailable('login lookup failed');
    }
    // Unknown, expired, and already-claimed are one answer on purpose: telling a
    // caller which it hit is free reconnaissance on a guessed code.
    if (dc === null || dc.status === DeviceStatus.Claimed || nowSecs() >= dc.expiresAt) {
      throw new DeployErr({
        code: AuthCode.ExpiredToken,
        message: 'that login request expired',
        fix: 'run two80 login',
      });
    }
    if (dc.status === DeviceStatus.Pending) {
      throw new DeployErr({
        code: AuthCode.AuthorizationPending,
        message: 'waiting for the user to finish signing in',
        fix: 'ask your user to open the login link, then run two80 login again',
      });
    }

    // Claim first: whoever wins this update is the only caller that may mint a token
    // for this code, so a duplicated poll cannot produce two credentials.
    let won: boolean;
    try {
      won = await this.deps(c).platform.store.claimDeviceCode(dc.deviceHash);
    } catch {
      throw unavailable('could not complete login');
    }
    if (!won) {
      throw new DeployErr({
        code: AuthCode.ExpiredToken,
        message: 'that login request expired',
        fix: 'run two80 login',
      });
    }

    const token = randomSecret(32);
    try {
      await this.deps(c).platform.store.addToken(dc.userId, hashToken(token));
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

    // The principal is the signed-in user, not a body field: a browser cannot approve
    // a login for anyone but itself.
    let ok: boolean;
    try {
      ok = await this.deps(c).platform.store.approveDeviceCode(normalizeUserCode(req.userCode), user.id, nowSecs());
    } catch {
      throw unavailable('could not record the approval');
    }
    if (!ok) {
      throw new DeployErr({
        code: AuthCode.ExpiredToken,
        message: 'that code is not waiting for approval',
        fix: 'ask your agent to run two80 login again',
      });
    }
    return c.body(null, 204);
  }

  private async handleApps(c: Context<HonoEnv>): Promise<Response> {
    const user = await this.sessionUser(c);

    let apps;
    try {
      apps = await this.deps(c).platform.store.appsByUser(user.id);
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
        createdAt: a.createdAt,
        lastDeployAt: a.lastDeployAt,
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

    const svc = this.deps(c).platform.for(user.id);

    // The dry run does the looking up: it fails closed on an app this account does
    // not own, and it is where the slug comes from.
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

  // ownedApp resolves the app named in the path, scoped to the caller, so a builder
  // can only ever manage sharing for their own apps. Same not-found answer for "no
  // app" and "another user's app": ownership is not probeable.
  private async ownedApp(c: Context<HonoEnv>): Promise<{ user: User; app: StoreApp }> {
    const user = await this.sessionUser(c);
    const appId = c.req.param('app') ?? '';
    let app;
    try {
      app = await this.deps(c).platform.store.app(user.id, appId);
    } catch {
      throw unavailable('could not look up the app');
    }
    if (app !== null) return { user, app };
    throw new DeployErr({ code: DeployCode.NoSuchApp, message: 'that app does not exist on this account' });
  }

  private async handleGrantsList(c: Context<HonoEnv>): Promise<Response> {
    const { app } = await this.ownedApp(c);
    let grants, policy;
    try {
      [grants, policy] = await Promise.all([
        this.deps(c).platform.store.grantsByApp(app.id),
        this.deps(c).platform.store.appPolicy(app.id),
      ]);
    } catch {
      throw unavailable('could not read the access list');
    }
    const ownerTenant = policy?.ownerTenant ?? '';
    return c.json({
      app: { id: app.id, slug: app.slug, url: app.url },
      script: app.script,
      access: policy?.access ?? 'invited',
      accessSource: policy?.accessSource ?? 'manifest',
      ownerTenant,
      // Lets the dialog disable/warn on "Anyone at gmail.com"; the gateway
      // independently refuses to admit on a consumer tenant (defense in depth).
      ownerTenantIsConsumer: isConsumerEmailDomain(ownerTenant),
      roles: policy?.roles ?? [],
      viewAsOrigin: this.deps(c).viewAsOrigin,
      grants: grants.map((g) => ({
        principal: g.principal,
        appRole: g.appRole,
        featureRole: g.featureRole,
        grantedBy: g.grantedBy,
        grantedAt: g.grantedAt,
      })),
    });
  }

  private async handleGrantPut(c: Context<HonoEnv>): Promise<Response> {
    const { user, app } = await this.ownedApp(c);
    const req = await readJson(c, SMALL_LIMIT, grantPutSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the grant',
      appendReason: false,
    });

    const principal = normalizePrincipal(req.principal);
    if (principal === '') {
      throw badRequest('name a person by email, or a domain like domain:firm.com');
    }
    if (!(APP_ROLE_ORDER as readonly string[]).includes(req.appRole)) {
      throw badRequest(`app role must be one of ${APP_ROLE_ORDER.join(', ')}`);
    }
    const featureRole = req.featureRole.trim();
    if (featureRole !== '') {
      const policy = await this.deps(c).platform.store.appPolicy(app.id).catch(() => null);
      const roles = policy?.roles ?? [];
      if (!roles.includes(featureRole)) {
        throw badRequest(`"${featureRole}" is not a feature role this app declares in 280.json`);
      }
    }
    // Never let the dialog remove the app's last owner: a builder who demotes
    // themselves by mistake would lock everyone out of managing it.
    await this.guardLastOwner(c, app.id, principal, req.appRole);

    try {
      await this.deps(c).platform.store.putGrant({
        appId: app.id,
        principal,
        appRole: req.appRole as AppRole,
        featureRole,
        dataScope: null,
        grantedBy: user.email,
        grantedAt: nowSecs(),
      });
    } catch {
      throw unavailable('could not save the grant');
    }
    return c.body(null, 204);
  }

  private async handleGrantRevoke(c: Context<HonoEnv>): Promise<Response> {
    const { user, app } = await this.ownedApp(c);
    const req = await readJson(c, SMALL_LIMIT, grantRevokeSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the request',
      appendReason: false,
    });
    const principal = normalizePrincipal(req.principal);
    await this.guardLastOwner(c, app.id, principal, null);
    try {
      await this.deps(c).platform.store.revokeGrant(app.id, principal, user.email);
    } catch {
      throw unavailable('could not update the access list');
    }
    return c.body(null, 204);
  }

  // handleSetAccess is the Share modal's "General access" dial: it writes the
  // dashboard override, which wins durably over 280.json's access on every future
  // deploy. ownedApp() makes it account-owner-only — public opens the app's whole
  // viewer surface to the internet, so nothing below the owner may flip it.
  private async handleSetAccess(c: Context<HonoEnv>): Promise<Response> {
    const { user, app } = await this.ownedApp(c);
    const req = await readJson(c, SMALL_LIMIT, accessSetSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the access change',
      appendReason: false,
    });
    if (!isAppAccess(req.access)) {
      throw badRequest('access must be one of invited, anyone-at-tenant, public');
    }

    let ok: boolean;
    try {
      ok = await this.deps(c).platform.store.setAppAccess(app.id, req.access, user.email);
    } catch {
      throw unavailable('could not save the access change');
    }
    if (!ok) {
      throw badRequest('this app has never gone live; push it first, then set its access');
    }
    return c.body(null, 204);
  }

  // guardLastOwner refuses a change that would leave an app with no owner: revoking
  // an owner (newRole null) or demoting the sole owner below owner.
  private async guardLastOwner(
    c: Context<HonoEnv>,
    appId: string,
    principal: string,
    newRole: string | null,
  ): Promise<void> {
    const grants = await this.deps(c).platform.store.grantsByApp(appId).catch(() => []);
    const owners = grants.filter((g) => g.appRole === 'owner');
    const targetIsOwner = owners.some((o) => o.principal === principal);
    if (targetIsOwner && owners.length <= 1 && newRole !== 'owner') {
      throw badRequest('this is the app\'s only owner; make someone else an owner first');
    }
  }

  private async handleShareDialog(c: Context<HonoEnv>): Promise<Response> {
    const { app } = await this.ownedApp(c);
    const policy = await this.deps(c).platform.store.appPolicy(app.id).catch(() => null);
    const html = sharePage({
      app: { id: app.id, slug: app.slug, url: app.url, script: app.script },
      access: policy?.access ?? 'invited',
      roles: policy?.roles ?? [],
      viewAsOrigin: this.deps(c).viewAsOrigin,
    });
    return c.html(html);
  }

  private async handleSecretsList(c: Context<HonoEnv>): Promise<Response> {
    const { app } = await this.ownedApp(c);
    const [{ secrets, config }, stored] = await Promise.all([
      this.declaredVariables(c, app.id),
      this.deps(c).platform.store.appSecrets(app.id),
    ]).catch(() => {
      throw unavailable('could not read the app secrets');
    });
    const byName = new Map(stored.map((s) => [s.name, s]));
    const row = (name: string, kind: 'secret' | 'config') => {
      const s = byName.get(name);
      return s ? { name, kind, configured: true, setBy: s.setBy, setAt: s.setAt } : { name, kind, configured: false };
    };
    return c.json({
      secrets: [
        ...secrets.map((name) => row(name, 'secret')),
        ...config.map((name) => row(name, 'config')),
      ],
    });
  }

  // The variables the owner may configure, split by channel. Both are gathered from
  // the live policy, every open deploy (a parked deploy must always be configurable),
  // and the newest deploy (even failed, so an expired park can be configured before
  // the re-push). `config` is the dashboard-entered kind only: required config
  // (sensitive with no committed value); public config carries its value in 280.json.
  private async declaredVariables(
    c: Context<HonoEnv>,
    appId: string,
  ): Promise<{ secrets: string[]; config: string[] }> {
    const store = this.deps(c).platform.store;
    const [policy, latest, open] = await Promise.all([
      store.appPolicy(appId),
      store.latestDeploy(appId).catch(() => null),
      store.openDeploys(appId).catch(() => []),
    ]);
    const secrets = new Set(policy?.secrets ?? []);
    const config = new Set(requiredConfigNames(policy?.config ?? []));
    for (const dep of [latest, ...open]) {
      for (const name of dep?.manifest.secrets ?? []) secrets.add(name);
      for (const name of requiredConfigNames(dep?.manifest.config ?? [])) config.add(name);
    }
    return { secrets: [...secrets], config: [...config] };
  }

  private async handleSecretPut(c: Context<HonoEnv>): Promise<Response> {
    const { user, app } = await this.ownedApp(c);
    const req = await readJson(c, SMALL_LIMIT, secretPutSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the secret',
      appendReason: false,
    });
    if (req.name === '') throw badRequest('name the secret to configure');
    if (req.value === '') throw badRequest('secret values cannot be empty');

    const cipher = this.deps(c).secretCipher;
    if (cipher === undefined) throw unavailable('secret storage is not configured');
    const { secrets, config } = await this.declaredVariables(c, app.id).catch(() => {
      throw unavailable('could not read the app secrets');
    });
    const isConfig = config.includes(req.name);
    if (!isConfig && !secrets.includes(req.name)) {
      throw badRequest(`"${req.name}" is not declared in this app's 280.json`);
    }

    try {
      await this.deps(c).platform.store.putAppSecret({
        appId: app.id,
        name: req.name,
        envelope: await cipher.protect(app.id, req.name, req.value),
        setBy: user.email,
        setAt: nowSecs(),
        kind: isConfig ? 'config' : 'secret',
      });
    } catch {
      throw unavailable('could not save the secret');
    }
    if (app.activeDeploy !== '') await this.deps(c).secretDelivery?.set(containerApp(app), req.name);
    await this.deps(c).platform.resumeWaitingSecrets(app).catch(() => {
      throw unavailable('could not resume the waiting deploy');
    });
    return c.body(null, 204);
  }

  private async handleSecretReveal(c: Context<HonoEnv>): Promise<Response> {
    const { app } = await this.ownedApp(c);
    const req = await readJson(c, SMALL_LIMIT, secretNameSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the secret name',
      appendReason: false,
    });
    const cipher = this.deps(c).secretCipher;
    if (cipher === undefined) throw unavailable('secret storage is not configured');
    const stored = await this.deps(c).platform.store.appSecrets(app.id).catch(() => {
      throw unavailable('could not read the app secrets');
    });
    const secret = stored.find((candidate) => candidate.name === req.name);
    if (!secret) throw badRequest('this variable has no value');
    try {
      c.header('Cache-Control', 'no-store');
      return c.json({ value: await cipher.reveal(app.id, secret.name, secret.envelope) });
    } catch {
      throw unavailable('could not reveal the variable');
    }
  }

  private async handleSecretDelete(c: Context<HonoEnv>): Promise<Response> {
    const { user, app } = await this.ownedApp(c);
    const req = await readJson(c, SMALL_LIMIT, secretNameSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the secret name',
      appendReason: false,
    });
    await this.deps(c).platform.store.deleteAppSecret(app.id, req.name, user.email).catch(() => {
      throw unavailable('could not delete the variable');
    });
    if (app.activeDeploy !== '') await this.deps(c).secretDelivery?.delete(containerApp(app), req.name);
    return c.body(null, 204);
  }

  // handlePreviewGrant issues an owner-authorized, short-lived, hashed preview
  // grant for one app (design: dashboard preview + view-as). ownedApp() scopes it
  // to the caller's own app; on top of that the caller's effective grant must be
  // admin or above (viewAsAllowed semantics), the same rule the gateway re-checks
  // on every mint from the grant.
  private async handlePreviewGrant(c: Context<HonoEnv>): Promise<Response> {
    const { user, app } = await this.ownedApp(c);
    const req = await readJson(c, SMALL_LIMIT, previewGrantRequestSchema, {
      code: DeployCode.PreflightRejected,
      message: 'could not read the preview request',
      appendReason: false,
    });
    const viewAs = await this.validViewAs(c, app.id, req.viewAs);

    const effective = await this.effectiveAppRole(c, app.id, user.email);
    if (!appRoleAtLeast(effective, 'admin')) {
      throw badRequest('only an app owner or admin can preview it');
    }

    const token = randomSecret(32);
    try {
      await this.deps(c).platform.store.createPreviewGrant({
        tokenHash: hashToken(token),
        appId: app.id,
        ownerUserId: user.id,
        viewAs,
        expiresAt: nowSecs() + PREVIEW_GRANT_TTL_SECS,
        revoked: false,
      });
    } catch {
      throw unavailable('could not create the preview grant');
    }
    return c.json({
      grant: token,
      expiresIn: PREVIEW_GRANT_TTL_SECS,
      url: `${app.url}/__280/preview?g=${token}`,
    });
  }

  // validViewAs normalizes and validates a preview target: a role target must name
  // a real app role or a feature role the app declares; a user target must be an
  // email (any email — view-as-user is open to all principals by design, and the
  // gateway runs the target through the normal admission decision).
  private async validViewAs(
    c: Context<HonoEnv>,
    appId: string,
    viewAs: ViewAsTarget,
  ): Promise<ViewAsTarget> {
    if (viewAs.kind === 'none') return { kind: 'none' };
    if (viewAs.kind === 'user') {
      const email = viewAs.email.trim().toLowerCase();
      if (email === '' || !email.includes('@')) {
        throw badRequest('name the person to view as by email');
      }
      return { kind: 'user', email };
    }
    const appRole = viewAs.appRole.trim();
    const featureRole = viewAs.featureRole.trim();
    if (appRole === '' && featureRole === '') {
      throw badRequest('name an app role or a feature role to view as');
    }
    if (appRole !== '' && !(APP_ROLE_ORDER as readonly string[]).includes(appRole)) {
      throw badRequest(`app role must be one of ${APP_ROLE_ORDER.join(', ')}`);
    }
    if (featureRole !== '') {
      const policy = await this.deps(c).platform.store.appPolicy(appId).catch(() => null);
      if (!(policy?.roles ?? []).includes(featureRole)) {
        throw badRequest(`"${featureRole}" is not a feature role this app declares in 280.json`);
      }
    }
    return { kind: 'role', appRole, featureRole };
  }

  // effectiveAppRole merges the caller's direct and org-domain grants into the app
  // role the gateway would resolve for them (the higher of the two wins).
  private async effectiveAppRole(c: Context<HonoEnv>, appId: string, email: string): Promise<string> {
    const store = this.deps(c).platform.store;
    const tenant = tenantFromEmail(email);
    let direct, domain;
    try {
      [direct, domain] = await Promise.all([
        store.grant(appId, email),
        tenant !== '' ? store.grant(appId, 'domain:' + tenant) : Promise.resolve(null),
      ]);
    } catch {
      throw unavailable('could not read the access list');
    }
    const a = direct?.appRole ?? '';
    const b = domain?.appRole ?? '';
    return appRoleAtLeast(a, b) ? a : b;
  }

  // handleAuthStart sends the browser to the provider's consent screen. A failure
  // bounces back to the frontend login page rather than showing a bare error.
  private async handleAuthStart(c: Context<HonoEnv>): Promise<Response> {
    const auth = this.deps(c).auth;
    if (auth === undefined) return c.text('login is not configured', 404);
    try {
      const { authUrl, stateCookie } = await auth.start(
        c.req.param('provider') ?? '',
        c.req.query('redirect') ?? '',
        clientIp(c),
      );
      setCookie(c, auth.oauthCookieName, stateCookie, this.cookieOpts(c, 600));
      return c.redirect(authUrl, 302);
    } catch (err) {
      if (err instanceof AuthError) return this.authBounce(c, auth);
      throw err;
    }
  }

  // handleAuthCallback finishes the flow: sets the session cookie, drops the state
  // cookie, and returns the browser to the destination start vetted.
  private async handleAuthCallback(c: Context<HonoEnv>): Promise<Response> {
    const auth = this.deps(c).auth;
    if (auth === undefined) return c.text('login is not configured', 404);
    // A provider can decline; treat it like any other failed login.
    if ((c.req.query('error') ?? '') !== '') return this.authBounce(c, auth);
    try {
      const result = await auth.complete(
        c.req.param('provider') ?? '',
        c.req.query('code') ?? '',
        c.req.query('state') ?? '',
        getCookie(c, auth.oauthCookieName) ?? '',
      );
      setCookie(c, auth.sessionCookieName, result.sessionToken, this.cookieOpts(c, auth.sessionTtlSecs));
      deleteCookie(c, auth.oauthCookieName, this.cookieOpts(c, 0));
      return c.redirect(result.redirect, 302);
    } catch (err) {
      if (err instanceof AuthError) {
        deleteCookie(c, auth.oauthCookieName, this.cookieOpts(c, 0));
        return this.authBounce(c, auth);
      }
      throw err;
    }
  }

  // handleAuthMe is what the frontend reads to render the signed-in state. It never
  // errors: no session is a null user, not a failure.
  private async handleAuthMe(c: Context<HonoEnv>): Promise<Response> {
    const auth = this.deps(c).auth;
    if (auth === undefined) return c.json({ user: null });
    const user = await auth.me(getCookie(c, auth.sessionCookieName) ?? '');
    return c.json({ user: user === null ? null : encodeUser(user) });
  }

  // handleAuthLogout clears both the session row (killing the token) and the cookie.
  private async handleAuthLogout(c: Context<HonoEnv>): Promise<Response> {
    const auth = this.deps(c).auth;
    if (auth === undefined) return c.text('login is not configured', 404);
    await auth.logout(getCookie(c, auth.sessionCookieName) ?? '');
    deleteCookie(c, auth.sessionCookieName, this.cookieOpts(c, 0));
    return c.redirect(auth.safeRedirect(c.req.query('redirect') ?? '/'), 303);
  }

  // authBounce returns a failed login to the frontend's login page with one message
  // for every failure: which step broke is not a browser's concern.
  private authBounce(c: Context<HonoEnv>, auth: Auth): Response {
    return c.redirect(auth.frontendOrigin + '/login?error=auth', 302);
  }

  // cookieOpts builds the attributes every cookie shares (maxAge 0 expires). Secure
  // rides on a real HTTPS request or a configured cookie domain; localhost dev over
  // http is not Secure, or the browser would drop the cookie.
  private cookieOpts(c: Context<HonoEnv>, maxAge: number): {
    httpOnly: true;
    sameSite: 'Lax';
    path: '/';
    secure: boolean;
    domain?: string;
    maxAge: number;
  } {
    const domain = this.deps(c).auth?.cookieDomain ?? '';
    return {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: domain !== '' || isSecureRequest(c),
      ...(domain !== '' ? { domain } : {}),
      maxAge,
    };
  }

  // sessionUser resolves the browser session on a web-surface call, or refuses. An
  // unset Auth is a closed door: internal endpoints answer not-found.
  private async sessionUser(c: Context<HonoEnv>): Promise<User> {
    const auth = this.deps(c).auth;
    if (auth === undefined) {
      throw new DeployErr({ code: DeployCode.NotFound, message: 'the internal API is not configured' });
    }
    const user = await auth.me(getCookie(c, auth.sessionCookieName) ?? '');
    if (user === null) {
      throw new DeployErr({ code: DeployCode.Unauthorized, message: 'not signed in' });
    }
    return user;
  }

  // tooOld throws cli_too_old if the caller's CLI predates MinCLIVersion, before the
  // token lookup so a binary that cannot speak this API costs no DB round trip.
  private tooOld(c: Context<HonoEnv>): void {
    if (!version.valid(this.deps(c).minCliVersion)) return;
    const got = c.req.header(HEADER_CLI_VERSION) ?? '';
    if (!version.valid(got) || !version.less(got, this.deps(c).minCliVersion)) return;
    throw new DeployErr({
      code: DeployCode.CLITooOld,
      message: `this 280 CLI (${got}) is older than 280 supports (${this.deps(c).minCliVersion})`,
      fix: 'run the same command again; 280 updates itself',
    });
  }

  // authorize resolves the bearer token to a user-scoped service.
  private async authorize(c: Context<HonoEnv>): Promise<Service> {
    this.tooOld(c);

    const header = c.req.header('Authorization') ?? '';
    const token = stripBearer(header);
    if (token === '' || token === header.trim()) {
      throw noAccount();
    }
    // Only the hash is stored, so a leaked database does not hand over the ability
    // to push as every user in it.
    const hash = hashToken(token);

    // An expired token (created before now - ttl) resolves to null, the same answer
    // an unknown token gets, so the CLI's "run two80 login" recovery covers both.
    const minCreatedAt = nowSecs() - this.deps(c).machineTokenTtlSecs;

    let user;
    try {
      user = await this.deps(c).platform.store.userByToken(hash, minCreatedAt);
    } catch {
      throw new DeployErr({ code: DeployCode.Unavailable, message: 'auth lookup failed', retryable: true });
    }
    if (user === null) {
      throw noAccount();
    }
    markAccount(c, user.id);
    return this.deps(c).platform.for(user.id);
  }

  // failResponse writes the seam's error shape. The client parses the body first and
  // only falls back to the status code, so the body is the contract.
  private failResponse(_c: Context<HonoEnv>, de: DeployError): Response {
    return new Response(JSON.stringify(encodeError(de)), {
      status: statusForCode(de.code),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // renderPanic is the observe backstop's error body: an unmapped throw is a bug,
  // not retryable, and the request id is how a user quotes it back.
  private renderPanic(_err: unknown): Response {
    const body = encodeError({
      code: DeployCode.Unavailable,
      message: '280 hit an internal error',
      fix: 'run two80 push again, and quote the request id in the response headers',
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

// Wire encoders mirror Go's omitempty semantics.

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
    // Go's nil Missing slice renders as null (never []); mirror that byte for byte.
    // The loose client schema normalizes null back to [] on receipt.
    missing: r.missing && r.missing.length > 0 ? r.missing : null,
  };
  if (r.failure) out.failure = encodeError(r.failure as DeployError);
  return out;
}

function encodeStatus(s: DeployStatus): Record<string, unknown> {
  const out: Record<string, unknown> = { state: s.state };
  // url is omitempty and set by the service only when live.
  if (s.url) out.url = s.url;
  if (s.notice) out.notice = s.notice;
  if (s.secretNotice) out.secretNotice = s.secretNotice;
  if (s.failure) out.failure = encodeError(s.failure as DeployError);
  return out;
}

function encodeDeleteResult(r: DeleteResult): Record<string, unknown> {
  return { app: encodeApp(r.app), deleted: r.deleted };
}

function randomSecret(n: number): string {
  return randomBytes(n).toString('hex');
}

// randomUserCode returns the canonical (storage) form: 8 characters, no separator.
// Everything that compares codes normalizes, so the dash only exists for human eyes.
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

// normalizeUserCode accepts what a human actually types: any case, with or without
// the dash or surrounding space.
function normalizeUserCode(s: string): string {
  return s.trim().toUpperCase().replaceAll('-', '');
}

function hashToken(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function stripBearer(header: string): string {
  const trimmed = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  return trimmed.trim();
}

function encodeUser(u: User): Record<string, unknown> {
  return { id: u.id, email: u.email, name: u.name, image: u.image };
}

// clientIp is the caller's address past the proxy: behind Railway the connecting
// address is the proxy, so the first X-Forwarded-For hop is the real one. Keys the
// login rate limiter.
function clientIp(c: Context<HonoEnv>): string {
  const fwd = c.req.header('x-forwarded-for') ?? '';
  const first = fwd.split(',')[0]?.trim() ?? '';
  return first !== '' ? first : (c.req.header('x-real-ip') ?? 'unknown');
}

// isSecureRequest trusts the proxy's X-Forwarded-Proto since TLS terminates there.
function isSecureRequest(c: Context<HonoEnv>): boolean {
  if ((c.req.header('x-forwarded-proto') ?? '').split(',')[0]?.trim() === 'https') return true;
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

function noAccount(): DeployErr {
  return new DeployErr({ code: DeployCode.Unauthorized, message: 'not logged in to 280', fix: 'run two80 login' });
}

function badRequest(message: string): DeployErr {
  return new DeployErr({ code: DeployCode.PreflightRejected, message });
}

// normalizePrincipal canonicalizes a grant principal so it matches what the gateway
// compares against: a "domain:firm.com" org grant or a lowercased email (addresses
// are case-insensitive; OIDC hands the gateway a lowercased address).
function normalizePrincipal(raw: string): string {
  const p = raw.trim();
  if (p === '') return '';
  if (p.toLowerCase().startsWith('domain:')) {
    const host = p.slice('domain:'.length).trim().toLowerCase();
    return host === '' ? '' : 'domain:' + host;
  }
  return p.toLowerCase();
}

// The share-dialog write bodies, parsed with tiny hand-written validators (no zod
// dependency in the backend). appRole is required; featureRole is optional and the
// handler validates it against the app's declared roles.
const grantPutSchema = {
  parse(u: unknown): { principal: string; appRole: string; featureRole: string } {
    const o = asObject(u);
    return { principal: str(o.principal), appRole: str(o.appRole), featureRole: str(o.featureRole) };
  },
};

const grantRevokeSchema = {
  parse(u: unknown): { principal: string } {
    return { principal: str(asObject(u).principal) };
  },
};

const accessSetSchema = {
  parse(u: unknown): { access: string } {
    return { access: str(asObject(u).access) };
  },
};

const secretNameSchema = {
  parse(u: unknown): { name: string } {
    const object = asObject(u);
    if (typeof object.name !== 'string' || object.name === '') {
      throw new Error('name must be a non-empty string');
    }
    return { name: object.name };
  },
};

const secretPutSchema = {
  parse(u: unknown): { name: string; value: string } {
    const object = asObject(u);
    if (typeof object.name !== 'string' || typeof object.value !== 'string') {
      throw new Error('expected string name and value');
    }
    return { name: object.name, value: object.value };
  },
};

function asObject(u: unknown): Record<string, unknown> {
  if (u === null || typeof u !== 'object' || Array.isArray(u)) throw new Error('expected a JSON object');
  return u as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function unavailable(msg: string): DeployErr {
  return new DeployErr({ code: DeployCode.Unavailable, message: msg, retryable: true });
}

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

// readJson reads and validates a JSON body, throwing the given seam error on any
// failure. sync/delete append the decoder's reason; internal endpoints use a fixed
// message. Folding validation here makes a non-object body fail like a malformed one.
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
// Exceeding the cap errors the stream, which deploysvc maps to a retryable error.
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
