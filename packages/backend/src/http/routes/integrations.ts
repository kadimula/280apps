import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { DeployCode, DeployErr } from '@280/contracts';
import { IntegrationError, type IntegrationService } from '../../integrations/service.js';
import type { HonoEnv } from '../../observe.js';
import { SMALL_LIMIT, asObject, cookieOpts, ownedApp, readJson, route, str } from '../kernel.js';

// Distinct from the dashboard login cookie so the two never collide.
const INTEGRATION_OAUTH_COOKIE = '280_int_oauth';

export function integrationRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.get('/internal/apps/:app/integrations', route(handleIntegrationsList));
  app.get('/internal/apps/:app/integrations/:provider/start', route(handleIntegrationStart));
  app.post('/internal/apps/:app/integrations/:id/selector-session', route(handleIntegrationSelector));
  app.post('/internal/apps/:app/integrations/:id/resources', route(handleIntegrationResourceAdd));
  app.post('/internal/apps/:app/integrations/resources/delete', route(handleIntegrationResourceDelete));
  app.delete('/internal/apps/:app/integrations/:id', route(handleIntegrationDisconnect));
  app.get('/integrations/:provider/callback', route(handleIntegrationCallback));
  return app;
}

function integrations(c: Context<HonoEnv>): IntegrationService {
  const svc = c.get('deps').integrations;
  if (svc === undefined) {
    throw new DeployErr({ code: DeployCode.NotFound, message: 'integrations are not configured' });
  }
  return svc;
}

function mapIntegrationErr(err: unknown): never {
  if (err instanceof IntegrationError) {
    const code =
      err.kind === 'not_found'
        ? DeployCode.NotFound
        : err.kind === 'unavailable'
          ? DeployCode.Unavailable
          : DeployCode.PreflightRejected;
    throw new DeployErr({ code, message: err.message, retryable: err.kind === 'unavailable' });
  }
  throw err;
}

async function handleIntegrationsList(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  const svc = integrations(c);
  try {
    // Requirements come from the newest deploy's manifest so a parked deploy, whose
    // policy is not registered until it goes live, still surfaces what to bind.
    const latest = await c.get('deps').platform.store.latestDeploy(app.id).catch(() => null);
    const requirements = latest?.manifest.integrations ?? [];
    return c.json({
      providers: svc.catalog(),
      connections: await svc.listConnections(app.id),
      slots: await svc.slots(app.id, requirements),
      requirements,
    });
  } catch (err) {
    mapIntegrationErr(err);
  }
}

async function handleIntegrationStart(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  const svc = integrations(c);
  try {
    const { authUrl, stateCookie } = await svc.startConnection({
      appId: app.id,
      provider: c.req.param('provider') ?? '',
      returnPath: c.req.query('redirect') ?? '',
    });
    setCookie(c, INTEGRATION_OAUTH_COOKIE, stateCookie, cookieOpts(c, 600));
    return c.redirect(authUrl, 302);
  } catch (err) {
    mapIntegrationErr(err);
  }
}

async function handleIntegrationCallback(c: Context<HonoEnv>): Promise<Response> {
  const svc = integrations(c);
  const provider = c.req.param('provider') ?? '';
  const code = c.req.query('code') ?? '';
  const stateQuery = c.req.query('state') ?? '';
  const stateCookie = getCookie(c, INTEGRATION_OAUTH_COOKIE) ?? '';

  // No code with a valid state is the user denying consent: redirect to the
  // dashboard so it renders the OAuth recovery state instead of a bare error.
  if (stateQuery !== '' && stateCookie !== '' && code === '') {
    const returnPath = await svc.resolveOAuthReturnPath(provider, stateCookie).catch(() => null);
    deleteCookie(c, INTEGRATION_OAUTH_COOKIE, cookieOpts(c, 0));
    if (returnPath !== null) {
      const url = new URL(returnPath);
      url.searchParams.set('integration_error', 'oauth');
      url.searchParams.set('integrations', '1');
      return c.redirect(url.toString(), 302);
    }
    throw mapIntegrationErr(new IntegrationError('bad_request', 'that connection could not be verified'));
  }

  try {
    const { redirect } = await svc.completeConnection({
      provider,
      code,
      stateQuery,
      stateCookie,
    });
    deleteCookie(c, INTEGRATION_OAUTH_COOKIE, cookieOpts(c, 0));
    return c.redirect(redirect, 302);
  } catch (err) {
    deleteCookie(c, INTEGRATION_OAUTH_COOKIE, cookieOpts(c, 0));
    mapIntegrationErr(err);
  }
}

async function handleIntegrationSelector(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  const svc = integrations(c);
  try {
    c.header('Cache-Control', 'no-store');
    return c.json(await svc.selectorSession(app.id, c.req.param('id') ?? ''));
  } catch (err) {
    mapIntegrationErr(err);
  }
}

async function handleIntegrationResourceAdd(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  const svc = integrations(c);
  const req = await readJson(c, SMALL_LIMIT, integrationResourceSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the resource',
    appendReason: false,
  });
  try {
    const result = await svc.registerResource({
      appId: app.id,
      connectionId: c.req.param('id') ?? '',
      capability: req.capability,
      alias: req.alias,
      externalId: req.externalId,
    });
    // Binding an alias may be the last thing a parked deploy was waiting on.
    await c.get('deps').platform.resumeWaiting(app).catch(() => undefined);
    return c.json(result);
  } catch (err) {
    mapIntegrationErr(err);
  }
}

async function handleIntegrationResourceDelete(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  const svc = integrations(c);
  const req = await readJson(c, SMALL_LIMIT, integrationResourceDeleteSchema, {
    code: DeployCode.PreflightRejected,
    message: 'could not read the request',
    appendReason: false,
  });
  try {
    await svc.removeResource(app.id, req.resourceId);
    return c.body(null, 204);
  } catch (err) {
    mapIntegrationErr(err);
  }
}

async function handleIntegrationDisconnect(c: Context<HonoEnv>): Promise<Response> {
  const { app } = await ownedApp(c);
  const svc = integrations(c);
  try {
    await svc.disconnect(app.id, c.req.param('id') ?? '');
    return c.body(null, 204);
  } catch (err) {
    mapIntegrationErr(err);
  }
}

const integrationResourceSchema = {
  parse(u: unknown): { capability: string; alias: string; externalId: string } {
    const o = asObject(u);
    return { capability: str(o.capability), alias: str(o.alias), externalId: str(o.externalId) };
  },
};

const integrationResourceDeleteSchema = {
  parse(u: unknown): { resourceId: string } {
    const o = asObject(u);
    if (typeof o.resourceId !== 'string' || o.resourceId === '') throw new Error('resourceId must be a non-empty string');
    return { resourceId: o.resourceId };
  },
};
