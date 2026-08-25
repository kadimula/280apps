import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  APP_ROLE_ORDER,
  appRoleAtLeast,
  isAppAccess,
  isConsumerEmailDomain,
  previewGrantRequestSchema,
  tenantFromEmail,
  DeployCode,
  type ViewAsTarget,
} from '@280/contracts';
import { hashToken } from '../../crypto.js';
import type { HonoEnv } from '../../observe.js';
import type { AppRole } from '../../seams.js';
import { sharePage } from '../../sharepage.js';
import {
  SMALL_LIMIT,
  asObject,
  badRequest,
  nowSecs,
  ownedApp,
  randomSecret,
  readJson,
  route,
  str,
  unavailable,
} from '../kernel.js';

// A preview grant outlives one dashboard visit, not a session: the app host
// re-mints ~120s identity tokens from it while the iframe is open.
const PREVIEW_GRANT_TTL_SECS = 15 * 60;

export function sharingRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.get('/internal/apps/:app/grants', route(handleGrantsList));
  app.post('/internal/apps/:app/grants', route(handleGrantPut));
  app.post('/internal/apps/:app/grants/revoke', route(handleGrantRevoke));
  app.post('/internal/apps/:app/access', route(handleSetAccess));
  app.get('/internal/apps/:app/share', route(handleShareDialog));
  app.post('/internal/apps/:app/preview-grant', route(handlePreviewGrant));
  return app;
}

async function handleGrantsList(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  let grants, policy;
  try {
    [grants, policy] = await Promise.all([
      c.get('deps').platform.store.grantsByApp(app.id),
      c.get('deps').platform.store.appPolicy(app.id),
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
    ownerTenantIsConsumer: isConsumerEmailDomain(ownerTenant),
    roles: policy?.roles ?? [],
    viewAsOrigin: c.get('deps').viewAsOrigin,
    grants: grants.map((g) => ({
      principal: g.principal,
      appRole: g.appRole,
      featureRole: g.featureRole,
      grantedBy: g.grantedBy,
      grantedAt: g.grantedAt,
    })),
  });
}

async function handleGrantPut(c: Context<HonoEnv>): Promise<Response> {
  const { user, app } = await ownedApp(c);
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
    const policy = await c.get('deps').platform.store.appPolicy(app.id).catch(() => null);
    const roles = policy?.roles ?? [];
    if (!roles.includes(featureRole)) {
      throw badRequest(`"${featureRole}" is not a feature role this app declares in 280.json`);
    }
  }
  await guardLastOwner(c, app.id, principal, req.appRole);

  try {
    await c.get('deps').platform.store.putGrant({
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

async function handleGrantRevoke(c: Context<HonoEnv>): Promise<Response> {
  const { user, app } = await ownedApp(c);
  const req = await readJson(c, SMALL_LIMIT, grantRevokeSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the request',
    appendReason: false,
  });
  const principal = normalizePrincipal(req.principal);
  await guardLastOwner(c, app.id, principal, null);
  try {
    await c.get('deps').platform.store.revokeGrant(app.id, principal, user.email);
  } catch {
    throw unavailable('could not update the access list');
  }
  return c.body(null, 204);
}

// Writes the dashboard override, which wins durably over 280.json's access on every
// future deploy. ownedApp makes it account-owner-only.
async function handleSetAccess(c: Context<HonoEnv>): Promise<Response> {
  const { user, app } = await ownedApp(c);
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
    ok = await c.get('deps').platform.store.setAppAccess(app.id, req.access, user.email);
  } catch {
    throw unavailable('could not save the access change');
  }
  if (!ok) {
    throw badRequest('this app has never gone live; push it first, then set its access');
  }
  return c.body(null, 204);
}

async function handleShareDialog(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  const policy = await c.get('deps').platform.store.appPolicy(app.id).catch(() => null);
  const html = sharePage({
    app: { id: app.id, slug: app.slug, url: app.url, script: app.script },
    access: policy?.access ?? 'invited',
    roles: policy?.roles ?? [],
    viewAsOrigin: c.get('deps').viewAsOrigin,
  });
  return c.html(html);
}

// The caller's effective grant must be admin or above, the same rule the gateway
// re-checks on every identity mint from the grant.
async function handlePreviewGrant(c: Context<HonoEnv>): Promise<Response> {
  const { user, app } = await ownedApp(c);
  const req = await readJson(c, SMALL_LIMIT, previewGrantRequestSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the preview request',
    appendReason: false,
  });
  const viewAs = await validViewAs(c, app.id, req.viewAs);

  const effective = await effectiveAppRole(c, app.id, user.email);
  if (!appRoleAtLeast(effective, 'admin')) {
    throw badRequest('only an app owner or admin can preview it');
  }

  const token = randomSecret(32);
  try {
    await c.get('deps').platform.store.createPreviewGrant({
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

// Refuses a change that would leave an app with no owner: revoking an owner
// (newRole null) or demoting the sole owner below owner.
async function guardLastOwner(
  c: Context<HonoEnv>,
  appId: string,
  principal: string,
  newRole: string | null,
): Promise<void> {
  const grants = await c.get('deps').platform.store.grantsByApp(appId).catch(() => []);
  const owners = grants.filter((g) => g.appRole === 'owner');
  const targetIsOwner = owners.some((o) => o.principal === principal);
  if (targetIsOwner && owners.length <= 1 && newRole !== 'owner') {
    throw badRequest("this is the app's only owner; make someone else an owner first");
  }
}

async function validViewAs(
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
    const policy = await c.get('deps').platform.store.appPolicy(appId).catch(() => null);
    if (!(policy?.roles ?? []).includes(featureRole)) {
      throw badRequest(`"${featureRole}" is not a feature role this app declares in 280.json`);
    }
  }
  return { kind: 'role', appRole, featureRole };
}

// Merges the caller's direct and org-domain grants into the app role the gateway
// would resolve for them (the higher of the two wins).
async function effectiveAppRole(c: Context<HonoEnv>, appId: string, email: string): Promise<string> {
  const store = c.get('deps').platform.store;
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

// Canonicalizes a grant principal to what the gateway compares against: a
// "domain:firm.com" org grant or a lowercased email.
function normalizePrincipal(raw: string): string {
  const p = raw.trim();
  if (p === '') return '';
  if (p.toLowerCase().startsWith('domain:')) {
    const host = p.slice('domain:'.length).trim().toLowerCase();
    return host === '' ? '' : 'domain:' + host;
  }
  return p.toLowerCase();
}

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
